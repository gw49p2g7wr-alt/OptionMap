"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Contract = require("../js/wallHistoryContract.js");
const Projection = require("../js/wallHistoryProjection.js");
const Comparison = require("../js/qriOptionsHistoryComparison.js");

const signature = value => value.repeat(64);
function revision(contract, tradingDate, versionKey, records, marker = "a") {
    const month = Number(contract.slice(5));
    return { contract, tradingDate, versionKey, signature: signature(marker), replacedAt: null,
        openInterestStatus: "available", pageUpdatedAt: `${tradingDate}T06:00:00+09:00`,
        canonical: { parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/", pageUpdatedAt: `${tradingDate}T06:00:00+09:00`,
            tradingDate, openInterestAsOf: null, contract, gengetsu: contract.replace("-", ""),
            contractLabel: `${month}月限月`, isActiveContract: true, lastTradingDate: `${contract}-10`,
            openInterestStatus: "available", availableContracts: [{ contract, label: `${month}月限月`,
                url: "https://svc.qri.jp/jpx/nkopm/", active: true }],
            records: records.map(record => ({ contract, ...record })) } };
}
function entry(contract, tradingDate, revisionValue) {
    return { entryKey: `${contract}|${tradingDate}`, contract, sourceDateKey: tradingDate,
        activeVersionKey: revisionValue.versionKey, revisions: [revisionValue] };
}
function fixture() {
    const contract = "2026-10";
    const r1 = revision(contract, "2026-09-11", "oi-1", [
        { optionType: "call", strike: 64000, published: true, value: 100 },
        { optionType: "call", strike: 64500, published: true, value: 100 },
        { optionType: "put", strike: 64000, published: false, value: null },
        { optionType: "put", strike: 64500, published: true, value: 50 }
    ]);
    const replaced = { ...revision(contract, "2026-09-15", "oi-old", [], "b"),
        replacedAt: "2026-09-15T08:00:00Z" };
    const r2 = revision(contract, "2026-09-15", "oi-2", [
        { optionType: "call", strike: 64000, published: true, value: 0 },
        { optionType: "call", strike: 64500, published: false, value: null },
        { optionType: "call", strike: 65000, published: true, value: 150 },
        { optionType: "put", strike: 64000, published: true, value: 80 },
        { optionType: "put", strike: 64500, published: false, value: null },
        { optionType: "put", strike: 65000, published: false, value: null }
    ], "c");
    const second = entry(contract, "2026-09-15", r2);
    second.revisions.unshift(replaced);
    const ivRevision = { versionKey: "iv-2", replacedAt: null, canonical: { records: [
        { optionType: "call", strike: 64000, iv: { status: "available", value: 24 } },
        { optionType: "put", strike: 64000, iv: { status: "missing", value: null } }
    ] } };
    return { contract, r1, r2, qriOptionsHistory: { entries: [entry(contract, "2026-09-11", r1), second] },
        qriOptionIvHistory: { entries: [{ contract, tradingDate: "2026-09-15",
            activeVersionKey: "iv-2", revisions: [ivRevision] }] }, priceSnapshots: [{ price: 63800,
            contract, tradingDate: "2026-09-15", observedAt: "2026-09-15T08:00:00Z",
            quotedAtNormalized: "2026-09-15T07:59:00Z", snapshotId: "price-1",
            sourceVersionReference: { contract, tradingDate: "2026-09-15",
                versionKey: "oi-2", signature: signature("c") } }] };
}

test("Phase 0 identityは限月とCALL/PUTを境界にしsource revisionは観測identityに置く", () => {
    const call = Contract.wallIdentity("2026-10", 64000, "call");
    assert.equal(call, "qri-nikkei225-option|2026-10|64000|call");
    assert.notEqual(call, Contract.wallIdentity("2026-11", 64000, "call"));
    assert.notEqual(call, Contract.wallIdentity("2026-10", 64000, "put"));
    assert.match(Contract.observationIdentity(call, "2026-09-15", "oi-2"), /\|oi-2$/);
});

test("active OIだけを投影しcompetition rank、delta、zero、first/maxを導出", () => {
    const result = Projection.projectWallHistory(fixture());
    const wall = result.walls.find(item => item.strike === 64000 && item.side === "call");
    assert.equal(wall.firstSeenDate, "2026-09-11");
    assert.equal(wall.maxOi, 100); assert.equal(wall.maxOiDate, "2026-09-11");
    assert.equal(wall.observations[0].rank, 1);
    assert.equal(result.walls.find(item => item.strike === 64500).observations[0].rank, 1);
    assert.equal(wall.observations[1].sourceRevision, "oi-2");
    assert.equal(wall.observations[1].previousObservationDelta, -100);
    assert.equal(wall.observations[1].zeroState, "zero_confirmed");
    assert.equal(wall.observations[1].shrinkState, "zero_confirmed");
});

test("missing、notPublished、gap、observedを混同しない", () => {
    const result = Projection.projectWallHistory(fixture());
    const put = result.walls.find(item => item.strike === 64000 && item.side === "put");
    assert.deepEqual(put.observations.map(item => item.state), ["notPublished", "observed"]);
    assert.equal(put.observations[1].previousObservationDelta, null);
    const newWall = result.walls.find(item => item.strike === 65000);
    assert.deepEqual(newWall.observations.map(item => item.state), ["missing", "observed"]);
    assert.deepEqual(put.gapEvents[0].candidateDates, ["2026-09-14"]);
    assert.match(result.semantics.derived.nonDisappearance, /notPublished_missing_gap/);
});

test("notPublishedやmissingを飛び越えてdelta・rank change・IV changeを算出しない", () => {
    const source = fixture();
    const result = Projection.projectWallHistory(source);
    const newWall = result.walls.find(item => item.strike === 65000 && item.side === "call");
    assert.equal(newWall.observations[1].previousObservationTradingDate, "2026-09-11");
    assert.equal(newWall.observations[1].previousObservedTradingDate, null);
    assert.equal(newWall.observations[1].previousObservationDelta, null);
    const put = result.walls.find(item => item.strike === 64000 && item.side === "put");
    assert.equal(put.observations[1].previousObservationDelta, null);
});

test("IV exact joinとQRI revision完全一致Price Snapshotだけを採用", () => {
    const source = fixture(); source.priceSnapshots.push({ ...source.priceSnapshots[0], price: 1,
        snapshotId: "wrong", observedAt: "2026-09-15T09:00:00Z",
        sourceVersionReference: { ...source.priceSnapshots[0].sourceVersionReference, versionKey: "wrong" } });
    const result = Projection.projectWallHistory(source);
    const current = result.walls.find(item => item.strike === 64000 && item.side === "call").observations[1];
    assert.equal(current.iv.value, 24); assert.equal(current.reference.value, 63800);
    assert.equal(current.priceDistance, 200); assert.equal(current.reference.mapping, "exact_qri_source_revision");
    assert.equal(result.walls.find(item => item.side === "put").observations[1].iv.status, "missing");
});

test("既存前回比較のdeltaとWall History最新観測が整合する", () => {
    const source = fixture();
    const compared = Comparison.compareRevisions(source.r1, source.r2, { contract: source.contract,
        previousSourceDate: "2026-09-11", currentSourceDate: "2026-09-15" });
    const existing = compared.comparison.byType.call.records.find(item => item.strike === 64000);
    const projected = Projection.projectWallHistory(source).walls.find(item =>
        item.strike === 64000 && item.side === "call").observations.at(-1);
    assert.equal(projected.previousObservationDelta, existing.delta);
});

test("最大建玉は各日side内のrank 1と一致し未知metricを生成しない", () => {
    const result = Projection.projectWallHistory(fixture());
    for (const tradingDate of ["2026-09-11", "2026-09-15"]) {
        const observed = result.walls.flatMap(wall => wall.observations.filter(item =>
            wall.side === "call" && item.tradingDate === tradingDate && item.state === "observed")
            .map(item => ({ wall, item })));
        const maximum = Math.max(...observed.map(({ item }) => item.openInterest));
        assert.equal(observed.filter(({ item }) => item.rank === 1)
            .every(({ item }) => item.openInterest === maximum), true);
    }
    assert.deepEqual(result.unavailableMetrics, ["volume", "optionPrice", "settlement", "bid", "ask"]);
    assert.equal(result.diagnostics.inferredUnavailableMetrics, false);
});

test("JSON getterのみを公開しUI、Full Export、Overall、Morningへ接続しない", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    assert.match(html, /wallHistoryContract\.js[\s\S]*wallHistoryProjection\.js/);
    for (const file of ["js/fullExportCollector.js", "js/overallJudgmentV2.js", "js/morningBaselineV4.js",
        "js/morningBaselineV5.js", "js/script.js"]) {
        assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /WallHistory/);
    }
    const projectionSource = fs.readFileSync(path.join(__dirname, "..", "js/wallHistoryProjection.js"), "utf8");
    assert.doesNotMatch(projectionSource, /localStorage|indexedDB|\.add\(|\.put\(|readwrite|fetch\(/);
});
