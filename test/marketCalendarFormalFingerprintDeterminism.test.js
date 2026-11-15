"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Atomic = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const SourceFixture = require("./fixtures/marketCalendar/partialSourcePreparationFixture.js");
const Acquisition = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const BojFixture = require("./fixtures/marketCalendar/bojCoverageFixture.js");
const BojParser = require("../js/marketCalendarRuntime/bojCoverageParser.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Native = require("../scripts/marketCalendarFormalFingerprintNative.js");

const BOJ = "jp-boj-calendar", BLS = "us-bls-calendar", BEA = "us-bea-calendar";
const compareCodeUnits = (left, right) => {
  const leftKey = String(left), rightKey = String(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};
async function japaneseBojRecords() {
  const context = { sourceId: BOJ, sourceUrl: "https://www.boj.or.jp/about/press/index.htm",
    fetchedAt: Acquisition.FETCHED_AT, parserId: "boj-calendar-v1", parserVersion: 1,
    rawContentHash: "a".repeat(64) }, parsed = BojParser.parseSpeeches(BojFixture.speeches(), context);
  assert.deepEqual(parsed.diagnostics, []);
  const selected = parsed.records.filter(value => ["浅田", "高田"].includes(
    value.speechIdentity.speakerId)), canonical = [];
  for (const value of selected) {
    const result = await Canonicalizer.canonicalize(value);
    assert.equal(result.ok, true, result.reason); canonical.push(structuredClone(result.event));
  }
  assert.equal(canonical.length, 2);
  return canonical;
}
async function fixture() {
  const baseline = await SourceFixture.snapshotWithSources([BOJ, BLS]), acquisition =
    await SourceFixture.replaceRecords(await Acquisition.validSource(BOJ), await japaneseBojRecords()),
    bojPlan = await Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(
      BOJ, baseline, acquisition));
  assert.equal(bojPlan.status, "ready_new_revision", bojPlan.reason);
  const before = await SourceFixture.applyPrepared(baseline, bojPlan), blsPlan =
    await Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(BLS, before,
      await SourceFixture.changedAcquisition(BLS)));
  assert.equal(blsPlan.status, "ready_new_revision", blsPlan.reason);
  const beaPlan = await Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(
    BEA, before));
  assert.equal(beaPlan.status, "ready_append_source", beaPlan.reason);
  const stale = await SourceFixture.applyPrepared(before, beaPlan);
  return { before, blsPlan, stale };
}

test("FF1-FF2 deterministic code-unit comparator orders Japanese and mixed keys", () => {
  const values = ["高田", "a", "浅田", "A", "2", "10", "あ"];
  assert.deepEqual(values.sort(compareCodeUnits), ["10", "2", "A", "a", "あ", "浅田", "高田"]);
  assert.equal(compareCodeUnits("浅田", "高田"), -1);
  assert.equal(compareCodeUnits("高田", "浅田"), 1);
  assert.equal(compareCodeUnits("浅田", "浅田"), 0);
});

test("FF4-FF5 ASCII ordering stays stable and snapshot fingerprints ignore input order", async () => {
  const descriptor = await SourceFixture.snapshotWithSources([BLS, BEA]), reverse = structuredClone(
    descriptor);
  for (const field of Preparation.SNAPSHOT_FIELDS) reverse[field].reverse();
  reverse.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(reverse);
  assert.equal(reverse.snapshotFingerprint, descriptor.snapshotFingerprint);
  const ascii = ["z", "a", "A", "10", "2"];
  assert.deepEqual([...ascii].sort(compareCodeUnits), [...ascii].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0));
});

test("FF3/FF6-FF8 real Chromium matches Node, commits BLS, and rejects a genuine stale DB", async () => {
  const { before, blsPlan, stale } = await fixture(), normal = await Native.run({
    snapshot: before, plan: blsPlan, operation: "append_source_revision" });
  assert.equal(normal.status, "PASS"); assert.equal(normal.realChromium, true);
  assert.equal(normal.before.fingerprint, before.snapshotFingerprint);
  assert.equal(normal.raw.status, "committed", normal.raw.reason);
  assert.equal(normal.raw.metrics.readwriteTransactions, 1);
  const finalized = await Atomic.finalizeAuthorizedRendererExecution(blsPlan,
    "append_source_revision", normal.raw);
  assert.equal(finalized.status, "committed", finalized.reason);
  const japanese = normal.before.eventKeys.filter(value => /浅田|高田/.test(value));
  assert.equal(japanese.length, 2); assert.match(japanese[0], /浅田/); assert.match(japanese[1], /高田/);
  const rejected = await Native.run({ snapshot: stale, plan: blsPlan,
    operation: "append_source_revision" });
  assert.notEqual(rejected.before.fingerprint, blsPlan.preconditions.formalSnapshotFingerprint);
  assert.equal(rejected.raw.status, "precondition_failed");
  assert.equal(rejected.raw.metrics.readwriteTransactions, 0);
  assert.equal(normal.networkAttempts + rejected.networkAttempts, 0);
});

test("FF9 malformed input remains fail-closed and FF10 schema/storage contract is unchanged", async () => {
  const { before } = await fixture(), malformed = structuredClone(before);
  malformed.entries.push({ sourceId: BLS });
  malformed.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(malformed);
  const result = await Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(
    BLS, malformed, await SourceFixture.changedAcquisition(BLS)));
  assert.equal(result.writeAllowed, false);
  assert.equal(result.status, "invalid_snapshot");
  assert.equal(Schema.VERSION, 1);
  assert.equal(Schema.EXPECTED_FINGERPRINT,
    "85248c8ec61ad4b554d77ee38e96088bc9b7fc0c3fc885e3af5332e7e02c2cbc");
  for (const file of ["js/marketCalendarHistory/formalControlledWriterCore.js",
    "js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js",
    "js/marketCalendarRuntime/formalShadowReadOnlyGate.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /localeCompare/);
  }
  const cycle = fs.readFileSync(path.join(__dirname, "..",
    "js/marketCalendarRuntime/formalShadowCycle.js"), "utf8");
  assert.match(cycle, /sort\(\(a, b\) => compareCodeUnits\(a\[key\], b\[key\]\)\)/);
  assert.doesNotMatch(cycle, /sort\(\(a, b\) => String\(a\[key\]\)\.localeCompare/);
  const plan = fs.readFileSync(path.join(__dirname, "..",
    "js/marketCalendarHistory/formalShadowWritePlan.js"), "utf8");
  assert.match(plan, /sort\(\(a, b\) =>\s*compareCodeUnits\(a\[key\], b\[key\]\)\)/);
  assert.doesNotMatch(plan, /sort\(\(a, b\) =>\s*String\(a\[key\]\)\.localeCompare/);
});
