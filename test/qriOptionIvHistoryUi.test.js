"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Selector = require("../js/qriOptionIvContractSelector.js");

const html = fs.readFileSync("index.html", "utf8");

function applyContractButtonDisabledMapping(choice) {
    const renderer = html.slice(html.indexOf("function renderQriIvContractSwitch"),
        html.indexOf("function renderQriIvGraph"));
    const assignment = renderer.match(/button\.disabled\s*=\s*[^;]+;/)?.[0];
    assert.ok(assignment, "contract button disabled mapping must exist");
    const button = { disabled: null };
    Function("item", "button", assignment)(choice, button);
    return button.disabled;
}

const historySource = (role, contract, versionKey) => ({
    available: true, role, origin: "history", sourceClass: "formal_history",
    formalStatus: "verified", contract, versionKey, canonical: { contract }
});

test("contract button DOM mapping enables every available fixed-role choice", () => {
    const choices = Selector.buildChoices({ defaultContract: "2026-09", historySources: {
        active: historySource("active", "2026-09", "active-v"),
        next: historySource("next", "2026-10", "next-v"),
        major_sq: historySource("major_sq", "2026-12", "major-v")
    } });
    assert.deepEqual(choices.map(choice => [choice.role, choice.available,
        applyContractButtonDisabledMapping(choice)]), [
        ["active", true, false], ["next", true, false], ["major_sq", true, false]
    ]);
});

test("contract button DOM mapping disables an unavailable choice without source field", () => {
    assert.equal(applyContractButtonDisabledMapping({ role: "active", contract: "2026-09",
        available: false, sourceKind: null, versionKey: null }), true);
    const renderer = html.slice(html.indexOf("function renderQriIvContractSwitch"),
        html.indexOf("function renderQriIvGraph"));
    assert.doesNotMatch(renderer, /item\.source\?\.available/);
});

test("restore dependencies load before graph resolver and Phase 2 persistence", () => {
    const ordered = ["qriOptionIv.js", "qriOptionIvHistory.js",
        "storage/qriOptionIvHistoryStore.js", "qriOptionIvHistoryRestore.js",
        "qriOptionIvContractSelector.js", "qriIvGraphSourceState.js",
        "qriIvGraphRuntime.js", "qriOptionIvHistoryPersistence.js"];
    const positions = ordered.map(name => html.indexOf(`js/${name}`));
    assert.equal(positions.every((position, index) => position >= 0 &&
        (index === 0 || position > positions[index - 1])), true);
});

test("renderer consumes restore state without direct IndexedDB lookup", () => {
    const wiring = html.slice(html.indexOf("function renderQriIvContractSwitch"),
        html.indexOf("function setQriContractSelectionNote"));
    assert.match(wiring, /getQriOptionIvHistoryRestoreState/);
    assert.match(wiring, /historySource/);
    assert.doesNotMatch(wiring, /indexedDB|getEntry|getActiveRevision|loadHistory/);
});

test("history UI is explicitly saved and includes Formal confirmation metadata", () => {
    assert.match(html, /正式履歴確認/);
    assert.match(html, /\["saved", "history"\]\.includes\(composed\.source\.sourceKind\)/);
    assert.match(html, /id="qriIvSavedBadge"[^>]*>保存済みIV</);
});

test("history context is invalidated on refresh and restored only from exact live context", () => {
    assert.match(html, /qriOptionIvHistoryRestore\.invalidateAll\("new_market_refresh"\)/);
    assert.match(html, /qriOptionIvHistoryRestore\.restore\("active", \{[\s\S]*contract: qriFact\.contract,[\s\S]*tradingDate: qriFact\.tradingDate/);
    assert.match(html, /qriOptionIvHistoryRestore\.restore\(role, \{[\s\S]*contract: input\.targetContract,[\s\S]*tradingDate: input\.referenceCanonical\?\.tradingDate/);
});

test("contract and range selection focus behavior remains event-driven", () => {
    const controls = html.slice(html.indexOf("qriIvContractSwitch?.addEventListener"),
        html.indexOf("window.renderQriIvGraph = renderQriIvGraph"));
    assert.match(controls, /const selectedRole = button\.dataset\.ivContractRole/);
    assert.match(controls, /selectedButton\.focus\(\)/);
    assert.doesNotMatch(controls, /qriIvContractSelection\s*=\s*["']active["']/);
    assert.match(controls, /qriIvRangeUserSelected = true/);
});

test("Phase 3 adds no Full Export, calculation, preload or network connection", () => {
    for (const file of ["js/fullExport.js", "js/fullExportCollector.js",
        "js/fullExportAiSummary.js", "preload.js", "js/overallJudgmentV2.js"]) {
        assert.equal(fs.readFileSync(file, "utf8").includes("qriOptionIvHistoryRestore"), false);
    }
    const restore = fs.readFileSync("js/qriOptionIvHistoryRestore.js", "utf8");
    assert.doesNotMatch(restore, /currentPrice|score|confidence|direction|coverage/);
});
