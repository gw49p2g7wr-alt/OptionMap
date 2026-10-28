"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const Export = require("../js/calendarExportV1.js");
const Coverage = require("../js/marketCalendarHistory/calendarPartialCoverage.js");
const Reader = require("../js/marketCalendarHistory/readOnlyCalendarConsumer.js");
const Runtime = require("../js/calendarExportRuntime.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Fixture = require("./fixtures/marketCalendar/partialSourcePreparationFixture.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Importance = require("../js/marketCalendar/importancePolicy.js");
const Labels = require("../js/marketCalendar/calendarSourceLabels.js");

const BLS = "us-bls-calendar", MOF = "jp-mof-jgb-auction-calendar",
  GENERATED = "2026-10-28T00:00:00.000Z", APP = "1.1.0-beta.15";
const failed = sourceId => ({ sourceId, lastOutcome: "failure", reason: "transport_failed",
  lastAttemptAt: "2026-10-28T00:00:00.000Z", lastSuccessAt: null });
function archive(snapshot, runtimeStates = []) {
  return { status: "available", reason: null, snapshot,
    coverage: Coverage.projectPartialCoverage({ formalSnapshot: snapshot, runtimeStates,
      schemaVersion: Schema.VERSION }) };
}
const create = (archiveResult, runtimeStates = []) => Export.create({ appVersion: APP,
  generatedAt: GENERATED, archiveResult, runtimeStates });

function loadBrowser(context, relative) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"), context,
    { filename: relative });
}
async function browserRuntime({ indexedDB = new IDBFactory(), sourceIds = ["jp-boj-calendar", BLS] } = {}) {
  const snapshot = await Fixture.snapshotWithSources(sourceIds), context = vm.createContext({
    console, document: {}, indexedDB, structuredClone, setTimeout, clearTimeout, URL, Intl, Date,
    OptionMapMarketCalendarPartialCoverage: Coverage,
    OptionMapMarketEventImportancePolicy: Importance,
    OptionMapMarketCalendarSourceLabels: Labels
  });
  context.window = context; context.globalThis = context;
  context.OptionMapMarketCalendarReadOnlyConsumer = { readArchive: async ({ runtimeStates }) =>
    archive(snapshot, runtimeStates) };
  loadBrowser(context, "js/calendarExportV1.js");
  loadBrowser(context, "js/calendarExportRuntime.js");
  const eagerlyCapturedStore = context.OptionMapCalendarRuntimeStateStore;
  loadBrowser(context, "js/marketCalendar/sourceRegistry.js");
  loadBrowser(context, "js/marketCalendarRuntime/sourceUpdateState.js");
  loadBrowser(context, "js/storage/marketCalendarRuntimeStateStore.js");
  return { context, indexedDB, snapshot, eagerlyCapturedStore };
}
const runtimeState = (sourceId, at, changes = {}) => ({ sourceId, lastAttemptAt: at,
  lastSuccessAt: at, lastOutcome: "success", retryAfter: null, lastHttpStatus: 200,
  lastDiagnosticClass: null, coordinatorVersion: 1, ...changes });

test("E1 13/13 full export has exact schema, populated events and deterministic order", async () => {
  const snapshot = await Fixture.snapshotWithSources(Coverage.EXPECTED_SOURCE_IDS), first = create(archive(snapshot)),
    second = create(archive(structuredClone(snapshot)));
  assert.equal(first.coverage.completeness, "full");
  assert.equal(first.coverage.persistedSourceCount, 13);
  assert.equal(first.calendarSourceStatus.length, 13);
  assert.ok(first.events.length >= 13);
  assert.deepEqual(Object.keys(first).sort(), [...Export.TOP_LEVEL_KEYS].sort());
  assert.equal(Export.validate(first).valid, true);
  assert.equal(Export.serialize(first), Export.serialize(second));
  assert.deepEqual(first.events.map(value => value.identity.eventKey),
    [...first.events].map(value => value.identity.eventKey));
});

test("E2 12/13 BLS absent and latest failed remains a valid partial export", async () => {
  const ids = Coverage.EXPECTED_SOURCE_IDS.filter(value => value !== BLS), runtime = [failed(BLS)],
    value = create(archive(await Fixture.snapshotWithSources(ids), runtime), runtime),
    bls = value.calendarSourceStatus.find(row => row.sourceId === BLS);
  assert.equal(value.coverage.completeness, "partial");
  assert.equal(value.coverage.persistedSourceCount, 12);
  assert.equal(bls.formalAvailability, "absent");
  assert.equal(bls.latestAcquisition, "failed");
  assert.equal(value.events.some(event => event.identity.sourceId === BLS), false);
  assert.ok(value.events.length >= 12);
});

test("E3 BLS Formal history remains present when latest acquisition failed", async () => {
  const runtime = [failed(BLS)], value = create(archive(
    await Fixture.snapshotWithSources(Coverage.EXPECTED_SOURCE_IDS), runtime), runtime),
    bls = value.calendarSourceStatus.find(row => row.sourceId === BLS);
  assert.equal(bls.formalAvailability, "available");
  assert.equal(bls.latestAcquisition, "failed");
  assert.ok(value.events.some(event => event.identity.sourceId === BLS));
});

test("E4 1/13 Formal coverage exports only its persisted source", async () => {
  const value = create(archive(await Fixture.snapshotWithSources([MOF])));
  assert.equal(value.coverage.persistedSourceCount, 1);
  assert.equal(value.coverage.completeness, "partial");
  assert.ok(value.events.length > 0);
  assert.equal(value.events.every(event => event.identity.sourceId === MOF), true);
});

test("E5 absent DB produces valid empty artifact without fake Formal rows", () => {
  const runtime = [failed(BLS)], value = create({ status: "absent", reason: "database_absent",
    snapshot: null, coverage: null }, runtime);
  assert.equal(value.coverage.formalAvailability, "absent");
  assert.deepEqual(value.events, []);
  assert.equal(value.calendarSourceStatus.every(row => row.formalAvailability === "absent"), true);
  assert.equal(value.calendarSourceStatus.find(row => row.sourceId === BLS).latestAcquisition, "failed");
  assert.equal(Export.validate(value).valid, true);
});

test("E6 invalid DB fails closed with no Runtime promotion", () => {
  const runtime = [{ sourceId: BLS, lastOutcome: "success", lastAttemptAt: GENERATED }],
    value = create({ status: "invalid", reason: "formal_integrity_invalid", snapshot: null,
      coverage: null }, runtime);
  assert.equal(value.coverage.formalAvailability, "invalid");
  assert.deepEqual(value.events, []);
  assert.equal(value.calendarSourceStatus.every(row => row.formalAvailability === "invalid"), true);
  const bls = value.calendarSourceStatus.find(row => row.sourceId === BLS);
  assert.equal(bls.latestAcquisition, "success");
  assert.equal(bls.formalAuthority, "formal_history");
  assert.equal(bls.runtimeAuthority, "runtime_state");
});

test("E7 two semantic revisions remain immutable and the active one is explicit", async () => {
  const sourceId = "jp-esri-machinery-orders-calendar", before = await Fixture.snapshotWithSources([sourceId]),
    plan = await Preparation.prepareCalendarFormalSourceMutation(await Fixture.input(sourceId, before,
      await Fixture.changedAcquisition(sourceId))), after = await Fixture.applyPrepared(before, plan),
    value = create(archive(after)), event = value.events[0];
  assert.equal(event.revisions.length, 2);
  assert.equal(event.revisions.filter(item => item.revision.active).length, 1);
  assert.equal(event.revisions[0].revision.validTo, event.revisions[1].revision.validFrom);
  assert.notEqual(event.revisions[0].revision.revisionKey, event.revisions[1].revision.revisionKey);
});

test("E8 evidence-only refresh adds provenance without a fake semantic revision", async () => {
  const snapshot = await Fixture.snapshotWithSources([BLS]), original = snapshot.evidence[0], copy =
    structuredClone(original);
  copy.acceptedAt = "2026-10-02T00:00:00.000Z";
  copy.evidenceLinkKey = `${original.evidenceLinkKey}|refresh`;
  snapshot.evidence.push(copy);
  const value = create(archive(snapshot));
  assert.equal(value.events[0].revisions.length, 1);
  assert.equal(value.events[0].revisions[0].provenance.evidence.length, 2);
});

test("E9 multi-document BLS provenance stays distinct", async () => {
  const snapshot = await Fixture.snapshotWithSources([BLS]), original = snapshot.evidence[0], copy =
    structuredClone(original);
  copy.evidenceLinkKey = `${copy.evidenceLinkKey}|ppi`;
  copy.acquisitionEvidence = { ...copy.acquisitionEvidence,
    sourceUrl: "https://www.bls.gov/schedule/news_release/ppi.htm", documentRole: "ppi" };
  copy.acquisitionEvidenceHash = await Canonicalizer.sha256(copy.acquisitionEvidence);
  copy.acquisitionEvidenceKey = `${BLS}|sha256:${copy.acquisitionEvidenceHash}`;
  copy.evidenceLinkKey = `${copy.revisionKey}|${copy.acquisitionEvidenceKey}`;
  snapshot.evidence.push(copy);
  const evidence = create(archive(snapshot)).events[0].revisions[0].provenance.evidence;
  assert.equal(evidence.length, 2);
  assert.equal(new Set(evidence.map(item => item.sourceUrl)).size, 2);
  assert.equal(evidence.some(item => item.documentRole === "ppi"), true);
});

test("E10 MOF index/month-page provenance stays distinct", async () => {
  const snapshot = await Fixture.snapshotWithSources([MOF]), original = snapshot.evidence[0], index =
    structuredClone(original);
  index.evidenceLinkKey = `${index.evidenceLinkKey}|index`;
  index.acquisitionEvidence = { ...index.acquisitionEvidence,
    sourceUrl: "https://www.mof.go.jp/jgbs/auction/calendar/index.htm", documentRole: "index" };
  index.acquisitionEvidenceHash = await Canonicalizer.sha256(index.acquisitionEvidence);
  index.acquisitionEvidenceKey = `${MOF}|sha256:${index.acquisitionEvidenceHash}`;
  index.evidenceLinkKey = `${index.revisionKey}|${index.acquisitionEvidenceKey}`;
  snapshot.evidence.push(index);
  const evidence = create(archive(snapshot)).events[0].revisions[0].provenance.evidence;
  assert.equal(evidence.length, 2);
  assert.equal(evidence.some(item => item.documentRole === "index"), true);
  assert.equal(evidence.some(item => item.sourceUrl.endsWith("2610.htm")), true);
});

test("schema keeps official and derived facts separate and economic values explicit", async () => {
  const event = create(archive(await Fixture.snapshotWithSources([BLS]))).events[0];
  assert.equal(event.officialFacts.economicValues.status, "unavailable");
  assert.equal(event.officialFacts.economicValues.reason, "not_acquired");
  assert.equal("importance" in event.officialFacts, false);
  assert.equal(event.optionMapDerived.importance.policyVersion, 1);
  assert.equal(event.readiness.status, "formal_reference_limited");
});

test("v1 is explicitly current-only and rejects ad-hoc or historical selection", async () => {
  const snapshot = await Fixture.snapshotWithSources([BLS]);
  assert.throws(() => Export.create({ appVersion: APP, generatedAt: GENERATED,
    selection: { mode: "as_known_at", asKnownAt: GENERATED }, archiveResult: archive(snapshot) }),
  /calendar_export_input_invalid/);
  const value = create(archive(snapshot)), extra = { ...value, arbitrary: true };
  assert.equal(Export.validate(extra).valid, false);
});

async function writeSnapshot(indexedDB, snapshot) {
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
    opening.onupgradeneeded = () => Schema.createInUpgrade(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction(Object.keys(Schema.STORES), "readwrite"), map = {
        runs: "marketCalendarSourceRuns", entries: "marketCalendarEventEntries",
        revisions: "marketCalendarSemanticRevisions", evidence: "marketCalendarAcquisitionEvidence",
        observations: "marketCalendarEventObservations", cursors: "marketCalendarSourceCursors" };
      for (const [field, store] of Object.entries(map)) for (const item of snapshot[field])
        tx.objectStore(store).put(item);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

test("Formal archive reader reads six stores once and never creates an absent DB", async () => {
  const indexedDB = new IDBFactory(), absent = await Reader.readArchive({ indexedDB });
  assert.equal(absent.status, "absent");
  assert.equal((await indexedDB.databases()).length, 0);
  const snapshot = await Fixture.snapshotWithSources([BLS]);
  await writeSnapshot(indexedDB, snapshot);
  const result = await Reader.readArchive({ indexedDB, runtimeStates: [failed(BLS)] });
  assert.equal(result.status, "available");
  assert.equal(result.snapshot.entries.length, 1);
  assert.equal(result.coverage.sources.find(row => row.sourceId === BLS).runtimeState,
    "runtime_failed");
});

test("Formal archive reader returns invalid and no snapshot on integrity failure", async () => {
  const indexedDB = new IDBFactory(), snapshot = await Fixture.snapshotWithSources([BLS]);
  snapshot.revisions[0].canonicalContentHash = "0".repeat(64);
  await writeSnapshot(indexedDB, snapshot);
  const result = await Reader.readArchive({ indexedDB });
  assert.equal(result.status, "invalid");
  assert.equal(result.snapshot, null);
  assert.ok(result.errors.includes("canonical_hash_mismatch"));
});

test("export runtime performs read-only projection and creates no Runtime State DB", async () => {
  const indexedDB = new IDBFactory(), snapshot = await Fixture.snapshotWithSources([BLS]);
  await writeSnapshot(indexedDB, snapshot);
  const before = await indexedDB.databases(), value = await Runtime.create({ indexedDB }).exportCurrent({
    appVersion: APP, generatedAt: GENERATED }), after = await indexedDB.databases();
  assert.equal(value.events.length, 1);
  assert.deepEqual(after, before);
  assert.equal(after.some(item => item.name === "optionMapMarketCalendarRuntimeState"), false);
  assert.equal(value.calendarSourceStatus.every(row => row.runtimeAvailability === "absent"), true);
});

test("C2 browser load order late-resolves the existing Runtime Store and exports BOJ/BLS state", async () => {
  const fixture = await browserRuntime(), Store = fixture.context.OptionMapCalendarRuntimeStateStore,
    originalCreate = Store.createRuntimeStateStore, seed = originalCreate({ indexedDB: fixture.indexedDB,
      targetEnvironment: "browser_runtime" }), bojAt = "2026-10-27T20:42:37.859Z",
    blsSuccess = "2026-10-20T20:27:04.238Z", blsAttempt = "2026-10-27T11:06:01.003Z";
  assert.equal(fixture.eagerlyCapturedStore, undefined);
  assert.equal((await seed.write("jp-boj-calendar", runtimeState("jp-boj-calendar", bojAt))).status, "ok");
  assert.equal((await seed.write(BLS, runtimeState(BLS, blsSuccess))).status, "ok");
  assert.equal((await seed.write(BLS, runtimeState(BLS, blsAttempt, { lastSuccessAt: blsSuccess,
    lastOutcome: "failure", retryAfter: null, lastHttpStatus: 403,
    lastDiagnosticClass: "parser_structure_change" }))).status, "ok");
  let reads = 0;
  fixture.context.OptionMapCalendarRuntimeStateStore = Object.freeze({ ...Store,
    createRuntimeStateStore: options => { const store = originalCreate(options); return Object.freeze({
      ...store, readAll: async () => { reads++; return store.readAll(); } }); } });
  const value = await fixture.context.OptionMapCalendarExportRuntime.create({ indexedDB: fixture.indexedDB })
    .exportCurrent({ appVersion: APP, generatedAt: GENERATED }), boj = value.calendarSourceStatus
      .find(row => row.sourceId === "jp-boj-calendar"), bls = value.calendarSourceStatus
      .find(row => row.sourceId === BLS);
  assert.equal(reads, 1);
  assert.deepEqual([boj.formalAvailability, boj.runtimeAvailability, boj.latestAcquisition,
    boj.lastAttemptAt, boj.lastSuccessAt], ["available", "available", "success", bojAt, bojAt]);
  assert.deepEqual([bls.formalAvailability, bls.runtimeAvailability, bls.latestAcquisition,
    bls.lastAttemptAt, bls.lastSuccessAt, bls.reason], ["available", "available", "failed",
    blsAttempt, blsSuccess, "parser_structure_change"]);
  assert.equal(value.events.some(event => event.identity.sourceId === BLS), true);
});

test("C2 browser runtime keeps absent Runtime DB as legitimate unknown without creating it", async () => {
  const fixture = await browserRuntime({ sourceIds: [BLS] }), before = await fixture.indexedDB.databases(),
    value = await fixture.context.OptionMapCalendarExportRuntime.create({ indexedDB: fixture.indexedDB })
      .exportCurrent({ appVersion: APP, generatedAt: GENERATED }), after = await fixture.indexedDB.databases(),
    bls = value.calendarSourceStatus.find(row => row.sourceId === BLS);
  assert.deepEqual(after, before);
  assert.equal(after.some(row => row.name === "optionMapMarketCalendarRuntimeState"), false);
  assert.deepEqual([bls.formalAvailability, bls.runtimeAvailability, bls.latestAcquisition,
    bls.lastAttemptAt, bls.lastSuccessAt], ["available", "absent", "unknown", null, null]);
  assert.equal(value.events.some(event => event.identity.sourceId === BLS), true);
});

test("C2 invalid Runtime schema is explicit and never downgrades Formal BLS history", async () => {
  const factory = new IDBFactory();
  await new Promise((resolve, reject) => { const request = factory.open(
    "optionMapMarketCalendarRuntimeState", 2);
    request.onupgradeneeded = () => request.result.createObjectStore("unexpected", { keyPath: "id" });
    request.onerror = () => reject(request.error); request.onsuccess = () => {
      request.result.close(); resolve(); };
  });
  const fixture = await browserRuntime({ indexedDB: factory, sourceIds: [BLS] }), value =
    await fixture.context.OptionMapCalendarExportRuntime.create({ indexedDB: factory }).exportCurrent({
      appVersion: APP, generatedAt: GENERATED }), bls = value.calendarSourceStatus
      .find(row => row.sourceId === BLS), catalog = await factory.databases();
  assert.deepEqual(catalog.find(row => row.name === "optionMapMarketCalendarRuntimeState"),
    { name: "optionMapMarketCalendarRuntimeState", version: 2 });
  assert.deepEqual([bls.formalAvailability, bls.runtimeAvailability, bls.latestAcquisition,
    bls.reason], ["available", "invalid", "invalid", "schema_mismatch"]);
  assert.equal(value.events.some(event => event.identity.sourceId === BLS), true);
});

test("C2 Runtime read failure is unavailable rather than a silent legitimate unknown", async () => {
  const broken = { databases: async () => { throw new Error("private detail"); }, open() {} },
    fixture = await browserRuntime({ indexedDB: broken, sourceIds: [BLS] }), value =
      await fixture.context.OptionMapCalendarExportRuntime.create({ indexedDB: broken }).exportCurrent({
        appVersion: APP, generatedAt: GENERATED }), bls = value.calendarSourceStatus
        .find(row => row.sourceId === BLS);
  assert.deepEqual([bls.formalAvailability, bls.runtimeAvailability, bls.latestAcquisition,
    bls.reason], ["available", "unavailable", "unavailable", "runtime_state_access_failed"]);
  assert.equal(value.events.some(event => event.identity.sourceId === BLS), true);
});
