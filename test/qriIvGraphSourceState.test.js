const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const Source = require("../js/qriIvGraphSourceState.js");

function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-"); cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function canonical(rows = row("40,000"), contract = "202609") {
    return Iv.parseQriOptionIvPage(`<dt>最終更新時刻</dt><dd>2026/08/25 06:00</dd>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=${contract}&amp;lang=ja">CSV</a><table>${rows}</table>`,
    "https://svc.qri.jp/jpx/nkopm/");
}
function live(data = canonical(), extra = {}) {
    return { available: true, sourceStatus: "acquired", reason: null, canonical: data,
        contract: data.contract, fetchedAt: "2026-08-25T07:00:00Z",
        calculationEligible: "existing_policy", ...extra };
}
function saved(data = canonical(), extra = {}) {
    return { status: "candidate", reason: null, displayEligible: true,
        calculationEligible: "undetermined",
        freshness: { status: "stale", reason: "saved_last_valid", origin: "cache",
            displayEligible: true, calculationEligible: "undetermined" },
        candidate: { origin: "cache", contract: data.contract, canonical: data,
            fetchedAt: "2026-08-25T06:00:00Z" },
        diagnostics: { integrityVerified: true }, ...extra };
}
function build(extra = {}) {
    return Source.buildQriIvGraphSourceState({ selectionMode: "auto",
        activeContract: "2026-09", liveStatus: "pending", ...extra });
}

test("auto selects matching live and always prefers it over saved", () => {
    const active = live(); const result = build({ activeRuntime: active,
        bootShadowState: saved(), liveStatus: "success" });
    assert.deepEqual([result.sourceKind, result.state, result.channel, result.contract],
        ["live", "live_available", "active", "2026-09"]);
    assert.equal(result.metadata.candidateOrigin, "live");
    assert.equal(result.calculationEligible, "existing_policy");
});
test("auto pending and failed select matching saved with distinct states", () => {
    for (const [liveStatus, state] of [["pending", "saved_pending"],
        ["failed", "saved_fallback"], ["unavailable", "saved_fallback"]]) {
        const result = build({ bootShadowState: saved(), liveStatus });
        assert.deepEqual([result.sourceKind, result.state, result.channel],
            ["saved", state, "active"]);
    }
});
test("saved stale is accepted and freshness is retained without calculation promotion", () => {
    const boot = saved(); const result = build({ bootShadowState: boot });
    assert.deepEqual(result.freshness, boot.freshness);
    assert.notStrictEqual(result.freshness, boot.freshness);
    assert.deepEqual([result.freshness.status, result.calculationEligible],
        ["stale", "undetermined"]);
});
test("display-ineligible missing invalid and integrity-unverified saved are rejected", () => {
    const cases = [null, saved(canonical(), { displayEligible: false }),
        saved(canonical(), { status: "invalid" }),
        saved(canonical(), { diagnostics: { integrityVerified: false } }),
        saved(canonical(), { candidate: { origin: "cache", contract: "2026-09",
            canonical: { invalid: true } } })];
    for (const bootShadowState of cases) {
        const result = build({ bootShadowState });
        assert.deepEqual([result.available, result.sourceKind], [false, "unavailable"]);
    }
});
test("superseded saved is never reused even when live canonical is absent", () => {
    const boot = saved(canonical(), { status: "superseded", reason: "replaced_by_live" });
    const result = build({ bootShadowState: boot, liveStatus: "failed" });
    assert.deepEqual([result.sourceKind, result.reason], ["unavailable", "saved_superseded"]);
});
test("saved requires explicit matching active contract", () => {
    const mismatch = build({ activeContract: "2026-12", bootShadowState: saved() });
    const unknown = build({ activeContract: null, bootShadowState: saved() });
    assert.deepEqual([mismatch.state, mismatch.reason, mismatch.canonical],
        ["contract_mismatch", "saved_contract_mismatch", null]);
    assert.deepEqual([unknown.reason, unknown.diagnostics.contractMatched],
        ["active_contract_unknown", null]);
});
test("auto ignores selected runtime", () => {
    const result = build({ selectedRuntime: live(), bootShadowState: null });
    assert.deepEqual([result.available, result.sourceKind], [false, "unavailable"]);
});
test("specific selects only matching selected live", () => {
    const result = Source.buildQriIvGraphSourceState({ selectionMode: "specific",
        selectedContract: "2026-09", selectedRuntime: live(), activeRuntime: live(),
        bootShadowState: saved(), liveStatus: "success" });
    assert.deepEqual([result.sourceKind, result.state, result.channel],
        ["live", "selected_live", "selected"]);
});
test("specific ignores active saved and rejects unavailable or mismatched selected", () => {
    for (const selectedRuntime of [null, live(canonical(), { contract: "2026-12" })]) {
        const result = Source.buildQriIvGraphSourceState({ selectionMode: "specific",
            selectedContract: "2026-09", selectedRuntime,
            bootShadowState: saved(), liveStatus: "failed" });
        assert.deepEqual([result.sourceKind, result.state, result.canonical],
            ["unavailable", "selected_unavailable", null]);
    }
});
test("sparse and all-missing valid saved canonicals remain selectable", () => {
    const fixtures = [canonical(row("40,000", "20%", "-")),
        canonical(row("40,000", "-", "-"))];
    for (const data of fixtures) {
        const result = build({ bootShadowState: saved(data) });
        assert.deepEqual([result.available, result.sourceKind], [true, "saved"]);
    }
    assert.deepEqual(Source.availableCounts(fixtures[1]), { call: 0, put: 0, total: 0 });
});
test("live and saved canonical outputs are detached and deeply frozen", () => {
    for (const input of [{ activeRuntime: live(), liveStatus: "success" },
        { bootShadowState: saved() }]) {
        const original = input.activeRuntime?.canonical || input.bootShadowState.candidate.canonical;
        const result = build(input);
        assert.notStrictEqual(result.canonical, original);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.canonical), true);
        assert.equal(Object.isFrozen(result.canonical.records), true);
        assert.equal(Object.isFrozen(result.rangePolicy), true);
    }
});
test("metadata and range policies preserve source meaning without CurrentPrice", () => {
    const liveResult = build({ activeRuntime: live(), liveStatus: "success" });
    const savedResult = build({ bootShadowState: saved() });
    assert.deepEqual([liveResult.metadata.tradingDate, liveResult.metadata.pageUpdatedAt,
        liveResult.metadata.fetchedAt, liveResult.metadata.candidateOrigin],
    ["2026-08-25", "2026-08-25T06:00:00+09:00",
        "2026-08-25T07:00:00Z", "live"]);
    assert.deepEqual([savedResult.metadata.candidateOrigin,
        savedResult.rangePolicy.defaultRange, savedResult.rangePolicy.allowLivePriceNavigation,
        savedResult.rangePolicy.allowSavedPriceNavigation], ["cache", "all", true, false]);
    assert.equal(liveResult.rangePolicy.defaultRange, "plus_minus_3000");
});
test("diagnostics contain technical selection facts", () => {
    const result = build({ bootShadowState: saved(), liveStatus: "pending" });
    assert.deepEqual([result.diagnostics.requestedMode, result.diagnostics.requestedContract,
        result.diagnostics.liveAvailable, result.diagnostics.savedAvailable,
        result.diagnostics.savedDisplayEligible, result.diagnostics.integrityVerified,
        result.diagnostics.contractMatched],
    ["auto", "2026-09", false, true, true, true, true]);
});
test("Phase 6.4 state table keeps live saved and selected semantics separate", () => {
    const cases = [
        [{ activeRuntime: live(), liveStatus: "success" },
            ["live", "live_available", true]],
        [{ bootShadowState: saved(), liveStatus: "pending" },
            ["saved", "saved_pending", true]],
        [{ bootShadowState: saved(), liveStatus: "failed" },
            ["saved", "saved_fallback", true]],
        [{ bootShadowState: null, liveStatus: "failed" },
            ["unavailable", "unavailable", false]],
        [{ activeContract: "2026-12", bootShadowState: saved(), liveStatus: "failed" },
            ["unavailable", "contract_mismatch", false]]
    ];
    for (const [input, expected] of cases) {
        const result = build(input);
        assert.deepEqual([result.sourceKind, result.state, result.available], expected);
        if (result.sourceKind === "saved") {
            assert.equal(result.metadata.candidateOrigin, "cache");
            assert.equal(result.calculationEligible, "undetermined");
        }
    }
    const specific = Source.buildQriIvGraphSourceState({ selectionMode: "specific",
        selectedContract: "2026-09", selectedRuntime: null,
        bootShadowState: saved(), liveStatus: "failed" });
    assert.deepEqual([specific.sourceKind, specific.state, specific.available],
        ["unavailable", "selected_unavailable", false]);
});
test("inputs are unchanged and source has no forbidden connections", () => {
    const input = { selectionMode: "auto", activeContract: "2026-09",
        activeRuntime: live(), bootShadowState: saved(), liveStatus: "success" };
    const before = JSON.stringify(input); Source.buildQriIvGraphSourceState(input);
    assert.equal(JSON.stringify(input), before);
    const source = fs.readFileSync(path.join(__dirname, "../js/qriIvGraphSourceState.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(source, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|Chart/);
    assert.doesNotMatch(source, /GraphViewModel|OptionMapCurrentPrice|OverallV2|History/);
    assert.doesNotMatch(source, /input\.(currentPrice|savedPrice)/);
    assert.doesNotMatch(source, /setTimeout|setInterval|currentQriOptionIv/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriIvGraphSourceState.js"), true);
    assert.equal(html.indexOf("qriOptionIv.js") <
        html.indexOf("qriIvGraphSourceState.js"), true);
});
