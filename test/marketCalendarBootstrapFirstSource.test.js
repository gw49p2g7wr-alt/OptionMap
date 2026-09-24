"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const PlanCanonicalizer = require("../js/marketCalendarHistory/planCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Writer = require("../js/marketCalendarHistory/bootstrapFirstSourceWriter.js");

const SOURCE = "jp-jpx-market-holidays", AT = "2026-09-24T00:00:00.000Z";
const catalog = indexedDB => indexedDB.databases();
async function fixture() {
  const source = Registry.getSource(SOURCE), logical = { eventKey:
    "JP|JPX|JPX_MARKET_HOLIDAY|2026-09-23|regular|JPX_cash_markets",
  jurisdiction: "JP", authority: "JPX", eventType: "JPX_MARKET_HOLIDAY",
  referencePeriod: "2026-09-23", edition: "regular", scope: "JPX_cash_markets",
  authorityEventId: "JPX market holiday|2026-09-23" }, semantic = { schemaVersion: 1,
    logical, schedule: { kind: "all_day", canonicalStart: null, canonicalEnd: null,
      sourceLocal: { startDate: "2026-09-23", startTime: null, endDate: null,
        endTime: null, timeZone: "Asia/Tokyo", resolvedOffset: null }, precision: "all_day" },
    lifecycleStatus: "scheduled", title: { ja: "秋分の日", en: "Autumnal Equinox Day" },
    change: { reason: null, supersedesRevisionKey: null } }, acquisitionEvidence = {
      sourceId: SOURCE, authority: "JPX", sourceUrl: source.canonicalUrl,
      sourcePublishedAt: null, sourceUpdatedAt: null, fetchedAt: AT,
      rawContentHash: "a".repeat(64), parserId: source.parserId,
      parserVersion: source.parserVersion, requestId: null, runId: "bootstrap-run-1",
      httpMetadata: { httpStatus: 200 } }, canonicalContentHash =
    await Canonicalizer.sha256(semantic), acquisitionEvidenceHash =
    await Canonicalizer.sha256(acquisitionEvidence), record = { ...semantic,
      source: acquisitionEvidence, acquisitionEvidence, eventKey: logical.eventKey,
      revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`,
      canonicalContentHash, acquisitionEvidenceHash,
      acquisitionEvidenceKey: `${SOURCE}|sha256:${acquisitionEvidenceHash}` },
    semanticSetHash = await Canonicalizer.sha256([record.revisionKey]), sourceIdentity = {
      sourceId: SOURCE, parserId: source.parserId, parserVersion: source.parserVersion,
      candidateSchemaVersion: 1, semanticSetHash }, candidateIdentity =
    await Canonicalizer.sha256({ sourceId: SOURCE, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1,
      revisionKeys: [record.revisionKey] }), candidate = { sourceId: SOURCE,
      candidateStatus: "available", formalEligible: true, candidateIdentity, recordCount: 1,
      canonicalRecords: [record], parserStatus: "success", canonicalizationStatus: "success",
      parserDiagnostics: [], canonicalDiagnostics: [], encodingEvidence: [], sourceIdentity },
    simulation = await Simulator.simulateCalendarTransition({ sourceId: SOURCE, candidate,
      previousState: null, coveragePolicy: null }), run = { sourceId: SOURCE,
      runId: "bootstrap-run-1", acceptedAt: AT, fetchedAt: [AT], status: "accepted",
      semanticSetHash }, planned = Planner.planTransition({ snapshot: Planner.emptySnapshot(), run,
      canonicalSet: [record], coverage: { confirmed: true, eventKeys: [record.eventKey] } }),
    planHash = await PlanCanonicalizer.planHash(planned.plan), precondition = {
      schemaVersion: 1, sourceId: SOURCE, candidateIdentity,
      simulationIdentity: simulation.simulationIdentity, planHash };
  assert.equal(simulation.simulationStatus, "new"); assert.equal(planned.ok, true);
  return { sourceId: SOURCE, candidate, simulation, plan: planned.plan,
    expectedSchemaVersion: 1, precondition };
}
const instance = indexedDB => Writer.createBootstrapFirstSourceWriter({ indexedDB,
  targetEnvironment: "isolated_test" });
async function seed(indexedDB, version = 1, valid = true) {
  await new Promise((resolve, reject) => { const opening = indexedDB.open(Schema.DATABASE_NAME, version);
    opening.onupgradeneeded = () => valid ? Schema.createInUpgrade(opening.result) :
      opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error); });
}

test("DB absent + accepted first sourceはschema v1と6 entityをatomic commit", async () => {
  const indexedDB = new IDBFactory(), writer = instance(indexedDB), result =
    await writer.bootstrap(await fixture());
  assert.deepEqual({ status: result.status, dbCreated: result.dbCreated,
    committed: result.committed, transactionOutcome: result.transactionOutcome,
    readBackStatus: result.readBackStatus }, { status: "committed", dbCreated: true,
    committed: true, transactionOutcome: "committed", readBackStatus: "passed" },
  JSON.stringify(result));
  assert.deepEqual(writer.diagnostics(), { databaseCreateAttempts: 1,
    successfulDatabaseCreates: 1, abortedCreateAttempts: 0, successfulSourceCommits: 1,
    rolledBackTransactions: 0, readBackTransactions: 1, openHandles: 0 });
  assert.deepEqual((await catalog(indexedDB)).map(value => [value.name, value.version]),
    [[Schema.DATABASE_NAME, 1]]);
});

test("candidate/transition/source/schema gate不成立はDB create 0", async () => {
  const base = await fixture(), cases = [null,
    { ...base, candidate: { ...base.candidate, candidateStatus: "rejected", formalEligible: false } },
    { ...base, candidate: { ...base.candidate, recordCount: 0, canonicalRecords: [] } },
    { ...base, simulation: { ...base.simulation, simulationStatus: "rejected" } },
    { ...base, sourceId: "unknown" }, { ...base, expectedSchemaVersion: 2 }];
  for (const value of cases) {
    const indexedDB = new IDBFactory(), writer = instance(indexedDB), result =
      await writer.bootstrap(value || {});
    assert.equal(result.status, "bootstrap_not_started");
    assert.equal(result.dbCreated, false); assert.equal(result.committed, false);
    assert.deepEqual(await catalog(indexedDB), []);
    assert.equal(writer.diagnostics().databaseCreateAttempts, 0);
  }
});

test("schemaからSourceCursorまでのfailureはupgrade全体rollbackしcatalog absent", async () => {
  for (const point of BootstrapSchema.FAILURE_POINTS) {
    const indexedDB = new IDBFactory(), writer = instance(indexedDB), input = await fixture(),
      result = await writer.bootstrap({ ...input, injectFailureAfter: point });
    assert.equal(result.status, "rolled_back", point);
    assert.equal(result.dbCreated, false, point); assert.equal(result.committed, false, point);
    assert.equal(result.transactionOutcome, "aborted", point);
    assert.deepEqual(await catalog(indexedDB), [], point);
    assert.deepEqual(writer.diagnostics(), { databaseCreateAttempts: 1,
      successfulDatabaseCreates: 0, abortedCreateAttempts: 1, successfulSourceCommits: 0,
      rolledBackTransactions: 1, readBackTransactions: 0, openHandles: 0 });
  }
});

test("既存schema v1 DBではbootstrap・update・upgradeを行わない", async () => {
  const indexedDB = new IDBFactory(); await seed(indexedDB);
  const writer = instance(indexedDB), result = await writer.bootstrap(await fixture());
  assert.equal(result.reason, "db_already_exists"); assert.equal(result.dbCreated, false);
  assert.equal(result.committed, false); assert.equal(writer.diagnostics().databaseCreateAttempts, 0);
  assert.deepEqual((await catalog(indexedDB)).map(value => value.version), [1]);
});

test("既存unexpected version/schemaはmigration・repairせずfail-closed", async () => {
  const indexedDB = new IDBFactory(); await seed(indexedDB, 2, false);
  const writer = instance(indexedDB), result = await writer.bootstrap(await fixture());
  assert.equal(result.reason, "schema_mismatch_existing");
  assert.equal(result.dbCreated, false); assert.equal(result.committed, false);
  assert.equal(writer.diagnostics().databaseCreateAttempts, 0);
  assert.deepEqual((await catalog(indexedDB)).map(value => value.version), [2]);
});

test("同じisolated DBへの2回目bootstrapはexisting updateへ切替えない", async () => {
  const indexedDB = new IDBFactory(), writer = instance(indexedDB), input = await fixture();
  assert.equal((await writer.bootstrap(input)).status, "committed");
  const second = await writer.bootstrap(input);
  assert.equal(second.reason, "db_already_exists"); assert.equal(second.committed, false);
  assert.equal(writer.diagnostics().successfulSourceCommits, 1);
});

test("writer APIは固定DB/schema/storesかつisolated test専用", () => {
  assert.throws(() => Writer.createBootstrapFirstSourceWriter({ indexedDB: new IDBFactory() }),
    /isolated_test_configuration_required/);
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarHistory/bootstrapFirstSourceWriter.js"), "utf8");
  assert.doesNotMatch(source, /configuration\.databaseName|input\.databaseName|localStorage|fetch\(/);
  assert.doesNotMatch(source, /QRI|Weekly|Participant|MarketObservation|PriceSnapshot|Morning/);
  assert.equal(BootstrapSchema.DATABASE_NAME, Schema.DATABASE_NAME);
  assert.equal(BootstrapSchema.VERSION, Schema.VERSION);
  assert.deepEqual(BootstrapSchema.STORES, Schema.STORES);
});
