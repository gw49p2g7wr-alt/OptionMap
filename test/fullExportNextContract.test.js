"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const qri = require("../js/qriOptions.js");
const fullExport = require("../js/fullExport.js");
const { createFullExportCollector } = require("../js/fullExportCollector.js");
const { createFullExportFreshnessAdapter } = require("../js/fullExportFreshness.js");

const CONTRACT = "2026-10";
const TRADING_DATE = "2026-09-07";
const PAGE_UPDATED_AT = "2026-09-07T18:45:00+09:00";
const FETCHED_AT = "2026-09-07T09:46:00.000Z";
const CONFIRMED_AT = "2026-09-07T09:47:00.000Z";
const COMPLETED_AT = "2026-09-07T09:48:00.000Z";
const SOURCE_URL = "https://svc.qri.jp/jpx/nkopm/2";

function canonical(overrides = {}) {
    const value = { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
        sourceUrl: SOURCE_URL, pageUpdatedAt: PAGE_UPDATED_AT,
        tradingDate: TRADING_DATE, openInterestAsOf: null, contract: CONTRACT,
        gengetsu: "202610", contractLabel: "10月限月", isActiveContract: true,
        lastTradingDate: "2026-10-08", openInterestStatus: "available",
        availableContracts: [{ contract: CONTRACT, label: "10月限月",
            url: SOURCE_URL, active: true }],
        records: [
            { contract: CONTRACT, optionType: "call", strike: 42000,
                published: true, value: 100 },
            { contract: CONTRACT, optionType: "put", strike: 42000,
                published: false, value: null },
            { contract: CONTRACT, optionType: "call", strike: 42500,
                published: true, value: 25 },
            { contract: CONTRACT, optionType: "put", strike: 42500,
                published: true, value: 80 }
        ] };
    return { ...value, ...overrides };
}

async function fixture(options = {}) {
    const canonicalValue = canonical(options.canonical || {});
    const signature = await qri.createSignature(canonicalValue);
    const versionKey = `qri-options-v2|${CONTRACT}|${canonicalValue.pageUpdatedAt}|sha256:${signature}`;
    const revision = { contract: CONTRACT, versionKey, signature,
        signatureAlgorithm: "sha256", sourceUrl: SOURCE_URL, fetchedAt: FETCHED_AT,
        confirmedAt: CONFIRMED_AT, snapshotDate: "2026-09-07", replacedAt: null,
        pageUpdatedAt: canonicalValue.pageUpdatedAt, tradingDate: TRADING_DATE,
        openInterestAsOf: null, lastTradingDate: "2026-10-08",
        openInterestStatus: "available", canonical: canonicalValue,
        ...(options.revision || {}) };
    const entry = { entryKey: `${CONTRACT}|${TRADING_DATE}`, contract: CONTRACT,
        sourceDateKey: TRADING_DATE, activeVersionKey: versionKey,
        firstSeenAt: CONFIRMED_AT, lastSeenAt: CONFIRMED_AT, revisions: [revision],
        ...(options.entry || {}) };
    const acquisition = { status: options.status || "saved", targetContract: CONTRACT,
        referenceTradingDate: TRADING_DATE, versionKey, targetUrl: SOURCE_URL,
        completedAt: COMPLETED_AT,
        canonicalValid: true, persistenceStatus: options.status || "saved",
        ...(options.acquisition || {}) };
    const history = { historyVersion: 1, parserVersion: 2, schemaVersion: 2,
        source: qri.SOURCE, signatureAlgorithm: "sha256", createdAt: CONFIRMED_AT,
        updatedAt: CONFIRMED_AT, entries: [entry] };
    return { acquisition, history, revision, versionKey };
}

async function collect(source, overrides = {}) {
    const freshnessAdapter = createFullExportFreshnessAdapter({
        getMarketSession: () => ({ formalTradingDate: TRADING_DATE })
    });
    const configuration = { now: () => "2026-09-07T10:00:00.000Z",
        getMarketSession: () => ({ status: "open", tradingDate: TRADING_DATE }),
        getMobileSummary: () => null,
        getQriReferenceAcquisitionState: () => ({ acquisition: source.acquisition }),
        readQriHistory: async () => ({ status: "ready", history: source.history }),
        validateQriHistory: history => qriHistoryValidation(history),
        getSectionFreshness: freshnessAdapter.getSectionFreshness,
        ...overrides };
    return createFullExportCollector(configuration).collect({ market: "Nikkei" });
}

async function qriHistoryValidation(history) {
    const api = require("../js/qriOptionsHistory.js");
    return api.validateHistory(history);
}

test("saved/unchanged referenceの完全一致historyだけをformal_historyで出力", async () => {
    for (const status of ["saved", "unchanged"]) {
        const source = await fixture({ status });
        const result = await collect(source);
        const section = result.sections.qriOptionsNextContract;
        assert.equal(section.status, "available");
        assert.deepEqual(section.authority, { source: qri.SOURCE,
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: source.versionKey, signature: source.revision.signature });
        assert.deepEqual(section.asOf, { tradingDate: TRADING_DATE,
            sourceDate: TRADING_DATE, snapshotDate: "2026-09-07",
            pageUpdatedAt: PAGE_UPDATED_AT, fetchedAt: FETCHED_AT,
            confirmedAt: CONFIRMED_AT });
        assert.deepEqual(section.summary.callAggregate,
            { value: 125, publishedRecordCount: 2, unpublishedRecordCount: 0 });
        assert.deepEqual(section.summary.putAggregate,
            { value: 80, publishedRecordCount: 1, unpublishedRecordCount: 1 });
        assert.equal(section.details.records[1].value, null);
        assert.deepEqual(section.details.warnings, []);
    }
});

test("未完了・failed・skipped・missingは古いhistoryへfallbackしない", async () => {
    for (const status of ["scheduled", "fetching", "validating", "persisting", "failed", "skipped"]) {
        const source = await fixture({ status });
        const section = (await collect(source)).sections.qriOptionsNextContract;
        assert.equal(section.status, "unavailable");
        assert.equal(section.reason, `next_contract_acquisition_${status}`);
        assert.notEqual(section.freshness.status, "fresh");
    }
    const source = await fixture();
    const result = await collect(source, { getQriReferenceAcquisitionState: () => null });
    assert.equal(result.sections.qriOptionsNextContract.reason,
        "next_contract_acquisition_missing");
});

test("locatorとactive revisionの不一致をすべて拒否", async () => {
    const cases = [
        source => { source.acquisition.targetContract = "2026-11"; },
        source => { source.acquisition.referenceTradingDate = "2026-09-08"; },
        source => { source.acquisition.versionKey += "-other"; },
        source => { source.acquisition.targetUrl = "https://svc.qri.jp/jpx/nkopm/3"; },
        source => { source.history.entries[0].activeVersionKey += "-inactive"; }
    ];
    for (const mutate of cases) {
        const source = await fixture(); mutate(source);
        const section = (await collect(source, { validateQriHistory: async () =>
            ({ valid: true, errors: [] }) })).sections.qriOptionsNextContract;
        assert.equal(section.status, "unavailable");
        assert.equal(section.reason, "next_contract_identity_mismatch");
    }
});

test("canonical/signature改変、specific canonical、isActiveContractだけでは昇格しない", async () => {
    const tampered = await fixture();
    tampered.revision.canonical.records[0].value += 1;
    assert.equal((await collect(tampered, { validateQriHistory: async () =>
        ({ valid: true, errors: [] }) })).sections.qriOptionsNextContract.reason,
    "next_contract_signature_mismatch");

    const source = await fixture();
    for (const state of [null, { status: "ready", canonical: source.revision.canonical },
        { status: "ready", isActiveContract: true }]) {
        const result = await collect(source, { getQriReferenceAcquisitionState: () => state });
        assert.equal(result.sections.qriOptionsNextContract.status, "unavailable");
    }
});

test("期先freshnessはdaily contractを使いhistoryをfreshへ昇格しない", async () => {
    const source = await fixture();
    const section = (await collect(source)).sections.qriOptionsNextContract;
    assert.equal(section.freshness.status, "stale");
    assert.equal(section.freshness.reason, "saved_last_valid");
    assert.equal(section.freshness.origin, "history");
    const adapter = createFullExportFreshnessAdapter({
        getMarketSession: () => ({ formalTradingDate: TRADING_DATE }) });
    assert.equal(adapter.getSectionFreshness("qriOptionsNextContract").status,
        "unavailable");
});

test("schema/security/deterministic serializationと既存section非依存を維持", async () => {
    const source = await fixture();
    const first = await collect(source, { getQriFormalIdentity: () => ({ status: "available",
        fact: { contract: "2099-01", canonicalVersionKey: "wrong-active-identity" } }) });
    const second = await collect(source, { getQriFormalIdentity: () => null });
    assert.equal(fullExport.validateFullExport(first).valid, true);
    assert.equal(first.sections.qriOptionsNextContract.status, "available");
    assert.equal(first.sections.qriOptions.status, "unavailable");
    assert.equal(first.sections.overallV2.status, "unavailable");
    assert.equal(first.sections.morning.status, "unavailable");
    assert.equal(fullExport.serializeFullExport(first), fullExport.serializeFullExport(second));
});
