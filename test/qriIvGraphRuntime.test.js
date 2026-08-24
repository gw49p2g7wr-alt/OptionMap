const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const Runtime = require("../js/qriIvGraphRuntime.js");

function canonical(call = "20%", put = "21%", contract = "202609") {
    const rows = [39500, 40000, 40500].map((strike, index) => {
        const cells = Array(17).fill("-"); cells[5] = index ? call : "-";
        cells[8] = String(strike); cells[11] = index === 2 ? put : "-";
        return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
    }).join("");
    return Iv.parseQriOptionIvPage(`<dt>最終更新時刻</dt><dd>2026/08/25 06:00</dd>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=${contract}&amp;lang=ja">CSV</a><table>${rows}</table>`,
    "https://svc.qri.jp/jpx/nkopm/");
}
function live(data = canonical()) {
    return { available: true, sourceStatus: "acquired", canonical: data,
        contract: data.contract, fetchedAt: "2026-08-25T07:00:00Z",
        signature: "live-signature", versionKey: "live-version" };
}
function boot(data = canonical(), extra = {}) {
    return { status: "candidate", displayEligible: true,
        freshness: { status: "stale", reason: "saved_last_valid",
            displayEligible: true, calculationEligible: "undetermined" },
        candidate: { origin: "cache", contract: data.contract, canonical: data,
            fetchedAt: "2026-08-24T11:14:28.539Z" },
        diagnostics: { integrityVerified: true }, ...extra };
}
function input(extra = {}) {
    return { selection: { mode: "auto" }, activeContract: "2026-09",
        runtimeState: { active: null, selected: null }, bootShadowState: boot(),
        liveStatus: "pending", requestedRange: "plus_minus_3000",
        rangeUserSelected: false, currentPrice: { value: 40000, mode: "automatic",
            contract: "26年09月限" }, ...extra };
}

test("live source uses the existing graph view model with default radius", () => {
    const result = Runtime.buildQriIvGraphRuntimeState(input({
        runtimeState: { active: live(), selected: null }, liveStatus: "success" }));
    assert.deepEqual([result.source.sourceKind, result.rangePolicy.rangeMode,
        result.viewModel.available], ["live", "plus_minus_3000", true]);
});
test("saved pending passes source canonical directly and defaults to all", () => {
    const saved = canonical(); const result = Runtime.buildQriIvGraphRuntimeState(input({
        bootShadowState: boot(saved) }));
    assert.deepEqual([result.source.sourceKind, result.rangePolicy.rangeMode,
        result.viewModel.metadata.contract, result.uiState.showSavedBadge],
    ["saved", "all", saved.contract, true]);
});
test("saved radius is allowed only after explicit selection with matching automatic live price", () => {
    for (const mode of ["plus_minus_3000", "plus_minus_5000"]) {
        const result = Runtime.buildQriIvGraphRuntimeState(input({ requestedRange: mode,
            rangeUserSelected: true }));
        assert.deepEqual([result.rangePolicy.rangeMode, result.rangePolicy.currentPrice],
            [mode, 40000]);
    }
});
test("manual mismatched and missing prices safely return saved graph to all", () => {
    const prices = [{ value: 40000, mode: "manual", contract: "26年09月限" },
        { value: 40000, mode: "automatic", contract: "26年12月限" }, null];
    for (const currentPrice of prices) {
        const result = Runtime.buildQriIvGraphRuntimeState(input({ rangeUserSelected: true,
            currentPrice }));
        assert.deepEqual([result.rangePolicy.rangeMode, result.rangePolicy.radiusEnabled],
            ["all", false]);
    }
});
test("specific never uses active saved while matching selected live still works", () => {
    const unavailable = Runtime.buildQriIvGraphRuntimeState(input({ selection:
        { mode: "specific", contract: "2026-09" } }));
    const available = Runtime.buildQriIvGraphRuntimeState(input({ selection:
        { mode: "specific", contract: "2026-09" }, runtimeState:
        { active: null, selected: live() } }));
    assert.deepEqual([unavailable.source.state, available.source.state],
        ["selected_unavailable", "selected_live"]);
});
test("contract mismatch blocks saved canonical before the view model", () => {
    const result = Runtime.buildQriIvGraphRuntimeState(input({ activeContract: "2026-12" }));
    assert.deepEqual([result.source.state, result.viewModel.available],
        ["contract_mismatch", false]);
});
test("sparse and all-missing preserve formal view-model semantics", () => {
    const sparse = Runtime.buildQriIvGraphRuntimeState(input());
    const missing = Runtime.buildQriIvGraphRuntimeState(input({
        bootShadowState: boot(canonical("-", "-")) }));
    assert.equal(sparse.viewModel.series.call.values.includes(null), true);
    assert.deepEqual([missing.viewModel.state, missing.viewModel.chartAvailable,
        missing.uiState.severity], ["empty", false, "neutral"]);
    assert.match(missing.uiState.message, /IV公表データがありません/);
});
test("live supersede and failure recovery clear saved labels", () => {
    const saved = Runtime.buildQriIvGraphRuntimeState(input({ liveStatus: "failed" }));
    const recovered = Runtime.buildQriIvGraphRuntimeState(input({ runtimeState:
        { active: live(), selected: null }, bootShadowState: boot(canonical(), {
            status: "superseded", reason: "replaced_by_live" }), liveStatus: "success" }));
    assert.deepEqual([saved.uiState.severity, recovered.source.sourceKind,
        recovered.uiState.showSavedBadge, recovered.uiState.message,
        recovered.rangePolicy.rangeMode],
    ["caution", "live", false, null, "plus_minus_3000"]);
});
test("runtime active and selected inputs remain byte-identical", () => {
    const state = { active: live(), selected: live() };
    const before = JSON.stringify(state); Runtime.buildQriIvGraphRuntimeState(input({
        runtimeState: state, liveStatus: "success" }));
    assert.equal(JSON.stringify(state), before);
});
test("output is deeply frozen and explicitly calculation/storage isolated", () => {
    const result = Runtime.buildQriIvGraphRuntimeState(input());
    assert.equal([result, result.source, result.viewModel, result.uiState,
        result.rangePolicy, result.diagnostics].every(Object.isFrozen), true);
    assert.deepEqual([result.diagnostics.calculationConnected,
        result.diagnostics.storageConnected], [false, false]);
});
test("runtime helper has no DOM storage fetch timer Mobile Overall or calculation wiring", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/qriIvGraphRuntime.js"), "utf8");
    assert.doesNotMatch(source, /document\.|localStorage|indexedDB|\bfetch\s*\(|setTimeout|setInterval/);
    assert.doesNotMatch(source, /Mobile|OverallV2|calculateOption|currentPriceLine/);
});
test("renderer loads modules in dependency order and reuses one existing canvas", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const names = ["qriOptionIv.js", "qriIvGraphViewModel.js",
        "qriIvGraphSourceState.js", "qriIvSavedUiState.js", "qriIvGraphRuntime.js",
        "qriIvGraphView.js"];
    const positions = names.map(name => html.indexOf(`js/${name}`));
    assert.equal(positions.every((position, index) => position >= 0 &&
        (index === 0 || position > positions[index - 1])), true);
    assert.equal((html.match(/id="qriIvChart"/g) || []).length, 1);
    assert.match(html, /buildQriIvGraphRuntimeState/);
});
test("renderer wiring does not apply saved canonical or add fetch timer and storage operations", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const wiring = html.slice(html.indexOf("function renderQriIvGraph"),
        html.indexOf("function setQriContractSelectionNote"));
    assert.doesNotMatch(wiring, /currentQriOptionIv\s*=|localStorage|indexedDB|fetch-option-page/);
    assert.doesNotMatch(wiring, /setTimeout|setInterval|OverallV2|currentPriceLine/);
    assert.match(wiring, /buildQriIvGraphRuntimeState/);
    const helper = fs.readFileSync(path.join(__dirname, "../js/qriIvGraphRuntime.js"), "utf8");
    assert.match(helper, /canonical: source\.canonical/);
});
