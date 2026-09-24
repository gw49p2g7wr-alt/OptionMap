"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const safety = require("../js/jpxSnapshotSafety.js");

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.textContent = "";
        this.className = "";
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    get firstChild() { return this.children[0] || null; }
}
const document = { createElement: tagName => new FakeElement(tagName) };
function flatten(node) { return [node, ...node.children.flatMap(flatten)]; }

test("safe snapshot DOM renders hostile memo and tag as text only", () => {
    const memo = "<img src=x onerror=alert(1)>";
    const tag = "<b>danger</b>";
    const root = safety.buildSnapshotItemContent(document, {
        sourceDate: "2026-09-07T00:00:00.000Z", savedAt: "2026-09-07T01:00:00.000Z",
        memo, tags: [tag], labels: [40000]
    }, 0);
    const nodes = flatten(root);
    assert.equal(nodes.some(node => node.tagName === "IMG" || node.tagName === "B"), false);
    assert.equal(nodes.find(node => node.className === "snapshot-memo").textContent, `📝 ${memo}`);
    assert.equal(nodes.find(node => node.className === "snapshot-tag").textContent, tag);
    assert.ok(nodes.find(node => node.className === "edit-snapshot-memo-button"));
    assert.ok(nodes.find(node => node.className === "show-snapshot-button"));
});

test("non-array tags and non-string tag or memo fail safe", () => {
    for (const snapshot of [{ tags: "bad", memo: {} }, { tags: [123, "ok"], memo: null }]) {
        const nodes = flatten(safety.buildSnapshotItemContent(document, snapshot, 0));
        assert.equal(nodes.some(node => node.className === "snapshot-memo"), false);
        assert.equal(nodes.filter(node => node.className === "snapshot-tag").length,
            Array.isArray(snapshot.tags) ? 1 : 0);
    }
});

test("manual same-day merge preserves memo, tags and absent rich fields", () => {
    const existing = { sourceDate: "same", memo: "keep", tags: ["tag"], participant: { id: 1 },
        weeklyFutures: { versionKey: "v1" }, rich: true };
    const blank = safety.mergeManualSnapshot(existing, { sourceDate: "same", memo: "", tags: [],
        participant: null, labels: [1] });
    assert.equal(blank.memo, "keep");
    assert.deepEqual(blank.tags, ["tag"]);
    assert.deepEqual(blank.participant, { id: 1 });
    assert.deepEqual(blank.weeklyFutures, { versionKey: "v1" });
    assert.deepEqual(blank.labels, [1]);
    assert.equal(safety.mergeManualSnapshot(existing, { memo: "replace" }).memo, "replace");
    assert.deepEqual(existing.tags, ["tag"]);
});

test("historical merge updates acquired fields without shrinking rich snapshot", () => {
    const existing = { sourceDate: "2026-09-07T12:00:00Z", memo: "memo", tags: ["manual"],
        participant: { status: "verified" }, brokerData: { rich: true }, parsedDayData: { old: true } };
    const merged = safety.mergeHistoricalSnapshot(existing, {
        sourceDate: "2026-09-07T00:00:00Z", memo: "", tags: ["過去自動取得"],
        parsedDayData: { new: true }
    });
    assert.equal(merged.sourceDate, existing.sourceDate);
    assert.equal(merged.memo, "memo");
    assert.deepEqual(merged.tags, ["manual"]);
    assert.deepEqual(merged.participant, existing.participant);
    assert.deepEqual(merged.brokerData, existing.brokerData);
    assert.deepEqual(merged.parsedDayData, { new: true });
});

test("malformed and non-array storage fail closed", () => {
    assert.deepEqual(safety.parseSnapshotList("{"),
        { ok: false, value: null, reason: "malformed_json" });
    assert.deepEqual(safety.parseSnapshotList("{}"),
        { ok: false, value: null, reason: "invalid_snapshot_list" });
    assert.equal(safety.parseSnapshotList('[{"sourceDate":"date"}]').ok, true);
});

test("backfill status distinguishes saved, skipped, partial and all failed", () => {
    assert.match(safety.formatBackfillStatus({ saved: 2, skipped: 0, failed: 0 }), /完了.*保存 2件.*失敗 0件/);
    assert.match(safety.formatBackfillStatus({ saved: 0, skipped: 2, failed: 0 }), /完了.*スキップ 2件/);
    assert.match(safety.formatBackfillStatus({ saved: 1, skipped: 1, failed: 1 }), /一部.*失敗 1件/);
    assert.match(safety.formatBackfillStatus({ saved: 0, skipped: 0, failed: 2 }), /失敗しました.*失敗 2件/);
});

test("production UI hides unfinished AI settings while preserving IDs and boot dependency", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "js", "script.js"), "utf8");
    assert.match(html, /<div class="card ui-category-panel category-system" hidden>/);
    for (const id of ["brokerTemplate", "directionTemplate", "saveAiTemplateButton"]) {
        assert.match(html, new RegExp(`id=["']${id}["']`));
    }
    assert.match(script, /getElementById\("saveAiTemplateButton"\)/);
    assert.match(html, /<script src="js\/jpxSnapshotSafety\.js"><\/script>\s*<script src="js\/startupBootstrap\.js"><\/script>\s*<script src="js\/script\.js"><\/script>/);
});
