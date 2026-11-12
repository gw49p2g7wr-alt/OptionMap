"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Fixture = require("./fixtures/weeklyProductionAcquisitionFixture.js");
const FuturesHistory = require("../js/weeklyFuturesHistory.js");
const OptionsHistory = require("../js/weeklyOptionsHistory.js");

const ROOT = path.resolve(__dirname, "..");
const latest = { requestKind: "latest_available" };
const acquire = async (t, options = {}, intent = latest) => {
  const harness = Fixture.createHarness(t, options), result = await harness.service.acquire(intent);
  return { harness, result };
};

test("W5-1 latest_available uses the main evidence pipeline only", async t => {
  const { result } = await acquire(t);
  assert.equal(result.status, "available");
  assert.equal(result.runs.length, 1);
  assert.match(result.runs[0].runId, /^weekly-run-v1\|sha256:/);
});

test("W5-2 explicit_source_date uses exact main discovery", async t => {
  const { result } = await acquire(t, { dates: ["2026-10-30", "2026-11-06"] },
    { requestKind: "explicit_source_date", targetDate: "2026-10-30" });
  assert.equal(result.runs[0].sourceDate, "2026-10-30");
});

test("W5-3 bounded backfill uses one shared main listing", async t => {
  const { result } = await acquire(t, { dates: ["2026-10-30", "2026-11-06"] },
    { requestKind: "historical_backfill_range", startDate: "2026-10-01",
      endDate: "2026-11-06" });
  assert.deepEqual(result.runs.map(run => run.sourceDate), ["2026-10-30", "2026-11-06"]);
});

test("W5-4 renderer URL authority is absent from the exposed bridge", () => {
  const preload = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  assert.doesNotMatch(preload, /fetchJpxPage:|fetchOpenInterestListing:|downloadJpxExcel:/);
  assert.match(preload, /acquireWeekly:/);
});

test("W5-5 shared listing success permits both domains", async t => {
  const { result } = await acquire(t);
  assert.deepEqual([result.runs[0].futures.status, result.runs[0].options.status],
    ["available", "available"]);
});

test("W5-6 listing failure blocks both and returns no candidate", async t => {
  const { result } = await acquire(t, { failListing: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.runs.length, 0);
});

test("W5-7 both domains promote independently on success", async t => {
  const { result } = await acquire(t);
  assert.deepEqual([result.runs[0].futures.semanticRevisionWriteCount,
    result.runs[0].options.semanticRevisionWriteCount], [1, 1]);
});

test("W5-8 Futures failure does not block Options", async t => {
  const { result } = await acquire(t, { failFutures: true });
  assert.deepEqual([result.runs[0].futures.status, result.runs[0].options.status],
    ["unavailable", "available"]);
});

test("W5-9 Options failure does not block Futures", async t => {
  const { result } = await acquire(t, { failOptions: true });
  assert.deepEqual([result.runs[0].futures.status, result.runs[0].options.status],
    ["available", "unavailable"]);
});

test("W5-10 Futures parser failure leaves Options available", async t => {
  const { result } = await acquire(t, { badFutures: true });
  assert.equal(result.runs[0].futures.status, "unavailable");
  assert.equal(result.runs[0].options.status, "available");
});

test("W5-11 Options parser failure leaves Futures available", async t => {
  const { result } = await acquire(t, { badOptions: true });
  assert.equal(result.runs[0].options.status, "unavailable");
  assert.equal(result.runs[0].futures.status, "available");
});

test("W5-12 Futures Evidence rejection prevents only Futures promotion", async t => {
  const { result } = await acquire(t, { rejectParserRole: "weekly_futures_workbook" });
  assert.equal(result.runs[0].futures.status, "unavailable");
  assert.equal(result.runs[0].options.status, "available");
});

test("W5-13 Options Evidence rejection prevents only Options promotion", async t => {
  const { result } = await acquire(t, { rejectParserRole: "weekly_options_workbook" });
  assert.equal(result.runs[0].options.status, "unavailable");
  assert.equal(result.runs[0].futures.status, "available");
});

test("W5-14 Futures semantic duplicate is write0", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); harness.configure({ futuresTag: "raw-change" });
  const second = await harness.service.acquire(latest);
  assert.equal(second.runs[0].futures.semanticRevisionWriteCount, 0);
});

test("W5-15 Options semantic duplicate is write0", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); harness.configure({ optionsTag: "raw-change" });
  const second = await harness.service.acquire(latest);
  assert.equal(second.runs[0].options.semanticRevisionWriteCount, 0);
});

test("W5-16 Futures same-week correction creates a revision", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); harness.configure({ futuresValue: 200 });
  const second = await harness.service.acquire(latest);
  assert.equal(second.runs[0].futures.semanticRevisionWriteCount, 1);
  assert.equal(second.runs[0].futures.history.entries[0].revisions.length, 2);
});

test("W5-17 Options same-week correction creates a revision", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); harness.configure({ optionsValue: 200 });
  const second = await harness.service.acquire(latest);
  assert.equal(second.runs[0].options.semanticRevisionWriteCount, 1);
  assert.equal(second.runs[0].options.history.entries[0].revisions.length, 2);
});

test("W5-18 Futures current previous remain distinct source dates", async t => {
  const harness = Fixture.createHarness(t, { dates: ["2026-10-30"] }),
    first = await harness.service.acquire(latest); harness.commit(first);
  harness.configure({ dates: ["2026-10-30", "2026-11-06"] });
  const second = await harness.service.acquire(latest), versions =
    await FuturesHistory.getActiveVersions(second.runs[0].futures.history);
  assert.deepEqual(versions.map(value => value.sourceDate), ["2026-10-30", "2026-11-06"]);
});

test("W5-19 Options previous helpers remain calendar based", async t => {
  const harness = Fixture.createHarness(t, { dates: ["2026-10-30"] }),
    first = await harness.service.acquire(latest); harness.commit(first);
  harness.configure({ dates: ["2026-10-30", "2026-11-06"] });
  const second = await harness.service.acquire(latest), previous =
    await OptionsHistory.findPreviousWeeklyOptionsRevision(
      second.runs[0].options.history, "2026-11-06");
  assert.equal(previous.previousCalendar.sourceDate, "2026-10-30");
});

test("W5-20 startup references the single production fetchWeeklyData path", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /refresh:\s*refreshAllMarketData/);
  assert.equal((html.match(/async function fetchWeeklyData\(/g) || []).length, 1);
});

test("W5-21 manual refresh reaches acquireWeekly through fetchWeeklyData", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /optionMapBridge\.acquireWeekly\(\{ requestKind: "latest_available" \}\)/);
});

test("W5-22 Morning targeted retry uses the same fetchWeeklyData", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /refreshWeekly:\s*\(\{ requestId \}\) => fetchWeeklyData\(\{ requestId \}\)/);
});

test("W5-23 a slower earlier run cannot promote over the later run", async t => {
  const harness = Fixture.createHarness(t, { listingDelayMs: 25 }), service = harness.service,
    first = service.acquire(latest);
  await new Promise(resolve => setTimeout(resolve, 2));
  harness.configure({ listingDelayMs: 0, futuresValue: 200 });
  const second = harness.service.acquire(latest), [older, newer] = await Promise.all([first, second]);
  assert.equal(older.status, "stale");
  assert.equal(newer.status, "available");
});

test("W5-24 semantic duplicate has no second history or binding write", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); harness.configure({});
  const second = await harness.service.acquire(latest);
  assert.deepEqual([second.runs[0].futures.semanticRevisionWriteCount,
    second.runs[0].futures.bindingWriteCount,
    second.runs[0].options.semanticRevisionWriteCount,
    second.runs[0].options.bindingWriteCount], [0, 0, 0, 0]);
});

test("post-binding consumer commit retry reuses the immutable original binding", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  assert.equal(first.runs[0].futures.bindingWriteCount, 1);
  harness.configure({ listingTag: "retry-after-consumer-failure" });
  const second = await harness.service.acquire(latest);
  assert.deepEqual([second.runs[0].futures.status, second.runs[0].futures.reason,
    second.runs[0].futures.semanticRevisionWriteCount,
    second.runs[0].futures.bindingWriteCount], ["available", "binding_retry", 1, 0]);
});

test("W5-25 Overall pair identity is stable on raw-only refresh", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); const before = first.runs[0].futures.candidate.versionKey;
  harness.configure({ listingTag: "raw-only" });
  const second = await harness.service.acquire(latest);
  assert.equal(second.runs[0].futures.candidate.versionKey, before);
});

test("W5-26 semantic correction updates only the active Futures member", async t => {
  const harness = Fixture.createHarness(t), first = await harness.service.acquire(latest);
  harness.commit(first); const old = first.runs[0].futures.candidate.versionKey;
  harness.configure({ futuresValue: 300 }); const second = await harness.service.acquire(latest);
  assert.notEqual(second.runs[0].futures.candidate.versionKey, old);
  assert.equal(second.runs[0].futures.history.entries[0].revisions[0].versionKey, old);
});

test("W5-27 Morning-facing Weekly history validates after production promotion", async t => {
  const { result } = await acquire(t);
  assert.equal(await FuturesHistory.validateHistory(result.runs[0].futures.history), true);
});

test("W5-28 Full Export semantic modules are not changed by production acquisition", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/weeklyProductionAcquisition.js"), "utf8");
  assert.doesNotMatch(source, /fullExport|changeSummary|topChanges/);
});

test("W5-29 UI receives the same validated canonical caches", async t => {
  const { result } = await acquire(t), run = result.runs[0];
  assert.equal(run.futures.cache.versionAssessment, "confirmed");
  assert.equal(run.options.cache.versionAssessment, "confirmed");
});

test("W5-30 production response leaks no raw bytes or Vault paths", async t => {
  const { result } = await acquire(t), encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /"bytes"|vaultPath|storagePath|source-evidence-vault/);
  assert.equal(result.diagnostics.rawPayloadExposed, false);
});
