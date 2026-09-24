"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const TransitionPlanner = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Reader = require("../js/marketCalendarHistory/existingDbPreconditionReader.js");
const Planner = require("../js/marketCalendarHistory/existingDbUpdatePlanner.js");

const SOURCE = "jp-boj-calendar", OTHER = "us-bls-calendar";
const T1 = "2026-09-24T00:00:00.000Z", T2 = "2026-09-25T00:00:00.000Z";
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
async function event(sourceId = SOURCE, overrides = {}, fetchedAt = T1) {
  const source = Registry.getSource(sourceId), input = { ...Fixtures.record(sourceId), sourceId,
    sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId,
    parserVersion: source.parserVersion, rawContentHash: "a".repeat(64), requestId: null,
    runId: null, httpMetadata: { httpStatus: 200 }, ...overrides }, result =
    await Canonicalizer.canonicalize(input);
  assert.equal(result.ok, true, result.reason); return result.event;
}
async function candidate(sourceId, records) {
  const source = Registry.getSource(sourceId), revisionKeys = records.map(value =>
    value.revisionKey).sort(), semanticSetHash = await Canonicalizer.sha256(revisionKeys),
    candidateIdentity = await Canonicalizer.sha256({ sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1, revisionKeys });
  return { sourceId, candidateStatus: "available", formalEligible: true, candidateIdentity,
    recordCount: records.length, canonicalRecords: records, parserStatus: "success",
    canonicalizationStatus: "success", parserDiagnostics: [], canonicalDiagnostics: [],
    encodingEvidence: [], sourceIdentity: { sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1, semanticSetHash } };
}
async function initialSnapshot(sourceId, records) {
  const semanticSetHash = await Canonicalizer.sha256(records.map(value => value.revisionKey).sort()),
    run = { sourceId, runId: `seed-${sourceId}`, acceptedAt: T1, fetchedAt: [T1],
      status: "accepted", semanticSetHash }, planned = TransitionPlanner.planTransition({
      snapshot: TransitionPlanner.emptySnapshot(), run, canonicalSet: records,
      coverage: { confirmed: true, eventKeys: records.map(value => value.eventKey) } });
  assert.equal(planned.ok, true); const mapped = Mapper.mapPlan(planned.plan);
  return { entries: mapped.appendEntries, revisions: mapped.appendRevisions,
    evidence: mapped.appendEvidence, observations: mapped.appendObservations,
    runs: mapped.appendRuns, cursors: mapped.updateCursors };
}
async function seed(indexedDB, snapshots, mutate = null) {
  const combined = { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] };
  for (const value of snapshots) for (const field of Object.keys(combined))
    combined[field].push(...value[field]);
  if (mutate) mutate(combined);
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
    opening.onupgradeneeded = () => BootstrapSchema.createAndPopulate(opening.result,
      opening.transaction, combined);
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  });
}
async function seedWrongSchema(indexedDB) {
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, 2);
    opening.onupgradeneeded = () => opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  });
}
const reader = indexedDB => Reader.createExistingDbPreconditionReader({ indexedDB,
  targetEnvironment: "isolated_test" });
function previousFrom(result) {
  const state = result.currentState, source = Registry.getSource(state.sourceId);
  return { sourceId: state.sourceId, schemaVersion: 1, contractVersion: 1,
    parserIdentity: { sourceId: state.sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion }, entries: structuredClone(state.entries),
    revisions: structuredClone(state.revisions), runs: structuredClone(state.runs),
    cursors: structuredClone(state.cursors) };
}
async function planFor(readResult, value, coveragePolicy = null) {
  const simulation = await Simulator.simulateCalendarTransition({ sourceId: value.sourceId,
    candidate: value, previousState: readResult.status === "source_state_missing" ? null :
      previousFrom(readResult), coveragePolicy });
  return { simulation, plan: await Planner.planExistingSourceUpdate({ sourceId: value.sourceId,
    currentState: readResult, candidate: value, simulation }) };
}

test("valid existing DBをreadonly検証しsource state identityを生成", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const instance = reader(indexedDB), result =
    await instance.read({ sourceId: SOURCE });
  assert.equal(result.status, "valid_existing");
  assert.match(result.currentState.currentStateFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.currentState.activeRevisionIdentities,
    [{ eventKey: old.eventKey, revisionKey: old.revisionKey }]);
  assert.deepEqual(instance.diagnostics(), { catalogReads: 1, databaseOpens: 1,
    readonlyTransactions: 1, readwriteTransactions: 0, upgradeAttempts: 0, openHandles: 0 });
});

test("valid existing + unchangedはrevision追加なしで取得事実だけをplan", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), value = await candidate(SOURCE, [await event(SOURCE, {}, T2)]),
    { plan } = await planFor(current, value), types = plan.operations.map(item => item.type);
  assert.equal(plan.planStatus, "planned"); assert.equal(plan.writeAllowed, false);
  assert.equal(types.includes("append_semantic_revision"), false);
  for (const type of ["append_source_run", "append_evidence", "append_observation",
    "update_event_entry_last_observed", "update_source_cursor"]) assert.equal(types.includes(type), true);
});

test("changedは旧revision immutableのままclose + append + pointer切替をplan", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), changed = await event(SOURCE, { sourceLocalSchedule: {
      ...Fixtures.record(SOURCE).sourceLocalSchedule, startDate: "2026-09-19" } }, T2),
    { plan } = await planFor(current, await candidate(SOURCE, [changed])), types =
    plan.operations.map(item => item.type);
  assert.equal(plan.summary.changedCount, 1);
  for (const type of ["close_semantic_revision", "append_semantic_revision",
    "update_event_entry_active_revision"]) assert.equal(types.includes(type), true);
  assert.equal(types.includes("overwrite_semantic_revision"), false);
});

test("new eventとmixed transitionをpartial linkageなしでplan", async () => {
  const indexedDB = new IDBFactory(), unchanged = await event(), changedOld = await event(SOURCE, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
    sourceTitle: "Decision", titleJa: "Decision" });
  await seed(indexedDB, [await initialSnapshot(SOURCE, [unchanged, changedOld])]);
  const current = await reader(indexedDB).read({ sourceId: SOURCE }), changed = await event(SOURCE, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
    sourceTitle: "Decision", titleJa: "Decision", sourceLocalSchedule: {
      ...Fixtures.record(SOURCE).sourceLocalSchedule, startDate: "2026-09-19" } }, T2),
    added = await event(SOURCE, { eventType: "BOJ_GOVERNOR_PRESS_CONFERENCE",
      referencePeriod: "2026-11-meeting", sourceTitle: "Press", titleJa: "Press" }, T2),
    { plan } = await planFor(current, await candidate(SOURCE, [added, changed,
      await event(SOURCE, {}, T2)]));
  assert.deepEqual([plan.summary.newCount, plan.summary.changedCount, plan.summary.unchangedCount],
    [1, 1, 1]);
  const newOperations = plan.operations.filter(item => item.eventKey === added.eventKey)
    .map(item => item.type);
  for (const type of ["append_event_entry", "append_semantic_revision", "append_evidence",
    "append_observation"]) assert.equal(newOperations.includes(type), true);
});

test("target source missingはDB全体をbootstrap扱いせずnew-source plan", async () => {
  const indexedDB = new IDBFactory(), other = await event(OTHER); await seed(indexedDB,
    [await initialSnapshot(OTHER, [other])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }); assert.equal(current.status, "source_state_missing");
  const added = await event(SOURCE, {}, T2), { plan } = await planFor(current,
    await candidate(SOURCE, [added]));
  assert.equal(plan.planStatus, "planned"); assert.equal(plan.summary.newCount, 1);
  assert.equal(plan.precondition.expectedSourceCursor, null);
});

test("absentとschema mismatchはopen/create/upgradeせず分類", async () => {
  const absentDb = new IDBFactory(), absentReader = reader(absentDb), absent =
    await absentReader.read({ sourceId: SOURCE });
  assert.equal(absent.status, "absent"); assert.equal(absentReader.diagnostics().databaseOpens, 0);
  const wrongDb = new IDBFactory(); await seedWrongSchema(wrongDb); const wrongReader = reader(wrongDb),
    mismatch = await wrongReader.read({ sourceId: SOURCE });
  assert.equal(mismatch.status, "schema_mismatch");
  assert.equal(wrongReader.diagnostics().upgradeAttempts, 0);
});

test("multiple active revision・cursor mismatch・broken linkageをfail-closed", async () => {
  const old = await event(), moved = await event(SOURCE, { sourceLocalSchedule: {
    ...Fixtures.record(SOURCE).sourceLocalSchedule, startDate: "2026-09-19" } });
  const mutations = [snapshot => snapshot.revisions.push({ ...snapshot.revisions[0],
    revisionKey: moved.revisionKey, canonicalContentHash: moved.canonicalContentHash,
    schedule: moved.schedule, validFrom: T2, validTo: null }),
  snapshot => { snapshot.cursors[0].runId = "missing"; },
  snapshot => { snapshot.observations[0].eventKey = "missing"; }];
  for (const mutate of mutations) {
    const indexedDB = new IDBFactory(); await seed(indexedDB,
      [await initialSnapshot(SOURCE, [old])], mutate);
    assert.equal((await reader(indexedDB).read({ sourceId: SOURCE })).status, "integrity_invalid");
  }
});

test("candidate/transition/source identity不正はplanを生成しない", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), value = await candidate(SOURCE, [await event(SOURCE, {}, T2)]),
    simulation = await Simulator.simulateCalendarTransition({ sourceId: SOURCE, candidate: value,
      previousState: previousFrom(current) });
  for (const input of [
    { sourceId: SOURCE, currentState: current, candidate: { ...value, formalEligible: false }, simulation },
    { sourceId: SOURCE, currentState: current,
      candidate: { ...value, candidateIdentity: "f".repeat(64) }, simulation },
    { sourceId: SOURCE, currentState: current, candidate: value,
      simulation: { ...simulation, simulationStatus: "rejected" } },
    { sourceId: OTHER, currentState: current, candidate: value, simulation }
  ]) assert.equal((await Planner.planExistingSourceUpdate(input)).planStatus, "rejected");
});

test("not_evaluatedはdelete/cancelへ変換しない", async () => {
  const indexedDB = new IDBFactory(), old = await event(), added = await event(SOURCE, {
    referencePeriod: "2026-10-meeting" }, T2); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), { plan } = await planFor(current, await candidate(SOURCE, [added]));
  assert.equal(plan.summary.not_evaluatedCount, 1);
  assert.equal(plan.operations.some(item => /delete|cancel/.test(item.type)), false);
});

test("preconditionはstate変更をstaleとして拒否可能", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), { plan } = await planFor(current,
      await candidate(SOURCE, [await event(SOURCE, {}, T2)]));
  assert.equal(Planner.comparePrecondition(current, plan.precondition).status, "current");
  const changed = structuredClone(current); changed.currentState.currentStateFingerprint = "f".repeat(64);
  assert.equal(Planner.comparePrecondition(changed, plan.precondition).status, "stale");
});

test("record/candidate/transition順とruntime timestamp差でplan identity不変", async () => {
  const indexedDB = new IDBFactory(), first = await event(), second = await event(SOURCE, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
    sourceTitle: "Decision", titleJa: "Decision" }); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [first, second])]); const current = await reader(indexedDB)
    .read({ sourceId: SOURCE }), records = [await event(SOURCE, {}, T2), await event(SOURCE, {
      eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
      sourceTitle: "Decision", titleJa: "Decision" }, T2)], value = await candidate(SOURCE, records),
    one = await planFor(current, value), reordered = { ...value,
      canonicalRecords: [...value.canonicalRecords].reverse() }, simulation = { ...one.simulation,
      transitions: [...one.simulation.transitions].reverse() }, two = await Planner.planExistingSourceUpdate({
        sourceId: SOURCE, currentState: current, candidate: reordered, simulation });
  assert.equal(one.plan.planIdentity, two.planIdentity);
  const semanticChange = structuredClone(current); semanticChange.currentState.currentStateFingerprint =
    "e".repeat(64); const staleIdentity = await Planner.planExistingSourceUpdate({ sourceId: SOURCE,
      currentState: semanticChange, candidate: reordered, simulation });
  assert.notEqual(one.plan.planIdentity, staleIdentity.planIdentity);
});

test("C3a modulesはreadwrite/writer/network/production profileへ接続しない", () => {
  for (const file of ["existingDbPreconditionReader.js", "existingDbUpdatePlanner.js"]) {
    const source = fs.readFileSync(path.join(__dirname, `../js/marketCalendarHistory/${file}`), "utf8");
    assert.doesNotMatch(source, /localStorage|fetch\(|ProductionHistoryWriter|\.put\(|\.add\(|\.delete\(/);
    assert.doesNotMatch(source, /transaction\([^\n]+["']readwrite["']/);
  }
});
