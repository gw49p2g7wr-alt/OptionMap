"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const PlanCanonicalizer = require("../js/marketCalendarHistory/planCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Coordinator = require("../js/marketCalendarHistory/bootstrapCoordinator.js");

const AT = "2026-09-24T00:00:00.000Z", ACTIVE = Object.keys(Registry.SOURCES);
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});
async function sourceFixture(sourceId, index = ACTIVE.indexOf(sourceId)) {
  const source = Registry.getSource(sourceId), date = `2026-10-${String(index + 1).padStart(2, "0")}`,
    logical = { eventKey: `${source.jurisdiction}|${source.authority}|TEST_EVENT|${date}|regular|${sourceId}`,
      jurisdiction: source.jurisdiction, authority: source.authority, eventType: "TEST_EVENT",
      referencePeriod: date, edition: "regular", scope: sourceId,
      authorityEventId: `${sourceId}|${date}` }, semantic = { schemaVersion: 1, logical,
      schedule: { kind: "all_day", canonicalStart: null, canonicalEnd: null,
        sourceLocal: { startDate: date, startTime: null, endDate: null, endTime: null,
          timeZone: source.sourceTimeZone, resolvedOffset: null }, precision: "all_day" },
      lifecycleStatus: "scheduled", title: { ja: sourceId, en: sourceId },
      change: { reason: null, supersedesRevisionKey: null } }, acquisitionEvidence = {
        sourceId, authority: source.authority, sourceUrl: source.canonicalUrl,
        sourcePublishedAt: null, sourceUpdatedAt: null, fetchedAt: AT,
        rawContentHash: String(index + 1).padStart(64, "a").slice(-64), parserId: source.parserId,
        parserVersion: source.parserVersion, requestId: null, runId: `run-${index}`,
        httpMetadata: { httpStatus: 200 } }, canonicalContentHash =
      await Canonicalizer.sha256(semantic), acquisitionEvidenceHash =
      await Canonicalizer.sha256(acquisitionEvidence), record = { ...semantic,
        source: acquisitionEvidence, acquisitionEvidence, eventKey: logical.eventKey,
        revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`,
        canonicalContentHash, acquisitionEvidenceHash,
        acquisitionEvidenceKey: `${sourceId}|sha256:${acquisitionEvidenceHash}` },
    semanticSetHash = await Canonicalizer.sha256([record.revisionKey]), sourceIdentity = {
      sourceId, parserId: source.parserId, parserVersion: source.parserVersion,
      candidateSchemaVersion: 1, semanticSetHash }, candidateIdentity =
      await Canonicalizer.sha256({ sourceId, parserId: source.parserId,
        parserVersion: source.parserVersion, candidateSchemaVersion: 1,
        revisionKeys: [record.revisionKey] }), candidate = { sourceId,
        candidateStatus: "available", formalEligible: true, candidateIdentity, recordCount: 1,
        canonicalRecords: [record], parserStatus: "success", canonicalizationStatus: "success",
        parserDiagnostics: [], canonicalDiagnostics: [], encodingEvidence: [], sourceIdentity },
    simulation = await Simulator.simulateCalendarTransition({ sourceId, candidate,
      previousState: null, coveragePolicy: null }), run = { sourceId, runId: `run-${index}`,
      acceptedAt: AT, fetchedAt: [AT], status: "accepted", semanticSetHash }, planned =
      Planner.planTransition({ snapshot: Planner.emptySnapshot(), run, canonicalSet: [record],
        coverage: { confirmed: true, eventKeys: [record.eventKey] } }), planHash =
      await PlanCanonicalizer.planHash(planned.plan);
  return { sourceId, candidate, simulation, plan: planned.plan, expectedSchemaVersion: 1,
    precondition: { schemaVersion: 1, sourceId, candidateIdentity,
      simulationIdentity: simulation.simulationIdentity, planHash } };
}
const rejected = async sourceId => { const value = await sourceFixture(sourceId);
  return { ...value, candidate: { ...value.candidate, candidateStatus: "rejected",
    formalEligible: false } }; };
const instance = indexedDB => Coordinator.createBootstrapCoordinator({ indexedDB,
  targetEnvironment: "isolated_test" });
async function readAll(indexedDB) {
  const opening = indexedDB.open(Schema.DATABASE_NAME), database = await request(opening),
    transaction = database.transaction(Object.keys(Schema.STORES), "readonly"), result = {};
  for (const [field, store] of BootstrapSchema.STORE_ORDER)
    result[field] = await request(transaction.objectStore(store).getAll());
  database.close(); return result;
}
async function seed(indexedDB, version = 1, valid = true) {
  await new Promise((resolve, reject) => { const opening = indexedDB.open(Schema.DATABASE_NAME, version);
    opening.onupgradeneeded = () => valid ? Schema.createInUpgrade(opening.result) :
      opening.result.createObjectStore("unexpected", { keyPath: "id" });
    opening.onsuccess = () => { opening.result.close(); resolve(); };
    opening.onerror = () => reject(opening.error); });
}

test("3 source all-successはfirst create後にsource単位commit", async () => {
  const indexedDB = new IDBFactory(), coordinator = instance(indexedDB), sources = await Promise.all(
    ACTIVE.slice(0, 3).map(sourceFixture)), result = await coordinator.bootstrap({ sources });
  assert.equal(result.overallOutcome, "success"); assert.equal(result.dbCreated, true);
  assert.equal(result.firstCommittedSourceId, ACTIVE[0]);
  assert.deepEqual(result.sourceResults.map(value => value.status),
    ["committed", "committed", "committed"]);
  assert.equal(result.summary.committedCount, 3);
  const stored = await readAll(indexedDB);
  assert.equal((await Integrity.audit(stored)).valid, true);
  assert.deepEqual(stored.cursors.map(value => value.sourceId).sort(), ACTIVE.slice(0, 3).sort());
  assert.equal(result.diagnostics.openHandles, 0);
});

test("middle append failureは当該sourceだけrollbackしlater sourceへ継続", async () => {
  const indexedDB = new IDBFactory(), sources = await Promise.all(ACTIVE.slice(0, 3).map(sourceFixture));
  sources[1] = { ...sources[1], injectFailureAfter: "evidence" };
  const result = await instance(indexedDB).bootstrap({ sources }), stored = await readAll(indexedDB);
  assert.equal(result.overallOutcome, "partial");
  assert.deepEqual(result.sourceResults.map(value => value.status), ["committed", "failed", "committed"]);
  assert.deepEqual(stored.cursors.map(value => value.sourceId).sort(), [ACTIVE[0], ACTIVE[2]].sort());
  assert.equal(stored.entries.some(value => value.sourceId === ACTIVE[1]), false);
  assert.equal((await Integrity.audit(stored)).valid, true);
});

test("12 source相当10 success / 2 rejectはpartialで成功sourceを保持", async () => {
  const indexedDB = new IDBFactory(), sources = await Promise.all(ACTIVE.map(sourceFixture));
  sources[3] = await rejected(ACTIVE[3]); sources[8] = await rejected(ACTIVE[8]);
  const result = await instance(indexedDB).bootstrap({ sources }), stored = await readAll(indexedDB);
  assert.equal(result.overallOutcome, "partial");
  assert.deepEqual(result.summary, { requestedCount: 12, acceptedCount: 10,
    committedCount: 10, failedCount: 0, rejectedCount: 2 });
  assert.equal(stored.cursors.length, 10); assert.equal((await Integrity.audit(stored)).valid, true);
});

test("first rejectedとfirst transaction failure後、次accepted sourceで初create", async () => {
  const indexedDB = new IDBFactory(), first = await rejected(ACTIVE[0]), second =
    { ...(await sourceFixture(ACTIVE[1])), injectFailureAfter: "entries" }, third =
    await sourceFixture(ACTIVE[2]), result = await instance(indexedDB).bootstrap({
      sources: [third, first, second] });
  assert.equal(result.firstCommittedSourceId, ACTIVE[2]);
  assert.deepEqual(result.sourceResults.map(value => value.status), ["rejected", "failed", "committed"]);
  assert.equal(result.diagnostics.databaseCreateAttempts, 2);
  assert.equal(result.diagnostics.successfulDatabaseCreates, 1);
});

test("all failureはDB create・Formal write 0でcatalog absent", async () => {
  const indexedDB = new IDBFactory(), sources = await Promise.all(ACTIVE.slice(0, 3).map(rejected)),
    result = await instance(indexedDB).bootstrap({ sources });
  assert.equal(result.overallOutcome, "failed"); assert.equal(result.dbCreated, false);
  assert.equal(result.summary.committedCount, 0); assert.deepEqual(await indexedDB.databases(), []);
  assert.equal(result.diagnostics.databaseCreateAttempts, 0);
  assert.equal(result.diagnostics.openHandles, 0);
});

test("append全failure pointは失敗sourceだけrollback", async () => {
  for (const point of BootstrapSchema.STORE_ORDER.map(([field]) => field)) {
    const indexedDB = new IDBFactory(), first = await sourceFixture(ACTIVE[0]), second =
      { ...(await sourceFixture(ACTIVE[1])), injectFailureAfter: point }, result =
      await instance(indexedDB).bootstrap({ sources: [first, second] }), stored =
      await readAll(indexedDB);
    assert.equal(result.sourceResults[1].status, "failed", point);
    assert.deepEqual(stored.cursors.map(value => value.sourceId), [ACTIVE[0]], point);
    assert.equal((await Integrity.audit(stored)).valid, true, point);
  }
});

test("duplicate sourceは二重commitせず明示reject", async () => {
  const indexedDB = new IDBFactory(), value = await sourceFixture(ACTIVE[0]), result =
    await instance(indexedDB).bootstrap({ sources: [value, structuredClone(value)] });
  assert.equal(result.sourceResults[0].status, "committed");
  assert.equal(result.sourceResults[1].reason, "duplicate_source_id");
  assert.equal((await readAll(indexedDB)).runs.length, 1);
});

test("input順に依存せずFormal registry順でcommit", async () => {
  const indexedDB = new IDBFactory(), values = await Promise.all(ACTIVE.slice(0, 3).map(sourceFixture)),
    result = await instance(indexedDB).bootstrap({ sources: [values[2], values[0], values[1]] });
  assert.deepEqual(result.sourceResults.map(value => value.sourceId), ACTIVE.slice(0, 3));
  assert.equal(result.firstCommittedSourceId, ACTIVE[0]);
});

test("任意existing DBとschema mismatchを一般updateへ使わない", async () => {
  for (const [version, valid, reason] of [[1, true, "db_already_exists"],
    [2, false, "schema_mismatch_existing"]]) {
    const indexedDB = new IDBFactory(); await seed(indexedDB, version, valid);
    const result = await instance(indexedDB).bootstrap({ sources: [await sourceFixture(ACTIVE[0])] });
    assert.equal(result.sourceResults[0].reason, reason);
    assert.equal(result.summary.committedCount, 0); assert.equal(result.dbCreated, false);
    assert.deepEqual((await indexedDB.databases()).map(value => value.version), [version]);
  }
});

test("C2 pathはisolated Calendar DB以外へ接続しない", () => {
  assert.throws(() => Coordinator.createBootstrapCoordinator({ indexedDB: new IDBFactory() }),
    /isolated_test_configuration_required/);
  for (const file of ["bootstrapCoordinator.js", "bootstrapAppendSourceWriter.js"]) {
    const source = fs.readFileSync(path.join(__dirname, `../js/marketCalendarHistory/${file}`), "utf8");
    assert.doesNotMatch(source, /configuration\.databaseName|input\.databaseName|localStorage|fetch\(/);
    assert.doesNotMatch(source, /QRI|Weekly|Participant|MarketObservation|PriceSnapshot|Morning/);
  }
});
