"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Runtime = require("../js/qriOptionsReferenceAcquisitionRuntime.js");
const Acquisition = require("../js/qriOptionsReferenceAcquisition.js");

const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const frozen = value => Object.isFrozen(value) && Object.values(value)
    .filter(item => item && typeof item === "object").every(frozen);

function fakeOrchestrator({ run } = {}) {
    let state = Object.freeze({ status: "idle" });
    const calls = [];
    return { calls,
        run: context => { calls.push(["run", structuredClone(context)]);
            return run ? run(context) : Promise.resolve(state = Object.freeze({ status: "saved" })); },
        invalidate: reason => { calls.push(["invalidate", reason]);
            return state = Object.freeze({ status: "stale", reason }); },
        dispose: () => { calls.push(["dispose"]);
            return state = Object.freeze({ status: "disposed" }); },
        getState: () => structuredClone(state) };
}

test("run starts only after formal completion and Morning render hook", async () => {
    const orchestrator = fakeOrchestrator();
    const contexts = [];
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => (contexts.push(input), { ...input }) });
    runtime.beginMarketRefresh("market-1");
    assert.deepEqual(orchestrator.calls, [["invalidate", "new_market_refresh"]]);
    assert.equal(contexts.length, 0);
    runtime.completeFormalRender("old-market");
    assert.equal(contexts.length, 0);
    runtime.completeFormalRender("market-1");
    assert.equal(contexts[0].formalCompletionVerified, true);
    assert.equal(orchestrator.calls.filter(call => call[0] === "run").length, 1);
    await tick();
});

test("reference work is fire-and-forget and does not block formal result", async () => {
    const reference = deferred();
    const orchestrator = fakeOrchestrator({ run: () => reference.promise });
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => input });
    runtime.beginMarketRefresh("market-1");
    const formalResult = { status: "success", rendered: true, morningPublished: true };
    const returned = runtime.completeFormalRender("market-1");
    assert.equal(returned.runtime.status, "scheduled");
    assert.deepEqual(formalResult, { status: "success", rendered: true, morningPublished: true });
    reference.resolve({ status: "saved" });
    await tick();
    assert.equal(runtime.getState().runtime.status, "saved");
});

test("new refresh invalidates an old fetch without changing formal state", async () => {
    const old = deferred();
    const orchestrator = fakeOrchestrator({ run: () => old.promise });
    const formal = Object.freeze({ result: "ready", lastValid: "same", overall: "same",
        morning: "same", evidence: "same" });
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => input });
    runtime.beginMarketRefresh("market-1");
    runtime.completeFormalRender("market-1");
    runtime.beginMarketRefresh("market-2");
    old.resolve({ status: "stale", reason: "lifecycle_changed" });
    await tick();
    assert.equal(runtime.getState().runtime.status, "pending_formal_completion");
    assert.deepEqual(formal, { result: "ready", lastValid: "same", overall: "same",
        morning: "same", evidence: "same" });
    assert.equal(orchestrator.calls.filter(call => call[0] === "invalidate").length, 2);
});

test("reference rejection is isolated in diagnostics", async () => {
    const orchestrator = fakeOrchestrator({ run: () => Promise.reject(new Error("fetch failed")) });
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => input });
    runtime.beginMarketRefresh("market-1");
    assert.doesNotThrow(() => runtime.completeFormalRender("market-1"));
    await tick();
    const state = runtime.getState();
    assert.equal(state.runtime.status, "failed");
    assert.equal(state.runtime.reason, "reference_run_rejected");
    assert.equal(state.runtime.errorCode, "fetch failed");
});

test("dispose prevents later scheduling", () => {
    const orchestrator = fakeOrchestrator();
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => input });
    runtime.beginMarketRefresh("market-1");
    runtime.dispose();
    runtime.completeFormalRender("market-1");
    runtime.beginMarketRefresh("market-2");
    assert.equal(orchestrator.calls.filter(call => call[0] === "run").length, 0);
    assert.equal(runtime.getState().runtime.status, "disposed");
});

test("getter is detached, deeply frozen and side-effect free", () => {
    const orchestrator = fakeOrchestrator();
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: input => input });
    runtime.beginMarketRefresh("market-1");
    const beforeCalls = orchestrator.calls.length;
    const first = runtime.getState();
    const second = runtime.getState();
    assert.notEqual(first, second);
    assert.equal(frozen(first), true);
    assert.equal(orchestrator.calls.length, beforeCalls);
    assert.throws(() => { first.runtime.status = "changed"; }, TypeError);
    assert.equal(second.runtime.status, "pending_formal_completion");
});

function actualHarness(overrides = {}) {
    let current;
    let lifecycle = { generation: null, disposed: false };
    const fetched = [];
    const persisted = [];
    const canonicalFor = url => ({ sourceUrl: url, contract: url.endsWith("/10") ? "2026-10" : "2026-11",
        tradingDate: "2026-08-31", openInterestStatus: "available",
        records: [{ contract: url.endsWith("/10") ? "2026-10" : "2026-11",
            optionType: "call", strike: 40000, published: true, value: 1 }] });
    const orchestrator = Acquisition.createQriReferenceAcquisitionOrchestrator({
        fetchReferencePage: async url => { fetched.push(url); return url; },
        buildCanonical: async url => canonicalFor(url), validateCanonical: async () => true,
        buildCache: async canonical => ({ contract: canonical.contract,
            sourceUrl: canonical.sourceUrl, versionKey: `v|${canonical.contract}`, canonical }),
        validateCache: async () => true,
        persistReference: async (cache, context) => { persisted.push({ cache, context });
            return { status: overrides.persistenceStatus || "saved" }; },
        getCurrentFormalContext: () => current, getCurrentLifecycleState: () => lifecycle,
        now: () => "2026-08-31T10:00:00+09:00", createRequestId: () => "reference-1" });
    const runtime = Runtime.createRuntime({ orchestrator,
        buildFormalContext: ({ requestId, formalCompletionVerified }) => current = {
            parentMarketRefreshRequestId: requestId, formalPublicationGeneration: 2,
            formalCompletionVerified, sourceClass: "formal_live", identityVerified: true,
            acquisitionVerified: true, openInterestStatus: overrides.openInterestStatus || "available",
            activeContract: overrides.activeContract || "2026-09", formalTradingDate: "2026-08-31",
            activeCanonicalVersionKey: "active-v1", activeSourceUrl: "/09",
            availableContracts: overrides.availableContracts || [
                { contract: "2026-09", url: "/09", active: true },
                { contract: "2026-10", url: "/10", active: false },
                { contract: "2026-11", url: "/11", active: false }] } });
    return { runtime, fetched, persisted, setLifecycle: value => { lifecycle = value; } };
}

test("OI unavailable skips before reference fetch", async () => {
    const { runtime, fetched } = actualHarness({ openInterestStatus: "unavailable" });
    runtime.beginMarketRefresh("market-1"); runtime.completeFormalRender("market-1");
    await tick();
    assert.deepEqual(fetched, []);
    assert.equal(runtime.getState().acquisition.reason, "open_interest_unavailable");
});

test("saved and unchanged both suppress same-day duplicate fetch", async () => {
    for (const persistenceStatus of ["saved", "unchanged"]) {
        const { runtime, fetched } = actualHarness({ persistenceStatus });
        runtime.beginMarketRefresh("market-1"); runtime.completeFormalRender("market-1");
        await tick();
        runtime.beginMarketRefresh("market-2"); runtime.completeFormalRender("market-2");
        await tick();
        assert.deepEqual(fetched, ["/10"]);
    }
});

test("contract roll uses the new active contract's immediate successor", async () => {
    const { runtime, fetched } = actualHarness({ activeContract: "2026-10",
        availableContracts: [{ contract: "2026-10", url: "/10", active: true },
            { contract: "2026-11", url: "/11", active: false }] });
    runtime.beginMarketRefresh("market-roll"); runtime.completeFormalRender("market-roll");
    await tick();
    assert.deepEqual(fetched, ["/11"]);
});

test("production wiring is ordered, post-render, non-awaiting and isolated", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    const persistence = html.indexOf('qriOptionsHistoryPersistence.js');
    const acquisition = html.indexOf('qriOptionsReferenceAcquisition.js');
    const runtime = html.indexOf('qriOptionsReferenceAcquisitionRuntime.js');
    assert.ok(persistence < acquisition && acquisition < runtime);
    const refresh = html.slice(html.indexOf("function refreshAllMarketData"),
        html.indexOf("window.refreshAllMarketData"));
    assert.ok(refresh.indexOf("beginMarketRefresh(requestId)") <
        refresh.indexOf("invalidateMorningComparisonV4Runtime"));
    assert.match(refresh, /await window\.renderOptionMapOverallJudgmentV2\?\.\(\)/);
    assert.ok(refresh.indexOf("await window.renderOptionMapOverallJudgmentV2") <
        refresh.indexOf("await window.OptionMapMobileSummaryPreview?.update"));
    assert.ok(refresh.indexOf("await window.publishMorningComparisonV4Runtime") <
        refresh.lastIndexOf("renderFormalComparisonV4") &&
        refresh.lastIndexOf("renderFormalComparisonV4") <
        refresh.indexOf("completeFormalRender(requestId)"));
    assert.doesNotMatch(refresh, /await\s+initializeQriReferenceAcquisitionRuntime/);
    const overallRender = script.slice(
        script.indexOf("function renderOptionMapOverallJudgmentV2Internal"),
        script.indexOf("async function publishFormalIdentityEnvelopesV2"));
    const safeOverallRender = script.slice(
        script.indexOf("function safeRenderOptionMapOverallJudgmentV2"),
        script.indexOf("function updateWeeklyCandidateV2"));
    assert.match(overallRender, /const formalPublication = publishFormalIdentityEnvelopesV2\(result\)/);
    assert.match(overallRender, /return formalPublication/);
    assert.doesNotMatch(overallRender, /void publishFormalIdentityEnvelopesV2/);
    assert.match(safeOverallRender,
        /return Promise\.resolve\(renderOptionMapOverallJudgmentV2Internal\(\)\)\.catch/);
    assert.doesNotMatch(refresh, /setTimeout|setInterval/);
    const adapter = html.slice(html.indexOf("function initializeQriReferenceAcquisitionRuntime"),
        html.indexOf("function validateQriPayload"));
    assert.match(adapter, /persistReferenceContractCache/);
    assert.doesNotMatch(adapter, /publishQriFormalIdentity|LastValid|renderOptionMapOverallJudgmentV2|publishMorning|publishFormalOptionAvailabilityEvidence|adoptQriOptionIv|CurrentPrice|\.render\(|document\./);
});

test("runtime module has no DOM, timer, polling, storage or formal publication capability", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsReferenceAcquisitionRuntime.js"), "utf8");
    assert.doesNotMatch(source, /document\.|querySelector|setTimeout|setInterval|indexedDB|localStorage|ipcRenderer|fetch\s*\(|publishQriFormal|LastValid|OverallV2|Morning|Evidence|optionSignal|CurrentPrice|IvAdoption/);
});
