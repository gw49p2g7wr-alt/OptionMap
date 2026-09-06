"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "js", "script.js"), "utf8");

function openingTag(id) {
    return html.match(new RegExp(`<[^>]+\\bid=["']${id}["'][^>]*>`))?.[0] || "";
}

test("Phase 3 controls have explicit accessible-name sources", () => {
    for (const [control, label] of [
        ["nightData", "nightDataLabel"],
        ["dayData", "dayDataLabel"],
        ["optionData", "optionDataLabel"],
        ["futureOpenInterestData", "futureOpenInterestDataLabel"]
    ]) {
        assert.match(openingTag(control), new RegExp(`aria-labelledby=["']${label}["']`));
        assert.match(openingTag(label), new RegExp(`id=["']${label}["']`));
    }
    for (const id of ["brokerTemplate", "directionTemplate", "currentPriceInput",
        "cumulativeBrokerSelect", "cumulativePeriodSelect"]) {
        assert.match(html, new RegExp(`<label\\b[^>]*for=["']${id}["'][^>]*>`));
    }
    assert.match(script, /textarea\.setAttribute\(\s*"aria-label",\s*`\$\{date\.toLocaleString\("ja-JP"\)\}のスナップショットメモ`/s);
});

test("all static IDs and ID references are valid", () => {
    const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of html.matchAll(/\b(?:for|aria-labelledby|aria-describedby|aria-controls)\s*=\s*["']([^"']+)["']/g)) {
        for (const id of match[1].trim().split(/\s+/)) assert.ok(ids.includes(id), `missing IDREF: ${id}`);
    }
});

test("textarea shares the existing focus-visible contract and snapshot display target is 40px", () => {
    assert.match(css, /button:focus-visible,\s*select:focus-visible,\s*input:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*3px solid rgba\(49, 95, 157, 0\.52\)[^}]*outline-offset:\s*2px/s);
    assert.match(css, /\.show-snapshot-button\s*\{[^}]*min-height:\s*40px/s);
});

test("user-triggered IV replacement restores only an enabled matching role", () => {
    assert.match(html, /const selectedRole = button\.dataset\.ivContractRole;[\s\S]*renderQriIvGraph\(\);[\s\S]*find\(item => item\.dataset\.ivContractRole === selectedRole\);[\s\S]*if \(selectedButton && !selectedButton\.disabled\) selectedButton\.focus\(\);/);
    const renderFunction = html.slice(html.indexOf("function renderQriIvGraph()"),
        html.indexOf('qriIvCurvePanel?.addEventListener("toggle"'));
    assert.doesNotMatch(renderFunction, /\.focus\(/);
});

test("snapshot memo editor names and manages focus without changing save storage", () => {
    assert.match(script, /editMemoButton\.dataset\.snapshotSourceDate = snapshot\.sourceDate \|\| ""/);
    assert.match(script, /editMemoButton\.insertAdjacentElement\([\s\S]*textarea\.focus\(\)/);
    assert.match(script, /cancelButton\.addEventListener\("click"[\s\S]*editor\.remove\(\);\s*editMemoButton\.focus\(\)/);
    assert.match(script, /snapshotMemoFocusRestoreSourceDate = snapshot\.sourceDate \|\| null;[\s\S]*localStorage\.setItem/);
    assert.match(script, /find\(button => button\.dataset\.snapshotSourceDate === sourceDate\);\s*editButton\?\.focus\(\)/);
});

test("important user-action feedback uses existing status semantics", () => {
    for (const id of ["snapshotSaveStatus", "historicalDataStatus", "currentPriceStatus"]) {
        assert.match(openingTag(id), /role=["']status["']/);
    }
    assert.match(script, /getElementById\("snapshotSaveStatus"\)/);
    assert.doesNotMatch(openingTag("snapshotSaveStatus"), /aria-live=/);
});

test("Phase 1 native details contract remains intact", () => {
    assert.equal((html.match(/<details\b/g) || []).length, 21);
    assert.equal((html.match(/<summary\b/g) || []).length, 21);
    assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:\s|=|>)/);
    assert.doesNotMatch(html, /aria-expanded=/);
    assert.doesNotMatch(html, /<summary\b[^>]*onkeydown=/);
});
