"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const crypto = require("node:crypto");
const Acquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Canonical = require("../js/economicValues/economicValueCanonical.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const Schema = require("../js/economicValues/economicValueSchemaV1.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Fixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");

const headers = values => ({ get: name => values[String(name).toLowerCase()] ?? null });
function fetchFor(html, { redirect = null, mime = "text/html; charset=utf-8", status = 200 } = {}) {
  return async () => redirect ? { status: 302, ok: false, headers: headers({ location: redirect }) } :
    new Response(html, { status, headers: { "content-type": mime } });
}
async function acquisition(options = {}) {
  const releaseDate = options.releaseDate || "2026-10-14", html = options.html || Fixture.html({ releaseDate });
  return Acquisition.createBlsCpiAcquisition({ fetchImpl: fetchFor(html, options),
    now: () => new Date(options.fetchedAt || `${releaseDate}T13:31:00.000Z`) }).acquire({ releaseDate });
}
async function candidate(options = {}) {
  const acquired = options.acquisition || await acquisition(options);
  return Cpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: options.acceptedAt || `${acquired.releaseDate}T13:32:00.000Z`,
    calendarEventKey: options.calendarEventKey ?? null });
}
async function commit(runtime, value) {
  const ticket = await runtime.registerAcceptedRelease(value);
  return runtime.commitAcceptedRelease(ticket);
}
const key = suffix => Cpi.SERIES.find(value => value.seriesDefinitionKey.includes(suffix)).seriesDefinitionKey;
function withPriorRevision(candidateValue, { seriesDefinitionKey = Cpi.SERIES[0].seriesDefinitionKey,
  referencePeriod = "2026-09", decimalValue = "0.5" } = {}) {
  const value = structuredClone(candidateValue), definition = value.definitions.find(item =>
    item.seriesDefinitionKey === seriesDefinitionKey), valueKey = `${seriesDefinitionKey}|${referencePeriod}`,
    fact = { valueKey, seriesDefinitionKey, referencePeriod, decimalValue,
      unit: definition.unit, seasonalAdjustment: definition.seasonalAdjustment,
      measure: definition.measure, officialStatus: "published" }, factHash = Canonical.sha256(fact);
  value.values.push({ ...fact, factHash, revisionKey: `${valueKey}|sha256:${factHash}`,
    releaseOccurrenceKey: value.release.releaseOccurrenceKey });
  value.candidateHash = Canonical.sha256({ release: value.release,
    values: value.values.map(item => item.revisionKey).sort(),
    sourceDocumentKey: value.document.sourceDocumentKey,
    acquisitionEvidenceHash: value.acquisitionEvidenceHash });
  return Canonical.freeze(value);
}

test("C1 normal official CPI release accepts exactly four decimal-string facts atomically", async () => {
  const indexedDB = new IDBFactory(), value = await candidate(), runtime = Store.createFormalRuntime({ indexedDB });
  const result = await commit(runtime, value), snapshot = (await runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.semanticWrites, result.transactionCount], ["committed", 4, 1]);
  assert.deepEqual(snapshot.revisions.map(item => item.decimalValue).sort(), ["0.3", "0.6", "2.6", "3.7"]);
  assert.equal(snapshot.releases.length, 1); assert.equal(snapshot.links.length, 4);
  assert.equal(snapshot.revisions.every(item => typeof item.decimalValue === "string"), true);
  assert.equal(await Schema.fingerprint(), Schema.EXPECTED_FINGERPRINT);
});

test("C2 exact duplicate performs semantic write0 and transaction0", async () => {
  const indexedDB = new IDBFactory(), value = await candidate(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, value); const second = await commit(runtime, value);
  assert.deepEqual([second.status, second.semanticWrites, second.transactionCount], ["unchanged", 0, 0]);
  assert.equal((await runtime.readSnapshot()).snapshot.runs.length, 1);
});

test("C3 same valueKey receives a new immutable revision and closes the prior interval", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), first = await candidate();
  await commit(runtime, first);
  const acquired = await acquisition({ releaseDate: "2026-11-13", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-13", headlineMom: "0.4", headlineYoy: "3.5",
    coreMom: "0.2", coreYoy: "2.5" }), fetchedAt: "2026-11-13T13:31:00.000Z" }),
    second = withPriorRevision(await candidate({ acquisition: acquired,
      acceptedAt: "2026-11-13T13:32:00.000Z" }));
  await commit(runtime, second);
  const own = (await runtime.readSnapshot()).snapshot.revisions.filter(value =>
    value.valueKey === `${Cpi.SERIES[0].seriesDefinitionKey}|2026-09`).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  assert.equal(own.length, 2); assert.equal(own[0].decimalValue, "0.6"); assert.equal(own[1].decimalValue, "0.5");
  assert.equal(own[0].validTo, own[1].validFrom); assert.equal(own[1].validTo, null);
});

test("C4 one later release atomically links current facts and a prior-period revision", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), first = await candidate();
  await commit(runtime, first);
  const acquired = await acquisition({ releaseDate: "2026-11-13", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-13" }), fetchedAt: "2026-11-13T13:31:00.000Z" }),
    second = withPriorRevision(await candidate({ acquisition: acquired,
      acceptedAt: "2026-11-13T13:32:00.000Z" }));
  await commit(runtime, second);
  const snapshot = (await runtime.readSnapshot()).snapshot, releaseKey = second.release.releaseOccurrenceKey;
  assert.equal(snapshot.links.filter(value => value.releaseOccurrenceKey === releaseKey).length, 5);
  assert.equal(snapshot.links.filter(value => value.releaseOccurrenceKey === releaseKey &&
    value.role === "released_prior_period_revision").length, 1);
});

test("C5 malformed numeric value fails closed", async () => {
  const acquired = await acquisition({ html: Fixture.html({ headlineMom: "not-a-number" }) });
  assert.throws(() => Cpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }), /bls_cpi_numeric_invalid/);
});

test("C6 unit or seasonal-adjustment mismatch fails closed", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }),
    value = structuredClone(await candidate());
  value.values[0].unit = "percentage_point";
  await assert.rejects(runtime.registerAcceptedRelease(value), /economic_candidate_invalid/);
});

test("C7 redirect to a non-BLS route is rejected before body parsing", async () => {
  const result = await Acquisition.createBlsCpiAcquisition({ fetchImpl: fetchFor("", {
    redirect: "https://example.com/news.release/archives/cpi_10142026.htm" }) }).acquire({ releaseDate: "2026-10-14" });
  assert.deepEqual([result.success, result.reason], [false, "redirect_route_security_rejected"]);
  assert.equal(Acquisition.validateUrl("https://www.bls.gov/news.release/archives/cpi_10142026.htm?x=1",
    "2026-10-14"), null);
});

test("C8 unexpected official page structure is rejected", async () => {
  const acquired = await acquisition({ html: Fixture.html({ heading: false }) });
  assert.throws(() => Cpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }), /structure_change/);
});

test("C9 a partial two-of-four release never opens or commits a Formal DB", async () => {
  const indexedDB = new IDBFactory(), acquired = await acquisition({ html: Fixture.html({ includeCore: false }) });
  assert.throws(() => Cpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }), /structure_change/);
  assert.deepEqual(await indexedDB.databases(), []);
});

test("C10 first acquisition/pre-write failure leaves no misleading DB shell", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB, faultAt: "before_open" });
  await assert.rejects(commit(runtime, await candidate()), /injected_before_open/);
  assert.deepEqual(await indexedDB.databases(), []);
});

test("C10 first upgrade transaction abort also leaves no empty Formal DB", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB,
    faultAt: "first_write_abort" });
  await assert.rejects(commit(runtime, await candidate()), /first_write_abort|first_write_failed/);
  assert.deepEqual(await indexedDB.databases(), []);
});

test("C10 existing-store transaction abort preserves the prior atomic snapshot", async () => {
  const indexedDB = new IDBFactory(), firstRuntime = Store.createFormalRuntime({ indexedDB });
  await commit(firstRuntime, await candidate());
  const before = (await firstRuntime.readSnapshot()).snapshot,
    acquired = await acquisition({ releaseDate: "2026-11-13", html: Fixture.html({
      referencePeriod: "2026-10", releaseDate: "2026-11-13" }),
    fetchedAt: "2026-11-13T13:31:00.000Z" }), aborting = Store.createFormalRuntime({ indexedDB,
      faultAt: "transaction_abort" });
  await assert.rejects(commit(aborting, await candidate({ acquisition: acquired,
    acceptedAt: "2026-11-13T13:32:00.000Z" })), /transaction_aborted/);
  assert.deepEqual((await firstRuntime.readSnapshot()).snapshot, before);
});

test("C11/C12 as-known-at returns old before and revised after acceptedAt", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), first = await candidate();
  await commit(runtime, first);
  const acquired = await acquisition({ releaseDate: "2026-11-13", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-13" }), fetchedAt: "2026-11-13T13:31:00.000Z" }),
    later = withPriorRevision(await candidate({ acquisition: acquired,
      acceptedAt: "2026-11-13T13:32:00.000Z" }));
  await commit(runtime, later);
  const valueKey = `${Cpi.SERIES[0].seriesDefinitionKey}|2026-09`, before = await Store.readAsKnownAt(indexedDB,
    "2026-11-13T13:31:59.999Z"), after = await Store.readAsKnownAt(indexedDB, "2026-11-13T13:32:00.000Z");
  assert.equal(before.officialValues.find(value => value.valueKey === valueKey).decimalValue, "0.6");
  assert.equal(after.officialValues.find(value => value.valueKey === valueKey).decimalValue, "0.5");
});

test("C13 Calendar linkage is optional but an exact deterministic link is retained", async () => {
  const absent = await candidate(), linked = await candidate({ fetchedAt: "2026-10-14T13:33:00.000Z",
    acceptedAt: "2026-10-14T13:34:00.000Z",
    calendarEventKey: "US|US_BLS|US_CPI|2026-09|initial|national" });
  assert.equal(absent.release.calendarEventKey, null);
  assert.equal(linked.release.calendarEventKey, "US|US_BLS|US_CPI|2026-09|initial|national");
});

test("C14 bounded export contains official values/provenance and invents no forecast", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate());
  const value = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-10-14T14:00:00.000Z",
    snapshotResult: await runtime.readSnapshot() });
  assert.equal(Export.validate(value).valid, true); assert.equal(value.officialValues.length, 4);
  assert.equal(value.officialValues.every(item => item.provenance.every(evidence =>
    evidence.runId && evidence.releaseOccurrenceKey)), true);
  assert.equal(value.sourceStatus.forecastValues, "unsupported");
  assert.doesNotMatch(Export.serialize(value), /parserInput|rawHtml|consensus|surprise/);
});

test("C14 as-known-at export excludes evidence accepted after the selected instant", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), first = await candidate();
  await commit(runtime, first);
  const acquired = await acquisition({ releaseDate: "2026-11-13", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-13" }), fetchedAt: "2026-11-13T13:31:00.000Z" });
  await commit(runtime, withPriorRevision(await candidate({ acquisition: acquired,
    acceptedAt: "2026-11-13T13:32:00.000Z" })));
  const value = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-11-13T14:00:00.000Z",
    selection: { mode: "as_known_at", asKnownAt: "2026-11-13T13:31:59.999Z" },
    snapshotResult: await runtime.readSnapshot() }), old = value.officialValues.find(item =>
      item.revision.valueKey === `${Cpi.SERIES[0].seriesDefinitionKey}|2026-09`);
  assert.equal(old.revision.decimalValue, "0.6");
  assert.equal(old.provenance.every(evidence => evidence.acceptedAt <= value.selection.asKnownAt), true);
});

test("current reader returns latest CPI occurrence, four official facts and provenance without writes", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate()); const before = (await runtime.readSnapshot()).snapshot.runs.length,
    current = await Store.readCurrentCpi(indexedDB), after = (await runtime.readSnapshot()).snapshot.runs.length;
  assert.deepEqual([current.status, current.readiness, current.officialValues.length,
    current.provenance.length], ["available", "formal_reference", 4, 4]);
  assert.equal(before, after);
});

test("route identity is fixed, body bounded, credentials omitted and raw bytes hash exactly", async () => {
  const html = Fixture.html(), calls = [];
  const result = await Acquisition.createBlsCpiAcquisition({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(html, { headers: { "content-type": "text/html" } });
  }, now: () => new Date("2026-10-14T13:31:00.000Z") }).acquire({ releaseDate: "2026-10-14" });
  assert.equal(result.success, true); assert.equal(calls[0].url,
    "https://www.bls.gov/news.release/archives/cpi_10142026.htm");
  assert.deepEqual([calls[0].options.credentials, calls[0].options.redirect, calls[0].options.cache],
    ["omit", "manual", "no-store"]);
  assert.equal(result.document.rawContentHash, crypto.createHash("sha256").update(html).digest("hex"));
});

test("Calendar schema/export and existing product boundaries remain byte-unchanged", () => {
  const fs = require("node:fs"), path = require("node:path"), root = path.join(__dirname, "..");
  for (const file of ["js/marketCalendarHistory/productionSchemaV1.js", "js/calendarExportV1.js",
    "preload.js", "main.js"]) assert.equal(fs.existsSync(path.join(root, file)), true);
  const sources = ["js/economicValues/economicValueFormalStore.js", "js/economicValues/blsCpiAcquisition.js"]
    .map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /ipcMain|ipcRenderer|contextBridge|optionMapMarketCalendarHistory/);
});
