const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Api = require("../js/qriOptionsReferenceAcquisition.js");

const activeUrl = "https://svc.qri.jp/jpx/nkopm/";
const targetUrl = "https://svc.qri.jp/jpx/nkopm/1";
const baseContext = () => ({ formalCompletionVerified: true,
    parentMarketRefreshRequestId: "market-1", formalPublicationGeneration: 7,
    sourceClass: "formal_live", identityVerified: true, acquisitionVerified: true,
    openInterestStatus: "available", activeContract: "2026-09",
    formalTradingDate: "2026-08-28", activeCanonicalVersionKey: "active-v1",
    activeSourceUrl: activeUrl, availableContracts: [
        { contract: "2026-09", active: true, url: activeUrl },
        { contract: null, active: false, url: targetUrl },
        { contract: null, active: false, url: "https://svc.qri.jp/jpx/nkopm/2" }
    ] });
const referenceCanonical = overrides => ({ contract: "2026-10", sourceUrl: targetUrl,
    tradingDate: "2026-08-28", openInterestStatus: "available",
    records: [{ contract: "2026-10", published: true }], ...overrides });

function fixture(overrides = {}) {
    let context = baseContext(); let lifecycleGeneration = 1;
    const calls = { fetch: [], build: 0, validate: 0, cache: 0, persist: [] };
    const fetchResolvers = [];
    const deps = {
        fetchReferencePage: async url => { calls.fetch.push(url); return { html: "sample", url }; },
        buildCanonical: async () => { calls.build += 1; return referenceCanonical(); },
        validateCanonical: async () => { calls.validate += 1; return true; },
        buildCache: async canonical => { calls.cache += 1; return { contract: canonical.contract,
            sourceUrl: canonical.sourceUrl, versionKey: "reference-v1", canonical }; },
        validateCache: async () => true,
        persistReference: async (cache, options) => { calls.persist.push({ cache, options });
            return { status: "saved" }; },
        getCurrentFormalContext: () => context,
        getCurrentLifecycleState: () => ({ generation: lifecycleGeneration, disposed: false }),
        now: (() => { let tick = 0; return () => `2026-08-28T08:00:0${tick++}.000Z`; })(),
        createRequestId: ({ generation }) => `reference-${generation}`,
        ...overrides
    };
    const orchestrator = Api.createQriReferenceAcquisitionOrchestrator(deps);
    return { orchestrator, deps, calls,
        setContext: value => { context = value; },
        setLifecycleGeneration: value => { lifecycleGeneration = value; },
        deferFetch: () => { deps.fetchReferencePage = url => { calls.fetch.push(url);
            return new Promise(resolve => { fetchResolvers.push(resolve); }); }; },
        resolveFetch: value => fetchResolvers.shift()(value) };
}

test("valid formal completion selects exactly the first entry after active and persists once", async () => {
    const x = fixture(); const input = baseContext(); const before = structuredClone(input);
    const result = await x.orchestrator.run(input);
    assert.deepEqual(x.calls.fetch, [targetUrl]);
    assert.equal(x.calls.persist.length, 1);
    assert.equal(result.status, "saved");
    assert.deepEqual(input, before);
});

test("active entry is never fetched and no target skips before fetch", async () => {
    const x = fixture(); const context = baseContext();
    context.availableContracts = [context.availableContracts[0]];
    const result = await x.orchestrator.run(context);
    assert.equal(result.reason, "no_target"); assert.equal(x.calls.fetch.length, 0);
});

test("target reusing the active source URL is invalid before fetch", async () => {
    const x = fixture(); const context = baseContext();
    context.availableContracts[1].url = activeUrl;
    const result = await x.orchestrator.run(context);
    assert.equal(result.reason, "invalid_target"); assert.equal(x.calls.fetch.length, 0);
});

test("incomplete, pre-completion and unavailable formal contexts skip", async () => {
    for (const [change, reason] of [
        [value => { delete value.activeCanonicalVersionKey; }, "formal_context_incomplete"],
        [value => { value.formalCompletionVerified = false; }, "formal_context_incomplete"],
        [value => { value.openInterestStatus = "unavailable"; }, "open_interest_unavailable"]
    ]) {
        const x = fixture(); const context = baseContext(); change(context);
        assert.equal((await x.orchestrator.run(context)).reason, reason);
        assert.equal(x.calls.fetch.length, 0);
    }
});

test("one successful target per active trading date skips later runs", async () => {
    const x = fixture(); assert.equal((await x.orchestrator.run(baseContext())).status, "saved");
    x.setLifecycleGeneration(2);
    const second = await x.orchestrator.run(baseContext());
    assert.equal(second.reason, "already_succeeded_for_trading_date");
    assert.equal(x.calls.fetch.length, 1);
});

test("canonical identity, future contract and OI are verified", async () => {
    for (const [canonical, reason] of [
        [referenceCanonical({ sourceUrl: activeUrl }), "contract_mismatch"],
        [referenceCanonical({ contract: "2026-09",
            records: [{ contract: "2026-09", published: true }] }), "contract_mismatch"],
        [referenceCanonical({ contract: "2026-08",
            records: [{ contract: "2026-08", published: true }] }), "contract_mismatch"],
        [referenceCanonical({ records: [{ contract: "2026-11", published: true }] }),
            "contract_mismatch"],
        [referenceCanonical({ openInterestStatus: "unavailable",
            records: [{ contract: "2026-10", published: false }] }), "open_interest_unavailable"]
    ]) {
        const x = fixture({ buildCanonical: async () => canonical });
        assert.equal((await x.orchestrator.run(baseContext())).reason, reason);
        assert.equal(x.calls.persist.length, 0);
    }
});

test("canonical and cache validators fail closed", async () => {
    const invalid = fixture({ validateCanonical: async () => false });
    assert.equal((await invalid.orchestrator.run(baseContext())).reason, "canonical_invalid");
    const cache = fixture({ validateCache: async () => false });
    assert.equal((await cache.orchestrator.run(baseContext())).reason, "cache_invalid");
});

test("reference canonical trading date is retained and alignment is factual", async () => {
    for (const [date, expected] of [["2026-08-28", "aligned"],
        ["2026-08-27", "reference_older"], ["2026-08-29", "reference_newer"]]) {
        const x = fixture({ buildCanonical: async () => referenceCanonical({ tradingDate: date }) });
        const result = await x.orchestrator.run(baseContext());
        assert.equal(result.referenceTradingDate, date);
        assert.equal(result.tradingDateAlignment, expected);
        assert.equal(result.status, "saved");
    }
});

test("persistence receives only the reference-history contract shape", async () => {
    const x = fixture(); await x.orchestrator.run(baseContext());
    const call = x.calls.persist[0];
    assert.deepEqual([call.options.mode, call.options.acquisitionOrigin,
        call.options.requestedContract, call.options.sourceUrl, call.options.requestId],
    ["reference_history", "live", "2026-10", targetUrl, "reference-1"]);
    assert.equal(call.options.isCurrentRequest(), true);
});

test("unchanged is a successful session capture", async () => {
    const x = fixture({ persistReference: async () => ({ status: "unchanged",
        reason: "duplicate_no_op" }) });
    const result = await x.orchestrator.run(baseContext());
    assert.deepEqual([result.status, result.unchanged, result.persisted],
        ["unchanged", true, false]);
    x.setLifecycleGeneration(2);
    assert.equal((await x.orchestrator.run(baseContext())).reason,
        "already_succeeded_for_trading_date");
});

test("fetch, canonical and persistence failures remain diagnostics", async () => {
    const cases = [
        [fixture({ fetchReferencePage: async () => { throw new Error("offline"); } }), "fetch_failed"],
        [fixture({ buildCanonical: async () => { throw new Error("parse"); } }), "canonical_build_failed"],
        [fixture({ persistReference: async () => { throw new Error("quota"); } }), "persistence_failed"],
        [fixture({ persistReference: async () => ({ status: "failed", reason: "rejected" }) }), "rejected"]
    ];
    for (const [x, reason] of cases) {
        const result = await x.orchestrator.run(baseContext());
        assert.equal(result.status, "failed"); assert.equal(result.reason, reason);
    }
});

async function race(change) {
    const x = fixture(); x.deferFetch();
    const pending = x.orchestrator.run(baseContext());
    await Promise.resolve(); change(x); x.resolveFetch({ html: "sample" });
    const result = await pending;
    assert.equal(x.calls.persist.length, 0); return result;
}

test("new refresh invalidation makes an in-flight result stale", async () => {
    const result = await race(x => x.orchestrator.invalidate("new_market_refresh"));
    assert.equal(result.status, "stale");
});

test("a newer run cannot make the older run return its diagnostics", async () => {
    const x = fixture(); x.deferFetch();
    const older = x.orchestrator.run(baseContext());
    await Promise.resolve();
    x.setLifecycleGeneration(2);
    const newer = x.orchestrator.run(baseContext());
    x.resolveFetch({ html: "old" });
    assert.equal((await older).status, "stale");
    x.resolveFetch({ html: "new" });
    assert.equal((await newer).status, "saved");
});

test("active contract, trading date, active version and publication generation races reject", async () => {
    for (const mutate of [
        value => { value.activeContract = "2026-10"; },
        value => { value.formalTradingDate = "2026-08-29"; },
        value => { value.activeCanonicalVersionKey = "active-v2"; },
        value => { value.formalPublicationGeneration = 8; }
    ]) {
        const result = await race(x => { const current = baseContext(); mutate(current);
            x.setContext(current); });
        assert.equal(result.status, "stale");
    }
});

test("dispose prevents in-flight and later persistence", async () => {
    const result = await race(x => x.orchestrator.dispose());
    assert.equal(result.status, "disposed");
    const x = fixture(); x.orchestrator.dispose();
    assert.equal((await x.orchestrator.run(baseContext())).status, "disposed");
    assert.equal(x.calls.fetch.length, 0);
});

test("getter is detached and deeply frozen", () => {
    const x = fixture(); const first = x.orchestrator.getState();
    assert.equal(Object.isFrozen(first), true);
    assert.throws(() => { "use strict"; first.status = "failed"; }, TypeError);
    assert.notEqual(first, x.orchestrator.getState());
    assert.equal(x.orchestrator.getState().status, "idle");
});

test("missing dependency is a programming error", () => {
    assert.throws(() => Api.createQriReferenceAcquisitionOrchestrator({}),
        /missing_dependency:fetchReferencePage/);
});

test("module stays pure while exposing its factory for production wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsReferenceAcquisition.js"), "utf8");
    assert.doesNotMatch(source, /FormalOptionAvailability|publishQriFormal|LastValid|OverallV2|Morning|optionSignal|CurrentPrice|IvAdoption|MobileSummary|document\.|indexedDB|ipcRenderer|BrowserWindow|fetch\s*\(|setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(source, /root\.OptionMapQriOptionsReferenceAcquisition = api/);
    assert.match(html, /qriOptionsReferenceAcquisition\.js/);
});
