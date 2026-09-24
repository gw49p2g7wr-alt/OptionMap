"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const TransitionPlanner = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Reader = require("../js/marketCalendarHistory/existingDbPreconditionReader.js");
const Planner = require("../js/marketCalendarHistory/existingDbUpdatePlanner.js");
const Writer = require("../js/marketCalendarHistory/existingDbControlledWriter.js");

const SOURCES = ["jp-boj-calendar", "us-bls-calendar", "us-fed-fomc-calendar",
  "us-census-calendar", "us-nyse-market-holidays"], T1 = "2026-09-24T00:00:00.000Z",
  T2 = "2026-09-25T00:00:00.000Z", T3 = "2026-09-26T00:00:00.000Z";
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
async function event(sourceId, overrides = {}, fetchedAt = T1) {
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
async function seed(indexedDB, sourceRecords) {
  const combined = { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] };
  for (const [sourceId, records] of sourceRecords) { const value = await initialSnapshot(sourceId, records);
    for (const field of Object.keys(combined)) combined[field].push(...value[field]); }
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
    opening.onupgradeneeded = () => BootstrapSchema.createAndPopulate(opening.result,
      opening.transaction, combined);
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  });
}
async function snapshot(indexedDB) {
  const database = await request(indexedDB.open(Schema.DATABASE_NAME)), transaction =
    database.transaction(Reader.STORE_NAMES, "readonly"), completed = done(transaction), result = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    result[field] = await request(transaction.objectStore(storeName).getAll());
  await completed; database.close(); return result;
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
  const current = await Reader.createExistingDbPreconditionReader({
    targetEnvironment: "isolated_test", indexedDB }).read({ sourceId: value.sourceId }),
    simulation = await Simulator.simulateCalendarTransition({ sourceId: value.sourceId,
      candidate: value, previousState: previousFrom(current), coveragePolicy }), plan =
    await Planner.planExistingSourceUpdate({ sourceId: value.sourceId, currentState: current,
      candidate: value, simulation });
  assert.equal(plan.planStatus, "planned"); return { sourceId: value.sourceId,
    candidate: value, simulation, plan };
}
const writer = (indexedDB, configuration = {}) => Writer.createExistingDbControlledWriter({
  targetEnvironment: "isolated_test", indexedDB, enabled: true, ...configuration });
let integrityChecks = 0;
async function assertIntegrity(indexedDB, sourceIds = SOURCES) {
  const value = await snapshot(indexedDB), semantic = await Integrity.audit(value),
    storage = Integrity.auditStorageSnapshot(value);
  assert.equal(semantic.valid, true, semantic.errors.join(","));
  assert.equal(storage.valid, true, storage.errors.join(","));
  for (const sourceId of sourceIds) {
    const result = await Reader.createExistingDbPreconditionReader({
      targetEnvironment: "isolated_test", indexedDB }).read({ sourceId });
    assert.equal(result.status, "valid_existing", `${sourceId}:${result.reason}`);
  }
  integrityChecks += 1; return value;
}
async function unchanged(sourceId, fetchedAt = T2) {
  return candidate(sourceId, [await event(sourceId, {}, fetchedAt)]);
}
async function changed(sourceId = SOURCES[0], fetchedAt = T2) {
  const original = Fixtures.record(sourceId);
  return candidate(sourceId, [await event(sourceId, { sourceLocalSchedule: {
    ...original.sourceLocalSchedule, startDate: "2026-09-19" } }, fetchedAt)]);
}

test("6-store checkpointsは各transactionをabortし完全なbefore stateを保持", async () => {
  for (const point of ["after_event_entry", "after_semantic_revision", "after_evidence",
    "after_observation", "after_source_run", "after_source_cursor"]) {
    const indexedDB = new IDBFactory(), source = SOURCES[0], old = await event(source);
    await seed(indexedDB, [[source, [old]]]); const before = await snapshot(indexedDB), input =
      await prepare(indexedDB, await changed(source)), instance = writer(indexedDB,
        { failureInjectionPoint: point }), outcome = await instance.write(input);
    assert.equal(outcome.status, "rolled_back", point);
    assert.deepEqual(await snapshot(indexedDB), before, point);
    assert.deepEqual(instance.diagnostics(), { readwriteTransactionAttempts: 1,
      committedTransactions: 0, abortedTransactions: 1, readonlyReadBackTransactions: 0,
      openHandles: 0 });
    await assertIntegrity(indexedDB, [source]);
  }
});

test("changed revisionのclose/append/pointer途中failureは全rollback", async () => {
  for (const point of ["after_close_revision", "after_append_revision", "after_event_entry"]) {
    const indexedDB = new IDBFactory(), source = SOURCES[0], old = await event(source);
    await seed(indexedDB, [[source, [old]]]); const before = await snapshot(indexedDB), input =
      await prepare(indexedDB, await changed(source)), outcome = await writer(indexedDB,
        { failureInjectionPoint: point }).write(input);
    assert.equal(outcome.status, "rolled_back"); assert.deepEqual(await snapshot(indexedDB), before);
    await assertIntegrity(indexedDB, [source]);
  }
});

test("new eventのentry/revision/evidence/run/cursor途中failureはorphan 0", async () => {
  for (const point of ["after_append_revision", "after_event_entry", "after_evidence",
    "after_source_cursor"]) {
    const indexedDB = new IDBFactory(), source = SOURCES[0], old = await event(source);
    await seed(indexedDB, [[source, [old]]]); const added = await event(source, {
      eventType: "BOJ_GOVERNOR_PRESS_CONFERENCE", referencePeriod: "2026-11-meeting",
      sourceTitle: "Press", titleJa: "Press" }, T2), before = await snapshot(indexedDB), input =
      await prepare(indexedDB, await candidate(source, [await event(source, {}, T2), added])),
      outcome = await writer(indexedDB, { failureInjectionPoint: point }).write(input);
    assert.equal(outcome.status, "rolled_back"); assert.deepEqual(await snapshot(indexedDB), before);
    await assertIntegrity(indexedDB, [source]);
  }
});

test("same-source plan replayは最初だけcommitし旧preconditionを拒否", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await seed(indexedDB,
    [[source, [await event(source)]]]); const input = await prepare(indexedDB, await unchanged(source)),
    instance = writer(indexedDB), first = await instance.write(input), afterFirst = await snapshot(indexedDB),
    replay = await instance.write(input);
  assert.equal(first.status, "committed"); assert.equal(replay.reason, "stale_precondition");
  assert.deepEqual(await snapshot(indexedDB), afterFirst);
  assert.equal(instance.diagnostics().committedTransactions, 1);
  await assertIntegrity(indexedDB, [source]);
});

test("transaction内部raceはstale検出し注入mutationごとrollback", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await seed(indexedDB,
    [[source, [await event(source)]]]); const before = await snapshot(indexedDB), input =
    await prepare(indexedDB, await unchanged(source)), instance = writer(indexedDB, {
      beforeInsidePrecondition: ({ transaction }) => request(transaction
        .objectStore("marketCalendarSourceRuns").add({ runKey: `${SOURCES[1]}|race`,
          sourceId: SOURCES[1], runId: "race", acceptedAt: T2, fetchedAt: [T2],
          status: "accepted", semanticSetHash: "f".repeat(64), contractVersion: 1 })) }),
    outcome = await instance.write(input);
  assert.equal(outcome.reason, "stale_precondition"); assert.deepEqual(await snapshot(indexedDB), before);
  assert.equal(instance.diagnostics().abortedTransactions, 1);
  await assertIntegrity(indexedDB, [source]);
});

test("different-source overlapping requestsはsource transaction単位でfailure隔離", async () => {
  for (const modes of [[null, null], ["after_evidence", null], [null, "after_evidence"]]) {
    const indexedDB = new IDBFactory(), [a, b] = SOURCES; await seed(indexedDB,
      [[a, [await event(a)]], [b, [await event(b)]]]);
    const first = (async () => writer(indexedDB, modes[0] ? { failureInjectionPoint: modes[0] } : {})
      .write(await prepare(indexedDB, await unchanged(a))))(), second = (async () => {
      await first; return writer(indexedDB, modes[1] ? { failureInjectionPoint: modes[1] } : {})
        .write(await prepare(indexedDB, await unchanged(b))); })(), outcomes = await Promise.all([first, second]);
    assert.equal(outcomes[0].status, modes[0] ? "rolled_back" : "committed");
    assert.equal(outcomes[1].status, modes[1] ? "rolled_back" : "committed");
    await assertIntegrity(indexedDB, [a, b]);
  }
});

test("5-source partial successはA/C/E commit・B rollback・D stale", async () => {
  const indexedDB = new IDBFactory(), records = [];
  for (const sourceId of SOURCES) records.push([sourceId, [await event(sourceId)]]);
  await seed(indexedDB, records); const staleD = await prepare(indexedDB, await unchanged(SOURCES[3])),
    outcomes = [];
  for (const [index, sourceId] of SOURCES.entries()) {
    if (index === 3) { outcomes.push(await writer(indexedDB).write(staleD)); continue; }
    const input = await prepare(indexedDB, await unchanged(sourceId)), instance = writer(indexedDB,
      index === 1 ? { failureInjectionPoint: "after_observation" } : {});
    outcomes.push(await instance.write(input));
  }
  assert.deepEqual(outcomes.map(value => value.status),
    ["committed", "rolled_back", "committed", "rejected", "committed"]);
  assert.equal(outcomes[3].reason, "stale_precondition");
  await assertIntegrity(indexedDB, SOURCES);
});

test("all failureでもpre-existing multi-source DBを完全保持", async () => {
  const indexedDB = new IDBFactory(), selected = SOURCES.slice(0, 3), records = [];
  for (const sourceId of selected) records.push([sourceId, [await event(sourceId)]]);
  await seed(indexedDB, records); const before = await snapshot(indexedDB);
  for (const sourceId of selected) {
    const outcome = await writer(indexedDB, { failureInjectionPoint: "after_source_run" })
      .write(await prepare(indexedDB, await unchanged(sourceId)));
    assert.equal(outcome.status, "rolled_back");
  }
  assert.deepEqual(await snapshot(indexedDB), before); await assertIntegrity(indexedDB, selected);
});

test("unknown/malformed operationとunknown failure seamはtransaction開始前に拒否", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await seed(indexedDB,
    [[source, [await event(source)]]]); const input = await prepare(indexedDB, await unchanged(source)),
    instance = writer(indexedDB), invalid = await instance.write({ ...input,
      plan: { ...input.plan, operations: [{ type: "unknown_mutation" }] } });
  assert.equal(invalid.status, "rejected");
  assert.equal(instance.diagnostics().readwriteTransactionAttempts, 0);
  assert.throws(() => writer(indexedDB, { failureInjectionPoint: "unknown" }),
    /failure_injection_point_invalid/);
  await assertIntegrity(indexedDB, [source]);
});

test("unobserved/not_evaluatedはobservationだけでdelete/cancel/lifecycle変更なし", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0], retained = await event(source),
    missing = await event(source, { eventType: "BOJ_POLICY_DECISION",
      referencePeriod: "2026-10-meeting", sourceTitle: "Decision", titleJa: "Decision" });
  await seed(indexedDB, [[source, [retained, missing]]]); const before = await snapshot(indexedDB),
    firstCandidate = await candidate(source, [await event(source, {}, T2)]), unobservedInput =
    await prepare(indexedDB, firstCandidate, { policyVersion: 1, sourceId: source,
      mode: "explicit_event_keys", allowUnobserved: true,
      parserId: firstCandidate.sourceIdentity.parserId,
      parserVersion: firstCandidate.sourceIdentity.parserVersion, eventKeys: [missing.eventKey] });
  assert.equal((await writer(indexedDB).write(unobservedInput)).status, "committed");
  const secondInput = await prepare(indexedDB, await candidate(source,
    [await event(source, {}, T3)]));
  assert.equal((await writer(indexedDB).write(secondInput)).status, "committed");
  const after = await assertIntegrity(indexedDB, [source]), missingRevision = after.revisions.find(value =>
    value.revisionKey === missing.revisionKey);
  assert.equal(missingRevision.validTo, null);
  assert.equal(after.entries.some(value => value.eventKey === missing.eventKey), true);
  assert.equal(after.observations.some(value => value.eventKey === missing.eventKey &&
    value.state === "unobserved"), true);
  assert.equal(after.observations.some(value => value.eventKey === missing.eventKey &&
    value.state === "not_evaluated"), true);
  assert.equal(after.entries.length, before.entries.length);
});

test("C3b2 audit countersはexpected fixture totalsでresource leak 0", () => {
  assert.equal(integrityChecks, 22);
});
