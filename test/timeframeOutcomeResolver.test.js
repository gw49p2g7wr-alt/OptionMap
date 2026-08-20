const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../js/timeframeOutcomeResolver.js");

const ORIGIN_AT = "2026-08-21T00:00:00.000Z";
const origin = (overrides = {}) => ({ asOf: ORIGIN_AT, price: 40000,
    contract: "2026-09", marketDate: "2026-08-21", ...overrides });
let sequence = 0;
const snapshot = (observedAt, price = 40100, contract = "2026-09", overrides = {}) => {
    sequence += 1;
    return { snapshotVersion: 1,
        snapshotId: `ps1-20260821030000000-${sequence.toString(16).padStart(16, "0")}`,
        observedAt, semanticSignature: "a".repeat(64), signatureAlgorithm: "sha256",
        generatedAt: observedAt, price, source: "test", mode: "automatic", contract,
        quotedAt: null, quotedAtRaw: null, quotedAtNormalized: null, fetchedAt: null,
        marketDate: "2026-08-21", tradingDate: null, calendarDay: "2026-08-21",
        session: "unknown", timeZone: "Asia/Tokyo",
        dataQuality: { availability: "available", status: "complete", warnings: [] },
        sourceVersionReference: null, ...overrides };
};
const resolve = (records, overrides = {}) => api.resolveApproximateFuture({ origin: origin(),
    targetMs: api.THREE_HOURS_MS, toleranceMs: 30 * 60 * 1000, records, targetType: "3h",
    ...overrides });

test("3h exact match returns only factual price outcome", () => {
    const result = resolve([snapshot("2026-08-21T03:00:00.000Z", 40200)]);
    assert.equal(result.available, true);
    assert.deepEqual([result.target.requestedAt, result.target.matchedAt,
        result.target.distanceFromTargetMs], ["2026-08-21T03:00:00.000Z",
        "2026-08-21T03:00:00.000Z", 0]);
    assert.deepEqual(result.result, { elapsedMs: api.THREE_HOURS_MS, priceDelta: 200,
        percentChange: 0.5, direction: "up" });
});

test("target inside tolerance resolves and outside tolerance stays unavailable", () => {
    const inside = resolve([snapshot("2026-08-21T03:20:00.000Z")]);
    assert.equal(inside.available, true);
    assert.equal(inside.target.distanceFromTargetMs, 20 * 60 * 1000);
    const outside = resolve([snapshot("2026-08-21T03:31:00.000Z")]);
    assert.deepEqual([outside.available, outside.reason],
        [false, "target_snapshot_unavailable"]);
});

test("only future same-contract records are candidates", () => {
    const records = [snapshot("2026-08-20T23:59:00.000Z", 50000),
        snapshot("2026-08-21T03:00:00.000Z", 40200, "2026-12"),
        snapshot("2026-08-21T03:10:00.000Z", 40100)];
    const result = resolve(records);
    assert.equal(result.target.price, 40100);
    assert.equal(result.target.contract, "2026-09");
});

test("different-contract candidates in the target window report rollover boundary", () => {
    const result = resolve([snapshot("2026-08-21T03:00:00.000Z", 40200, "2026-12")]);
    assert.deepEqual([result.available, result.reason], [false, "contract_mismatch"]);
});

test("nearest target wins; equal distance chooses earlier then lexical snapshot id", () => {
    const early = snapshot("2026-08-21T02:50:00.000Z", 39900);
    const late = snapshot("2026-08-21T03:10:00.000Z", 40300);
    assert.equal(resolve([late, early]).target.snapshotId, early.snapshotId);
    const duplicateA = snapshot("2026-08-21T03:00:00.000Z", 40100);
    const duplicateB = snapshot("2026-08-21T03:00:00.000Z", 40200);
    duplicateA.snapshotId = "ps1-20260821030000000-0000000000000002";
    duplicateB.snapshotId = "ps1-20260821030000000-0000000000000001";
    assert.equal(resolve([duplicateA, duplicateB]).target.snapshotId, duplicateB.snapshotId);
});

test("price sign alone produces up, down and neutral", () => {
    for (const [price, direction, delta] of [[40100, "up", 100], [39900, "down", -100],
        [40000, "neutral", 0]]) {
        const result = resolve([snapshot("2026-08-21T03:00:00.000Z", price)]);
        assert.deepEqual([result.result.direction, result.result.priceDelta], [direction, delta]);
    }
});

test("origin validation, invalid snapshot timestamp and empty records stop safely", () => {
    assert.equal(resolve([], { origin: origin({ asOf: "08/21 09:00" }) }).reason, "origin_invalid");
    const invalid = snapshot("2026-08-21T03:00:00.000Z"); invalid.observedAt = "invalid";
    assert.equal(resolve([invalid]).reason, "target_snapshot_unavailable");
    assert.equal(resolve([]).reason, "target_snapshot_unavailable");
});

test("elapsed must be positive and origin is never replaced from history", () => {
    const result = api.resolveApproximateFuture({ origin: origin(), targetMs: 1,
        toleranceMs: 1, records: [snapshot(ORIGIN_AT, 39900)] });
    assert.equal(result.reason, "target_snapshot_unavailable");
    const normal = resolve([snapshot("2026-08-21T03:00:00.000Z")]);
    assert.deepEqual(normal.origin, origin());
});

test("6h helper and configurable target/tolerance remain caller-controlled", () => {
    const six = api.resolveSixHour({ origin: origin(), toleranceMs: 0,
        records: [snapshot("2026-08-21T06:00:00.000Z")] });
    assert.deepEqual([six.available, six.targetType, six.result.elapsedMs],
        [true, "6h", api.SIX_HOURS_MS]);
    const custom = api.resolveThreeHour({ origin: origin(), targetMs: 4 * 60 * 60 * 1000,
        toleranceMs: 5 * 60 * 1000, records: [snapshot("2026-08-21T04:04:00.000Z")] });
    assert.equal(custom.available, true);
    assert.equal(custom.target.toleranceMs, 5 * 60 * 1000);
});

const morning = (overrides = {}) => ({ baselineId: "mb1-formal", baselineDay: "2026-08-22",
    capturedAt: "2026-08-21T20:10:00.000Z", validFrom: "2026-08-21T20:10:00.000Z",
    validUntil: "2026-08-23T00:00:00+09:00", sessionBoundary: "jst_calendar_day",
    currentPrice: { available: true, value: 40500, contract: "2026-09" }, ...overrides });

test("next morning uses explicit formal baseline price without guessing a time", () => {
    const result = api.resolveNextMorning({ origin: origin(), nextMorningBaseline: morning(),
        targetCalendarDay: "2026-08-22", priceSource: "baseline" });
    assert.equal(result.available, true);
    assert.deepEqual([result.target.source, result.target.matchedAt, result.target.price,
        result.target.snapshotId], ["morning_baseline", morning().capturedAt, 40500, null]);
});

test("next morning can explicitly use a same-contract snapshot near baseline capturedAt", () => {
    const record = snapshot("2026-08-21T20:15:00.000Z", 40400);
    const result = api.resolveNextMorning({ origin: origin(), nextMorningBaseline: morning(),
        targetCalendarDay: "2026-08-22", priceSource: "snapshot", toleranceMs: 10 * 60 * 1000,
        records: [record] });
    assert.deepEqual([result.available, result.target.source, result.target.snapshotId],
        [true, "price_snapshot", record.snapshotId]);
});

test("missing formal morning target and morning contract mismatch are unavailable", () => {
    const missing = api.resolveNextMorning({ origin: origin(), targetCalendarDay: "2026-08-22" });
    assert.equal(missing.reason, "next_morning_target_unavailable");
    const mismatch = api.resolveNextMorning({ origin: origin(), nextMorningBaseline: morning({
        currentPrice: { available: true, value: 40500, contract: "2026-12" } }),
    targetCalendarDay: "2026-08-22" });
    assert.equal(mismatch.reason, "contract_mismatch");
});

test("module is pure, runtime-only and disconnected from protected systems", () => {
    const root = path.resolve(__dirname, "..");
    const moduleText = fs.readFileSync(path.join(root, "js/timeframeOutcomeResolver.js"), "utf8");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.doesNotMatch(html, /timeframeOutcomeResolver/);
    assert.doesNotMatch(moduleText, /\bfetch\s*\(|indexedDB|localStorage|setInterval|setTimeout|persist|save|put\(/i);
    assert.doesNotMatch(moduleText, /hit.?rate|\bwin\b|\bloss\b|\bentry\b|\bMAE\b|\bMFE\b|prediction|score/i);
});
