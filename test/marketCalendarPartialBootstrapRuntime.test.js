"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Coverage = require("../js/marketCalendarHistory/calendarPartialCoverage.js");
const Coordinator = require("../js/marketCalendarRuntime/calendarPartialBootstrapCoordinator.js");
const Bootstrap = require("../js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Acquisition = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const F = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");
const Projection = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Atomic = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const WriterCore = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");

const BLS = "us-bls-calendar", BEA = "us-bea-calendar", CENSUS = "us-census-calendar";
function reader(indexedDB) {
  return async () => {
    const snapshot = await F.read(indexedDB);
    return snapshot ? { status: "ok", snapshot,
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, audit: { readwrite: 0, writes: 0 } } :
      { status: "unavailable", reason: "formal_database_absent",
        audit: { readwrite: 0, writes: 0 } };
  };
}
function runtime(options = {}) {
  const h = options.harness || F.harness(), notify = { count: 0 }, executor = options.executor ||
    h.executor, coordinator = Coordinator.createCalendarPartialBootstrapCoordinator({
      readFormal: reader(h.indexedDB), executionAuthority: h.authority, executor,
      notify: async () => { notify.count++; } });
  return { ...h, coordinator, notify };
}
const run = (h, sourceResults, generationIdentity = Acquisition.GENERATION) =>
  h.coordinator.processGeneration({ sourceResults, acceptedAt: Acquisition.ACCEPTED_AT,
    generationIdentity });
const sourceIds = snapshot => [...new Set(snapshot.entries.map(value => value.sourceId))];

test("R1 absent DB builds all thirteen sources serially without legacy ownership", async () => {
  const h = runtime(), result = await run(h, await Acquisition.allSuccess()), stored =
    await F.read(h.indexedDB);
  assert.equal(result.status, "committed");
  assert.equal(result.writerExecution, 13);
  assert.deepEqual(result.committedSourceIds, Contract.EXPECTED_SOURCE_IDS);
  assert.equal(Coverage.projectPartialCoverage({ formalSnapshot: stored }).coverageCount, 13);
  assert.equal(h.executor.diagnostics().maxConcurrentExecutions, 1);
  assert.equal(h.notify.count, 1);
  assert.equal(result.legacyBootstrapEligible, false);
});

test("R2 absent DB persists twelve independent sources when BLS fails", async () => {
  const values = await Acquisition.allSuccess(), index = values.findIndex(value =>
    value.sourceId === BLS);
  values[index] = Acquisition.parserFailure(values[index]);
  const h = runtime(), result = await run(h, values), stored = await F.read(h.indexedDB), coverage =
    Coverage.projectPartialCoverage({ formalSnapshot: stored });
  assert.equal(result.writerExecution, 12);
  assert.equal(coverage.coverageCount, 12);
  assert.deepEqual(coverage.absentSourceIds, [BLS]);
  assert.equal(result.coverage.failedSourceIds.includes(BLS), true);
});

test("R3 one eligible source creates a valid one-source archive", async () => {
  const values = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted), first =
    await Acquisition.validSource(Contract.EXPECTED_SOURCE_IDS[4]);
  values[4] = first;
  const h = runtime(), result = await run(h, values), stored = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.deepEqual(sourceIds(stored), [first.sourceId]);
  assert.equal(result.coverage.formalPersistedSourceCount, 1);
});

test("R4 zero eligible sources creates no database", async () => {
  const h = runtime(), result = await run(h,
    Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted));
  assert.equal(result.writerExecution, 0);
  assert.equal(result.legacyBootstrapEligible, true);
  assert.equal(await F.read(h.indexedDB), null);
});

test("R5 a later BLS recovery appends only BLS to an existing twelve-source DB", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => sourceId !== BLS), before =
    await F.SourceFixture.snapshotWithSources(existing), h = runtime();
  await F.seed(h.indexedDB, before);
  const values = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  values[Contract.EXPECTED_SOURCE_IDS.indexOf(BLS)] = await Acquisition.validSource(BLS);
  const result = await run(h, values), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.deepEqual(result.committedSourceIds, [BLS]);
  for (const field of Object.keys(after)) assert.deepEqual(
    after[field].filter(value => value.sourceId !== BLS), before[field], field);
  assert.equal(result.coverage.formalPersistedSourceCount, 13);
});

test("R6 existing complete unchanged archive is semantic write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources(Contract.EXPECTED_SOURCE_IDS), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await Acquisition.allSuccess()), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.deepEqual(after, Object.fromEntries(Object.keys(after).map(field => [field, before[field]])));
  assert(result.sourceResults.every(value => value.status === "no_semantic_change"));
});

test("R7 two missing sources append in canonical order with one transaction each", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => ![BLS, BEA].includes(sourceId)),
    before = await F.SourceFixture.snapshotWithSources(existing), h = runtime();
  await F.seed(h.indexedDB, before);
  const values = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  values[Contract.EXPECTED_SOURCE_IDS.indexOf(BLS)] = await Acquisition.validSource(BLS);
  values[Contract.EXPECTED_SOURCE_IDS.indexOf(BEA)] = await Acquisition.validSource(BEA);
  const result = await run(h, values);
  assert.deepEqual(result.committedSourceIds, [BEA, BLS]);
  assert.equal(result.writerExecution, 2);
  assert.equal(h.executor.diagnostics().committedTransactions, 2);
});

test("R8 first-source failure leaves no empty shell and stops the generation", async () => {
  const h = runtime({ harness: F.harness(undefined, { firstSourceFailureAfter: "revisions" }) }),
    result = await run(h, await Acquisition.allSuccess());
  assert.equal(result.status, "partial_failure");
  assert.equal(result.writerExecution, 0);
  assert.equal(await F.read(h.indexedDB), null);
  assert.equal(result.sourceResults.filter(value => value.reason ===
    "first_source_failure_generation_stopped").length, 12);
});

test("R9 an existing-DB source failure rolls back locally and later sources continue", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => ![BLS, CENSUS].includes(sourceId)),
    before = await F.SourceFixture.snapshotWithSources(existing), base = F.harness();
  await F.seed(base.indexedDB, before);
  const executor = { executeCalendarFormalSourceMutation: input => input.plan.sourceId === BLS
    ? Promise.resolve({ status: "transaction_aborted", reason: "transaction_aborted",
      committed: false, durableReceipt: null })
    : base.executor.executeCalendarFormalSourceMutation(input) }, h = runtime({ harness: base, executor }),
    values = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  values[Contract.EXPECTED_SOURCE_IDS.indexOf(BLS)] = await Acquisition.validSource(BLS);
  values[Contract.EXPECTED_SOURCE_IDS.indexOf(CENSUS)] = await Acquisition.validSource(CENSUS);
  const result = await run(h, values), stored = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.deepEqual(result.committedSourceIds, [CENSUS]);
  assert.equal(sourceIds(stored).includes(BLS), false);
  assert.equal(sourceIds(stored).includes(CENSUS), true);
});

test("R10 duplicate generation callback is write0", async () => {
  const h = runtime(), values = await Acquisition.allSuccess(), first = await run(h, values),
    writes = h.executor.diagnostics().readwriteTransactions, duplicate = await run(h, values);
  assert.equal(first.writerExecution, 13);
  assert.equal(duplicate.status, "duplicate_generation");
  assert.equal(duplicate.writerExecution, 0);
  assert.equal(h.executor.diagnostics().readwriteTransactions, writes);
});

test("R11 overlapping generations serialize and the second sees persisted coverage", async () => {
  const h = runtime(), firstValues = await Acquisition.allSuccess(), secondValues =
    structuredClone(firstValues), secondGeneration = "d".repeat(64);
  secondValues.forEach(value => { value.generationIdentity = secondGeneration; });
  const [first, second] = await Promise.all([run(h, firstValues),
    run(h, secondValues, secondGeneration)]);
  assert.equal(first.writerExecution, 13);
  assert.equal(second.writerExecution, 0);
  assert.equal(second.coverage.formalPersistedSourceCount, 13);
  assert.equal(h.executor.diagnostics().maxConcurrentExecutions, 1);
});

test("R12 restart resumes from durable partial coverage without rewriting committed sources", async () => {
  const h = runtime(), one = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  one[0] = await Acquisition.validSource(Contract.EXPECTED_SOURCE_IDS[0]);
  assert.equal((await run(h, one)).writerExecution, 1);
  const Authority = require("../js/marketCalendarHistory/calendarPartialSourceExecutionAuthority.js"),
    Executor = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js"),
    authority = Authority.createCalendarPartialExecutionAuthority(), executor =
      Executor.createCalendarPartialSourceAtomicExecutor({ targetEnvironment: "isolated_test",
        indexedDB: h.indexedDB, executionAuthority: authority }), restarted = { executor,
      coordinator: Coordinator.createCalendarPartialBootstrapCoordinator({
        readFormal: reader(h.indexedDB), executionAuthority: authority, executor }) };
  const rest = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  rest[1] = await Acquisition.validSource(Contract.EXPECTED_SOURCE_IDS[1]);
  const result = await run(restarted, rest);
  assert.equal(result.writerExecution, 1);
  assert.equal(result.coverage.formalPersistedSourceCount, 2);
  assert.equal((await F.read(h.indexedDB)).runs.filter(value =>
    value.sourceId === Contract.EXPECTED_SOURCE_IDS[0]).length, 1);
});

test("B4 legacy exact13 bootstrap runs only when partial coordinator explicitly yields ownership", async () => {
  const sources = await Acquisition.allSuccess(), normal = { check: async () => ({ state: "success",
    checkedAt: Acquisition.ACCEPTED_AT }), restore: () => null,
    diagnostics: () => ({ comparison: { sourceResults: sources,
      generationIdentity: Acquisition.GENERATION } }) }, calls = { legacy: 0 }, legacy = {
      bootstrap: async () => { calls.legacy++; return { status: "committed", reason: null }; },
      diagnostics: () => null }, partial = { processGeneration: async () => ({ status: "committed",
        reason: null, writerExecution: 1, committedSourceIds: [sources[0].sourceId],
        legacyBootstrapEligible: false }), diagnostics: () => null };
  const composed = Bootstrap.wrapNormalRuntime(normal, legacy, partial), result = await composed.check();
  assert.equal(calls.legacy, 0);
  assert.equal(result.formalPersistence.writerExecution, 1);
});

test("B4 wiring exposes no renderer writer IPC and keeps consumer/export files unchanged", () => {
  const root = path.join(__dirname, ".."), main = fs.readFileSync(path.join(root, "main.js"), "utf8"),
    preload = fs.readFileSync(path.join(root, "preload.js"), "utf8"), html =
      fs.readFileSync(path.join(root, "index.html"), "utf8"), exportFile =
      fs.readFileSync(path.join(root, "js/fullExportCollector.js"), "utf8");
  assert.match(main, /calendarPartialBootstrapProductionRuntime/);
  for (const value of [preload, html, exportFile])
    assert.doesNotMatch(value, /partial-bootstrap|partialBootstrap|source-mutation|execute.*plan/i);
  assert.equal(Schema.VERSION, 1);
});

test("B4 normal acquisition projection retains the accepted B1 eligibility facts", async () => {
  const source = await Acquisition.validSource(BLS), projected = Projection.projectAcquisition({
    sourceId: source.sourceId, routeIdentity: source.routeIdentity,
    generationIdentity: source.generationIdentity,
    acquisitionOutcome: source.acquisitionOutcome, failedRoles: source.failedRoles,
    documentHealth: source.documentHealth, candidateEnvelope: {
      candidateStatus: source.candidateStatus, formalEligible: source.formalEligible,
      candidateIdentity: source.candidateIdentity, canonicalRecords: source.canonicalRecords,
      parserStatus: source.parserStatus, structureGuardStatus: source.structureGuardStatus,
      canonicalizationStatus: source.canonicalizationStatus,
      parserDiagnostics: source.parserDiagnostics,
      canonicalDiagnostics: source.canonicalDiagnostics } }), checked =
    await Contract.evaluateSourceEligibility({ sourceResult: projected,
      acceptedAt: Acquisition.ACCEPTED_AT, generationIdentity: Acquisition.GENERATION });
  assert.equal(checked.eligible, true, checked.reason);
});

test("B4 fixed hidden-renderer operation matches the B3 durable receipt contract", async () => {
  const h = F.harness(), plan = await F.prepareFirst(Contract.EXPECTED_SOURCE_IDS[0]), raw =
    await Atomic.executeAuthorizedMutationInRenderer(plan,
      "create_schema_and_commit_first_source", WriterCore, {
        DATABASE_NAME: Schema.DATABASE_NAME, VERSION: Schema.VERSION,
        EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT, STORES: Schema.STORES },
      BootstrapSchema.STORE_ORDER, Canonicalizer.stable, h.indexedDB), result =
    await Atomic.finalizeAuthorizedRendererExecution(plan,
      "create_schema_and_commit_first_source", raw);
  assert.equal(result.status, "committed");
  assert.equal(result.durableReceipt.verified, true);
  assert.deepEqual(raw.metrics, { catalogReads: 2, readonlyTransactions: 1,
    readwriteTransactions: 1, committedTransactions: 1, abortedTransactions: 0,
    openHandles: 0 });
});
