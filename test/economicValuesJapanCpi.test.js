"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/jpCpiAcquisition.js");
const JapanCpi = require("../js/economicValues/jpCpiFormal.js");
const Encoding = require("../js/economicValues/jpCpiEncoding.js");
const CpiAcquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const EmploymentAcquisition = require("../js/economicValues/blsEmploymentAcquisition.js");
const Employment = require("../js/economicValues/blsEmploymentFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Fixture = require("./fixtures/economicValues/jpCpiReleaseFixture.js");
const CpiFixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");
const EmploymentFixture = require("./fixtures/economicValues/blsEmploymentReleaseFixture.js");

const headers = values => ({ get: name => values[String(name).toLowerCase()] ?? null });
function fetchFor(html, { redirect = null, mime = "text/html; charset=utf-8", status = 200 } = {}) {
  return async () => redirect ? { status: 302, ok: false, headers: headers({ location: redirect }) } :
    new Response(html, { status, headers: { "content-type": mime } });
}
async function acquisition(options = {}) {
  const html = options.html || Fixture.html(options);
  return Acquisition.createJapanCpiAcquisition({ fetchImpl: fetchFor(html, options),
    now: () => new Date(options.fetchedAt || "2026-10-23T00:01:00.000Z") }).acquire();
}
async function candidate(options = {}) {
  const acquired = options.acquisition || await acquisition(options);
  return JapanCpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: options.acceptedAt || "2026-10-23T00:02:00.000Z",
    calendarEventKey: options.calendarEventKey ?? null });
}
async function commit(runtime, value) {
  const ticket = await runtime.registerAcceptedRelease(value);
  return runtime.commitAcceptedRelease(ticket);
}
const key = (base, code, measure, period = "2026-09") =>
  `JP|JP_STATISTICS_BUREAU|CPI|NATIONAL|${code}|${measure}|NSA|${base}|${period}`;

test("J1 nationwide release parses and atomically persists six official values", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate(),
    result = await commit(runtime, value), snapshot = (await runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.semanticWrites, result.transactionCount], ["committed", 6, 1]);
  assert.equal(snapshot.definitions.length, 6); assert.equal(snapshot.revisions.length, 6);
  assert.deepEqual(snapshot.revisions.map(item => item.decimalValue).sort(),
    ["102.2", "102.3", "102.8", "2.1", "2.1", "2.4"]);
});

test("J2 official labels and e-Stat classification codes are retained exactly", async () => {
  const value = await candidate();
  assert.deepEqual(value.definitions.filter(item => item.measure === "index_level").map(item =>
    [item.variant, item.officialLabel]), [["0001", "総合"], ["0161", "生鮮食品を除く総合"],
    ["0178", "生鮮食品及びエネルギーを除く総合"]]);
  assert.equal(value.document.httpMetadata.eStatDatasetId, "0004052037");
  assert.equal(value.document.httpMetadata.statisticsCode, "00200573");
});

test("J3 geography is an explicit identity axis and parser accepts nationwide only", async () => {
  const national = JapanCpi.seriesForBaseYear("2025", "national"),
    tokyo = JapanCpi.seriesForBaseYear("2025", "tokyo_wards");
  assert.equal(national.some(left => tokyo.some(right => left.seriesDefinitionKey === right.seriesDefinitionKey)), false);
  const acquired = await acquisition({ html: Fixture.html({ geography: "東京都区部" }) });
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-23T00:02:00.000Z" }), /structure_change/);
});

test("J4 index base year is explicit in every definition and release value identity", async () => {
  const value = await candidate();
  assert.equal(value.definitions.every(item => item.indexBaseIdentity === "2025=100" &&
    item.seriesDefinitionKey.endsWith("|2025")), true);
  assert.equal(value.values.every(item => item.seriesDefinitionKey.includes("|2025")), true);
});

test("J5 a base-year change creates new definitions and never revises the prior base", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), oldAcquired = await acquisition({
    html: Fixture.html({ baseYear: "2020", referencePeriod: "2021-09", releaseDate: "2021-10-22" }),
    fetchedAt: "2021-10-22T00:01:00.000Z" });
  await commit(runtime, await candidate({ acquisition: oldAcquired, acceptedAt: "2021-10-22T00:02:00.000Z" }));
  await commit(runtime, await candidate());
  const snapshot = (await runtime.readSnapshot()).snapshot,
    beforeRebase = await Store.readAsKnownAt(indexedDB, "2026-10-22T23:59:59.999Z");
  assert.equal(snapshot.definitions.length, 12);
  assert.equal(snapshot.revisions.filter(item => item.seriesDefinitionKey.endsWith("|2020")).length, 6);
  assert.equal(snapshot.revisions.filter(item => item.seriesDefinitionKey.endsWith("|2025")).length, 6);
  assert.equal(beforeRebase.officialValues.length, 6);
  assert.equal(beforeRebase.officialValues.every(item => item.seriesDefinitionKey.endsWith("|2020")), true);
});

test("J6/J7 an official correction is a new occurrence and revises the same series/reference facts", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), initial = await candidate();
  await commit(runtime, initial);
  const acquired = await acquisition({ html: Fixture.html({ corrected: true, allItemsIndex: "102.3" }),
    fetchedAt: "2026-10-23T01:01:00.000Z" }), corrected = await candidate({ acquisition: acquired,
      acceptedAt: "2026-10-23T01:02:00.000Z" });
  const result = await commit(runtime, corrected);
  const snapshot = (await runtime.readSnapshot()).snapshot,
    valueKey = key("2025", "0001", "INDEX"), revisions = snapshot.revisions.filter(value => value.valueKey === valueKey),
    current = revisions.find(value => value.validTo === null), evidence = snapshot.evidence.find(value =>
      value.revisionKey === current.revisionKey && value.releaseOccurrenceKey === corrected.release.releaseOccurrenceKey);
  assert.equal(revisions.length, 2); assert.equal(current.decimalValue, "102.3"); assert.ok(evidence);
  assert.deepEqual([result.semanticWrites, result.transactionCount], [1, 1]);
  assert.notEqual(corrected.release.releaseOccurrenceKey, initial.release.releaseOccurrenceKey);
  assert.equal(corrected.release.occurrenceType, "correction");
});

test("J8 ambiguous duplicate official row fails closed before any transaction", async () => {
  const acquired = await acquisition({ html: Fixture.html({ duplicate: true }) });
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-23T00:02:00.000Z" }), /structure_change/);
});

test("J9 missing base-year authority fails closed", async () => {
  const acquired = await acquisition({ html: Fixture.html({ omitBase: true }) });
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-23T00:02:00.000Z" }), /structure_change/);
});

test("J10 fixed official route rejects query, wrong host and off-route redirect", async () => {
  assert.equal(Acquisition.validateUrl(`${Acquisition.SOURCE_URL}?x=1`), null);
  assert.equal(Acquisition.validateUrl("https://www.e-stat.go.jp/stat-search/database"), null);
  const result = await Acquisition.createJapanCpiAcquisition({ fetchImpl: fetchFor("", {
    redirect: "https://www.stat.go.jp/data/cpi/other.html" }) }).acquire();
  assert.deepEqual([result.success, result.reason], [false, "redirect_route_security_rejected"]);
});

test("J11 identical accepted acquisition is semantic write0 and transaction0", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate();
  await commit(runtime, value); const duplicate = await commit(runtime, value);
  assert.deepEqual([duplicate.status, duplicate.semanticWrites, duplicate.transactionCount], ["unchanged", 0, 0]);
});

test("J12/J13 as-known-at selects initial fact before correction and corrected fact after it", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate());
  const acquired = await acquisition({ html: Fixture.html({ corrected: true, allItemsIndex: "102.3" }),
    fetchedAt: "2026-10-23T01:01:00.000Z" });
  await commit(runtime, await candidate({ acquisition: acquired, acceptedAt: "2026-10-23T01:02:00.000Z" }));
  const before = await Store.readAsKnownAt(indexedDB, "2026-10-23T01:01:59.999Z"),
    after = await Store.readAsKnownAt(indexedDB, "2026-10-23T01:02:00.000Z"), valueKey = key("2025", "0001", "INDEX");
  assert.equal(before.officialValues.find(value => value.valueKey === valueKey).decimalValue, "102.2");
  assert.equal(after.officialValues.find(value => value.valueKey === valueKey).decimalValue, "102.3");
});

test("J14 Calendar linkage is optional and exact when supplied", async () => {
  const absent = await candidate(), linked = await candidate({ fetchedAt: "2026-10-23T00:03:00.000Z",
    acceptedAt: "2026-10-23T00:04:00.000Z",
    calendarEventKey: "JP|JP_STATISTICS_BUREAU|JP_NATIONAL_CPI|2026-09|initial|national" });
  assert.equal(absent.release.calendarEventKey, null);
  assert.equal(linked.release.calendarEventKey,
    "JP|JP_STATISTICS_BUREAU|JP_NATIONAL_CPI|2026-09|initial|national");
});

test("J15 Export v1 exposes Japan CPI facts/provenance without forecasts", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await commit(runtime, await candidate());
  const artifact = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-10-23T02:00:00.000Z",
    snapshotResult: await runtime.readSnapshot() }), status = artifact.sourceStatus.sources.find(value =>
      value.sourceId === JapanCpi.SOURCE_ID);
  assert.equal(Export.validate(artifact).valid, true); assert.equal(status.officialValueCount, 6);
  assert.equal(status.readiness, "formal_reference"); assert.equal(artifact.sourceStatus.forecastValues, "unsupported");
  assert.equal(artifact.seriesDefinitions.filter(item => item.indicator === "JP_CPI").every(item =>
    item.officialLabel && item.scope === "Japan_nationwide" && item.indexBaseIdentity === "2025=100" &&
    item.seasonalAdjustment === "not_seasonally_adjusted" &&
    ["index_level", "year_over_year"].includes(item.measure)), true);
  assert.equal(artifact.officialValues.every(item => item.provenance.length === 1), true);
  assert.doesNotMatch(Export.serialize(artifact), /parserInput|rawHtml|consensus|surprise/);
});

test("malformed required value preserves an empty isolated DB and correction time must be independently known", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), acquired = await acquisition({
    html: Fixture.html({ allItemsIndex: "bad" }) });
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-23T00:02:00.000Z" }), /structure_change/);
  assert.deepEqual(await indexedDB.databases(), []);
  const noTime = await acquisition({ html: Fixture.html({ corrected: true }).replace(/<p>訂正公表:[\s\S]*?<\/p>/, "") });
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: noTime,
    acceptedAt: "2026-10-23T01:02:00.000Z" }), /correction_time_unverifiable/);
  assert.equal((await runtime.readSnapshot()).status, "absent");
});

test("official acquisition is credential-free, bounded, fixed-route and hashes exact bytes", async () => {
  const html = Fixture.html(), calls = [], result = await Acquisition.createJapanCpiAcquisition({
    fetchImpl: async (url, options) => { calls.push({ url, options });
      return new Response(html, { headers: { "content-type": "text/html" } }); },
    now: () => new Date("2026-10-23T00:01:00.000Z") }).acquire();
  assert.equal(result.success, true); assert.equal(calls[0].url, Acquisition.SOURCE_URL);
  assert.deepEqual([calls[0].options.credentials, calls[0].options.redirect], ["omit", "manual"]);
  assert.equal(result.document.rawContentHash, crypto.createHash("sha256").update(html).digest("hex"));
});

test("current official Shift_JIS encoding authority is detected and decoded deterministically", () => {
  const bytes = Buffer.concat([Buffer.from('<meta charset="Shift_JIS"><p>', "ascii"),
    Buffer.from("91538d9120918d8d872090b6914e90489569208347836c838b834d815b", "hex"),
    Buffer.from("</p>", "ascii")]);
  assert.equal(Encoding.detect(bytes), "shift_jis");
  assert.equal(Encoding.decode(bytes).includes("全国 総合 生鮮食品 エネルギー"), true);
});

test("US CPI, Employment and Japan CPI coexist in the same schema-v1 DB", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }),
    cpiDate = "2026-10-14", cpiHtml = CpiFixture.html(),
    cpiAcquired = await CpiAcquisition.createBlsCpiAcquisition({ fetchImpl: fetchFor(cpiHtml),
      now: () => new Date("2026-10-14T13:31:00.000Z") }).acquire({ releaseDate: cpiDate }),
    employmentDate = "2026-10-02", employmentHtml = EmploymentFixture.html(),
    employmentAcquired = await EmploymentAcquisition.createBlsEmploymentAcquisition({
      fetchImpl: fetchFor(employmentHtml), now: () => new Date("2026-10-02T12:31:00.000Z")
    }).acquire({ releaseDate: employmentDate });
  await commit(runtime, Cpi.createAcceptedCandidate({ acquisition: cpiAcquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }));
  await commit(runtime, Employment.createAcceptedCandidate({ acquisition: employmentAcquired,
    acceptedAt: "2026-10-02T12:32:00.000Z" }));
  await commit(runtime, await candidate());
  const snapshot = (await runtime.readSnapshot()).snapshot, current = await Store.readCurrentJapanCpi(indexedDB);
  assert.equal(snapshot.definitions.length, 12); assert.equal(snapshot.revisions.length, 12);
  assert.deepEqual([current.status, current.seriesDefinitions.length, current.officialValues.length],
    ["available", 6, 6]);
});
