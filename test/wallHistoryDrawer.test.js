"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Model = require("../js/wallHistoryDrawerModel.js");
const Selection = require("../js/wallHistoryChartSelection.js");

const wall = { wallIdentity: "qri-nikkei225-option|2026-10|60000|put", contract: "2026-10",
    strike: 60000, side: "put", firstSeenDate: "2026-09-10", maxOi: 120, maxOiDate: "2026-09-15",
    coverage: { observationCount: 3, observedCount: 2, missingCount: 1, notPublishedCount: 0,
        gapEventCount: 1, ivObservedCount: 1, referenceObservedCount: 0 },
    quality: { complete: false, gapBasis: "weekday" }, gapEvents: [{ afterTradingDate: "2026-09-10",
        beforeTradingDate: "2026-09-15", candidateDates: ["2026-09-11"], state: "gap" }],
    observations: [{ tradingDate: "2026-09-10", state: "observed", openInterest: 100,
        previousObservationDelta: null, rank: 2, rankChange: null, shrinkState: "not_shrinking",
        zeroState: "nonzero", iv: { status: "available", value: 22 }, ivChange: null,
        reference: { status: "missing", value: null }, priceDistance: null, sourceRevision: "oi-1" },
    { tradingDate: "2026-09-11", state: "missing", openInterest: null,
        previousObservationDelta: null, rank: null, rankChange: null, shrinkState: "unavailable",
        zeroState: "unavailable", iv: { status: "missing", value: null }, ivChange: null,
        reference: { status: "missing", value: null }, priceDistance: null, sourceRevision: "oi-2" },
    { tradingDate: "2026-09-15", state: "observed", openInterest: 120,
        previousObservationDelta: null, rank: 1, rankChange: null, shrinkState: "not_shrinking",
        zeroState: "nonzero", iv: { status: "missing", value: null }, ivChange: null,
        reference: { status: "missing", value: null }, priceDistance: null, sourceRevision: "oi-3" }] };

test("drawer modelは欠測、IV coverage、未保存factを保ちreference 0件を隠す", () => {
    const result = Model.build(wall, ["volume", "optionPrice", "settlement", "bid", "ask"]);
    assert.equal(result.reference, null);
    assert.deepEqual(result.observations.map(item => item.state), ["observed", "missing", "observed"]);
    assert.equal(result.observations[2].previousObservationDelta, null);
    assert.equal(result.coverage.ivObservedCount, 1);
    assert.equal(result.unavailableFacts.every(item => item.note === "未保存・推測なし"), true);
    assert.equal(Object.isFrozen(result), true);
});

test("referenceは厳密join実績がある場合だけoptional modelを作る", () => {
    const joined = structuredClone(wall); joined.coverage.referenceObservedCount = 1;
    joined.observations[0].reference = { status: "observed", value: 59800 };
    joined.observations[0].priceDistance = 200;
    assert.deepEqual(Model.build(joined).reference.observations,
        [{ tradingDate: "2026-09-10", price: 59800, priceDistance: 200 }]);
});

function chart(side = "call", hits = [{ datasetIndex: 0, index: 1 }]) { return { data: {
    labels: ["59,500", "60,000"], datasets: [{ optionSide: side }] },
getElementsAtEventForMode(event, mode, options, useFinalPosition) {
    assert.equal(mode, "nearest"); assert.deepEqual(options, { intersect: true });
    assert.equal(useFinalPosition, true); return hits; } }; }
const identity = { rendererKind: "formal", displayOnly: false, mode: "openInterest",
    contract: "2026-10", generation: 7 };

test("formal openInterestの実バーだけをoptionSide metadataで選択", () => {
    assert.deepEqual(Selection.select({ chart: chart(), event: {}, rendererIdentity: identity,
        currentIdentity: identity }), { contract: "2026-10", strike: 60000, side: "call",
        rendererGeneration: 7 });
    for (const invalid of [{ ...identity, rendererKind: "display_only" }, { ...identity, displayOnly: true },
        { ...identity, mode: "volume" }, { ...identity, contract: null }]) assert.equal(
        Selection.select({ chart: chart(), event: {}, rendererIdentity: invalid,
            currentIdentity: invalid }), null);
    assert.equal(Selection.select({ chart: chart("call", []), event: {}, rendererIdentity: identity,
        currentIdentity: identity }), null);
    assert.equal(Selection.select({ chart: chart(), event: {}, rendererIdentity: identity,
        currentIdentity: { ...identity, generation: 8 } }), null);
});

test("drag/touch相当のpointer移動後はclickを1回抑止", () => {
    const guard = Selection.createGestureGuard(8);
    guard.pointerDown({ clientX: 10, clientY: 10, pointerId: 1 });
    guard.pointerMove({ clientX: 40, clientY: 10, pointerId: 1 });
    guard.pointerUp({ pointerId: 1 });
    assert.equal(guard.shouldSuppressClick(), true);
    assert.equal(guard.shouldSuppressClick(), false);
});

test("HTML wiringはread-only drawerだけを追加し保護対象へ接続しない", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const runtime = fs.readFileSync(path.join(root, "js/wallHistoryDrawerRuntime.js"), "utf8");
    assert.match(html, /id="wallHistoryDrawer"[\s\S]*wallHistoryDrawerRuntime\.js/);
    assert.match(html, /id="wallHistoryIvUnavailable"[^>]*hidden/);
    assert.match(runtime, /runWallHistoryShadowEvaluation/);
    assert.doesNotMatch(runtime, /localStorage|readwrite|\.add\(|\.put\(|fetch\(/);
    for (const file of ["js/fullExportCollector.js", "js/overallJudgmentV2.js",
        "js/morningBaselineV4.js", "js/morningBaselineV5.js"]) assert.doesNotMatch(
        fs.readFileSync(path.join(root, file), "utf8"), /wallHistoryDrawer|WallHistoryDrawer/);
});
