const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Diagnostics = require("../js/qriOptionsSavedDisplayDiagnostics.js");

function fixtures() {
    return {
        display: { generation: 7,
            sourceState: { sourceKind: "saved", state: "saved_fallback",
                contract: "2026-09" },
            positionsState: { displayOnly: true },
            uiState: { visible: true, showSavedBadge: true,
                badgeText: "保存済み建玉",
                message: "QRI取得に失敗しました。保存済み建玉を表示しています",
                severity: "caution", contractText: "2026年9月限",
                tradingDateText: "2026/08/25", pageUpdatedAtText: "05:50",
                fetchedAtText: "8/25 15:10" } },
        chart: { displayOnly: true, sourceKind: "saved", state: "saved_fallback",
            contract: "2026-09", labels: ["65,000"] },
        chartIdentity: { rendererKind: "display_only", sourceKind: "saved",
            displayOnly: true, generation: 4, displayGeneration: 7,
            renderedAt: "2026-08-25T06:15:00Z" },
        formal: { sourceIdentity: { origin: "live", contract: "2026-09" },
            formalGlobals: { labels: ["65,000"], call: [100], put: [200] },
            wallState: { call: "CALL 65,000", put: "PUT 64,000" },
            judgmentState: { available: true, score: 1 },
            overallV2State: { result: { status: "complete", direction: 20 } },
            fetchState: { status: "failed", requestId: "qri-7" } },
        boot: { status: "candidate", generation: 3,
            candidate: { origin: "cache", contract: "2026-09",
                tradingDate: "2026-08-25", pageUpdatedAt: "2026-08-25T05:50:00+09:00",
                fetchedAt: "2026-08-25T06:10:00Z", canonicalSignature: "saved-signature",
                canonicalVersionKey: "saved-version" },
            diagnostics: { liveAcquisitionIdentity: "live-acquisition-7",
                liveRequestId: "qri-7", liveContract: "2026-09",
                liveFetchedAt: "2026-08-25T06:20:00Z" } },
        live: { contract: "2026-09", fetchedAt: "2026-08-25T06:20:00Z",
            sourceStatus: "acquired" },
        reference: { status: "visible", referenceOnly: true,
            calculationEligible: false,
            identity: { contract: "2026-09", canonicalVersionKey: "saved-version",
                displayGeneration: 7 },
            analysisState: { sourceKind: "saved" },
            uiState: { visible: true, call: { topItems: [{ text: "CALL 1" }] },
                put: { topItems: [{ text: "PUT 1" }, { text: "PUT 2" }] } } },
        referenceDom: { visible: true, title: "保存済み建玉からの参考情報",
            call: { items: [{ text: "CALL 1", maximum: true }] },
            put: { items: [{ text: "PUT 1", maximum: true },
                { text: "PUT 2", maximum: false }] },
            metadata: "限月：2026年9月限", note: "参考情報" }
    };
}

function create(values = fixtures()) {
    const diagnostics = Diagnostics.createQriOptionsSavedDisplayDiagnostics({
        getDisplayState: () => values.display, getChartState: () => values.chart,
        getChartIdentity: () => values.chartIdentity,
        getFormalState: () => values.formal, getBootShadowState: () => values.boot,
        getLiveState: () => values.live,
        getReferenceState: () => values.reference,
        getReferenceDomState: () => values.referenceDom,
        getSavedUiDomState: () => ({ visible: true,
            badge: { visible: true, text: "保存済み建玉" },
            message: { visible: true, text: "保存済み建玉を表示中", severity: "neutral" },
            metadata: { visible: true, text: "2026年9月限 / 取引日 2026/08/25" } }),
        getCanvasCount: () => 1
    });
    return { values, diagnostics };
}

test("getter exposes display saved UI chart and generation facts", () => {
    const result = create().diagnostics.getDiagnostics();
    assert.deepEqual(result.display, { sourceKind: "saved", state: "saved_fallback",
        generation: 7, displayOnly: true });
    assert.deepEqual(result.savedUi, { visible: true, showSavedBadge: true,
        badgeText: "保存済み建玉",
        message: "QRI取得に失敗しました。保存済み建玉を表示しています",
        severity: "caution", metadata: { contractText: "2026年9月限",
            tradingDateText: "2026/08/25", pageUpdatedAtText: "05:50",
            fetchedAtText: "8/25 15:10" }, actualDom: { visible: true,
            badge: { visible: true, text: "保存済み建玉" },
            message: { visible: true, text: "保存済み建玉を表示中", severity: "neutral" },
            metadata: { visible: true, text: "2026年9月限 / 取引日 2026/08/25" } } });
    assert.deepEqual(result.chart, { actualStateAvailable: true,
        displayDataAvailable: true, rendererKind: "display_only", sourceKind: "saved",
        state: "saved_fallback", contract: "2026-09", displayOnly: true,
        generation: 4, displayGeneration: 7, renderedAt: "2026-08-25T06:15:00Z",
        canvasCount: 1 });
});

test("chart identity is never inferred from saved display state", () => {
    const values = fixtures();
    values.chart = null;
    values.chartIdentity = null;
    const result = create(values).diagnostics.getDiagnostics();
    assert.deepEqual(result.chart, { actualStateAvailable: false,
        displayDataAvailable: false, rendererKind: "unknown", sourceKind: "unknown",
        state: null, contract: null, displayOnly: null, generation: null,
        displayGeneration: null, renderedAt: null, canvasCount: 1 });
    assert.equal(result.display.sourceKind, "saved");
});

test("getter exposes reference runtime identity counts and actual DOM", () => {
    const result = create().diagnostics.getDiagnostics();
    assert.deepEqual(result.referenceAnalysis, { visible: true, sourceKind: "saved",
        state: "visible", referenceOnly: true, calculationEligible: false,
        contract: "2026-09", canonicalVersionKey: "saved-version",
        displayGeneration: 7, callCount: 1, putCount: 2,
        actualDom: fixtures().referenceDom });
});

test("display data does not substitute for missing renderer identity", () => {
    const values = fixtures();
    values.chartIdentity = null;
    const result = create(values).diagnostics.getDiagnostics();
    assert.deepEqual([result.chart.actualStateAvailable,
        result.chart.displayDataAvailable, result.chart.rendererKind,
        result.chart.sourceKind, result.chart.displayOnly],
    [false, true, "unknown", "unknown", null]);
    assert.equal(result.chart.state, "saved_fallback");
});

test("getter exposes formal wall judgment and OverallV2 fingerprints", () => {
    const result = create().diagnostics.getDiagnostics();
    assert.deepEqual(result.formal.sourceIdentity, { origin: "live", contract: "2026-09" });
    for (const key of ["globalsFingerprint", "wallFingerprint",
        "judgmentFingerprint", "overallV2Fingerprint"]) {
        assert.equal(result.formal[key].algorithm, "fnv1a32-stable-json");
        assert.match(result.formal[key].value, /^[0-9a-f]{8}$/);
    }
    assert.notEqual(result.formal.globalsFingerprint.value,
        result.formal.wallFingerprint.value);
});

test("getter exposes Boot Shadow saved and live acquisition identities", () => {
    const result = create().diagnostics.getDiagnostics();
    assert.deepEqual([result.bootShadow.status, result.bootShadow.generation,
        result.bootShadow.savedCandidateIdentity.canonicalSignature,
        result.bootShadow.liveAcquisitionIdentity, result.liveAcquisition.identity],
    ["candidate", 3, "saved-signature", "live-acquisition-7", "live-acquisition-7"]);
});

test("fingerprints are deterministic across object key order", () => {
    assert.deepEqual(Diagnostics.fingerprint({ b: 2, a: { d: 4, c: 3 } }),
        Diagnostics.fingerprint({ a: { c: 3, d: 4 }, b: 2 }));
});

test("getter is detached deeply frozen and leaves every provider state unchanged", () => {
    const { values, diagnostics } = create();
    const before = JSON.stringify(values);
    const first = diagnostics.getDiagnostics();
    const second = diagnostics.getDiagnostics();
    assert.equal(JSON.stringify(values), before);
    assert.deepEqual(first, second);
    for (const value of [first, first.display, first.savedUi, first.savedUi.metadata,
        first.referenceAnalysis, first.referenceAnalysis.actualDom,
        first.chart, first.formal, first.formal.globalsFingerprint, first.bootShadow,
        first.liveAcquisition, first.resource]) assert.equal(Object.isFrozen(value), true);
    assert.notStrictEqual(first.formal.sourceIdentity, values.formal.sourceIdentity);
});

test("getter changes no formal wall judgment OverallV2 fetch or resource state", () => {
    const { values, diagnostics } = create();
    const watched = [values.display, values.chart, values.chartIdentity,
        values.reference, values.referenceDom,
        values.formal.formalGlobals, values.formal.wallState,
        values.formal.judgmentState, values.formal.overallV2State, values.formal.fetchState];
    const before = watched.map(value => JSON.stringify(value));
    diagnostics.getDiagnostics();
    assert.deepEqual(watched.map(value => JSON.stringify(value)), before);
    const resource = diagnostics.getDiagnostics().resource;
    assert.deepEqual([resource.storageAccessed, resource.databaseAccessed,
        resource.fetchTriggered, resource.timerScheduled], [false, false, false, false]);
});

test("module has no storage database network timer DOM or calculation connector", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedDisplayDiagnostics.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|setTimeout|setInterval/);
    assert.doesNotMatch(code, /document\.|querySelector|drawJpxPriceChart|\bChart\b/);
    assert.doesNotMatch(code, /calculate|renderOption|updateWall|migration|backfill/i);
});

test("renderer wires one read-only getter after diagnostics dependency", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const runtimeAt = html.indexOf("js/qriOptionsDisplayRuntime.js");
    const diagnosticsAt = html.indexOf("js/qriOptionsSavedDisplayDiagnostics.js");
    const scriptAt = html.indexOf("js/script.js");
    assert.ok(runtimeAt >= 0 && runtimeAt < diagnosticsAt && diagnosticsAt < scriptAt);
    assert.equal((html.match(/window\.getQriOptionsSavedDisplayDiagnostics\s*=/g) || [])
        .length, 1);
    const wiring = html.slice(html.indexOf("const qriOptionsSavedDisplayDiagnostics ="),
        html.indexOf("function refreshQriOptionsDisplay"));
    assert.doesNotMatch(wiring, /refreshQriOptionsDisplay\(|drawJpxPriceChart|localStorage|indexedDB|fetch\(/);
});

test("formal snapshot provider clones state without recalculation or rendering", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    const provider = script.slice(script.indexOf("window.getQriOptionsFormalDiagnosticsSnapshot"),
        script.indexOf("window.drawJpxPriceChart", script.indexOf(
            "window.getQriOptionsFormalDiagnosticsSnapshot")));
    for (const fact of ["allJpxOpenInterestLabels", "allJpxCallValues", "allJpxPutValues",
        "optionMapJudgmentState", "optionMapJudgmentStateV2", "callWallResult",
        "putWallResult", "dataFetchState?.qri"]) assert.equal(provider.includes(fact), true);
    assert.doesNotMatch(provider, /calculate|renderOption|safeRender|drawJpxPriceChart|setItem|indexedDB/);
});
