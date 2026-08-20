const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../js/timeframeOutcomeLifecycle.js");

const TARGET = "2026-08-21T09:00:00.000Z";
const TOLERANCE = 30 * 60 * 1000;
const resolver = (available, reason = available ? null : "target_snapshot_unavailable") =>
    ({ available, reason });
const classify = (evaluatedAt, overrides = {}) => api.classifyOutcomeLifecycle({
    evaluatedAt, targetAt: TARGET, toleranceMs: TOLERANCE,
    resolverResult: resolver(false), targetType: "3h", ...overrides
});

test("target前とwindow開始前はpending", () => {
    const before = classify("2026-08-21T08:00:00.000Z");
    assert.deepEqual([before.status, before.reason, before.final],
        ["pending", "window_not_started", false]);
    assert.equal(before.windowStart, "2026-08-21T08:30:00.000Z");
});

test("window内は候補の有無にかかわらずpending", () => {
    const without = classify("2026-08-21T08:50:00.000Z");
    assert.deepEqual([without.status, without.reason, without.candidateAvailable],
        ["pending", "window_open", false]);
    const withCandidate = classify("2026-08-21T09:05:00.000Z",
        { resolverResult: resolver(true) });
    assert.deepEqual([withCandidate.status, withCandidate.reason,
        withCandidate.candidateAvailable, withCandidate.final],
    ["pending", "window_open", true, false]);
});

test("target到達後もwindowEndまではpending", () => {
    assert.equal(classify(TARGET, { resolverResult: resolver(true) }).status, "pending");
    assert.equal(classify("2026-08-21T09:29:59.999Z").status, "pending");
});

test("windowEndちょうどからresolver resultをfinal分類する", () => {
    const available = classify("2026-08-21T09:30:00.000Z",
        { resolverResult: resolver(true) });
    assert.deepEqual([available.status, available.reason, available.final],
        ["available", null, true]);
    assert.equal(available.windowEnd, "2026-08-21T09:30:00.000Z");
});

test("window終了後のsnapshot不足とcontract mismatchはunavailable", () => {
    const missing = classify("2026-08-21T09:31:00.000Z");
    assert.deepEqual([missing.status, missing.reason, missing.final],
        ["unavailable", "target_snapshot_unavailable", true]);
    const mismatch = classify("2026-08-21T09:31:00.000Z",
        { resolverResult: resolver(false, "contract_mismatch") });
    assert.deepEqual([mismatch.status, mismatch.reason], ["unavailable", "contract_mismatch"]);
});

test("resolverのorigin/window/elapsed異常は時刻にかかわらずinvalid", () => {
    for (const reason of ["origin_invalid", "window_invalid", "elapsed_invalid"]) {
        const state = classify("2026-08-21T08:00:00.000Z",
            { resolverResult: resolver(false, reason) });
        assert.deepEqual([state.status, state.reason, state.final], ["invalid", reason, true]);
    }
});

test("toleranceは呼び出し側設定で3h/6h共通state machineを使う", () => {
    const three = classify("2026-08-21T09:10:00.000Z",
        { toleranceMs: 5 * 60 * 1000, resolverResult: resolver(true), targetType: "3h" });
    const six = classify("2026-08-21T09:10:00.000Z",
        { toleranceMs: 5 * 60 * 1000, resolverResult: resolver(true), targetType: "6h" });
    assert.deepEqual([three.status, six.status], ["available", "available"]);
    assert.equal(three.windowEnd, six.windowEnd);
});

test("evaluatedAtとtimestamp/window入力は必須で不正ならinvalid", () => {
    assert.equal(api.classifyOutcomeLifecycle({ targetAt: TARGET, toleranceMs: 0,
        resolverResult: resolver(true), targetType: "3h" }).reason, "evaluated_at_invalid");
    assert.equal(classify("invalid").status, "invalid");
    assert.equal(classify(TARGET, { targetAt: "invalid" }).reason, "target_at_invalid");
    assert.equal(classify(TARGET, { toleranceMs: -1 }).reason, "window_invalid");
});

test("翌朝target未確定はdeadlineなし・deadline前ともpending", () => {
    const noDeadline = classify("2026-08-22T00:00:00.000Z", { targetType: "next_morning",
        targetAt: null, toleranceMs: undefined,
        resolverResult: resolver(false, "next_morning_target_unavailable") });
    assert.deepEqual([noDeadline.status, noDeadline.reason], ["pending", "target_not_established"]);
    const before = classify("2026-08-22T00:00:00.000Z", { targetType: "next_morning",
        targetAt: null, toleranceMs: undefined, targetDeadlineAt: "2026-08-22T01:00:00.000Z",
        resolverResult: resolver(false, "next_morning_target_unavailable") });
    assert.equal(before.status, "pending");
});

test("翌朝target未確定は明示deadline到達後にunavailable", () => {
    const state = classify("2026-08-22T01:00:00.000Z", { targetType: "next_morning",
        targetAt: null, toleranceMs: undefined, targetDeadlineAt: "2026-08-22T01:00:00.000Z",
        resolverResult: resolver(false, "next_morning_target_unavailable") });
    assert.deepEqual([state.status, state.reason, state.final],
        ["unavailable", "next_morning_target_unavailable", true]);
});

test("翌朝Baseline価格方式はtolerance 0でtarget到達時にavailable", () => {
    const state = classify(TARGET, { targetType: "next_morning", toleranceMs: 0,
        resolverResult: resolver(true) });
    assert.deepEqual([state.status, state.windowStart, state.windowEnd],
        ["available", TARGET, TARGET]);
});

test("翌朝snapshot方式はcapturedAtのwindow終了までpending", () => {
    const pending = classify("2026-08-21T09:10:00.000Z", { targetType: "next_morning",
        resolverResult: resolver(true) });
    assert.deepEqual([pending.status, pending.candidateAvailable], ["pending", true]);
    const final = classify("2026-08-21T09:30:00.000Z", { targetType: "next_morning",
        resolverResult: resolver(true) });
    assert.equal(final.status, "available");
});

test("historical評価も明示evaluatedAtだけで同じfinal結果を得る", () => {
    const historical = classify("2026-09-01T00:00:00.000Z",
        { resolverResult: resolver(true), targetType: "6h" });
    assert.deepEqual([historical.status, historical.final], ["available", true]);
});

test("moduleはpureで保存・UI・clock・外部accessへ接続しない", () => {
    const root = path.resolve(__dirname, "..");
    const moduleText = fs.readFileSync(path.join(root, "js/timeframeOutcomeLifecycle.js"), "utf8");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.doesNotMatch(html, /timeframeOutcomeLifecycle/);
    assert.doesNotMatch(moduleText, /Date\.now|new Date\(\)|\bfetch\s*\(|indexedDB|localStorage|setInterval|setTimeout/i);
    assert.doesNotMatch(moduleText, /persist|save|migration|schemaVersion/i);
    assert.doesNotMatch(moduleText, /prediction|hit|miss|\bwin\b|\bloss\b|buy|sell|score|threshold/i);
});
