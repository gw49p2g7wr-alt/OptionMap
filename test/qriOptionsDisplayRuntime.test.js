const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriOptions.js");
const Runtime = require("../js/qriOptionsDisplayRuntime.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－"); cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function canonical(contract = "202609") {
    return Qri.parseQriOptionsPage(`<dt>最終更新時刻</dt><dd>2026/08/25 05:50</dd>
      <div id="futuresContractTab"><li class="active"><a>9月限月</a></li></div>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=${contract}&amp;lang=ja">CSV</a><table>${row("65,000")}</table>`, URL);
}
function saved(data = canonical()) {
    return { status: "candidate", displayEligible: true, canonical: data,
        freshness: { status: "stale", reason: "saved_last_valid" },
        candidate: { origin: "cache", contract: data.contract,
            fetchedAt: "2026-08-25T06:10:00Z" },
        diagnostics: { integrityVerified: true } };
}
function live(data = canonical()) {
    return { available: true, sourceStatus: "acquired", isCurrent: true,
        canonical: data, contract: data.contract, fetchedAt: "2026-08-25T06:20:00Z" };
}
function input(extra = {}) {
    return { mode: "auto", activeContract: "2026-09", liveStatus: "pending", ...extra };
}
function harness() {
    const calls = [];
    const runtime = Runtime.createQriOptionsDisplayRuntime({
        renderPositions: state => { calls.push(["positions", state]); return true; },
        clearPositions: options => { calls.push(["clear", options]); return true; },
        renderUi: state => calls.push(["ui", state]),
        preserveLegacy: state => calls.push(["legacy", state])
    });
    return { runtime, calls };
}

test("saved pending renders adapter arrays and saved UI only", () => {
    const { runtime, calls } = harness();
    const result = runtime.render(input({ bootShadowState: saved() }));
    assert.deepEqual([result.sourceKind, result.state, result.formalAnalysisRequested,
        result.legacyAnalysisRequested], ["saved", "saved_pending", false, false]);
    const display = calls.find(call => call[0] === "positions")[1];
    assert.deepEqual([display.labels, display.callValues, display.putValues],
        [["65,000"], [100], [200]]);
    assert.equal(calls.find(call => call[0] === "ui")[1].showSavedBadge, true);
});

test("saved fallback keeps formal and legacy analysis suppressed", () => {
    const { runtime, calls } = harness();
    const result = runtime.render(input({ liveStatus: "failed", bootShadowState: saved() }));
    assert.equal(result.state, "saved_fallback");
    assert.equal(result.runtimeState.sourceState.analysisPolicy.allowFormalAnalysis, false);
    assert.equal(result.runtimeState.sourceState.analysisPolicy.allowLegacyAnalysis, false);
    assert.equal(calls.some(call => call[0] === "legacy"), false);
});

test("live clears saved-only state without requesting formal analysis", () => {
    const { runtime, calls } = harness();
    const result = runtime.render(input({ liveStatus: "success", liveState: live(),
        bootShadowState: saved() }));
    assert.equal(result.sourceKind, "live");
    assert.equal(result.formalAnalysisRequested, false);
    assert.deepEqual(calls.find(call => call[0] === "clear")[1],
        { preserveCanvas: true, redrawFormal: false, reason: "live_source" });
    assert.equal(calls.find(call => call[0] === "ui")[1].visible, false);
});

test("legacy is preserved without rendering through saved path", () => {
    const { runtime, calls } = harness();
    const legacy = { available: true, positions: [
        { strike: 65000, callOpenInterest: 1, putOpenInterest: 2 }] };
    const result = runtime.render(input({ liveStatus: "failed",
        bootShadowState: { status: "missing" }, legacyFallbackState: legacy }));
    assert.equal(result.sourceKind, "legacy");
    assert.equal(calls.some(call => call[0] === "legacy"), true);
    assert.equal(calls.some(call => call[0] === "positions"), false);
});

test("specific never selects active saved or legacy", () => {
    const { runtime } = harness();
    const result = runtime.render(input({ mode: "specific", selectedContract: "2026-09",
        liveStatus: "failed", bootShadowState: saved(), legacyFallbackState: {
            available: true, positions: [{ strike: 1 }] } }));
    assert.deepEqual([result.sourceKind, result.state],
        ["unavailable", "specific_unavailable"]);
});

test("contract mismatch clears saved display as unavailable", () => {
    const { runtime, calls } = harness();
    const result = runtime.render(input({ activeContract: "2026-12",
        liveStatus: "failed", bootShadowState: saved() }));
    assert.deepEqual([result.sourceKind, result.state], ["unavailable", "contract_mismatch"]);
    assert.equal(calls.find(call => call[0] === "clear")[1].reason, "unavailable");
});

test("saved to live and live to saved use one renderer action per transition", () => {
    const { runtime, calls } = harness();
    runtime.render(input({ bootShadowState: saved() }));
    runtime.render(input({ liveStatus: "success", liveState: live(),
        bootShadowState: saved() }));
    runtime.render(input({ liveStatus: "failed", liveState: null,
        bootShadowState: saved() }));
    assert.deepEqual(calls.filter(call => ["positions", "clear"].includes(call[0]))
        .map(call => call[0]), ["positions", "clear", "positions"]);
});

test("stale delayed render cannot overwrite a newer generation", () => {
    const { runtime, calls } = harness();
    const oldGeneration = runtime.nextGeneration();
    const liveGeneration = runtime.nextGeneration();
    const liveResult = runtime.render(input({ liveStatus: "success", liveState: live() }),
        { generation: liveGeneration });
    const before = calls.length;
    const stale = runtime.render(input({ bootShadowState: saved() }),
        { generation: oldGeneration });
    assert.equal(liveResult.sourceKind, "live");
    assert.deepEqual([stale.applied, stale.reason, calls.length],
        [false, "stale_generation", before]);
});

test("unavailable clears an old saved display", () => {
    const { runtime, calls } = harness();
    runtime.render(input({ bootShadowState: saved() }));
    runtime.render(input({ liveStatus: "failed", bootShadowState: { status: "missing" } }));
    assert.equal(calls.at(-1)[0], "clear");
    assert.equal(calls.at(-1)[1].reason, "unavailable");
});

test("DOM renderer writes and clears badge message and metadata", () => {
    function element() { return { hidden: true, textContent: "", dataset: {} }; }
    const nodes = Object.fromEntries(["qriOptionsSavedSourceState", "qriOptionsSavedBadge",
        "qriOptionsSavedMessage", "qriOptionsSavedMetadata"].map(id => [id, element()]));
    const documentRef = { getElementById: id => nodes[id] || null };
    Runtime.renderSavedUiState({ visible: true, sourceKind: "saved",
        showSavedBadge: true, badgeText: "保存済み建玉", message: "保存済み建玉を表示中",
        severity: "neutral", contractText: "2026年9月限", tradingDateText: "2026/08/25",
        pageUpdatedAtText: "05:50", fetchedAtText: "8/25 15:10" }, documentRef);
    assert.equal(nodes.qriOptionsSavedBadge.textContent, "保存済み建玉");
    assert.equal(nodes.qriOptionsSavedMetadata.textContent,
        "2026年9月限 / 取引日 2026/08/25 / QRI更新 05:50 / 最終取得 8/25 15:10");
    Runtime.renderSavedUiState({ visible: false, sourceKind: "live" }, documentRef);
    assert.deepEqual([nodes.qriOptionsSavedSourceState.hidden,
        nodes.qriOptionsSavedBadge.textContent, nodes.qriOptionsSavedMessage.textContent],
    [true, "", ""]);
});

test("runtime source has no formal globals storage network timers or Chart", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsDisplayRuntime.js"), "utf8");
    assert.doesNotMatch(code, /allJpx|wall|Judgment|OverallV2|Morning|Observation|Snapshot/);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|\bChart\b|setTimeout|setInterval/);
});

test("renderer wiring uses safe display chart and keeps formal draw behind guard", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const ordered = ["qriOptionsDisplaySourceState.js", "qriOptionsSavedUiState.js",
        "qriOptionsDisplayPositionsAdapter.js", "qriOptionsDisplayRuntime.js"]
        .map(name => html.indexOf(`js/${name}`));
    assert.equal(ordered.every(value => value >= 0), true);
    assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);
    assert.match(html, /renderPositions\(display\)[\s\S]+?setQriContractDisplayData/);
    assert.match(html, /existingFallbackBlocked[\s\S]+?!existingFallbackBlocked && typeof window\.drawJpxPriceChart/);
    assert.match(html, /fallbackResult\?\.applied[\s\S]+?clearQriContractDisplayData\?\.\(\{ redraw: false \}\)/);
    const runtime = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsDisplayRuntime.js"), "utf8");
    assert.doesNotMatch(runtime, /drawJpxPriceChart/);
});

test("saved chart wiring uses adapter facts and never formal globals", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const wiring = html.slice(html.indexOf("const qriOptionsDisplayRuntime ="),
        html.indexOf("function refreshQriOptionsDisplay"));
    for (const fact of ["display.labels", "display.callValues", "display.putValues",
        "display.rows", "displayOnly: true"]) assert.equal(wiring.includes(fact), true);
    assert.doesNotMatch(wiring, /allJpx|wall|Judgment|OverallV2|drawJpxPriceChart/);
});

test("PC markup has one canvas and dedicated saved UI region", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal((html.match(/id="combinedPriceChart"/g) || []).length, 1);
    for (const id of ["qriOptionsSavedSourceState", "qriOptionsSavedBadge",
        "qriOptionsSavedMessage", "qriOptionsSavedMetadata"]) {
        assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
    }
});
