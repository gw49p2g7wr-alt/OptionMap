"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/mobileSummaryPreview.js"), "utf8");

function api() {
    const document = { addEventListener() {}, getElementById() { return null; },
        createElement() { return {}; } };
    const window = { document };
    vm.runInNewContext(source, { window, document, globalThis: window, console, Intl, Date,
        Object, Array, Number, String, Boolean, Math, JSON, Promise, Set, Map });
    return window.OptionMapMobileSummaryPreview;
}

test("前日calendar日保存と翌取引日marketDateを別々に表示する", () => {
    assert.equal(api().morningBaselineUpdateConfirmation(
        "2026-08-31", "2026-08-29T22:50:31.610Z"),
    "取引日2026-08-31の朝基準が保存済みです。\n" +
        "保存日時：2026-08-30 07:50\n現在の状態で更新しますか？");
});

test("同日保存でも取引日と保存日時を明示する", () => {
    assert.equal(api().morningBaselineUpdateConfirmation(
        "2026-08-31", "2026-08-30T22:50:31.610Z"),
    "取引日2026-08-31の朝基準が保存済みです。\n" +
        "保存日時：2026-08-31 07:50\n現在の状態で更新しますか？");
});

test("capturedAtはAsia/Tokyo固定でformatし旧確認文を残さない", () => {
    const message = api().morningBaselineUpdateConfirmation(
        "2026-01-01", "2025-12-31T15:05:00.000Z");
    assert.match(message, /保存日時：2026-01-01 00:05/);
    assert.doesNotMatch(message, /今日の朝基準|に保存済みです。現在/);
    assert.match(source, /timeZone: "Asia\/Tokyo"/);
    assert.doesNotMatch(source,
        /window\.confirm\(`今日の朝基準は\$\{savedAt\}に保存済みです/);
});
