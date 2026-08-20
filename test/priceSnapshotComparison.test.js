const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const snapshotApi = require("../js/priceSnapshot.js");
const comparisonApi = require("../js/priceSnapshotComparison.js");

const GENERATED = "2026-08-21T00:00:00.000Z";
const summary = (price, contract = "2026-09") => ({ generatedAt: GENERATED,
    marketDate: "2026-08-21", sourceVersions: [],
    dataQuality: { status: "complete", warnings: [] }, payload: { currentPrice: {
        available: true, status: "available", value: price, source: "qri-nikkei225-futures",
        mode: "automatic", contract, quotedAt: GENERATED, fetchedAt: GENERATED } } });
const make = (price, observedAt, contract = "2026-09") => snapshotApi.createSnapshot({
    summary: summary(price, contract), rendererState: { currentPrice: { quotedAt: GENERATED } },
    observedAt });

test("two same-contract snapshots produce elapsed, delta, percent and upward direction", async () => {
    const previous = await make(40000, "2026-08-21T00:00:00.000Z");
    const current = await make(40100, "2026-08-21T01:12:00.000Z");
    const result = await comparisonApi.createPriceSnapshotComparison([previous, current]);
    assert.equal(result.available, true);
    assert.equal(result.previous.snapshotId, previous.snapshotId);
    assert.equal(result.current.snapshotId, current.snapshotId);
    assert.equal(result.elapsedMs, 72 * 60 * 1000);
    assert.equal(result.priceDelta, 100);
    assert.equal(result.percentChange, 0.25);
    assert.deepEqual([result.direction, result.directionLabel, result.arrow], ["up", "上昇", "↑"]);
});

test("negative and zero deltas map only by sign without a threshold", async () => {
    const previous = await make(40000, "2026-08-21T00:00:00.000Z");
    const down = await make(39999, "2026-08-21T00:18:00.000Z");
    const flat = await make(39999, "2026-08-21T00:36:00.000Z");
    const downward = await comparisonApi.createPriceSnapshotComparison([previous, down]);
    const neutral = await comparisonApi.createPriceSnapshotComparison([down, flat]);
    assert.deepEqual([downward.priceDelta, downward.direction, downward.directionLabel, downward.arrow],
        [-1, "down", "下落", "↓"]);
    assert.deepEqual([neutral.priceDelta, neutral.percentChange, neutral.direction,
        neutral.directionLabel, neutral.arrow], [0, 0, "neutral", "横ばい", "→"]);
});

test("one snapshot is a normal unavailable state", async () => {
    const only = await make(40000, "2026-08-21T00:00:00.000Z");
    const result = await comparisonApi.createPriceSnapshotComparison([only]);
    assert.equal(result.available, false);
    assert.equal(result.reason, "previous_comparable_unavailable");
    assert.equal(result.current.snapshotId, only.snapshotId);
});

test("rollover never compares different contracts", async () => {
    const previous = await make(40000, "2026-08-21T00:00:00.000Z", "2026-09");
    const current = await make(40500, "2026-08-21T01:00:00.000Z", "2026-12");
    const result = await comparisonApi.createPriceSnapshotComparison([previous, current]);
    assert.equal(result.available, false);
    assert.equal(result.reason, "contract_mismatch");
    assert.equal(result.boundary, "rollover_boundary");
    assert.equal(result.priceDelta, null);
    assert.equal(result.percentChange, null);
});

test("invalid signature and a zero previous price are rejected safely", async () => {
    const valid = await make(40000, "2026-08-21T00:00:00.000Z");
    const tampered = structuredClone(valid); tampered.price = 40001;
    const invalidSignature = await comparisonApi.createPriceSnapshotComparison([tampered]);
    assert.equal(invalidSignature.reason, "invalid_snapshot");
    assert.deepEqual(invalidSignature.validationErrors, ["semantic_signature_mismatch"]);
    const zero = structuredClone(valid); zero.price = 0;
    const zeroResult = await comparisonApi.createPriceSnapshotComparison([zero, valid]);
    assert.equal(zeroResult.available, false);
    assert.equal(zeroResult.reason, "invalid_snapshot");
});

test("unsorted records select latest and immediate previous same-contract only", async () => {
    const oldest = await make(40000, "2026-08-21T00:00:00.000Z");
    const otherContract = await make(50000, "2026-08-21T01:00:00.000Z", "2026-12");
    const previous = await make(40100, "2026-08-21T02:00:00.000Z");
    const latest = await make(40200, "2026-08-21T03:00:00.000Z");
    const result = await comparisonApi.createPriceSnapshotComparison(
        [latest, oldest, otherContract, previous]);
    assert.equal(result.current.snapshotId, latest.snapshotId);
    assert.equal(result.previous.snapshotId, previous.snapshotId);
    assert.equal(result.priceDelta, 100);
    assert.equal(result.elapsedMs, 60 * 60 * 1000);
});

test("integration is read-only history display and leaves protected modules disconnected", () => {
    const root = path.resolve(__dirname, "..");
    const moduleText = fs.readFileSync(path.join(root, "js/priceSnapshotComparison.js"), "utf8");
    const preview = fs.readFileSync(path.join(root, "js/mobileSummaryPreview.js"), "utf8");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(moduleText, /latestSnapshot\(records\)/);
    assert.match(moduleText, /previousComparableSnapshot\(records, latest\)/);
    assert.match(moduleText, /compareSnapshots\(previousResult\.snapshot, latest\)/);
    assert.doesNotMatch(moduleText, /resolveApproximatePrior|\bbuy\b|\bsell\b|score/i);
    assert.doesNotMatch(moduleText + preview, /\bfetch\s*\(|ipcRenderer|setInterval|setTimeout/);
    assert.match(preview, /OptionMapPriceSnapshotStore\.listAll\(\)/);
    assert.doesNotMatch(preview, /OptionMapPriceSnapshotStore\.(?:append|openStore|closeStore)\(/);
    assert.match(html, /前回観測比/);
    assert.match(html, /朝からの変化/);
});
