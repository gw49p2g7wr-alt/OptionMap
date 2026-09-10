const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/morningBaselineV4StatusView.js");

const restore = overrides => ({ restoreStatus: "valid", integrityStatus: "valid",
    applicabilityStatus: "applicable", reason: null,
    baseline: { capturedAt: "2026-09-07T06:36:00+09:00" }, ...overrides });

test("formal storage authority remains saved after the automatic window closes", () => {
    const model = View.createViewModel(restore(), { windowStatus: "outside_window_after" });
    assert.match(model.storageLabel, /06:36 保存済み/);
    assert.equal(model.automaticLabel, "自動取得：終了（05:00〜09:00）");
    assert.doesNotMatch(model.storageLabel, /保存されていません/);
});
test("valid but non-applicable storage is distinct from a missing baseline", () => {
    const outside = View.createViewModel(restore({ applicabilityStatus: "not_applicable",
        reason: "contract_mismatch", baseline: null }), null);
    const missing = View.createViewModel({ restoreStatus: "missing", integrityStatus: "missing",
        applicabilityStatus: "no_baseline", reason: "no_baseline" }, null);
    assert.equal(outside.storageLabel, "正式朝基準：保存済み（現在の正式scope対象外）");
    assert.equal(outside.restoreReason, "contract_mismatch");
    assert.equal(missing.storageLabel, "正式朝基準：本日は保存されていません");
});
test("invalid storage is never presented as missing", () => {
    const model = View.createViewModel({ restoreStatus: "invalid",
        integrityStatus: "integrity_invalid", reason: "integrity_invalid" }, null);
    assert.equal(model.storageStatus, "invalid");
    assert.equal(model.storageLabel, "正式朝基準：保存データを検証できません");
});
test("scheduler cutoff distinguishes ended-without-baseline from an ordinary missing state", () => {
    const missing = { restoreStatus: "missing", integrityStatus: "missing",
        applicabilityStatus: "no_baseline", reason: "no_baseline" };
    const model = View.createViewModel(missing, null, { status: "stopped",
        stoppedReason: "window_closed", windowState: "after" });
    assert.equal(model.storageLabel, "正式朝基準：本日は正式朝基準を取得できませんでした");
    assert.equal(model.automaticLabel, "自動取得：終了（05:00〜09:00）");
});
test("scheduler running, successful, and invalid-storage states remain factual", () => {
    const missing = { restoreStatus: "missing", integrityStatus: "missing",
        applicabilityStatus: "no_baseline", reason: "no_baseline" };
    assert.equal(View.createViewModel(missing, null, { status: "running",
        windowState: "inside" }).automaticLabel, "自動取得：09:00まで自動再試行中");
    assert.equal(View.createViewModel(restore(), null, { status: "stopped",
        stoppedReason: "baseline_applicable" }).automaticLabel, "自動取得：完了");
    const invalid = { restoreStatus: "invalid", integrityStatus: "integrity_invalid",
        reason: "integrity_invalid" };
    assert.match(View.createViewModel(invalid, null, { status: "stopped",
        stoppedReason: "storage_invalid" }).automaticLabel, /停止/);
});
test("manual formal save remains visible independently of an after-window attempt", () => {
    const model = View.createViewModel(restore(), { status: "outside_window",
        windowStatus: "outside_window_after", saved: false });
    assert.equal(model.storageStatus, "applicable");
    assert.match(model.storageLabel, /保存済み/);
    assert.match(model.automaticLabel, /終了/);
});
test("status view is pure, detached and deeply frozen", () => {
    const source = restore(); const before = structuredClone(source);
    const model = View.createViewModel(source, { status: "already_saved" });
    assert.deepEqual(source, before); assert.equal(Object.isFrozen(model), true);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
        "../js/morningBaselineV4StatusView.js"), "utf8"),
    /localStorage|sessionStorage|indexedDB|fetch\s*\(|document\.|setItem/);
});
