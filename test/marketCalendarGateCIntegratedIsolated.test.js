"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const TransitionPlanner = require("../js/marketCalendarHistory/transitionPlanner.js");
const PlanCanonicalizer = require("../js/marketCalendarHistory/planCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapCoordinator.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Reader = require("../js/marketCalendarHistory/existingDbPreconditionReader.js");
const Planner = require("../js/marketCalendarHistory/existingDbUpdatePlanner.js");
const Writer = require("../js/marketCalendarHistory/existingDbControlledWriter.js");

const SOURCES = Object.keys(Registry.SOURCES).slice(0, 5), T1 = "2026-09-24T00:00:00.000Z",
  T2 = "2026-09-25T00:00:00.000Z", T3 = "2026-09-26T00:00:00.000Z";
const audit = { bootstrapSessions: 0, databaseCreateAttempts: 0, successfulDatabaseCreates: 0,
  abortedCreateAttempts: 0, readwriteTransactionAttempts: 0, committedTransactions: 0,
  abortedTransactions: 0, staleRejects: 0, readonlyIntegrityTransactions: 0,
  restartReopenCycles: 0, finalHandles: 0 };
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});

async function record(sourceId, overrides = {}, fetchedAt = T1) {
  const source = Registry.getSource(sourceId), result = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), sourceId, sourceUrl: source.canonicalUrl, fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64), requestId: null, runId: null,
    httpMetadata: { httpStatus: 200 }, ...overrides });
  assert.equal(result.ok, true, `${sourceId}:${result.reason}`);
  return result.event;
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
async function bootstrapInput(value, acceptedAt = T1) {
  const sourceId = value.sourceId, simulation = await Simulator.simulateCalendarTransition({
    sourceId, candidate: value, previousState: null, coveragePolicy: null }), run = { sourceId,
      runId: `bootstrap-${sourceId}`, acceptedAt, fetchedAt: [acceptedAt], status: "accepted",
      semanticSetHash: value.sourceIdentity.semanticSetHash }, planned =
      TransitionPlanner.planTransition({ snapshot: TransitionPlanner.emptySnapshot(), run,
        canonicalSet: value.canonicalRecords, coverage: { confirmed: true,
          eventKeys: value.canonicalRecords.map(item => item.eventKey) } });
  assert.equal(planned.ok, true);
  const planHash = await PlanCanonicalizer.planHash(planned.plan);
  return { sourceId, candidate: value, simulation, plan: planned.plan, expectedSchemaVersion: 1,
    precondition: { schemaVersion: 1, sourceId, candidateIdentity: value.candidateIdentity,
      simulationIdentity: simulation.simulationIdentity, planHash } };
}
async function accepted(sourceId, records = null) {
  return bootstrapInput(await candidate(sourceId, records || [await record(sourceId)]));
}
async function rejected(sourceId) {
  const value = await accepted(sourceId);
  return { ...value, candidate: { ...value.candidate, candidateStatus: "rejected",
    formalEligible: false } };
}
function bootstrap(indexedDB) {
  return Bootstrap.createBootstrapCoordinator({ targetEnvironment: "isolated_test", indexedDB });
}
async function runBootstrap(indexedDB, sources) {
  const result = await bootstrap(indexedDB).bootstrap({ sources }), metrics = result.diagnostics;
  audit.bootstrapSessions += 1;
  audit.databaseCreateAttempts += metrics.databaseCreateAttempts;
  audit.successfulDatabaseCreates += metrics.successfulDatabaseCreates;
  audit.abortedCreateAttempts += metrics.databaseCreateAttempts - metrics.successfulDatabaseCreates;
  audit.readwriteTransactionAttempts += metrics.sourceTransactionAttempts;
  audit.committedTransactions += metrics.committedSourceTransactions;
  audit.abortedTransactions += metrics.rolledBackSourceTransactions;
  audit.readonlyIntegrityTransactions += metrics.readBackTransactions;
  audit.finalHandles += metrics.openHandles;
  return result;
}
async function snapshot(indexedDB) {
  const database = await request(indexedDB.open(Schema.DATABASE_NAME)), transaction =
    database.transaction(Reader.STORE_NAMES, "readonly"), completed = done(transaction), result = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    result[field] = await request(transaction.objectStore(storeName).getAll());
  await completed; database.close(); audit.readonlyIntegrityTransactions += 1; return result;
}
async function assertIntegrity(indexedDB, sourceIds) {
  const value = await snapshot(indexedDB), semantic = await Integrity.audit(value),
    storage = Integrity.auditStorageSnapshot(value);
  assert.equal(semantic.valid, true, semantic.errors.join(","));
  assert.equal(storage.valid, true, storage.errors.join(","));
  const entries = new Map(value.entries.map(item => [item.eventKey, item])),
    revisions = new Map(value.revisions.map(item => [item.revisionKey, item])),
    runs = new Map(value.runs.map(item => [item.runKey, item]));
  for (const item of value.entries) assert.equal(revisions.get(item.activeRevisionKey)?.eventKey,
    item.eventKey);
  for (const item of value.evidence) {
    assert.equal(revisions.get(item.revisionKey)?.eventKey, item.eventKey);
    assert.equal(runs.has(`${item.sourceId}|${item.runId}`), true);
  }
  for (const item of value.observations) {
    assert.equal(entries.get(item.eventKey)?.sourceId, item.sourceId);
    assert.equal(runs.has(`${item.sourceId}|${item.runId}`), true);
  }
  assert.equal(new Set(value.cursors.map(item => item.sourceId)).size, value.cursors.length);
  for (const sourceId of sourceIds) {
    const reader = Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test",
      indexedDB }), state = await reader.read({ sourceId });
    assert.equal(state.status, "valid_existing", `${sourceId}:${state.reason}`);
    assert.equal(reader.diagnostics().openHandles, 0);
    audit.readonlyIntegrityTransactions += reader.diagnostics().readonlyTransactions;
  }
  return value;
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
  const reader = Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test",
    indexedDB }), current = await reader.read({ sourceId: value.sourceId }), simulation =
    await Simulator.simulateCalendarTransition({ sourceId: value.sourceId, candidate: value,
      previousState: previousFrom(current), coveragePolicy }), plan =
    await Planner.planExistingSourceUpdate({ sourceId: value.sourceId, currentState: current,
      candidate: value, simulation });
  assert.equal(plan.planStatus, "planned");
  audit.readonlyIntegrityTransactions += reader.diagnostics().readonlyTransactions;
  return { sourceId: value.sourceId, candidate: value, simulation, plan };
}
function writer(indexedDB, configuration = {}) {
  return Writer.createExistingDbControlledWriter({ targetEnvironment: "isolated_test", indexedDB,
    enabled: true, ...configuration });
}
async function runWrite(indexedDB, input, configuration = {}) {
  const instance = writer(indexedDB, configuration), result = await instance.write(input),
    metrics = instance.diagnostics();
  audit.readwriteTransactionAttempts += metrics.readwriteTransactionAttempts;
  audit.committedTransactions += metrics.committedTransactions;
  audit.abortedTransactions += metrics.abortedTransactions;
  audit.readonlyIntegrityTransactions += metrics.readonlyReadBackTransactions;
  audit.finalHandles += metrics.openHandles;
  if (result.reason === "stale_precondition") audit.staleRejects += 1;
  return result;
}
async function initial(indexedDB, sourceIds = SOURCES.slice(0, 3), recordsBySource = new Map()) {
  const inputs = [];
  for (const sourceId of sourceIds) inputs.push(await accepted(sourceId,
    recordsBySource.get(sourceId) || null));
  const result = await runBootstrap(indexedDB, inputs);
  assert.equal(result.overallOutcome, "success");
  return result;
}
async function mutate(indexedDB, storeName, action) {
  const database = await request(indexedDB.open(Schema.DATABASE_NAME)), transaction =
    database.transaction(Reader.STORE_NAMES, "readwrite"), completed = done(transaction);
  await action(transaction.objectStore(storeName), transaction); await completed; database.close();
}

test("Scenario A/D: clean bootstrap→restart→unchanged existing update", async () => {
  const indexedDB = new IDBFactory(), sourceIds = SOURCES.slice(0, 3), inputs = [];
  assert.deepEqual(await indexedDB.databases(), []);
  for (const sourceId of sourceIds) inputs.push(await accepted(sourceId));
  let coordinator = bootstrap(indexedDB), result = await coordinator.bootstrap({ sources: inputs });
  audit.bootstrapSessions += 1; const metrics = result.diagnostics;
  audit.databaseCreateAttempts += metrics.databaseCreateAttempts;
  audit.successfulDatabaseCreates += metrics.successfulDatabaseCreates;
  audit.readwriteTransactionAttempts += metrics.sourceTransactionAttempts;
  audit.committedTransactions += metrics.committedSourceTransactions;
  audit.readonlyIntegrityTransactions += metrics.readBackTransactions;
  assert.equal(result.overallOutcome, "success"); assert.equal(result.dbCreated, true);
  assert.equal(result.firstCommittedSourceId, sourceIds[0]);
  const boot = await assertIntegrity(indexedDB, sourceIds), active = boot.entries[0].activeRevisionKey,
    revisionCount = boot.revisions.length;
  coordinator = null; audit.restartReopenCycles += 1;
  const blocked = await bootstrap(indexedDB).bootstrap({ sources: [inputs[0]] });
  assert.equal(blocked.sourceResults[0].reason, "db_already_exists");
  const value = await candidate(sourceIds[0], [await record(sourceIds[0], {}, T2)]), input =
    await prepare(indexedDB, value), outcome = await runWrite(indexedDB, input);
  assert.equal(outcome.status, "committed");
  const after = await assertIntegrity(indexedDB, sourceIds);
  assert.equal(after.entries[0].activeRevisionKey, active);
  assert.equal(after.revisions.length, revisionCount);
  assert.equal(after.runs.length, boot.runs.length + 1);
  assert.equal(after.evidence.length, boot.evidence.length + 1);
  assert.equal(after.observations.length, boot.observations.length + 1);
});

test("Scenario B: partial bootstrap keeps A/C/E and identifies B/D", async () => {
  const indexedDB = new IDBFactory(), inputs = [];
  for (const sourceId of SOURCES) inputs.push(await accepted(sourceId));
  inputs[1] = await rejected(SOURCES[1]); inputs[3] = { ...inputs[3], injectFailureAfter: "evidence" };
  const result = await runBootstrap(indexedDB, inputs), stored = await assertIntegrity(indexedDB,
    [SOURCES[0], SOURCES[2], SOURCES[4]]);
  assert.equal(result.overallOutcome, "partial");
  assert.deepEqual(result.sourceResults.map(item => item.status),
    ["committed", "rejected", "committed", "failed", "committed"]);
  assert.deepEqual(stored.cursors.map(item => item.sourceId).sort(),
    [SOURCES[0], SOURCES[2], SOURCES[4]].sort());
});

test("Scenario C: all failure leaves catalog absent and handles closed", async () => {
  const indexedDB = new IDBFactory(), result = await runBootstrap(indexedDB,
    await Promise.all(SOURCES.slice(0, 3).map(rejected)));
  assert.equal(result.overallOutcome, "failed"); assert.equal(result.dbCreated, false);
  assert.equal(result.summary.committedCount, 0); assert.deepEqual(await indexedDB.databases(), []);
  assert.equal(result.diagnostics.openHandles, 0);
});

test("Scenario E/F: changed revision and new event preserve linkage", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await initial(indexedDB, [source]);
  const before = await snapshot(indexedDB), changed = await record(source, { titleJa: "changed" }, T2),
    changedInput = await prepare(indexedDB, await candidate(source, [changed]));
  assert.equal((await runWrite(indexedDB, changedInput)).status, "committed");
  const afterChanged = await assertIntegrity(indexedDB, [source]), old = afterChanged.revisions.find(item =>
    item.revisionKey === before.revisions[0].revisionKey), active = afterChanged.entries[0].activeRevisionKey;
  assert.notEqual(active, before.entries[0].activeRevisionKey); assert.notEqual(old.validTo, null);
  const changedAgain = await record(source, { titleJa: "changed" }, T3), added =
    await record(source, { eventType: "BOJ_POLICY_DECISION",
      referencePeriod: "2026-11-meeting", sourceTitle: "Decision", titleJa: "Decision" }, T3), next =
    await candidate(source, [changedAgain, added]), newInput = await prepare(indexedDB, next);
  assert.equal((await runWrite(indexedDB, newInput)).status, "committed");
  const afterNew = await assertIntegrity(indexedDB, [source]);
  assert.equal(afterNew.entries.some(item => item.eventKey === added.eventKey), true);
  assert.equal(afterNew.revisions.some(item => item.revisionKey === added.revisionKey), true);
});

test("Scenario G/unobserved: mixed transitions never infer delete/cancel/lifecycle end", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0], base = await record(source), changing =
    await record(source, { eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
      sourceTitle: "Decision", titleJa: "Decision" }), missing = await record(source, {
      eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-12-meeting",
      sourceTitle: "Outlook", titleJa: "Outlook" });
  await initial(indexedDB, [source], new Map([[source, [base, changing, missing]]]));
  const changed = await record(source, { eventType: "BOJ_POLICY_DECISION",
    referencePeriod: "2026-10-meeting", sourceTitle: "Decision revised",
    titleJa: "Decision revised" }, T2), added = await record(source, {
      eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-11-meeting",
      sourceTitle: "Press", titleJa: "Press" }, T2), next = await candidate(source,
      [await record(source, {}, T2), changed, added]), input = await prepare(indexedDB, next);
  assert.deepEqual(new Set(input.simulation.transitions.map(item => item.status)),
    new Set(["unchanged", "changed", "new", "not_evaluated"]));
  assert.equal((await runWrite(indexedDB, input)).status, "committed");
  const explicit = await candidate(source, [await record(source, {}, T3), await record(source, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-10-meeting",
    sourceTitle: "Decision revised", titleJa: "Decision revised" }, T3), await record(source, {
    eventType: "BOJ_POLICY_DECISION", referencePeriod: "2026-11-meeting",
    sourceTitle: "Press", titleJa: "Press" }, T3)]),
    unobserved = await prepare(indexedDB, explicit, { policyVersion: 1, sourceId: source,
      mode: "explicit_event_keys", allowUnobserved: true,
      parserId: explicit.sourceIdentity.parserId, parserVersion: explicit.sourceIdentity.parserVersion,
      eventKeys: [missing.eventKey] });
  assert.equal((await runWrite(indexedDB, unobserved)).status, "committed");
  const stored = await assertIntegrity(indexedDB, [source]), missingEntry = stored.entries.find(item =>
    item.eventKey === missing.eventKey), missingRevision = stored.revisions.find(item =>
    item.revisionKey === missingEntry.activeRevisionKey);
  assert.equal(missingRevision.validTo, null);
  assert.equal(["cancelled", "deleted"].includes(missingRevision.lifecycleStatus), false);
  assert.equal(stored.observations.some(item => item.eventKey === missing.eventKey &&
    item.state === "unobserved"), true);
});

test("Scenario H: stale plan writes nothing and preserves newer state", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await initial(indexedDB, [source]);
  const stale = await prepare(indexedDB, await candidate(source, [await record(source, {}, T2)])), fresh =
    await prepare(indexedDB, await candidate(source, [await record(source, { titleJa: "fresh" }, T2)]));
  assert.equal((await runWrite(indexedDB, fresh)).status, "committed");
  const before = await snapshot(indexedDB), result = await runWrite(indexedDB, stale);
  assert.equal(result.reason, "stale_precondition"); assert.deepEqual(await snapshot(indexedDB), before);
  await assertIntegrity(indexedDB, [source]);
});

test("Scenario I: each store checkpoint rolls back the entire source transaction", async () => {
  for (const point of ["after_semantic_revision", "after_event_entry", "after_evidence",
    "after_observation", "after_source_run", "after_source_cursor"]) {
    const indexedDB = new IDBFactory(), source = SOURCES[0]; await initial(indexedDB, [source]);
    const before = await snapshot(indexedDB), input = await prepare(indexedDB,
      await candidate(source, [await record(source, { titleJa: point }, T2)])), result =
      await runWrite(indexedDB, input, { failureInjectionPoint: point });
    assert.equal(result.status, "rolled_back", point);
    assert.deepEqual(await snapshot(indexedDB), before, point);
    await assertIntegrity(indexedDB, [source]);
  }
});

test("Scenario J: multi-source partial update isolates success/failure/stale", async () => {
  const indexedDB = new IDBFactory(); await initial(indexedDB, SOURCES);
  const stale = await prepare(indexedDB, await candidate(SOURCES[3],
    [await record(SOURCES[3], {}, T2)])), outcomes = [];
  outcomes.push(await runWrite(indexedDB, await prepare(indexedDB,
    await candidate(SOURCES[0], [await record(SOURCES[0], {}, T2)]))));
  outcomes.push(await runWrite(indexedDB, await prepare(indexedDB,
    await candidate(SOURCES[1], [await record(SOURCES[1], {}, T2)])),
  { failureInjectionPoint: "after_evidence" }));
  outcomes.push(await runWrite(indexedDB, await prepare(indexedDB,
    await candidate(SOURCES[2], [await record(SOURCES[2], { titleJa: "changed" }, T2)]))));
  outcomes.push(await runWrite(indexedDB, stale));
  const added = await record(SOURCES[4], { eventType: "JP_GDP",
    referencePeriod: "2026-Q4", sourceTitle: "Special", titleJa: "Special" }, T2), existing =
    await record(SOURCES[4], {}, T2);
  outcomes.push(await runWrite(indexedDB, await prepare(indexedDB,
    await candidate(SOURCES[4], [existing, added]))));
  assert.deepEqual(outcomes.map(item => item.status),
    ["committed", "rolled_back", "committed", "rejected", "committed"]);
  assert.equal(outcomes[3].reason, "stale_precondition");
  const stored = await assertIntegrity(indexedDB, SOURCES);
  assert.equal(stored.cursors.length, SOURCES.length);
  assert.equal(stored.entries.some(item => item.eventKey === added.eventKey), true);
});

test("Schema/corruption gate rejects without repair, migration, upgrade, or deletion", async () => {
  const source = SOURCES[0], cases = [];
  const wrongVersion = new IDBFactory(); await new Promise((resolve, reject) => {
    const opening = wrongVersion.open(Schema.DATABASE_NAME, 2);
    opening.onupgradeneeded = () => opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  }); cases.push([wrongVersion, "schema_mismatch"]);
  const missingStore = new IDBFactory(); await new Promise((resolve, reject) => {
    const opening = missingStore.open(Schema.DATABASE_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error);
  }); cases.push([missingStore, "integrity_invalid"]);
  for (const kind of ["active", "cursor", "revision"]) {
    const indexedDB = new IDBFactory(); await initial(indexedDB, [source]);
    const stored = await snapshot(indexedDB);
    if (kind === "active") await mutate(indexedDB, "marketCalendarSemanticRevisions", store =>
      request(store.put({ ...stored.revisions[0], validTo: T2 })));
    if (kind === "cursor") await mutate(indexedDB, "marketCalendarSourceCursors", store =>
      request(store.put({ ...stored.cursors[0], runId: "broken" })));
    if (kind === "revision") await mutate(indexedDB, "marketCalendarSemanticRevisions", store =>
      request(store.put({ ...stored.revisions[0], sourceId: SOURCES[1] })));
    cases.push([indexedDB, "integrity_invalid"]);
  }
  for (const [indexedDB, expected] of cases) {
    const catalogBefore = await indexedDB.databases(), reader =
      Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test", indexedDB }),
      result = await reader.read({ sourceId: source });
    assert.equal(result.status, expected); assert.deepEqual(await indexedDB.databases(), catalogBefore);
    assert.equal(reader.diagnostics().upgradeAttempts, 0); assert.equal(reader.diagnostics().openHandles, 0);
  }
});

test("Deterministic identity binds candidate, simulation, plan, and precondition", async () => {
  const indexedDB = new IDBFactory(), source = SOURCES[0]; await initial(indexedDB, [source]);
  const a = await candidate(source, [await record(source, {}, T2)]), b = await candidate(source,
    [await record(source, {}, T3)]), inputA = await prepare(indexedDB, a), inputB =
    await prepare(indexedDB, b);
  assert.equal(a.candidateIdentity, b.candidateIdentity);
  assert.equal(inputA.simulation.simulationIdentity, inputB.simulation.simulationIdentity);
  assert.equal(inputA.plan.planIdentity, inputB.plan.planIdentity);
  assert.equal(inputA.plan.precondition.currentStateFingerprint,
    inputB.plan.precondition.currentStateFingerprint);
  const semantic = await candidate(source, [await record(source, { titleJa: "semantic-change" }, T3)]),
    changed = await prepare(indexedDB, semantic);
  assert.notEqual(semantic.candidateIdentity, a.candidateIdentity);
  assert.notEqual(changed.simulation.simulationIdentity, inputA.simulation.simulationIdentity);
  assert.notEqual(changed.plan.planIdentity, inputA.plan.planIdentity);
});

test("Gate C resource and production boundary summary", () => {
  assert.equal(audit.finalHandles, 0);
  assert.ok(audit.bootstrapSessions >= 10);
  assert.ok(audit.databaseCreateAttempts > 0);
  assert.ok(audit.committedTransactions > 0);
  assert.ok(audit.abortedTransactions > 0);
  assert.ok(audit.staleRejects >= 2);
  assert.ok(audit.restartReopenCycles >= 1);
  console.log(`GATE_C_ISOLATED_METRICS ${JSON.stringify(audit)}`);
});
