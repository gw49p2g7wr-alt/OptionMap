const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Runtime = require("../js/qriOptionsSavedReferenceRuntime.js");

class Element {
    constructor(id = null) {
        this.id = id; this.hidden = false; this.dataset = {}; this.className = "";
        this.children = []; this._text = "";
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = String(value ?? ""); this.children = []; }
    get childNodes() {
        return [...(this._text ? [{ textContent: this._text }] : []), ...this.children];
    }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this._text = ""; this.children = [...children]; }
}

const IDS = ["qriOptionsSavedReferenceState", "qriOptionsSavedReferenceTitle",
    "qriOptionsSavedReferenceSubtitle", "qriOptionsSavedReferenceCallLabel",
    "qriOptionsSavedReferenceCallList", "qriOptionsSavedReferenceCallEmpty",
    "qriOptionsSavedReferencePutLabel", "qriOptionsSavedReferencePutList",
    "qriOptionsSavedReferencePutEmpty", "qriOptionsSavedReferenceMetadata",
    "qriOptionsSavedReferenceNote"];

function documentFixture() {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.qriOptionsSavedReferenceState.hidden = true;
    return { nodes, document: { getElementById: id => nodes[id] || null,
        createElement: () => new Element() } };
}

function savedDisplay(generation = 7, state = "saved_fallback") {
    return { generation, sourceState: { available: true, sourceKind: "saved", state,
        contract: "2026-09", displayEligible: true,
        metadata: { contract: "2026-09", tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-25T05:50:00+09:00",
            fetchedAt: "2026-08-25T06:10:00Z" },
        freshness: { status: "stale", reason: "saved_last_valid",
            expectedTradingDate: "2026-08-25" },
        diagnostics: { savedIntegrityVerified: true } },
    positionsState: { available: true, sourceKind: "saved", state,
        contract: "2026-09", displayOnly: true,
        metadata: { contract: "2026-09", tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-25T05:50:00+09:00",
            fetchedAt: "2026-08-25T06:10:00Z" },
        rows: [
            { strike: 67000, callOpenInterest: 3250, putOpenInterest: 900,
                callPublished: true, putPublished: true },
            { strike: 62000, callOpenInterest: 800, putOpenInterest: 4100,
                callPublished: true, putPublished: true }
        ] } };
}

function liveDisplay(generation = 8, state = "live_available") {
    return { generation, sourceState: { available: true, sourceKind: "live", state,
        contract: "2026-09", metadata: { contract: "2026-09" } },
    positionsState: { available: true, sourceKind: "live", state,
        contract: "2026-09", displayOnly: true, rows: [] } };
}

function candidate(version = "saved-version") {
    return { contract: "2026-09", tradingDate: "2026-08-25",
        pageUpdatedAt: "2026-08-25T05:50:00+09:00",
        fetchedAt: "2026-08-25T06:10:00Z", canonicalSignature: "a".repeat(64),
        canonicalVersionKey: version };
}

function harness(initial = savedDisplay()) {
    const dom = documentFixture(); let display = initial; let savedIdentity = candidate();
    const runtime = Runtime.createQriOptionsSavedReferenceRuntime({
        getDisplayState: () => display, getSavedIdentity: () => savedIdentity,
        renderUi: ui => Runtime.renderQriOptionsSavedReferenceUi(ui, dom.document),
        clearUi: () => Runtime.clearQriOptionsSavedReferenceDom(dom.document)
    });
    return { ...dom, runtime, setDisplay: value => { display = value; },
        setIdentity: value => { savedIdentity = value; } };
}

test("saved pending and fallback render the dedicated reference card", async () => {
    for (const state of ["saved_pending", "saved_fallback"]) {
        const value = harness(savedDisplay(7, state));
        const result = await value.runtime.refresh();
        assert.deepEqual([result.status, result.referenceOnly,
            result.calculationEligible, value.nodes.qriOptionsSavedReferenceState.hidden],
        ["visible", true, false, false]);
        assert.equal(value.nodes.qriOptionsSavedReferenceTitle.textContent,
            "保存済み建玉からの参考情報");
    }
});

test("CALL PUT maximum metadata and note come from pure UI state", async () => {
    const value = harness(); await value.runtime.refresh();
    assert.deepEqual(value.nodes.qriOptionsSavedReferenceCallList.children.map(item =>
        item.childNodes[0].textContent), ["1. 67,000円　3,250枚", "2. 62,000円　800枚"]);
    assert.deepEqual(value.nodes.qriOptionsSavedReferencePutList.children.map(item =>
        item.childNodes[0].textContent), ["1. 62,000円　4,100枚", "2. 67,000円　900枚"]);
    assert.equal(value.nodes.qriOptionsSavedReferenceCallList.children[0]
        .children[0].textContent, "最大");
    assert.match(value.nodes.qriOptionsSavedReferenceMetadata.textContent,
        /限月：2026年9月限.*取引日：2026\/08\/25.*QRI更新/);
    assert.equal(value.nodes.qriOptionsSavedReferenceNote.textContent,
        "保存済みデータからの参考情報です。現在の相場判断には使用していません。");
    assert.equal(value.nodes.qriOptionsSavedReferenceState.dataset.severity, "neutral");
});

test("empty sides use UI state publication wording", async () => {
    const input = savedDisplay();
    input.positionsState.rows.forEach(row => {
        row.callPublished = false; row.callOpenInterest = null;
        row.putPublished = false; row.putOpenInterest = null;
    });
    const value = harness(input); await value.runtime.refresh();
    assert.deepEqual([value.nodes.qriOptionsSavedReferenceCallEmpty.textContent,
        value.nodes.qriOptionsSavedReferencePutEmpty.textContent],
    ["CALL：公表建玉なし", "PUT：公表建玉なし"]);
});

test("live legacy unavailable specific mismatch and superseded clear the DOM", async () => {
    const cases = [liveDisplay(),
        { generation: 8, sourceState: { sourceKind: "legacy", state: "legacy_fallback" } },
        { generation: 8, sourceState: { sourceKind: "unavailable", state: "unavailable" } },
        liveDisplay(8, "specific_live"),
        { generation: 8, sourceState: { sourceKind: "unavailable", state: "contract_mismatch" } },
        { generation: 8, sourceState: { sourceKind: "unavailable", state: "superseded" } }
    ];
    for (const display of cases) {
        const value = harness(); await value.runtime.refresh(); value.setDisplay(display);
        const result = await value.runtime.refresh();
        assert.equal(result.status, "hidden");
        assert.equal(value.nodes.qriOptionsSavedReferenceState.hidden, true);
        for (const id of IDS.filter(id => id !== "qriOptionsSavedReferenceState")) {
            assert.equal(value.nodes[id].textContent, "");
        }
    }
});

test("identity and generation changes at commit are rejected", async () => {
    for (const change of ["identity", "generation"]) {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const value = harness();
        const baseBuild = require("../js/qriOptionsSavedReferenceAnalysis.js")
            .buildQriOptionsSavedReferenceAnalysis;
        const runtime = Runtime.createQriOptionsSavedReferenceRuntime({
            getDisplayState: () => value.runtimeDisplay || savedDisplay(
                change === "generation" && value.changed ? 8 : 7),
            getSavedIdentity: () => candidate(change === "identity" && value.changed
                ? "changed-version" : "saved-version"),
            buildAnalysis: async input => { await gate; return baseBuild(input); },
            buildUi: input => require("../js/qriOptionsSavedReferenceUiState.js")
                .buildQriOptionsSavedReferenceUiState(input),
            renderUi: ui => Runtime.renderQriOptionsSavedReferenceUi(ui, value.document),
            clearUi: () => Runtime.clearQriOptionsSavedReferenceDom(value.document)
        });
        const pending = runtime.refresh(); value.changed = true; release();
        const result = await pending;
        assert.deepEqual([result.status, value.nodes.qriOptionsSavedReferenceState.hidden],
            ["hidden", true]);
    }
});

test("a delayed saved result cannot overwrite a newer live clear", async () => {
    let resolveBuild; const value = harness(); let display = savedDisplay();
    const runtime = Runtime.createQriOptionsSavedReferenceRuntime({
        getDisplayState: () => display, getSavedIdentity: () => candidate(),
        buildAnalysis: input => new Promise(resolve => { resolveBuild = () => resolve(
            require("../js/qriOptionsSavedReferenceAnalysis.js")
                .buildQriOptionsSavedReferenceAnalysis(input)); }),
        buildUi: input => require("../js/qriOptionsSavedReferenceUiState.js")
            .buildQriOptionsSavedReferenceUiState(input),
        renderUi: ui => Runtime.renderQriOptionsSavedReferenceUi(ui, value.document),
        clearUi: () => Runtime.clearQriOptionsSavedReferenceDom(value.document)
    });
    const delayed = runtime.refresh(); display = liveDisplay();
    const live = await runtime.refresh(); resolveBuild(); const stale = await delayed;
    assert.deepEqual([live.status, stale.applied, stale.reason],
        ["hidden", false, "stale_sequence"]);
    assert.equal(value.nodes.qriOptionsSavedReferenceState.hidden, true);
});

test("saved reference can reappear after a later fallback", async () => {
    const value = harness(); await value.runtime.refresh();
    value.setDisplay(liveDisplay()); await value.runtime.refresh();
    value.setDisplay(savedDisplay(9)); value.setIdentity(candidate("saved-version-2"));
    await value.runtime.refresh();
    assert.equal(value.nodes.qriOptionsSavedReferenceState.hidden, false);
});

test("DOM diagnostics match runtime output and clear after live recovery", async () => {
    const value = harness(); const visible = await value.runtime.refresh();
    const dom = Runtime.getQriOptionsSavedReferenceDomState(value.document);
    assert.deepEqual([visible.uiState.title, dom.title, visible.uiState.call.topItems.length,
        dom.call.items.length, visible.uiState.put.topItems.length, dom.put.items.length],
    [dom.title, "保存済み建玉からの参考情報", 2, 2, 2, 2]);
    value.setDisplay(liveDisplay()); await value.runtime.refresh();
    const cleared = Runtime.getQriOptionsSavedReferenceDomState(value.document);
    assert.deepEqual([cleared.visible, cleared.title, cleared.call.items,
        cleared.put.items, cleared.metadata, cleared.note],
    [false, null, [], [], null, null]);
});

test("runtime never receives or mutates formal state chart price or history", async () => {
    const protectedState = { formalGlobals: { labels: [1] }, wall: { call: "unchanged" },
        judgment: { score: 2 }, overall: { direction: 20 }, currentPrice: { value: 65000 },
        history: [{ versionKey: "formal" }], canvasCount: 1,
        chartIdentity: { rendererKind: "display_only", generation: 4 } };
    const before = JSON.stringify(protectedState); const value = harness();
    await value.runtime.refresh();
    assert.equal(JSON.stringify(protectedState), before);
});

test("module and renderer wiring have no protected-system connector", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedReferenceRuntime.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|setTimeout|setInterval/);
    assert.doesNotMatch(code, /allJpx|updateWallCandidates|calculateOptionMarketJudgment/);
    assert.doesNotMatch(code, /optionMapJudgmentState|OptionMapOverallJudgmentV2/);
    assert.doesNotMatch(code, /currentPrice|History|comparisonSnapshot|\bChart\b/);
    assert.doesNotMatch(code, /migration|backfill/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal((html.match(/id="combinedPriceChart"/g) || []).length, 1);
    const ordered = ["qriOptionsDisplaySourceState.js",
        "qriOptionsDisplayPositionsAdapter.js", "qriOptionsSavedReferenceAnalysis.js",
        "qriOptionsSavedReferenceUiState.js", "qriOptionsSavedReferenceRuntime.js"]
        .map(file => html.indexOf(`js/${file}`));
    assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);
});
