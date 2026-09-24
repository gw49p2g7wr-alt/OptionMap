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
const Writer = require("../js/marketCalendarHistory/existingDbControlledWriter.js");

const SOURCE = "jp-boj-calendar", OTHER = "us-bls-calendar";
const T1 = "2026-09-24T00:00:00.000Z", T2 = "2026-09-25T00:00:00.000Z";
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
async function event(sourceId = SOURCE, overrides = {}, fetchedAt = T1) {
  const source = Registry.getSource(sourceId), result = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), sourceId, sourceUrl: source.canonicalUrl, fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64), requestId: null, runId: null,
    httpMetadata: { httpStatus: 200 }, ...overrides });
  assert.equal(result.ok, true, result.reason); return result.event;
}
async function candidate(sourceId, records) {
  const source = Registry.getSource(sourceId), revisionKeys = records.map(value => value.revisionKey).sort(),
    semanticSetHash = await Canonicalizer.sha256(revisionKeys), candidateIdentity =
    await Canonicalizer.sha256({ sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1, revisionKeys });
  return { sourceId, candidateStatus: "available", formalEligible: true, candidateIdentity,
    recordCount: records.length, canonicalRecords: records, parserStatus: "success",
    canonicalizationStatus: "success", parserDiagnostics: [], canonicalDiagnostics: [],
    encodingEvidence: [], sourceIdentity: { sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1, semanticSetHash } };
}
async function initialSnapshot(sourceId, records, acceptedAt = T1) {
  const semanticSetHash = await Canonicalizer.sha256(records.map(value => value.revisionKey).sort()),
    run = { sourceId, runId: `seed-${sourceId}`, acceptedAt, fetchedAt: [acceptedAt],
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
  for (const snapshot of snapshots) for (const field of Object.keys(combined))
    combined[field].push(...snapshot[field]);
  if (mutate) mutate(combined);
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
    opening.onupgradeneeded = () => BootstrapSchema.createAndPopulate(opening.result,
      opening.transaction, combined);
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  });
}
async function addSnapshot(indexedDB, snapshot) {
  const database = await request(indexedDB.open(Schema.DATABASE_NAME)), transaction =
    database.transaction(Reader.STORE_NAMES, "readwrite"), completed = done(transaction);
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    for (const value of snapshot[field]) await request(transaction.objectStore(storeName).add(value));
  await completed; database.close();
}
function previousFrom(result) {
  const state = result.currentState, source = Registry.getSource(state.sourceId);
  return { sourceId: state.sourceId, schemaVersion: 1, contractVersion: 1,
    parserIdentity: { sourceId: state.sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion }, entries: structuredClone(state.entries),
    revisions: structuredClone(state.revisions), runs: structuredClone(state.runs),
    cursors: structuredClone(state.cursors) };
}
async function prepare(indexedDB, value, coveragePolicy = null) {
  const reader = Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test", indexedDB }),
    current = await reader.read({ sourceId: value.sourceId }), simulation =
    await Simulator.simulateCalendarTransition({ sourceId: value.sourceId, candidate: value,
      previousState: current.status === "source_state_missing" ? null : previousFrom(current),
      coveragePolicy }), plan = await Planner.planExistingSourceUpdate({ sourceId: value.sourceId,
      currentState: current, candidate: value, simulation });
  assert.equal(plan.planStatus, "planned"); return { sourceId: value.sourceId,
    candidate: value, simulation, plan };
}
const createWriter = (indexedDB, extras = {}) => Writer.createExistingDbControlledWriter({
  targetEnvironment: "isolated_test", indexedDB, enabled: true, ...extras });
async function readState(indexedDB, sourceId = SOURCE) {
  return Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test", indexedDB })
    .read({ sourceId });
}

test("unchangedはsemantic revisionを増やさずacquisition factをatomic commit", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2)])), before = await readState(indexedDB),
    writer = createWriter(indexedDB), outcome = await writer.write(input), after = await readState(indexedDB);
  assert.equal(outcome.status, "committed"); assert.equal(outcome.readBackStatus, "passed");
  assert.equal(after.currentState.revisions.length, before.currentState.revisions.length);
  assert.equal(after.currentState.entries[0].activeRevisionKey,
    before.currentState.entries[0].activeRevisionKey);
  assert.equal(after.currentState.evidence.length, before.currentState.evidence.length + 1);
  assert.equal(after.currentState.observations.length, before.currentState.observations.length + 1);
  assert.deepEqual(writer.diagnostics(), { readwriteTransactionAttempts: 1,
    committedTransactions: 1, abortedTransactions: 0, readonlyReadBackTransactions: 1,
    openHandles: 0 });
});

test("changedは旧revisionをcloseし新revisionとactive pointerをatomic commit", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const changed = await event(SOURCE, {
      sourceLocalSchedule: { ...Fixtures.record(SOURCE).sourceLocalSchedule,
        startDate: "2026-09-19" } }, T2), input = await prepare(indexedDB,
      await candidate(SOURCE, [changed])), writer = createWriter(indexedDB), outcome =
      await writer.write(input), after = await readState(indexedDB);
  assert.equal(outcome.status, "committed"); assert.equal(after.currentState.revisions.length, 2);
  assert.equal(after.currentState.entries[0].activeRevisionKey, changed.revisionKey);
  assert.equal(after.currentState.revisions.find(value => value.revisionKey === old.revisionKey).validTo,
    after.currentState.sourceCursor.acceptedAt);
});

test("source_state_missingのnew eventを既存DBへ1 transactionで追加", async () => {
  const indexedDB = new IDBFactory(), other = await event(OTHER); await seed(indexedDB,
    [await initialSnapshot(OTHER, [other])]); const added = await event(SOURCE, {}, T2), input =
    await prepare(indexedDB, await candidate(SOURCE, [added])), writer = createWriter(indexedDB),
    outcome = await writer.write(input), after = await readState(indexedDB);
  assert.equal(outcome.status, "committed"); assert.equal(after.status, "valid_existing");
  assert.equal(after.currentState.entries.length, 1);
  assert.equal(after.currentState.entries[0].activeRevisionKey, added.revisionKey);
});

test("mixed unchanged/changed/newをpartial writeなしでcommit", async () => {
  const indexedDB = new IDBFactory(), stable = await event(), prior = await event(SOURCE, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
    sourceTitle: "Decision", titleJa: "Decision" });
  await seed(indexedDB, [await initialSnapshot(SOURCE, [stable, prior])]);
  const changed = await event(SOURCE, { eventType: "BOJ_POLICY_DECISION",
    referencePeriod: "2026-10-meeting", sourceTitle: "Decision", titleJa: "Decision",
    sourceLocalSchedule: { ...Fixtures.record(SOURCE).sourceLocalSchedule,
      startDate: "2026-09-19" } }, T2), added = await event(SOURCE, {
    eventType: "BOJ_GOVERNOR_PRESS_CONFERENCE", referencePeriod: "2026-11-meeting",
    sourceTitle: "Press", titleJa: "Press" }, T2), input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2), changed, added])), outcome =
    await createWriter(indexedDB).write(input), after = await readState(indexedDB);
  assert.equal(outcome.status, "committed"); assert.equal(after.currentState.entries.length, 3);
  assert.equal(after.currentState.revisions.length, 4);
});

test("transaction直前のstate変更はstale_preconditionでwrite 0", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2)])), other = await event(OTHER);
  await addSnapshot(indexedDB, await initialSnapshot(OTHER, [other]));
  const writer = createWriter(indexedDB), outcome = await writer.write(input);
  assert.equal(outcome.reason, "stale_precondition");
  assert.equal(writer.diagnostics().readwriteTransactionAttempts, 0);
});

test("transaction内部のstate変更はabortして後勝ち上書きしない", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2)])), writer = createWriter(indexedDB, {
      beforeInsidePrecondition: async ({ transaction }) => request(transaction
        .objectStore("marketCalendarSourceRuns").add({ runKey: `${OTHER}|race`, sourceId: OTHER,
          runId: "race", acceptedAt: T2, fetchedAt: [T2], status: "accepted",
          semanticSetHash: "f".repeat(64), contractVersion: 1 })) }), outcome =
      await writer.write(input), after = await readState(indexedDB);
  assert.equal(outcome.status, "rolled_back"); assert.equal(outcome.reason, "stale_precondition");
  assert.equal(after.currentState.runs.some(value => value.runId === "race"), false);
  assert.deepEqual(writer.diagnostics(), { readwriteTransactionAttempts: 1,
    committedTransactions: 0, abortedTransactions: 1, readonlyReadBackTransactions: 0,
    openHandles: 0 });
});

test("planner/schema/source/operation/malformed planをDB open前にreject", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2)])), cases = [
      { ...input, plan: { ...input.plan, plannerVersion: 999 } },
      { ...input, plan: { ...input.plan, precondition: { ...input.plan.precondition,
        schemaVersion: 999 } } },
      { ...input, sourceId: OTHER },
      { ...input, plan: { ...input.plan, operations: [{ type: "delete_everything" }] } },
      { sourceId: SOURCE, plan: null, candidate: input.candidate, simulation: input.simulation }
    ], writer = createWriter(indexedDB);
  for (const value of cases) assert.equal((await writer.write(value)).status, "rejected");
  assert.equal(writer.diagnostics().readwriteTransactionAttempts, 0);
});

test("schema mismatchはupgradeせずwrite 0", async () => {
  const indexedDB = new IDBFactory(); await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, 2);
    opening.onupgradeneeded = () => opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  });
  const fake = { sourceId: SOURCE, plan: { sourceId: SOURCE, planStatus: "planned",
    writeAllowed: false, plannerVersion: 1, planIdentity: "a".repeat(64), operations: [],
    precondition: { schemaVersion: 1, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
      sourceId: SOURCE, currentStateFingerprint: "b".repeat(64),
      expectedActiveRevisionIdentities: [], expectedRelevantCounts: { global: {}, source: {} } } },
    candidate: { sourceId: SOURCE, candidateIdentity: "c".repeat(64) },
    simulation: { sourceId: SOURCE, candidateIdentity: "c".repeat(64) } }, writer = createWriter(indexedDB),
    outcome = await writer.write(fake);
  assert.equal(outcome.status, "rejected");
  assert.equal(writer.diagnostics().readwriteTransactionAttempts, 0);
});

test("invalid active revision stateはwrite 0", async () => {
  const indexedDB = new IDBFactory(), old = await event(); await seed(indexedDB,
    [await initialSnapshot(SOURCE, [old])]); const input = await prepare(indexedDB,
    await candidate(SOURCE, [await event(SOURCE, {}, T2)])), database =
    await request(indexedDB.open(Schema.DATABASE_NAME)), transaction = database.transaction(
      "marketCalendarEventEntries", "readwrite"), completed = done(transaction), store =
      transaction.objectStore("marketCalendarEventEntries"), entry = await request(store.get(old.eventKey));
  await request(store.put({ ...entry, activeRevisionKey: "missing" })); await completed; database.close();
  const writer = createWriter(indexedDB), outcome = await writer.write(input);
  assert.equal(outcome.status, "rejected"); assert.equal(outcome.reason, "stale_precondition");
  assert.equal(writer.diagnostics().readwriteTransactionAttempts, 0);
});

test("writer APIはisolated固定DB/storeのみでproduction wiringを持たない", () => {
  assert.throws(() => Writer.createExistingDbControlledWriter({ indexedDB: new IDBFactory(),
    targetEnvironment: "production", enabled: true }), /isolated_test_configuration_required/);
  const writer = createWriter(new IDBFactory());
  assert.equal(writer.contract.databaseName, Schema.DATABASE_NAME);
  assert.deepEqual(writer.contract.stores, Reader.STORE_NAMES);
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarHistory/existingDbControlledWriter.js"), "utf8");
  assert.doesNotMatch(source, /localStorage|fetch\(|production profile|repair|backfill|migration/);
});
