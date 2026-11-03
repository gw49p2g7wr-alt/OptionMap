"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/blsEmploymentAcquisition.js");
const Employment = require("../js/economicValues/blsEmploymentFormal.js");
const CpiAcquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Fixture = require("./fixtures/economicValues/blsEmploymentReleaseFixture.js");
const CpiFixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");

const headers = values => ({ get: name => values[String(name).toLowerCase()] ?? null });
function fetchFor(html, { redirect = null, mime = "text/html; charset=utf-8", status = 200 } = {}) {
  return async () => redirect ? { status: 302, ok: false, headers: headers({ location: redirect }) } :
    new Response(html, { status, headers: { "content-type": mime } });
}
async function acquisition(options = {}) {
  const releaseDate = options.releaseDate || "2026-10-02", html = options.html || Fixture.html({ releaseDate });
  return Acquisition.createBlsEmploymentAcquisition({ fetchImpl: fetchFor(html, options),
    now: () => new Date(options.fetchedAt || `${releaseDate}T12:31:00.000Z`) }).acquire({ releaseDate });
}
async function candidate(options = {}) {
  const acquired = options.acquisition || await acquisition(options);
  return Employment.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: options.acceptedAt || `${acquired.releaseDate}T12:32:00.000Z`,
    calendarEventKey: options.calendarEventKey ?? null });
}
async function commit(runtime, value) {
  const ticket = await runtime.registerAcceptedRelease(value);
  return runtime.commitAcceptedRelease(ticket);
}
const payrollKey = period => `${Employment.SERIES[0].seriesDefinitionKey}|${period}`;
async function seedThroughSeptember(runtime) {
  const releases = [
    { referencePeriod: "2026-07", releaseDate: "2026-08-07", payroll: "+21,000", unemployment: "4.1" },
    { referencePeriod: "2026-08", releaseDate: "2026-09-04", payroll: "+162,000", unemployment: "4.1" },
    { referencePeriod: "2026-09", releaseDate: "2026-10-02", payroll: "+29,000", unemployment: "4.2",
      revisions: [{ month: "JULY", from: "+21,000", to: "-10,000" },
        { month: "AUGUST", from: "+162,000", to: "+133,000" }] }
  ];
  for (const [index, value] of releases.entries()) {
    const acquired = await acquisition({ releaseDate: value.releaseDate, html: Fixture.html(value),
      fetchedAt: `${value.releaseDate}T12:31:00.000Z` });
    await commit(runtime, await candidate({ acquisition: acquired,
      acceptedAt: `${value.releaseDate}T12:32:0${index}.000Z` }));
  }
}
async function octoberRevisionCandidate(options = {}) {
  const releaseDate = "2026-11-06", acquired = await acquisition({ releaseDate,
    html: Fixture.html({ referencePeriod: "2026-10", releaseDate, payroll: options.payroll || "+40,000",
      unemployment: options.unemployment || "4.2", corrected: options.corrected || false,
      revisions: [{ month: "AUGUST", from: "+133,000", to: "+140,000" },
        { month: "SEPTEMBER", from: "+29,000", to: options.revisedSeptember || "+20,000" }] }),
    fetchedAt: options.fetchedAt || "2026-11-06T13:31:00.000Z" });
  return candidate({ acquisition: acquired, acceptedAt: options.acceptedAt || "2026-11-06T13:32:00.000Z" });
}

test("E2-1 normal release accepts current payroll and unemployment as decimal strings", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate();
  const result = await commit(runtime, value), snapshot = (await runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.semanticWrites, result.transactionCount], ["committed", 2, 1]);
  assert.deepEqual(snapshot.revisions.map(item => item.decimalValue).sort(), ["29", "4.2"]);
});

test("E2-2 one prior payroll revision belongs to its historical valueKey", async () => {
  const acquired = await acquisition({ html: Fixture.html({ revisions: [
    { month: "AUGUST", from: "+162,000", to: "+133,000" }] }) }), value = await candidate({ acquisition: acquired });
  assert.equal(value.values.length, 3);
  assert.equal(value.values.find(item => item.referencePeriod === "2026-08").valueKey, payrollKey("2026-08"));
});

test("E2-3 two prior payroll revisions are parsed and linked to one release", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime);
  const snapshot = (await runtime.readSnapshot()).snapshot,
    release = snapshot.releases.find(value => value.officialReleaseDate === "2026-10-02");
  assert.equal(snapshot.links.filter(value => value.releaseOccurrenceKey === release.releaseOccurrenceKey).length, 4);
  assert.equal(snapshot.links.filter(value => value.releaseOccurrenceKey === release.releaseOccurrenceKey &&
    value.role === "released_prior_period_revision").length, 2);
});

test("E2-4 malformed required current value causes transaction0 and preserves snapshot", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime); const before = (await runtime.readSnapshot()).snapshot,
    acquired = await acquisition({ releaseDate: "2026-11-06", html: Fixture.html({
      referencePeriod: "2026-10", releaseDate: "2026-11-06", unemployment: "bad" }) });
  assert.throws(() => Employment.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-11-06T13:32:00.000Z" }), /structure_change/);
  assert.deepEqual((await runtime.readSnapshot()).snapshot, before);
});

test("E2-4 an injected multi-period transaction abort preserves the complete prior snapshot", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime);
  const before = (await runtime.readSnapshot()).snapshot,
    aborting = Store.createFormalRuntime({ indexedDB, faultAt: "transaction_abort" }),
    value = await octoberRevisionCandidate(), ticket = await aborting.registerAcceptedRelease(value);
  await assert.rejects(() => aborting.commitAcceptedRelease(ticket));
  assert.deepEqual((await runtime.readSnapshot()).snapshot, before);
});

test("E2-5 identical release is semantic write0 and transaction0", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate();
  await commit(runtime, value); const duplicate = await commit(runtime, value);
  assert.deepEqual([duplicate.status, duplicate.semanticWrites, duplicate.transactionCount], ["unchanged", 0, 0]);
});

test("E2-6/E2-7 as-known-at returns old payroll before and revised payroll after acceptance", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime); await commit(runtime, await octoberRevisionCandidate());
  const before = await Store.readAsKnownAt(indexedDB, "2026-11-06T13:31:59.999Z"),
    after = await Store.readAsKnownAt(indexedDB, "2026-11-06T13:32:00.000Z");
  assert.equal(before.officialValues.find(value => value.valueKey === payrollKey("2026-09")).decimalValue, "29");
  assert.equal(after.officialValues.find(value => value.valueKey === payrollKey("2026-09")).decimalValue, "20");
});

test("E2-8 revised September provenance points to the October-data release occurrence", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime); const revision = await octoberRevisionCandidate();
  await commit(runtime, revision); const snapshot = (await runtime.readSnapshot()).snapshot,
    active = snapshot.revisions.find(value => value.valueKey === payrollKey("2026-09") && value.validTo === null),
    evidence = snapshot.evidence.find(value => value.revisionKey === active.revisionKey);
  assert.equal(active.releaseOccurrenceKey, revision.release.releaseOccurrenceKey);
  assert.equal(evidence.releaseOccurrenceKey, revision.release.releaseOccurrenceKey);
});

test("E2-9 Calendar link absence does not invalidate Employment values", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }), value = await candidate();
  assert.equal(value.release.calendarEventKey, null); await commit(runtime, value);
  assert.equal((await Store.readCurrentEmployment(indexedDB)).status, "available");
});

test("E2-10 wrong route and query are rejected before parsing", async () => {
  const result = await Acquisition.createBlsEmploymentAcquisition({ fetchImpl: fetchFor("", {
    redirect: "https://example.com/news.release/archives/empsit_10022026.htm" }) }).acquire({ releaseDate: "2026-10-02" });
  assert.deepEqual([result.success, result.reason], [false, "redirect_route_security_rejected"]);
  assert.equal(Acquisition.validateUrl("https://www.bls.gov/news.release/archives/empsit_10022026.htm?x=1",
    "2026-10-02"), null);
});

test("E2-11 unexpected page structure fails closed", async () => {
  const acquired = await acquisition({ html: Fixture.html({ heading: false }) });
  assert.throws(() => Employment.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-02T12:32:00.000Z" }), /structure_change/);
});

test("E2-12 prior unemployment revisions are never synthesized", async () => {
  const value = await octoberRevisionCandidate(), unemployment = Employment.SERIES[1].seriesDefinitionKey;
  assert.equal(value.values.filter(item => item.seriesDefinitionKey === unemployment).length, 1);
  assert.equal(value.values.find(item => item.seriesDefinitionKey === unemployment).referencePeriod, "2026-10");
});

test("E2-13 an official correction is a distinct immutable occurrence, not overwrite", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime); const initial = await octoberRevisionCandidate(); await commit(runtime, initial);
  const correction = await octoberRevisionCandidate({ corrected: true, payroll: "+42,000",
    revisedSeptember: "+22,000", fetchedAt: "2026-11-06T14:01:00.000Z",
    acceptedAt: "2026-11-06T14:02:00.000Z" });
  await commit(runtime, correction); const snapshot = (await runtime.readSnapshot()).snapshot;
  assert.notEqual(correction.release.releaseOccurrenceKey, initial.release.releaseOccurrenceKey);
  assert.equal(snapshot.releases.filter(value => value.officialReleaseDate === "2026-11-06").length, 2);
  assert.equal(snapshot.revisions.filter(value => value.valueKey === payrollKey("2026-09")).length, 3);
});

test("E2-13 a correction marker without an independently verifiable publication time fails closed", async () => {
  const acquired = await acquisition({ releaseDate: "2026-11-06", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-06", corrected: true
  }).replace(/<p>Corrected:[\s\S]*?<\/p>/, "") });
  assert.throws(() => Employment.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-11-06T14:02:00.000Z" }), /correction_time_unverifiable/);
});

test("Economic Values Export v1 exposes revision history and causing release without forecasts", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB });
  await seedThroughSeptember(runtime); const later = await octoberRevisionCandidate(); await commit(runtime, later);
  const artifact = Export.create({ appVersion: "1.1.0-beta.16", generatedAt: "2026-11-06T14:00:00.000Z",
    snapshotResult: await runtime.readSnapshot() }), item = artifact.officialValues.find(value =>
      value.revision.valueKey === payrollKey("2026-09"));
  assert.equal(artifact.schemaVersion, "optionmap-economic-values-export-v1");
  assert.deepEqual(item.revisionHistory.map(value => value.revision.decimalValue), ["29", "20"]);
  assert.equal(item.revisionHistory[1].provenance.some(value =>
    value.releaseOccurrenceKey === later.release.releaseOccurrenceKey), true);
  assert.equal(artifact.sourceStatus.forecastValues, "unsupported");
});

test("CPI and Employment coexist in the same schema-v1 DB without identity collision", async () => {
  const indexedDB = new IDBFactory(), runtime = Store.createFormalRuntime({ indexedDB }),
    cpiHtml = CpiFixture.html(), cpiAcquired = await CpiAcquisition.createBlsCpiAcquisition({
      fetchImpl: fetchFor(cpiHtml), now: () => new Date("2026-10-14T13:31:00.000Z")
    }).acquire({ releaseDate: "2026-10-14" });
  await commit(runtime, Cpi.createAcceptedCandidate({ acquisition: cpiAcquired,
    acceptedAt: "2026-10-14T13:32:00.000Z" }));
  await commit(runtime, await candidate({ releaseDate: "2026-11-06", html: Fixture.html({
    referencePeriod: "2026-10", releaseDate: "2026-11-06" }), fetchedAt: "2026-11-06T13:31:00.000Z",
    acceptedAt: "2026-11-06T13:32:00.000Z" }));
  assert.equal((await Store.readCurrentCpi(indexedDB)).seriesDefinitions.length, 4);
  assert.equal((await Store.readCurrentEmployment(indexedDB)).seriesDefinitions.length, 2);
  assert.equal((await runtime.readSnapshot()).snapshot.definitions.length, 6);
});

test("Employment route is fixed and raw bytes are hashed without credential authority", async () => {
  const html = Fixture.html(), calls = [], result = await Acquisition.createBlsEmploymentAcquisition({
    fetchImpl: async (url, options) => { calls.push({ url, options });
      return new Response(html, { headers: { "content-type": "text/html" } }); },
    now: () => new Date("2026-10-02T12:31:00.000Z") }).acquire({ releaseDate: "2026-10-02" });
  assert.equal(result.success, true);
  assert.equal(calls[0].url, "https://www.bls.gov/news.release/archives/empsit_10022026.htm");
  assert.deepEqual([calls[0].options.credentials, calls[0].options.redirect], ["omit", "manual"]);
  assert.equal(result.document.rawContentHash, crypto.createHash("sha256").update(html).digest("hex"));
});
