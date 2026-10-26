"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Authority = require("../js/marketCalendarHistory/calendarPartialSourceExecutionAuthority.js");
const Executor = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const Acquisition = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const F = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE = "jp-esri-machinery-orders-calendar", BLS = "us-bls-calendar",
  BEA = "us-bea-calendar";
const execute = async (harness, plan, grant = null) => harness.executor
  .executeCalendarFormalSourceMutation({ plan, grant: grant || await F.grant(harness.authority, plan) });

test("E1 absent DB creates schema and first source atomically with durable receipt", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), outcome = await execute(h, plan),
    stored = await F.read(h.indexedDB);
  assert.equal(outcome.status, "committed");
  assert.equal(outcome.operation, "create_schema_and_commit_first_source");
  assert.equal(outcome.durableReceipt.verified, true);
  assert.equal(outcome.durableReceipt.schemaVersion, Schema.VERSION);
  assert.equal(outcome.durableReceipt.schemaFingerprint, Schema.EXPECTED_FINGERPRINT);
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0].sourceId, SOURCE);
  assert.deepEqual((await h.indexedDB.databases()).map(value => [value.name, value.version]),
    [[Schema.DATABASE_NAME, Schema.VERSION]]);
});

test("E2 first-source upgrade failure leaves no empty DB shell", async () => {
  const h = F.harness(undefined, { firstSourceFailureAfter: "revisions" }),
    plan = await F.prepareFirst(SOURCE), outcome = await execute(h, plan);
  assert.equal(outcome.status, "transaction_aborted");
  assert.equal(outcome.committed, false);
  assert.deepEqual(await h.indexedDB.databases(), []);
  assert.equal(h.executor.diagnostics().abortedTransactions, 1);
});

test("E3 existing twelve-source DB appends only missing BLS", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => sourceId !== BLS), before =
    await F.SourceFixture.snapshotWithSources(existing), h = F.harness();
  await F.seed(h.indexedDB, before);
  const plan = await F.prepareExisting(BLS, before), outcome = await execute(h, plan), after =
    await F.read(h.indexedDB);
  assert.equal(outcome.status, "committed");
  assert.equal(outcome.operation, "append_missing_source");
  assert.equal(after.entries.some(value => value.sourceId === BLS), true);
  for (const field of Preparation.SNAPSHOT_FIELDS)
    assert.deepEqual(after[field].filter(value => value.sourceId !== BLS), before[field], field);
});

test("E4 source revision preserves old revision and advances active pointer", async () => {
  const before = await F.SourceFixture.snapshotWithSources([SOURCE]), h = F.harness();
  await F.seed(h.indexedDB, before);
  const changed = await F.SourceFixture.changedAcquisition(SOURCE), plan =
    await F.prepareExisting(SOURCE, before, changed), outcome = await execute(h, plan), after =
    await F.read(h.indexedDB), oldKey = before.entries[0].activeRevisionKey,
    newKey = plan.mutations.appendRevisions[0].revisionKey;
  assert.equal(outcome.status, "committed");
  assert.equal(outcome.operation, "append_source_revision");
  assert.equal(after.revisions.find(value => value.revisionKey === oldKey).validTo,
    Acquisition.ACCEPTED_AT);
  assert.equal(after.revisions.find(value => value.revisionKey === newKey).validTo, null);
  assert.equal(after.entries[0].activeRevisionKey, newKey);
});

test("E5 unchanged source is an accepted write0 outcome", async () => {
  const before = await F.SourceFixture.snapshotWithSources([SOURCE]), h = F.harness(), plan =
    await F.prepareExisting(SOURCE, before), outcome = await execute(h, plan);
  assert.equal(plan.status, "no_semantic_change");
  assert.equal(outcome.status, "no_semantic_change");
  assert.equal(outcome.committed, false);
  assert.equal(h.executor.diagnostics().catalogReads, 0);
  assert.equal(h.executor.diagnostics().readwriteTransactions, 0);
});

test("E6 replayed prepared plan detects already committed state with write0", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), first = await execute(h, plan),
    beforeReplay = h.executor.diagnostics().readwriteTransactions,
    replay = await execute(h, plan);
  assert.equal(first.status, "committed");
  assert.equal(replay.status, "already_committed");
  assert.equal(replay.durableReceipt.verified, true);
  assert.equal(h.executor.diagnostics().readwriteTransactions, beforeReplay);
});

test("E6b replay remains write0 after an unrelated source commits", async () => {
  const h = F.harness(), firstPlan = await F.prepareFirst(SOURCE);
  assert.equal((await execute(h, firstPlan)).status, "committed");
  const afterFirst = await F.SourceFixture.descriptor(await F.read(h.indexedDB)), beaPlan =
    await F.prepareExisting(BEA, afterFirst);
  assert.equal((await execute(h, beaPlan)).status, "committed");
  const beforeReplay = h.executor.diagnostics().readwriteTransactions,
    replay = await execute(h, firstPlan);
  assert.equal(replay.status, "already_committed");
  assert.equal(h.executor.diagnostics().readwriteTransactions, beforeReplay);
});

test("E7 stale full snapshot precondition fails before write", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => ![BLS, BEA].includes(sourceId)),
    preparedAgainst = await F.SourceFixture.snapshotWithSources(existing), actual =
    await F.SourceFixture.snapshotWithSources([...existing, BEA]), h = F.harness();
  await F.seed(h.indexedDB, actual);
  const plan = await F.prepareExisting(BLS, preparedAgainst), outcome = await execute(h, plan);
  assert.equal(outcome.status, "precondition_failed");
  assert.equal(h.executor.diagnostics().readwriteTransactions, 0);
});

test("E8 foreign-source mutation rejects before grant consumption or write", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), grant = await F.grant(h.authority, plan),
    tampered = structuredClone(plan);
  tampered.mutations.appendEntries[0].sourceId = BLS;
  const outcome = await execute(h, tampered, grant);
  assert.equal(outcome.reason, "source_scope_violation");
  assert.equal(h.executor.diagnostics().readwriteTransactions, 0);
});

test("E9 mutation ceiling mismatch rejects before write", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), grant = await F.grant(h.authority, plan),
    tampered = structuredClone(plan);
  tampered.mutationCeiling.appendEntries += 1;
  const outcome = await execute(h, tampered, grant);
  assert.equal(outcome.reason, "mutation_ceiling_mismatch");
  assert.equal(h.executor.diagnostics().readwriteTransactions, 0);
});

test("E10 readback mismatch never reports successful verification", async () => {
  const h = F.harness(undefined, { readbackMutator: snapshot => {
    snapshot.cursors = []; return snapshot;
  } }), plan = await F.prepareFirst(SOURCE), outcome = await execute(h, plan);
  assert.equal(outcome.status, "readback_mismatch");
  assert.equal(outcome.committed, true);
  assert.equal(outcome.durableReceipt, null);
});

test("E11 a consumed grant cannot execute twice", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), grant = await F.grant(h.authority, plan),
    first = await execute(h, plan, grant), second = await execute(h, plan, grant);
  assert.equal(first.status, "committed");
  assert.equal(second.reason, "grant_reused");
  assert.equal(h.executor.diagnostics().readwriteTransactions, 1);
});

test("E12 competing source plans serialize and stale plan cannot corrupt either source", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => ![BLS, BEA].includes(sourceId)),
    before = await F.SourceFixture.snapshotWithSources(existing), h = F.harness();
  await F.seed(h.indexedDB, before);
  const bls = await F.prepareExisting(BLS, before), bea = await F.prepareExisting(BEA, before),
    [first, second] = await Promise.all([execute(h, bls), execute(h, bea)]), after =
    await F.read(h.indexedDB);
  assert.equal(first.status, "committed");
  assert.equal(second.status, "precondition_failed");
  assert.equal(after.entries.some(value => value.sourceId === BLS), true);
  assert.equal(after.entries.some(value => value.sourceId === BEA), false);
  assert.equal(h.executor.diagnostics().maxConcurrentExecutions, 1);
});

test("B3 existing-source transaction failure rolls back all stores and unrelated sources", async () => {
  const before = await F.SourceFixture.snapshotWithSources([SOURCE, BEA]), h = F.harness(undefined,
    { existingFailurePoint: "after_semantic_revision" });
  await F.seed(h.indexedDB, before);
  const plan = await F.prepareExisting(SOURCE, before,
    await F.SourceFixture.changedAcquisition(SOURCE)), outcome = await execute(h, plan), after =
    await F.read(h.indexedDB);
  assert.equal(outcome.status, "transaction_aborted");
  assert.deepEqual(after, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, before[field]])));
  assert.equal(h.executor.diagnostics().abortedTransactions, 1);
  assert.equal(h.executor.diagnostics().openHandles, 0);
});

test("B3 special BOJ/BLS/JPX/MOF fixtures preserve exact Formal evidence", async () => {
  for (const sourceId of ["jp-boj-calendar", BLS, "jp-jpx-derivatives-calendar",
    "jp-mof-jgb-auction-calendar"]) {
    const h = F.harness(), plan = await F.prepareFirst(sourceId), outcome = await execute(h, plan),
      stored = await F.read(h.indexedDB);
    assert.equal(outcome.status, "committed", `${sourceId}:${outcome.reason}`);
    assert.deepEqual(stored.evidence, plan.mutations.appendEvidence, sourceId);
    assert.equal(outcome.durableReceipt.verified, true, sourceId);
  }
});

test("B3 expired and forged grants fail closed", async () => {
  let now = 1_000;
  const expiredHarness = F.harness(undefined, null, () => now), plan = await F.prepareFirst(SOURCE),
    grant = await F.grant(expiredHarness.authority, plan);
  now += Authority.GRANT_TTL_MS + 1;
  assert.equal((await execute(expiredHarness, plan, grant)).reason, "invalid_grant");
  const fresh = F.harness();
  assert.equal((await execute(fresh, plan, Object.freeze({}))).reason, "invalid_grant");
});

test("B3 API rejects arbitrary executor configuration and invocation fields", async () => {
  const h = F.harness(), plan = await F.prepareFirst(SOURCE), grant = await F.grant(h.authority, plan);
  assert.throws(() => Executor.createCalendarPartialSourceAtomicExecutor({
    targetEnvironment: "isolated_test", indexedDB: new F.IDBFactory(),
    executionAuthority: h.authority, databaseName: "arbitrary" }),
  /controlled_isolated_executor_required/);
  const outcome = await h.executor.executeCalendarFormalSourceMutation({ plan, grant,
    sourceData: { arbitrary: true } });
  assert.equal(outcome.reason, "invalid_plan");
});

test("B3 has no renderer/normal-acquisition wiring and leaves existing bootstrap untouched", () => {
  const root = path.join(__dirname, ".."), names = [
    "calendarPartialSourceExecutionAuthority", "calendarPartialSourceAtomicExecutor"];
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js", "js/fullExportCollector.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const name of names) assert.doesNotMatch(source, new RegExp(name), file);
  }
  assert.equal(Schema.DATABASE_NAME, "optionMapMarketCalendarHistory");
  assert.equal(Schema.VERSION, 1);
  assert.equal(Schema.EXPECTED_FINGERPRINT,
    "85248c8ec61ad4b554d77ee38e96088bc9b7fc0c3fc885e3af5332e7e02c2cbc");
});
