const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriOptions.js");
const Source = require("../js/qriOptionsDisplaySourceState.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－"); cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function canonical(contract = "202609", call = "100", put = "200") {
    return Qri.parseQriOptionsPage(`<dt>最終更新時刻</dt><dd>2026/08/25 05:50</dd>
      <div id="futuresContractTab"><li class="active"><a href="javascript:void(0)">9月限月</a></li></div>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=${contract}&amp;lang=ja">CSV</a><table>${row("65,000", call, put)}</table>`, URL);
}
function live(data = canonical(), extra = {}) {
    return { available: true, sourceStatus: "acquired", isCurrent: true,
        canonical: data, contract: data.contract, fetchedAt: "2026-08-25T06:10:00Z",
        calculationEligible: "existing_policy", ...extra };
}
function saved(data = canonical(), extra = {}) {
    return { status: "candidate", reason: null, displayEligible: true,
        calculationEligible: "undetermined", canonical: data,
        freshness: { status: "stale", reason: "saved_last_valid", origin: "cache",
            displayEligible: true, calculationEligible: "undetermined" },
        candidate: { origin: "cache", contract: data.contract,
            fetchedAt: "2026-08-25T06:10:00Z" },
        diagnostics: { integrityVerified: true }, ...extra };
}
function legacy(extra = {}) {
    return { available: true, valid: true, positions: [{ strike: 65000,
        callOpenInterest: 100, putOpenInterest: 200 }],
        sourceDate: "2026-08-24T06:00:00+09:00",
        sourceDateKind: "qri_page_last_updated",
        fetchedAt: "2026-08-24T06:10:00Z",
        calculationEligible: "existing_legacy_policy", ...extra };
}
function build(extra = {}) {
    return Source.buildQriOptionsDisplaySourceState({ mode: "auto",
        activeContract: "2026-09", liveStatus: "pending", ...extra });
}

test("matching current formal live has priority over saved and legacy", () => {
    const result = build({ liveState: live(), bootShadowState: saved(),
        legacyFallbackState: legacy(), liveStatus: "success" });
    assert.deepEqual([result.sourceKind, result.state, result.available],
        ["live", "live_available", true]);
    assert.deepEqual(result.analysisPolicy, { allowFormalAnalysis: true,
        allowLegacyAnalysis: false, calculationSourcePolicy: "existing_live_policy",
        reason: null });
});

test("pending auto selects matching saved as display-only", () => {
    const result = build({ bootShadowState: saved(), legacyFallbackState: legacy() });
    assert.deepEqual([result.sourceKind, result.state, result.calculationEligible],
        ["saved", "saved_pending", "undetermined"]);
    assert.deepEqual(result.analysisPolicy, { allowFormalAnalysis: false,
        allowLegacyAnalysis: false, calculationSourcePolicy: "none",
        reason: "saved_display_only" });
    assert.equal(result.diagnostics.analysisSuppressed, true);
});

test("network parser source failure and OI unavailable select saved fallback", () => {
    for (const liveStatus of ["failed", "parser_error", "source_error", "success"]) {
        const result = build({ liveStatus, liveState: live(canonical("202609", "－", "－"),
            { available: false, sourceStatus: "unavailable" }), bootShadowState: saved() });
        assert.deepEqual([result.sourceKind, result.state], ["saved", "saved_fallback"]);
    }
});

test("stale saved remains display eligible without calculation promotion", () => {
    const boot = saved(); const result = build({ bootShadowState: boot });
    assert.deepEqual([result.freshness.status, result.displayEligible,
        result.calculationEligible], ["stale", true, "undetermined"]);
    assert.notStrictEqual(result.freshness, boot.freshness);
});

test("partial and unavailable formal live are never live display sources", () => {
    for (const data of [canonical("202609", "100", "－"),
        canonical("202609", "－", "－")]) {
        const result = build({ liveState: live(data), liveStatus: "success",
            bootShadowState: saved() });
        assert.deepEqual([result.sourceKind, result.state], ["saved", "saved_fallback"]);
    }
});

test("saved contract mismatch blocks unverifiable legacy fallback", () => {
    const result = build({ activeContract: "2026-12", bootShadowState: saved(),
        legacyFallbackState: legacy(), liveStatus: "failed" });
    assert.deepEqual([result.sourceKind, result.state, result.reason],
        ["unavailable", "contract_mismatch", "saved_contract_mismatch"]);
    assert.equal(result.diagnostics.legacyRejectedReason, "legacy_contract_unverifiable");
});

test("invalid tampered or integrity-unverified saved blocks legacy", () => {
    const cases = [saved(canonical(), { status: "invalid" }),
        saved(canonical(), { status: "tampered" }),
        saved(canonical(), { diagnostics: { integrityVerified: false } }),
        saved(canonical(), { reason: "signature_invalid" })];
    for (const bootShadowState of cases) {
        const result = build({ bootShadowState, legacyFallbackState: legacy(),
            liveStatus: "failed" });
        assert.deepEqual([result.available, result.sourceKind, result.reason],
            [false, "unavailable", "saved_integrity_invalid"]);
        assert.equal(result.analysisPolicy.allowLegacyAnalysis, false);
    }
});

test("display-ineligible saved is not selected", () => {
    const result = build({ bootShadowState: saved(canonical(),
        { displayEligible: false }), liveStatus: "failed" });
    assert.deepEqual([result.available, result.sourceKind], [false, "unavailable"]);
});

test("missing saved preserves auto legacy compatibility and its policy metadata", () => {
    const result = build({ bootShadowState: { status: "missing" },
        legacyFallbackState: legacy(), liveStatus: "failed" });
    assert.deepEqual([result.sourceKind, result.state, result.canonical],
        ["legacy", "legacy_fallback", null]);
    assert.deepEqual([result.analysisPolicy.allowLegacyAnalysis,
        result.analysisPolicy.calculationSourcePolicy],
    [true, "existing_legacy_policy"]);
    assert.equal(result.metadata.origin, "legacy");
});

test("specific uses only matching selected live", () => {
    const result = Source.buildQriOptionsDisplaySourceState({ mode: "specific",
        selectedContract: "2026-09", liveStatus: "success", liveState: live(),
        bootShadowState: saved(), legacyFallbackState: legacy() });
    assert.deepEqual([result.sourceKind, result.state], ["live", "specific_live"]);
});

test("specific never uses active saved or legacy", () => {
    const result = Source.buildQriOptionsDisplaySourceState({ mode: "specific",
        selectedContract: "2026-09", liveStatus: "failed", liveState: null,
        bootShadowState: saved(), legacyFallbackState: legacy() });
    assert.deepEqual([result.sourceKind, result.state, result.available],
        ["unavailable", "specific_unavailable", false]);
    assert.equal(result.analysisPolicy.allowLegacyAnalysis, false);
});

test("superseded saved is never reselected and does not expose legacy analysis", () => {
    const boot = saved(canonical(), { status: "superseded", reason: "replaced_by_live" });
    const result = build({ bootShadowState: boot, legacyFallbackState: legacy(),
        liveStatus: "failed" });
    assert.deepEqual([result.sourceKind, result.reason], ["unavailable", "saved_superseded"]);
    assert.equal(result.analysisPolicy.allowLegacyAnalysis, false);
});

test("canonical and positions are detached and the whole result is deeply frozen", () => {
    for (const input of [{ liveState: live(), liveStatus: "success" },
        { bootShadowState: saved() }, { bootShadowState: { status: "missing" },
            legacyFallbackState: legacy(), liveStatus: "failed" }]) {
        const originalCanonical = input.liveState?.canonical || input.bootShadowState?.canonical;
        const originalPositions = input.legacyFallbackState?.positions;
        const result = build(input);
        if (originalCanonical) assert.notStrictEqual(result.canonical, originalCanonical);
        if (originalPositions) assert.notStrictEqual(result.positions, originalPositions);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.positions), true);
        assert.equal(Object.isFrozen(result.metadata), true);
        assert.equal(Object.isFrozen(result.diagnostics), true);
        assert.equal(Object.isFrozen(result.analysisPolicy), true);
    }
});

test("metadata and diagnostics retain source-selection facts", () => {
    const result = build({ bootShadowState: saved(), legacyFallbackState: legacy() });
    assert.deepEqual([result.metadata.contract, result.metadata.tradingDate,
        result.metadata.pageUpdatedAt, result.metadata.origin],
    ["2026-09", "2026-08-25", "2026-08-25T05:50:00+09:00", "cache"]);
    assert.deepEqual([result.diagnostics.requestedMode, result.diagnostics.activeContract,
        result.diagnostics.savedAvailable, result.diagnostics.legacyAvailable,
        result.diagnostics.savedContractMatched],
    ["auto", "2026-09", true, true, true]);
});

test("Phase 7.5 state table keeps display and analysis policies consistent", () => {
    const cases = [
        [{ liveState: live(), liveStatus: "success" }, ["live", "live_available", true, true]],
        [{ bootShadowState: saved(), liveStatus: "pending" }, ["saved", "saved_pending", true, false]],
        [{ bootShadowState: saved(), liveStatus: "failed" }, ["saved", "saved_fallback", true, false]],
        [{ bootShadowState: { status: "missing" }, legacyFallbackState: legacy(),
            liveStatus: "failed" }, ["legacy", "legacy_fallback", true, true]],
        [{ liveStatus: "failed" }, ["unavailable", "unavailable", false, false]],
        [{ activeContract: "2026-12", bootShadowState: saved(), liveStatus: "failed" },
            ["unavailable", "contract_mismatch", false, false]]
    ];
    for (const [input, expected] of cases) {
        const result = build(input);
        assert.deepEqual([result.sourceKind, result.state, result.available,
            result.analysisPolicy.allowFormalAnalysis ||
                result.analysisPolicy.allowLegacyAnalysis], expected);
    }
});

test("input is unchanged and module has no forbidden connection", () => {
    const input = { mode: "auto", activeContract: "2026-09", liveStatus: "pending",
        liveState: null, bootShadowState: saved(), legacyFallbackState: legacy() };
    const before = JSON.stringify(input); Source.buildQriOptionsDisplaySourceState(input);
    assert.equal(JSON.stringify(input), before);
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsDisplaySourceState.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(source, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|\bChart\b/);
    assert.doesNotMatch(source, /drawJpxPriceChart|allJpx|OverallV2|optionMapJudgmentState/);
    assert.doesNotMatch(source, /setTimeout|setInterval|migration|backfill/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsDisplaySourceState.js"), true);
});
