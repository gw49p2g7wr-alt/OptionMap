"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/beaPceAcquisition.js");
const Pce = require("../js/economicValues/beaPceFormal.js");
const CpiAcquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const EmploymentAcquisition = require("../js/economicValues/blsEmploymentAcquisition.js");
const Employment = require("../js/economicValues/blsEmploymentFormal.js");
const JapanAcquisition = require("../js/economicValues/jpCpiAcquisition.js");
const Japan = require("../js/economicValues/jpCpiFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Fixture = require("./fixtures/economicValues/beaPceReleaseFixture.js");
const CpiFixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");
const EmploymentFixture = require("./fixtures/economicValues/blsEmploymentReleaseFixture.js");
const JapanFixture = require("./fixtures/economicValues/jpCpiReleaseFixture.js");

const headers = values => ({ get: name => values[String(name).toLowerCase()] ?? null });
function fetchFor(body, { redirect = null, mime = "text/html; charset=utf-8", status = 200 } = {}) {
  return async () => redirect ? { status: 302, ok: false, headers: headers({ location: redirect }) } :
    new Response(body, { status, headers: { "content-type": mime } });
}
async function acquisition(options = {}) {
  const referencePeriod = options.referencePeriod || "2026-09", releaseDate = options.releaseDate || "2026-10-29",
    body = options.html || Fixture.html({ ...options, referencePeriod, releaseDate });
  return Acquisition.createBeaPceAcquisition({ fetchImpl: fetchFor(body, options),
    now: () => new Date(options.fetchedAt || "2026-10-29T12:31:00.000Z") })
    .acquire({ referencePeriod, releaseDate });
}
async function candidate(options = {}) {
  return Pce.createAcceptedCandidate({ acquisition: options.acquisition || await acquisition(options),
    acceptedAt: options.acceptedAt || "2026-10-29T12:32:00.000Z",
    calendarEventKey: options.calendarEventKey ?? null });
}
async function commit(runtime, value) {
  return runtime.commitAcceptedRelease(await runtime.registerAcceptedRelease(value));
}
const valueKey = (variant, measure, period) => Pce.SERIES.find(value => value.variant === variant &&
  value.measure === measure).seriesDefinitionKey + `|${period}`;

test("P1 release-specific BEA publication persists four current official PCE values atomically", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate(),
    result = await commit(runtime, value), snapshot = (await runtime.readSnapshot()).snapshot,
    current = value.values.filter(item => item.referencePeriod === "2026-09");
  assert.deepEqual([result.status, result.semanticWrites, result.transactionCount], ["committed", 6, 1]);
  assert.deepEqual(current.map(item => item.decimalValue), ["0.5", "3.6", "0.3", "3.1"]);
  assert.equal(snapshot.releases.length, 1); assert.equal(snapshot.revisions.length, 6);
});

test("P2/P3 headline/core and MoM/YoY have distinct deterministic identities", async () => {
  const value = await candidate(), keys = value.definitions.map(item => item.seriesDefinitionKey);
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(value.definitions.map(item => [item.officialLabel, item.measure]), [
    ["PCE price index", "month_over_month"], ["PCE price index", "year_over_year"],
    ["PCE price index excluding food and energy", "month_over_month"],
    ["PCE price index excluding food and energy", "year_over_year"]]);
});

test("P4 duplicate acquisition is semantic write0", async () => {
  const runtime = Store.createFormalRuntime({ indexedDB: new IDBFactory() }), value = await candidate();
  await commit(runtime, value); const duplicate = await commit(runtime, value);
  assert.deepEqual([duplicate.status, duplicate.semanticWrites, duplicate.transactionCount], ["unchanged", 0, 0]);
});

test("P5/P6 later release atomically appends multiple prior-period revisions", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), july = await candidate({
    referencePeriod: "2026-07", releaseDate: "2026-08-26", releaseNumber: "26–39",
    headlineMom: "0.2", headlineYoy: "3.7", coreMom: "0.2", coreYoy: "3.3",
    priorHeadlineMom: "-0.1", priorCoreMom: "0.1", coreAlso: true,
    fetchedAt: "2026-08-26T12:31:00.000Z",
    acceptedAt: "2026-08-26T12:32:00.000Z" });
  await commit(runtime, july);
  const august = await candidate({ referencePeriod: "2026-08", releaseDate: "2026-09-30",
    releaseNumber: "26–43", headlineMom: "0.3", headlineYoy: "3.4", coreMom: "0.2", coreYoy: "3.0",
    priorHeadlineMom: "0.1", priorCoreMom: "0.1", fetchedAt: "2026-09-30T12:31:00.000Z",
    acceptedAt: "2026-09-30T12:32:00.000Z" }), result = await commit(runtime, august),
    snapshot = (await runtime.readSnapshot()).snapshot, julyHeadline = snapshot.revisions.filter(item =>
      item.valueKey === valueKey("headline", "month_over_month", "2026-07")),
    julyCore = snapshot.revisions.filter(item => item.valueKey ===
      valueKey("excluding_food_energy", "month_over_month", "2026-07"));
  assert.deepEqual([result.semanticWrites, result.transactionCount], [6, 1]);
  assert.deepEqual(julyHeadline.map(item => item.decimalValue).sort(), ["0.1", "0.2"]);
  assert.deepEqual(julyCore.map(item => item.decimalValue).sort(), ["0.1", "0.2"]);
  assert.equal(snapshot.links.filter(item => item.releaseOccurrenceKey === august.release.releaseOccurrenceKey &&
    item.role === "released_prior_period_revision").length, 2);
});

test("P7/P8 as-known-at preserves the old values before revision and new values after", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate({ referencePeriod: "2026-07", releaseDate: "2026-08-26",
    releaseNumber: "26–39", headlineMom: "0.2", headlineYoy: "3.7", coreMom: "0.2", coreYoy: "3.3",
    priorHeadlineMom: "-0.1", priorCoreMom: "0.1", coreAlso: true,
    fetchedAt: "2026-08-26T12:31:00.000Z",
    acceptedAt: "2026-08-26T12:32:00.000Z" }));
  await commit(runtime, await candidate({ referencePeriod: "2026-08", releaseDate: "2026-09-30",
    releaseNumber: "26–43", headlineMom: "0.3", headlineYoy: "3.4", coreMom: "0.2", coreYoy: "3.0",
    priorHeadlineMom: "0.1", priorCoreMom: "0.1", fetchedAt: "2026-09-30T12:31:00.000Z",
    acceptedAt: "2026-09-30T12:32:00.000Z" }));
  const key = valueKey("headline", "month_over_month", "2026-07"),
    before = await Store.readAsKnownAt(indexedDB, "2026-09-30T12:31:59.999Z"),
    after = await Store.readAsKnownAt(indexedDB, "2026-09-30T12:32:00.000Z");
  assert.equal(before.officialValues.find(item => item.valueKey === key).decimalValue, "0.2");
  assert.equal(after.officialValues.find(item => item.valueKey === key).decimalValue, "0.1");
});

test("P9 release-specific archive identity wins over mutable latest-table state", async () => {
  const value = await candidate(), metadata = value.document.httpMetadata;
  assert.equal(metadata.vintageAuthority, "bea_release_specific_news_archive");
  assert.match(value.document.sourceUrl, /\/news\/2026\/personal-income-and-outlays-september-2026$/);
  assert.deepEqual(metadata.tableIdentities, ["BEA_NIPA_TABLE_2_8_7", "BEA_NIPA_TABLE_2_8_11"]);
  assert.match(metadata.releasePdfUrl, /pi0926\.pdf$/); assert.match(metadata.historicalComparisonsUrl, /pi0926-hist\.xlsx$/);
  assert.equal(Acquisition.validateUrl("https://apps.bea.gov/iTable/?reqid=19", "2026-09", "2026-10-29"), null);
});

test("P10 directly published percentages remain official and no derived fact is invented", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate());
  const artifact = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-10-29T13:00:00.000Z",
    snapshotResult: await runtime.readSnapshot() }), serialized = Export.serialize(artifact);
  assert.equal(artifact.officialValues.every(item => item.revision.officialStatus === "published"), true);
  assert.doesNotMatch(serialized, /derivedValues|formulaVersion|calculationTimestamp|roundingPolicy/);
});

test("P11 malformed, ambiguous and internally inconsistent structures fail closed", async () => {
  for (const html of [Fixture.html({ duplicateNarrative: true }), Fixture.html({ omitArchive: true }),
    Fixture.html({ tableCurrentHeadline: "0.4" })]) {
    const acquired = await acquisition({ html });
    assert.throws(() => Pce.createAcceptedCandidate({ acquisition: acquired,
      acceptedAt: "2026-10-29T12:32:00.000Z" }), /bea_pce_(?:structure_change|vintage_links_invalid)/);
  }
});

test("P12 fixed release route rejects wrong host, mutable table and off-route redirect", async () => {
  assert.equal(Acquisition.validateUrl("https://bea.gov/news/2026/personal-income-and-outlays-september-2026",
    "2026-09", "2026-10-29"), null);
  assert.equal(Acquisition.validateUrl(`${Acquisition.urlFor("2026-09", "2026-10-29")}?x=1`,
    "2026-09", "2026-10-29"), null);
  const result = await Acquisition.createBeaPceAcquisition({ fetchImpl: fetchFor("", {
    redirect: "https://www.bea.gov/news/2026/personal-income-and-outlays-august-2026" }) })
    .acquire({ referencePeriod: "2026-09", releaseDate: "2026-10-29" });
  assert.deepEqual([result.success, result.reason], [false, "redirect_route_security_rejected"]);
});

test("P13 Calendar linkage is optional and exact when supplied", async () => {
  const absent = await candidate(), linked = await candidate({ fetchedAt: "2026-10-29T12:33:00.000Z",
    acceptedAt: "2026-10-29T12:34:00.000Z",
    calendarEventKey: "US|US_BEA|US_PCE|2026-09|initial|national" });
  assert.equal(absent.release.calendarEventKey, null);
  assert.equal(linked.release.calendarEventKey, "US|US_BEA|US_PCE|2026-09|initial|national");
});

test("P14 Export v1 exposes PCE provenance and explicitly keeps forecasts unsupported", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate());
  const artifact = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-10-29T13:00:00.000Z",
    snapshotResult: await runtime.readSnapshot() }), status = artifact.sourceStatus.sources.find(item =>
      item.sourceId === Pce.SOURCE_ID);
  assert.equal(Export.validate(artifact).valid, true); assert.equal(status.officialValueCount, 6);
  assert.equal(status.readiness, "formal_reference"); assert.equal(artifact.sourceStatus.forecastValues, "unsupported");
  assert.equal(artifact.officialValues.every(item => item.provenance.length === 1), true);
});

test("transport is credential-free, bounded, exact-route and hashes exact release bytes", async () => {
  const html = Fixture.html(), calls = [], result = await Acquisition.createBeaPceAcquisition({
    fetchImpl: async (url, options) => { calls.push({ url, options });
      return new Response(html, { headers: { "content-type": "text/html" } }); },
    now: () => new Date("2026-10-29T12:31:00.000Z") }).acquire({
      referencePeriod: "2026-09", releaseDate: "2026-10-29" });
  assert.equal(result.success, true); assert.equal(calls[0].url, Acquisition.urlFor("2026-09", "2026-10-29"));
  assert.deepEqual([calls[0].options.credentials, calls[0].options.redirect], ["omit", "manual"]);
  assert.equal(result.document.rawContentHash, crypto.createHash("sha256").update(html).digest("hex"));
});

test("all four Formal sources coexist in one unchanged schema-v1 database", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }),
    cpiHtml = CpiFixture.html(), cpiAcquired = await CpiAcquisition.createBlsCpiAcquisition({
      fetchImpl: fetchFor(cpiHtml), now: () => new Date("2026-10-14T13:31:00.000Z") })
      .acquire({ releaseDate: "2026-10-14" }), employmentHtml = EmploymentFixture.html(),
    employmentAcquired = await EmploymentAcquisition.createBlsEmploymentAcquisition({
      fetchImpl: fetchFor(employmentHtml), now: () => new Date("2026-10-02T12:31:00.000Z") })
      .acquire({ releaseDate: "2026-10-02" }), japanHtml = JapanFixture.html(),
    japanAcquired = await JapanAcquisition.createJapanCpiAcquisition({ fetchImpl: fetchFor(japanHtml),
      now: () => new Date("2026-10-23T00:01:00.000Z") }).acquire();
  await commit(runtime, Cpi.createAcceptedCandidate({ acquisition: cpiAcquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }));
  await commit(runtime, Employment.createAcceptedCandidate({ acquisition: employmentAcquired,
    acceptedAt: "2026-10-02T12:32:00.000Z" }));
  await commit(runtime, Japan.createAcceptedCandidate({ acquisition: japanAcquired,
    acceptedAt: "2026-10-23T00:02:00.000Z" }));
  await commit(runtime, await candidate());
  const snapshot = (await runtime.readSnapshot()).snapshot, current = await Store.readCurrentPce(indexedDB);
  assert.equal(snapshot.definitions.length, 16); assert.equal(snapshot.revisions.length, 18);
  assert.deepEqual([current.status, current.seriesDefinitions.length, current.officialValues.length],
    ["available", 4, 6]);
});
