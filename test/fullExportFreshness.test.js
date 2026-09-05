"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const freshness = require("../js/dataFreshness.js");
const { createFullExportFreshnessAdapter } = require("../js/fullExportFreshness.js");

function dependencies(overrides = {}) {
    const fetchStates = {
        qri: { status: "success", fetchedAt: "2026-09-06T00:05:00Z" },
        participant: { status: "success", fetchedAt: "2026-09-04T08:00:00Z" },
        weeklyFutures: { status: "success", fetchedAt: "2026-09-06T00:06:00Z" },
        weeklyOptions: { status: "success", fetchedAt: "2026-09-06T00:07:00Z" }
    };
    const weekly = {
        weeklyFutures: { status: "latest", sourceDate: "2026-08-28",
            signature: "wf-signature", origin: "history", remoteCheckStatus: "current" },
        weeklyOptions: { status: "latest", sourceDate: "2026-08-28",
            signature: "wo-signature", origin: "history", remoteCheckStatus: "current" }
    };
    return {
        getMarketSession: () => ({ formalTradingDate: "2026-09-07" }),
        getCurrentPriceIdentity: () => ({ status: "available", fact: { available: true,
            sourceKind: "live", origin: "live", mode: "automatic", identityVerified: true,
            acquisitionVerified: true, currentRequestVerified: true, contract: "2026-09",
            quotedAt: "2026-09-05T06:00:00+09:00", fetchedAt: "2026-09-06T00:05:00Z",
            qriTradingDateMapping: { mappingVerified: true,
                mappingSource: "same_date_explicit", qriTradingDate: "2026-09-07" } } }),
        getQriFormalIdentity: () => ({ status: "available", fact: {
            sourceClass: "formal_live", origin: "live", identityVerified: true,
            acquisitionVerified: true, usingFallback: false, referenceOnly: false,
            contract: "2026-09", tradingDate: "2026-09-07",
            pageUpdatedAt: "2026-09-05T18:45:00+09:00",
            fetchedAt: "2026-09-06T00:05:00Z", canonicalSignature: "qri-signature" } }),
        getOverallV2FormalEnvelope: () => ({ status: "available", envelope: {
            formalApplied: true, identityVerified: true,
            result: { status: "partial", components: { option: { available: false },
                weekly: { available: true } } } } }),
        getFetchState: name => fetchStates[name] || null,
        getWeeklyDataState: name => weekly[name] || null,
        getParticipantState: () => ({ sourceDate: "2026-09-04",
            observedLatestDate: "2026-09-04", fetchedAt: "2026-09-04T08:00:00Z",
            signature: "participant-signature", origin: "live", dataStatus: "partial" }),
        ...overrides
    };
}

test("daily/weekly sourceは既存evaluatorの結果をそのまま利用", () => {
    const deps = dependencies();
    const adapter = createFullExportFreshnessAdapter(deps);
    const qri = adapter.getSectionFreshness("qriOptions");
    const expectedQri = freshness.evaluateDailyFreshness({ sourceType: "qri_options",
        origin: "live", hasData: true, dataTradingDate: "2026-09-07",
        sourceUpdatedAt: "2026-09-05T18:45:00+09:00",
        fetchedAt: "2026-09-06T00:05:00Z", expectedTradingDate: "2026-09-07",
        lastAttemptedAt: "2026-09-06T00:05:00Z", lastAttemptStatus: "success",
        mode: "automatic", contract: "2026-09", validation: true,
        signatureValid: true, calculationEligible: "eligible" });
    assert.deepEqual(qri, expectedQri);
    assert.equal(adapter.getSectionFreshness("weeklyFutures").status, "fresh");
    assert.equal(adapter.getSectionFreshness("weeklyOptions").status, "fresh");
});

test("stale/cache/fallback/referenceをfreshへ昇格しない", () => {
    const stale = createFullExportFreshnessAdapter(dependencies({
        getWeeklyDataState: () => ({ status: "latest", sourceDate: "2026-08-28",
            signature: "sig", origin: "cache", remoteCheckStatus: "failed" })
    })).getSectionFreshness("weeklyFutures");
    assert.equal(stale.status, "stale");
    const qri = createFullExportFreshnessAdapter(dependencies({
        getQriFormalIdentity: () => ({ status: "available", fact: { origin: "history",
            identityVerified: true, acquisitionVerified: true, usingFallback: true } })
    })).getSectionFreshness("qriOptions");
    assert.equal(qri.status, "unavailable");
});

test("情報不足と未検証authorityはunavailable", () => {
    const adapter = createFullExportFreshnessAdapter(dependencies({
        getCurrentPriceIdentity: () => null, getWeeklyDataState: () => null,
        getParticipantState: () => null
    }));
    assert.equal(adapter.getSectionFreshness("marketSnapshot").status, "unavailable");
    assert.equal(adapter.getSectionFreshness("weeklyFutures").status, "unavailable");
    assert.equal(adapter.getSectionFreshness("participants").status, "unavailable");
});

test("Morning/history/Intelligence/OverallV2をcurrent data freshnessへ昇格しない", () => {
    const adapter = createFullExportFreshnessAdapter(dependencies());
    assert.deepEqual(adapter.getSectionFreshness("morning"), {
        applicable: false, status: "not_applicable", reason: "session_based_reference",
        sourceType: "morning_baseline", promotedToCurrent: false });
    for (const name of ["qriHistoryComparison", "intelligence"]) {
        assert.equal(adapter.getSectionFreshness(name).status, "not_applicable");
        assert.equal(adapter.getSectionFreshness(name).reason, "history_fact");
    }
    assert.equal(adapter.getSectionFreshness("overallV2").status, "not_applicable");
});

test("OverallV2は正式envelope不在時にfreshnessを推測しない", () => {
    const adapter = createFullExportFreshnessAdapter(dependencies({
        getOverallV2FormalEnvelope: () => ({ status: "unavailable", envelope: null })
    }));
    assert.equal(adapter.getSectionFreshness("overallV2").status, "unavailable");
});

test("importantLevelsはQRI freshnessを再計算せず投影", () => {
    const adapter = createFullExportFreshnessAdapter(dependencies());
    const qri = adapter.getSectionFreshness("qriOptions");
    assert.deepEqual(adapter.getSectionFreshness("importantLevels"), {
        ...qri, projectionSource: "qriOptions" });
});

test("weekend cross-dateの未解決contextをsame-dateへ推測しない", () => {
    const deps = dependencies(); const state = deps.getCurrentPriceIdentity();
    deps.getCurrentPriceIdentity = () => ({ ...state, fact: { ...state.fact,
        qriTradingDateMapping: { mappingVerified: false, mappingSource: null,
            relation: "previous_date", quoteDate: "2026-09-05",
            qriTradingDate: "2026-09-07", status: "date_context_unresolved" } } });
    const result = createFullExportFreshnessAdapter(deps)
        .getSectionFreshness("marketSnapshot");
    assert.equal(result.status, "stale");
    assert.equal(result.reason, "date_unverifiable");
    assert.equal(result.dataTradingDate, null);
});

test("participant partialをfreshness上の欠損へ変換しない", () => {
    const result = createFullExportFreshnessAdapter(dependencies())
        .getSectionFreshness("participants");
    assert.equal(result.status, "fresh");
    assert.equal(result.calculationEligible, "undetermined");
});

test("adapterはfetch/storage/publishを呼ばず入力を変更しない", () => {
    const source = dependencies();
    const before = structuredClone(source.getQriFormalIdentity());
    let sideEffects = 0;
    const adapter = createFullExportFreshnessAdapter({ ...source,
        fetch: () => sideEffects++, put: () => sideEffects++, publish: () => sideEffects++ });
    for (const name of ["marketSnapshot", "overallV2", "morning", "importantLevels",
        "qriOptions", "qriHistoryComparison", "weeklyFutures", "weeklyOptions",
        "participants", "intelligence"]) adapter.getSectionFreshness(name);
    assert.equal(sideEffects, 0);
    assert.deepEqual(source.getQriFormalIdentity(), before);
});

test("UI wiringに全section固定unavailableを残さない", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /OptionMapFullExportFreshness[\s\S]*getSectionFreshness:\s*freshnessAdapter\.getSectionFreshness/);
    assert.doesNotMatch(html, /getSectionFreshness:\s*name\s*=>\s*\(\{\s*status:\s*"unavailable"/);
});
