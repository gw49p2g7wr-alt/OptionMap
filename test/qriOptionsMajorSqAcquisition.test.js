"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Api = require("../js/qriOptionsMajorSqAcquisition.js");

const activeUrl = "https://svc.qri.jp/jpx/nkopm/";
const urlFor = contract => `https://svc.qri.jp/jpx/nkopm/${contract.replace("-", "")}`;
const labelFor = contract => `${Number(contract.slice(5))}月限`;
function context(activeContract = "2026-09", entries) {
    return { parentMarketRefreshRequestId: "market-1", formalPublicationGeneration: 7,
        formalCompletionVerified: true, sourceClass: "formal_live", identityVerified: true,
        acquisitionVerified: true, openInterestStatus: "available", activeContract,
        formalTradingDate: "2026-09-04", activeCanonicalVersionKey: "active-v1",
        activeSourceUrl: activeUrl, availableContracts: entries || [
            { contract: activeContract, label: labelFor(activeContract), url: activeUrl, active: true },
            { contract: Api.nextMajorSqContract(activeContract),
                label: labelFor(Api.nextMajorSqContract(activeContract)),
                url: urlFor(Api.nextMajorSqContract(activeContract)), active: false }
        ] };
}
function canonicalFor(contract, overrides = {}) {
    const url = urlFor(contract); const label = labelFor(contract);
    return { contract, gengetsu: contract.replace("-", ""), sourceUrl: url,
        contractLabel: label, tradingDate: "2026-09-04", openInterestStatus: "available",
        availableContracts: [{ contract, label, url, active: true }],
        records: [{ contract, optionType: "call", strike: 40000, published: true, value: 10 },
            { contract, optionType: "put", strike: 40000, published: true, value: 20 }],
        ...overrides };
}
function harness({ formal = context(), canonical, validateCanonical = true,
    validateCache = true, persistence = { status: "saved" },
    persistAcceptedIvHistory, publishAcceptedReference, restoreAcceptedIvHistory } = {}) {
    let current = structuredClone(formal); let lifecycle = { generation: null, disposed: false };
    const fetched = []; const persisted = [];
    const target = Api.nextMajorSqContract(formal.activeContract);
    const orchestrator = Api.createQriMajorSqAcquisitionOrchestrator({
        fetchReferencePage: async url => { fetched.push(url); return { url }; },
        buildCanonical: async () => structuredClone(canonical || canonicalFor(target)),
        validateCanonical: async () => validateCanonical,
        buildCache: async value => ({ contract: value.contract, sourceUrl: value.sourceUrl,
            signature: "a".repeat(64), versionKey: `qri-options-v2|${value.contract}|v1`,
            canonical: value }),
        validateCache: async () => validateCache,
        persistReference: async (cache, options) => (persisted.push({ cache, options }), persistence),
        persistAcceptedIvHistory,
        publishAcceptedReference,
        restoreAcceptedIvHistory,
        getCurrentFormalContext: () => current,
        getCurrentLifecycleState: () => lifecycle,
        now: () => "2026-09-06T10:00:00+09:00", createRequestId: () => "major-1"
    });
    return { orchestrator, fetched, persisted,
        setCurrent: value => { current = value; }, setLifecycle: value => { lifecycle = value; } };
}

test("same-day Major-SQ skip restores only its exact immutable success memo", async () => {
    const restored = []; const formal = context();
    const x = harness({ formal, restoreAcceptedIvHistory: async (memo, guard) => {
        restored.push({ memo, current: guard.isCurrentRequest(), frozen: Object.isFrozen(memo) });
    } });
    assert.equal((await x.orchestrator.run(formal)).status, "saved");
    const second = await x.orchestrator.run(formal);
    assert.equal(second.reason, "already_succeeded_for_trading_date");
    assert.deepEqual(restored, [{ memo: { role: "major_sq", activeContract: "2026-09",
        activeVersionKey: "active-v1", targetContract: "2026-12",
        referenceTradingDate: "2026-09-04", targetUrl: urlFor("2026-12"),
        versionKey: "qri-options-v2|2026-12|v1" }, current: true, frozen: true }]);
    assert.equal(x.fetched.length, 1);
});

test("Major-SQ success memo is not reused across date, target or URL changes", async () => {
    for (const mutate of [
        value => { value.formalTradingDate = "2026-09-05"; },
        value => { value.activeContract = "2026-10"; },
        value => { value.availableContracts[1].url = `${urlFor("2026-12")}?changed`; }
    ]) {
        const restored = []; const formal = context();
        const x = harness({ formal, restoreAcceptedIvHistory: memo => restored.push(memo) });
        await x.orchestrator.run(formal); const changed = structuredClone(formal); mutate(changed);
        x.setCurrent(changed); await x.orchestrator.run(changed);
        assert.equal(restored.length, 0);
    }
});

test("Major-SQ same-day restore accepts a refreshed active Formal version", async () => {
    const restored = []; const formal = context();
    const x = harness({ formal, restoreAcceptedIvHistory: memo => restored.push(memo) });
    await x.orchestrator.run(formal);
    const refreshed = structuredClone(formal);
    refreshed.activeCanonicalVersionKey = "active-v2";
    x.setCurrent(refreshed);
    const result = await x.orchestrator.run(refreshed);
    assert.equal(result.reason, "already_succeeded_for_trading_date");
    assert.equal(x.fetched.length, 1);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].activeVersionKey, "active-v1");
});

test("quarter target is derived from the active contract including year rollover", () => {
    assert.deepEqual([["2026-09", "2026-12"], ["2026-10", "2026-12"],
        ["2026-11", "2026-12"], ["2026-12", "2027-03"], ["2027-01", "2027-03"]]
        .map(([active, expected]) => [Api.nextMajorSqContract(active), expected]),
    [["2026-12", "2026-12"], ["2026-12", "2026-12"], ["2026-12", "2026-12"],
        ["2027-03", "2027-03"], ["2027-03", "2027-03"]]);
});

test("manifest order does not affect contract target selection", async () => {
    const formal = context("2026-09", [
        { contract: "2026-11", label: "11月限", url: urlFor("2026-11"), active: false },
        { contract: "2026-12", label: "12月限", url: urlFor("2026-12"), active: false },
        { contract: "2026-10", label: "10月限", url: urlFor("2026-10"), active: false },
        { contract: "2026-09", label: "9月限", url: activeUrl, active: true }
    ]);
    const x = harness({ formal });
    assert.equal((await x.orchestrator.run(formal)).status, "saved");
    assert.deepEqual(x.fetched, [urlFor("2026-12")]);
});

test("missing target fails closed without fetching or history fallback", async () => {
    const formal = context("2026-09", [
        { contract: "2026-09", label: "9月限", url: activeUrl, active: true },
        { contract: "2026-10", label: "10月限", url: urlFor("2026-10"), active: false }
    ]);
    const x = harness({ formal }); const result = await x.orchestrator.run(formal);
    assert.equal(result.reason, "manifest_target_missing");
    assert.deepEqual([x.fetched.length, x.persisted.length,
        x.orchestrator.getFormalHistoryLocator()], [0, 0, null]);
});

test("unresolved target is accepted only after specific canonical navigation verification", async () => {
    const formal = context("2026-09", [
        { contract: "2026-09", label: "9月限", url: activeUrl, active: true },
        { contract: null, label: "12月限", url: urlFor("2026-12"), active: false,
            resolution: "unresolved", selectionKey: `url:${urlFor("2026-12")}` }
    ]);
    const x = harness({ formal }); const result = await x.orchestrator.run(formal);
    assert.equal(result.status, "saved");
    assert.equal(x.persisted[0].options.requestedContract, "2026-12");
});

test("URL, canonical contract, mixed records and invalid trading date are rejected", async () => {
    const cases = [
        [canonicalFor("2026-12", { sourceUrl: urlFor("2026-11") }), "source_url_mismatch"],
        [canonicalFor("2026-11", { sourceUrl: urlFor("2026-12") }), "contract_mismatch"],
        [canonicalFor("2026-12", { records: [
            { contract: "2026-12", published: true }, { contract: "2026-11", published: true }] }),
        "contract_mismatch"],
        [canonicalFor("2026-12", { tradingDate: "2026-02-31" }),
            "reference_trading_date_invalid"]
    ];
    for (const [canonical, reason] of cases) {
        const x = harness({ canonical });
        assert.equal((await x.orchestrator.run(context())).reason, reason);
        assert.equal(x.persisted.length, 0);
    }
});

test("OI unavailable and no published record remain distinct fail-closed reasons", async () => {
    const unavailable = harness({ canonical: canonicalFor("2026-12",
        { openInterestStatus: "unavailable" }) });
    assert.equal((await unavailable.orchestrator.run(context())).reason,
        "open_interest_unavailable");
    const unpublishedCanonical = canonicalFor("2026-12");
    unpublishedCanonical.records.forEach(record => { record.published = false; record.value = null; });
    const unpublished = harness({ canonical: unpublishedCanonical });
    assert.equal((await unpublished.orchestrator.run(context())).reason,
        "published_record_missing");
});

test("invalid signature/versionKey cache is rejected", async () => {
    const x = harness({ validateCache: false });
    assert.equal((await x.orchestrator.run(context())).reason, "cache_invalid");
    assert.equal(x.persisted.length, 0);
});

test("fetch, parse, canonical validation and persistence failures never Formalize", async () => {
    const stages = [
        ["fetchReferencePage", "fetch_failed"], ["buildCanonical", "canonical_build_failed"],
        ["validateCanonical", "canonical_validation_failed"],
        ["persistReference", "persistence_failed"]
    ];
    for (const [stage, reason] of stages) {
        const formal = context(); let current = formal; let persisted = 0;
        const dependencies = {
            fetchReferencePage: async () => ({}), buildCanonical: () => canonicalFor("2026-12"),
            validateCanonical: () => true, buildCache: value => ({ contract: value.contract,
                sourceUrl: value.sourceUrl, signature: "a".repeat(64), versionKey: "v", canonical: value }),
            validateCache: () => true, persistReference: () => (persisted += 1, { status: "saved" }),
            getCurrentFormalContext: () => current,
            getCurrentLifecycleState: () => ({ disposed: false }),
            now: () => "2026-09-06T10:00:00+09:00", createRequestId: () => "major-1"
        };
        dependencies[stage] = async () => { throw new Error(`${stage}_error`); };
        const orchestrator = Api.createQriMajorSqAcquisitionOrchestrator(dependencies);
        assert.equal((await orchestrator.run(formal)).reason, reason);
        assert.equal(orchestrator.getFormalHistoryLocator(), null);
        if (stage !== "persistReference") assert.equal(persisted, 0);
        current = null;
    }
});

test("obsolete parent request/generation rejects before persistence", async () => {
    let release; const pendingFetch = new Promise(resolve => { release = resolve; });
    const formal = context(); let current = structuredClone(formal); const persisted = [];
    const orchestrator = Api.createQriMajorSqAcquisitionOrchestrator({
        fetchReferencePage: () => pendingFetch, buildCanonical: () => canonicalFor("2026-12"),
        validateCanonical: () => true, buildCache: value => ({ contract: value.contract,
            sourceUrl: value.sourceUrl, signature: "a".repeat(64), versionKey: "v", canonical: value }),
        validateCache: () => true, persistReference: value => (persisted.push(value), { status: "saved" }),
        getCurrentFormalContext: () => current, getCurrentLifecycleState: () => ({ disposed: false }),
        now: () => "2026-09-06T10:00:00+09:00", createRequestId: () => "major-1" });
    const pending = orchestrator.run(formal); await Promise.resolve();
    current.formalPublicationGeneration = 8; release({});
    assert.equal((await pending).status, "stale"); assert.equal(persisted.length, 0);
});

test("saved and unchanged expose immutable Formal locators; failed/skipped do not", async () => {
    for (const status of ["saved", "unchanged"]) {
        const x = harness({ persistence: { status, reason: status === "unchanged"
            ? "duplicate_no_op" : null } });
        await x.orchestrator.run(context());
        const locator = x.orchestrator.getFormalHistoryLocator();
        assert.deepEqual([locator.status, locator.targetContract, locator.referenceTradingDate,
            locator.targetUrl, locator.versionKey, locator.parentMarketRefreshRequestId],
        [status, "2026-12", "2026-09-04", urlFor("2026-12"),
            "qri-options-v2|2026-12|v1", "market-1"]);
        assert.equal(Object.isFrozen(locator), true);
    }
    const failed = harness({ validateCache: false }); await failed.orchestrator.run(context());
    assert.equal(failed.orchestrator.getFormalHistoryLocator(), null);
    const skippedFormal = context(); skippedFormal.availableContracts = [skippedFormal.availableContracts[0]];
    const skipped = harness({ formal: skippedFormal }); await skipped.orchestrator.run(skippedFormal);
    assert.equal(skipped.orchestrator.getFormalHistoryLocator(), null);
});

test("persistence uses the existing reference_history contract", async () => {
    const x = harness(); await x.orchestrator.run(context());
    const options = x.persisted[0].options;
    assert.deepEqual([options.mode, options.acquisitionOrigin, options.requestedContract,
        options.sourceUrl, options.requestId, options.isCurrentRequest()],
    ["reference_history", "live", "2026-12", urlFor("2026-12"), "major-1", true]);
});

test("Major-SQ session consumer runs only after accepted Formal persistence", async () => {
    const published = [];
    const formal = context(); let current = structuredClone(formal);
    const target = "2026-12";
    const orchestrator = Api.createQriMajorSqAcquisitionOrchestrator({
        fetchReferencePage: async () => "same-major-html",
        buildCanonical: async () => canonicalFor(target), validateCanonical: async () => true,
        buildCache: async value => ({ contract: value.contract, sourceUrl: value.sourceUrl,
            signature: "a".repeat(64), versionKey: "major-version",
            fetchedAt: "2026-09-06T10:00:00Z", canonical: value }),
        validateCache: async () => true,
        persistReference: async () => ({ status: "unchanged" }),
        publishAcceptedReference: async (input, guard) => published.push({ input,
            current: guard.isCurrentRequest() }),
        getCurrentFormalContext: () => current,
        getCurrentLifecycleState: () => ({ disposed: false }),
        now: () => "2026-09-06T10:00:00+09:00", createRequestId: () => "major-1"
    });
    assert.equal((await orchestrator.run(formal)).status, "unchanged");
    assert.deepEqual([published.length, published[0].input.responseHtml,
        published[0].input.targetContract, published[0].input.referenceStatus,
        published[0].input.referenceVersionKey, published[0].current],
    [1, "same-major-html", target, "unchanged", "major-version", true]);
    current = null;
});

test("Major-SQ IV history receives calculated and manifest-verified target before session", async () => {
    const order = []; const target = "2026-12";
    const x = harness({
        persistAcceptedIvHistory: async (input, guard) => {
            order.push("iv"); assert.equal(input.targetContract, target);
            assert.equal(input.referenceCanonical.contract, target);
            assert.equal(guard.isCurrentRequest(), true);
        },
        publishAcceptedReference: async () => { order.push("session"); }
    });
    assert.equal((await x.orchestrator.run(context())).status, "saved");
    assert.deepEqual(order, ["iv", "session"]);
});

test("production runtime stays dedicated while Full Export uses only its locator", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsMajorSqAcquisition.js"), "utf8");
    assert.match(html, /qriMajorSqAcquisitionRuntime/);
    assert.match(html, /getQriMajorSqFormalHistoryLocator/);
    assert.match(html, /createQriMajorSqAcquisitionOrchestrator/);
    assert.equal((source.match(/persistReference/g) || []).length > 0, true);
    assert.doesNotMatch(source, /qriOptionsNextContract|fullExport|OverallV2|Morning|MobileSummary|document\./);
    assert.match(fs.readFileSync(path.join(__dirname, "../js/fullExport.js"), "utf8"),
        /qriOptionsMajorSqNextContract/);
});
