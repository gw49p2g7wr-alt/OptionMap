"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const qri = require("../js/qriOptions.js");
const historyApi = require("../js/qriOptionsHistory.js");
const fullExport = require("../js/fullExport.js");
const { createFullExportCollector } = require("../js/fullExportCollector.js");
const { createFullExportFreshnessAdapter } = require("../js/fullExportFreshness.js");

const CONTRACT = "2026-12";
const DATE = "2026-09-07";
const URL = "https://svc.qri.jp/jpx/nkopm/4";
const UPDATED = "2026-09-07T18:45:00+09:00";
const FETCHED = "2026-09-07T09:46:00.000Z";
const CONFIRMED = "2026-09-07T09:47:00.000Z";
const COMPLETED = "2026-09-07T09:48:00.000Z";

function canonical(overrides = {}) {
    return { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE, sourceUrl: URL,
        pageUpdatedAt: UPDATED, tradingDate: DATE, openInterestAsOf: null,
        contract: CONTRACT, gengetsu: "202612", contractLabel: "12月限月",
        isActiveContract: true, lastTradingDate: "2026-12-10",
        openInterestStatus: "available", availableContracts: [
            { contract: CONTRACT, label: "12月限月", url: URL, active: true }],
        records: [
            { contract: CONTRACT, optionType: "call", strike: 42000,
                published: true, value: 100 },
            { contract: CONTRACT, optionType: "call", strike: 42500,
                published: false, value: null },
            { contract: CONTRACT, optionType: "put", strike: 42000,
                published: true, value: 70 },
            { contract: CONTRACT, optionType: "put", strike: 42500,
                published: true, value: 30 }
        ], ...overrides };
}

async function source(options = {}) {
    const canonicalValue = canonical(options.canonical);
    const signature = await qri.createSignature(canonicalValue);
    const versionKey = `qri-options-v2|${CONTRACT}|${UPDATED}|sha256:${signature}`;
    const revision = { contract: CONTRACT, versionKey, signature,
        signatureAlgorithm: "sha256", sourceUrl: URL, fetchedAt: FETCHED,
        confirmedAt: CONFIRMED, snapshotDate: DATE, replacedAt: null,
        pageUpdatedAt: UPDATED, tradingDate: DATE, openInterestAsOf: null,
        lastTradingDate: "2026-12-10", openInterestStatus: "available",
        canonical: canonicalValue, ...(options.revision || {}) };
    const entry = { entryKey: `${CONTRACT}|${DATE}`, contract: CONTRACT,
        sourceDateKey: DATE, activeVersionKey: versionKey, firstSeenAt: CONFIRMED,
        lastSeenAt: CONFIRMED, revisions: [revision], ...(options.entry || {}) };
    const locator = { status: options.status || "saved", targetContract: CONTRACT,
        referenceTradingDate: DATE, targetUrl: URL, versionKey, completedAt: COMPLETED,
        ...(options.locator || {}) };
    return { locator, revision, versionKey, history: { historyVersion: 1,
        parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
        signatureAlgorithm: "sha256", createdAt: CONFIRMED, updatedAt: CONFIRMED,
        entries: [entry] } };
}

async function collect(value, overrides = {}) {
    const freshness = createFullExportFreshnessAdapter({
        getMarketSession: () => ({ formalTradingDate: DATE }) });
    return createFullExportCollector({ now: () => "2026-09-07T10:00:00.000Z",
        getMarketSession: () => ({ status: "verified", tradingDate: DATE }),
        getMobileSummary: () => null,
        getQriMajorSqFormalHistoryLocator: () => value?.locator || null,
        readQriHistory: async () => ({ status: "ready", history: value?.history }),
        validateQriHistory: candidate => historyApi.validateHistory(candidate),
        getSectionFreshness: freshness.getSectionFreshness,
        ...overrides }).collect({ market: "Nikkei" });
}

test("saved/unchanged locator and exact active history produce formal_history authority", async () => {
    for (const status of ["saved", "unchanged"]) {
        const value = await source({ status });
        const section = (await collect(value)).sections.qriOptionsMajorSqNextContract;
        assert.equal(section.status, "available");
        assert.deepEqual(section.authority, { source: qri.SOURCE,
            sourceClass: "formal_history", origin: "history", formalStatus: "verified",
            versionKey: value.versionKey, signature: value.revision.signature });
        assert.deepEqual(section.asOf, { tradingDate: DATE, sourceDate: DATE,
            snapshotDate: DATE, pageUpdatedAt: UPDATED, fetchedAt: FETCHED,
            confirmedAt: CONFIRMED });
    }
});

test("null or non-success locator never searches old Major-SQ history", async () => {
    const value = await source();
    assert.equal((await collect(value, { getQriMajorSqFormalHistoryLocator: () => null }))
        .sections.qriOptionsMajorSqNextContract.reason, "major_sq_locator_unavailable");
    for (const status of ["failed", "skipped", "stale"]) {
        value.locator.status = status;
        const section = (await collect(value)).sections.qriOptionsMajorSqNextContract;
        assert.equal(section.status, "unavailable");
        assert.equal(section.reason, `major_sq_acquisition_${status}`);
    }
});

test("every locator/entry/active revision identity mismatch is unavailable", async () => {
    const mutations = [
        value => { value.locator.targetContract = "2027-03"; },
        value => { value.locator.referenceTradingDate = "2026-09-08"; },
        value => { value.locator.targetUrl = "https://svc.qri.jp/jpx/nkopm/5"; },
        value => { value.locator.versionKey += "-other"; },
        value => { value.history.entries[0].activeVersionKey += "-other"; }
    ];
    for (const mutate of mutations) {
        const value = await source(); mutate(value);
        const section = (await collect(value, { validateQriHistory: () =>
            ({ valid: true, errors: [] }) })).sections.qriOptionsMajorSqNextContract;
        assert.equal(section.status, "unavailable");
        assert.equal(section.reason, "major_sq_identity_mismatch");
    }
});

test("canonical or signature tampering is rejected after history validation", async () => {
    for (const mutate of [
        value => { value.revision.canonical.records[0].value += 1; },
        value => { value.revision.signature = "b".repeat(64); },
        value => { value.revision.canonical.pageUpdatedAt =
            "2026-09-07T18:46:00+09:00"; }
    ]) {
        const value = await source(); mutate(value);
        const section = (await collect(value, { validateQriHistory: () =>
            ({ valid: true, errors: [] }) })).sections.qriOptionsMajorSqNextContract;
        assert.notEqual(section.status, "available");
    }
});

test("published aggregates exclude unpublished records without zero filling", async () => {
    const section = (await collect(await source())).sections.qriOptionsMajorSqNextContract;
    assert.deepEqual(section.summary.callAggregate,
        { value: 100, publishedRecordCount: 1, unpublishedRecordCount: 1 });
    assert.deepEqual(section.summary.putAggregate,
        { value: 100, publishedRecordCount: 2, unpublishedRecordCount: 0 });
    assert.equal(section.details.records[1].published, false);
    assert.equal(section.details.records[1].value, null);
    assert.deepEqual(section.details.warnings, []);
});

test("history freshness stays stale and missing locator freshness stays unavailable", async () => {
    const available = (await collect(await source())).sections.qriOptionsMajorSqNextContract;
    assert.deepEqual([available.freshness.status, available.freshness.reason,
        available.freshness.origin], ["stale", "saved_last_valid", "history"]);
    const missing = (await collect(await source(), {
        getQriMajorSqFormalHistoryLocator: () => null }))
        .sections.qriOptionsMajorSqNextContract;
    assert.equal(missing.freshness.status, "unavailable");
});

test("active Formal and ordinary next-contract authorities are never reused", async () => {
    const value = await source();
    const result = await collect(value, {
        getQriMajorSqFormalHistoryLocator: () => null,
        getQriFormalIdentity: () => ({ status: "available", fact: {
            contract: CONTRACT, canonicalVersionKey: value.versionKey } }),
        getQriReferenceAcquisitionState: () => ({ acquisition: {
            status: "saved", targetContract: CONTRACT, referenceTradingDate: DATE,
            targetUrl: URL, versionKey: value.versionKey } })
    });
    assert.equal(result.sections.qriOptionsMajorSqNextContract.status, "unavailable");
});

test("serialization is deterministic, deep frozen and security-valid", async () => {
    const value = await source(); const first = await collect(value); const second = await collect(value);
    assert.equal(fullExport.SCHEMA_VERSION, "optionmap-full-export-v1");
    assert.equal(fullExport.validateFullExport(first).valid, true);
    assert.equal(Object.isFrozen(first.sections.qriOptionsMajorSqNextContract.details.records), true);
    assert.equal(fullExport.serializeFullExport(first), fullExport.serializeFullExport(second));
    assert.equal(first.sections.qriOptions.status, second.sections.qriOptions.status);
    assert.equal(first.sections.qriOptionsNextContract.status,
        second.sections.qriOptionsNextContract.status);
    assert.equal(first.sections.overallV2.status, second.sections.overallV2.status);
    assert.equal(first.sections.morning.status, second.sections.morning.status);
});
