const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../js/mobileMorningComparison.js");
const qri = require("../js/qriOptions.js");
const historyApi = require("../js/qriOptionsHistory.js");

const NOW = "2026-08-18T08:00:00.000Z";
const URL = "https://svc.qri.jp/jpx/nkopm/";
const overall = (direction = 20, label = "買い優勢", extra = {}) => ({ available: true,
    status: "complete", direction, directionLabel: label, confidence: 70, coverage: 80,
    agreement: 90, ...extra });
const price = (value = 40000, extra = {}) => ({ available: true, value,
    source: "qri", mode: "automatic", contract: "2026-09", quotedAt: NOW, ...extra });
const quality = (status = "complete", warnings = []) => ({ status, warnings });
function canonical({ pageUpdatedAt = "2026-08-18T16:00:00+09:00", status = "available",
    records, contract = "2026-09", tradingDate = "2026-08-18" } = {}) {
    const published = status === "available";
    return { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE, sourceUrl: URL,
        pageUpdatedAt, tradingDate, openInterestAsOf: null, contract,
        gengetsu: contract.replace("-", ""), contractLabel: "9月限月", isActiveContract: true,
        lastTradingDate: `${contract}-10`, openInterestStatus: status,
        availableContracts: [{ contract, label: "9月限月", url: URL, active: true,
            gengetsu: contract.replace("-", ""), lastTradingDate: `${contract}-10` }],
        records: records || [
            { contract, optionType: "call", strike: 40000, published, value: published ? 10 : null },
            { contract, optionType: "put", strike: 40000, published, value: published ? 20 : null }
        ] };
}
async function identity(value) {
    const signature = await qri.createSignature(value);
    return { signature: `sha256:${signature}`,
        versionKey: `qri-options-v2|${value.contract}|${value.pageUpdatedAt}|sha256:${signature}` };
}

test("overallV2 compares numeric fields and classifies all side transitions", () => {
    const same = api.compareOverallV2(overall(), overall());
    assert.equal(same.transition, "label_unchanged"); assert.equal(same.directionDelta, 0);
    const cases = [[0, 20, "neutral_to_buy"], [0, -20, "neutral_to_sell"],
        [20, 0, "buy_to_neutral"], [-20, 0, "sell_to_neutral"],
        [20, -20, "buy_to_sell"], [-20, 20, "sell_to_buy"]];
    for (const [before, after, expected] of cases)
        assert.equal(api.compareOverallV2(overall(before), overall(after)).transition, expected);
    const changed = api.compareOverallV2(overall(20), overall(40, "強い買い優勢",
        { confidence: 75, coverage: 90, agreement: 80 }));
    assert.equal(changed.transition, "strength_changed_same_side");
    assert.deepEqual([changed.directionDelta, changed.confidenceDelta, changed.coverageDelta,
        changed.agreementDelta], [20, 5, 10, -10]);
    assert.equal(api.compareOverallV2({ available: false }, overall()).available, false);
    assert.throws(() => api.compareOverallV2(overall(), overall(Infinity)), /invalid_overall/);
});

test("currentPrice retains metadata and safely handles unavailable, zero and contract mismatch", () => {
    assert.equal(api.compareCurrentPrice(price(40000), price(40320)).delta, 320);
    assert.equal(api.compareCurrentPrice(price(40000), price(39600)).percentChange, -1);
    assert.equal(api.compareCurrentPrice(price(0), price(10)).percentChange, null);
    const changed = api.compareCurrentPrice(price(10), price(10, { source: "manual", mode: "manual" }));
    assert.equal(changed.sourceChanged, true); assert.equal(changed.modeChanged, true);
    assert.equal(api.compareCurrentPrice({ available: false }, price()).reason, "baseline_price_unavailable");
    assert.equal(api.compareCurrentPrice(price(), { available: false }).reason, "current_price_unavailable");
    assert.equal(api.compareCurrentPrice(price(), price(1, { contract: "2026-10" })).reason, "contract_mismatch");
    assert.throws(() => api.compareCurrentPrice(price(), price(NaN)), /invalid_price/);
});

test("dataQuality compares warning sets without order dependence", () => {
    assert.equal(api.compareDataQuality(quality(), quality()).transition, "unchanged");
    assert.equal(api.compareDataQuality(quality("partial", ["b", "a"]),
        quality("complete", [])).transition, "improved");
    const degraded = api.compareDataQuality(quality("complete", ["old"]),
        quality("partial", ["new", "old"]));
    assert.equal(degraded.transition, "degraded");
    assert.deepEqual(degraded.addedWarnings, ["new"]); assert.deepEqual(degraded.resolvedWarnings, []);
    assert.equal(api.compareDataQuality(quality("unavailable"), quality("partial")).transition, "improved");
});

test("QRI intraday separates CALL/PUT and never zero-fills unobserved records", async () => {
    const morning = canonical({ records: [
        { contract: "2026-09", optionType: "call", strike: 40000, published: true, value: 10 },
        { contract: "2026-09", optionType: "call", strike: 40500, published: true, value: 0 },
        { contract: "2026-09", optionType: "call", strike: 41000, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 39500, published: true, value: 30 },
        { contract: "2026-09", optionType: "put", strike: 40000, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 40500, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 41000, published: false, value: null },
        { contract: "2026-09", optionType: "call", strike: 39500, published: false, value: null }
    ] });
    const current = canonical({ pageUpdatedAt: "2026-08-18T17:00:00+09:00", status: "partial", records: [
        { contract: "2026-09", optionType: "call", strike: 40000, published: true, value: 25 },
        { contract: "2026-09", optionType: "call", strike: 40500, published: true, value: 5 },
        { contract: "2026-09", optionType: "call", strike: 41000, published: true, value: 99 },
        { contract: "2026-09", optionType: "put", strike: 39500, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 40000, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 40500, published: false, value: null },
        { contract: "2026-09", optionType: "put", strike: 41000, published: false, value: null },
        { contract: "2026-09", optionType: "call", strike: 39500, published: false, value: null }
    ] });
    const recordOrder = (left, right) => left.strike - right.strike || left.optionType.localeCompare(right.optionType);
    morning.records.sort(recordOrder); current.records.sort(recordOrder);
    const mi = await identity(morning); const ci = await identity(current);
    const result = await api.compareQriIntraday({ marketDate: "2026-08-18",
        baselineCanonical: morning, baselineVersionKey: mi.versionKey, baselineSignature: mi.signature,
        currentCanonical: current, currentVersionKey: ci.versionKey, currentSignature: ci.signature });
    assert.equal(result.available, true, JSON.stringify(result)); assert.equal(result.CALL.comparableCount, 2);
    assert.equal(result.CALL.currentOnlyCount, 1); assert.equal(result.PUT.morningOnlyCount, 1);
    assert.equal(result.CALL.netDelta, 20); assert.equal(result.CALL.absoluteDeltaTotal, 20);
    assert.equal(result.CALL.topIncreases[0].strike, 40000);
    assert.equal(result.CALL.topIncreases.some(item => item.strike === 41000), false);
    assert.equal(result.CALL.topIncreases.find(item => item.strike === 40500).percentChange, null);
});

test("QRI comparison rejects unavailable, identity and date/contract mismatches", async () => {
    const morning = canonical(); const current = canonical({ pageUpdatedAt: "2026-08-18T17:00:00+09:00" });
    const mi = await identity(morning); const ci = await identity(current);
    const base = { marketDate: "2026-08-18", baselineCanonical: morning,
        baselineVersionKey: mi.versionKey, baselineSignature: mi.signature,
        currentCanonical: current, currentVersionKey: ci.versionKey, currentSignature: ci.signature };
    assert.equal((await api.compareQriIntraday({ ...base, baselineVersionKey: "bad" })).reason, "version_key_mismatch");
    assert.equal((await api.compareQriIntraday({ ...base, currentSignature: "sha256:" + "0".repeat(64) })).reason,
        "signature_mismatch");
    assert.equal((await api.compareQriIntraday({ ...base, marketDate: "2026-08-17" })).reason,
        "market_date_mismatch");
    const unavailable = canonical({ status: "unavailable" }); const ui = await identity(unavailable);
    assert.equal((await api.compareQriIntraday({ ...base, baselineCanonical: unavailable,
        baselineVersionKey: ui.versionKey, baselineSignature: ui.signature })).reason, "baseline_qri_unavailable");
});

test("QRI comparison permits a validated session trading-date transition only when explicit", async () => {
    const morning = canonical();
    const current = canonical({ tradingDate: "2026-08-19", pageUpdatedAt: "2026-08-18T18:00:00+09:00" });
    const mi = await identity(morning); const ci = await identity(current);
    const input = { marketDate: "2026-08-19", baselineCanonical: morning,
        baselineVersionKey: mi.versionKey, baselineSignature: mi.signature,
        currentCanonical: current, currentVersionKey: ci.versionKey, currentSignature: ci.signature };
    assert.equal((await api.compareQriIntraday(input)).reason, "trading_date_mismatch");
    assert.equal((await api.compareQriIntraday({ ...input, sessionApplicable: true })).available, true);
    const rolled = canonical({ contract: "2026-10", tradingDate: "2026-08-19",
        pageUpdatedAt: "2026-08-18T18:00:00+09:00" });
    rolled.contractLabel = "10月限月";
    rolled.availableContracts[0].label = "10月限月";
    const ri = await identity(rolled);
    assert.equal((await api.compareQriIntraday({ ...input, sessionApplicable: true,
        currentCanonical: rolled, currentVersionKey: ri.versionKey,
        currentSignature: ri.signature })).reason, "contract_mismatch");
});

test("resolver uses active baseline reference and resolves an old non-active QRI revision", async () => {
    const firstCache = await qri.createCacheV2(canonical(), NOW);
    const secondCache = await qri.createCacheV2(canonical({ pageUpdatedAt: "2026-08-18T17:00:00+09:00" }), NOW);
    const first = (await historyApi.createHistoryCandidate(firstCache)).candidate;
    let history = (await historyApi.mergeCandidate(historyApi.createEmptyQriOptionsHistory(), first,
        { confirmedAt: NOW })).history;
    const second = (await historyApi.createHistoryCandidate(secondCache)).candidate;
    history = (await historyApi.mergeCandidate(history, second,
        { confirmedAt: "2026-08-18T09:00:00.000Z" })).history;
    const baseline = { activeBaselineId: "active", revisions: [
        { baselineId: "old", comparisonReference: { contract: "2026-09", tradingDate: "2026-08-18",
            versionKey: second.versionKey, signature: `sha256:${second.signature}` } },
        { baselineId: "active", comparisonReference: { contract: "2026-09", tradingDate: "2026-08-18",
            versionKey: first.versionKey, signature: `sha256:${first.signature}` },
        qriAvailability: { available: true } }
    ] };
    const resolved = await api.resolveBaselineQriRevision(history, baseline);
    assert.equal(resolved.available, true); assert.equal(resolved.revision.versionKey, first.versionKey);
    const missing = structuredClone(baseline); missing.revisions[1].comparisonReference.versionKey = "missing";
    assert.equal((await api.resolveBaselineQriRevision(history, missing)).reason, "baseline_revision_missing");
    const broken = structuredClone(history); broken.entries[0].activeVersionKey = "missing";
    assert.equal((await api.resolveBaselineQriRevision(broken, baseline)).reason, "history_corrupted");
});

test("resolver distinguishes unavailable, legacy unknown, missing reference and missing revision", async () => {
    const empty = historyApi.createEmptyQriOptionsHistory();
    const revision = availability => ({ baselineId: "active", qriAvailability: availability,
        comparisonReference: null });
    assert.equal((await api.resolveBaselineQriRevision(empty, { activeBaselineId: "active",
        revisions: [revision({ available: false, openInterestStatus: "unavailable" })] })).reason,
    "baseline_qri_unavailable");
    assert.equal((await api.resolveBaselineQriRevision(empty, { activeBaselineId: "active",
        revisions: [{ baselineId: "active", comparisonReference: null }] })).reason,
    "qri_availability_unknown");
    assert.equal((await api.resolveBaselineQriRevision(empty, { activeBaselineId: "active",
        revisions: [revision({ available: false, openInterestStatus: "available" })] })).reason,
    "qri_reference_missing");
    const missing = revision({ available: true, openInterestStatus: "available" });
    missing.comparisonReference = { contract: "2026-09", tradingDate: "2026-08-18",
        versionKey: "missing", signature: `sha256:${"a".repeat(64)}` };
    assert.equal((await api.resolveBaselineQriRevision(empty, { activeBaselineId: "active",
        revisions: [missing] })).reason, "baseline_revision_missing");
});

test("summaryItems are deduplicated, prioritized and capped; formatter hides technical reason", () => {
    const items = api.summaryItems({ overallV2: api.compareOverallV2(overall(20), overall(-20)),
        currentPrice: api.compareCurrentPrice(price(40000), price(40100)),
        dataQuality: api.compareDataQuality(quality("complete"), quality("partial")),
        optionChanges: { available: false, reason: "baseline_qri_unavailable" } });
    assert.equal(items.length, 3); assert.equal(items[0].code, "overall_side_changed");
    assert.equal(new Set(items.map(item => item.code)).size, items.length);
    assert.doesNotMatch(api.formatReason("baseline_qri_unavailable"), /baseline_qri/);
    assert.doesNotMatch(api.formatReason("qri_availability_unknown"), /qri_availability/);
});

test("comparison pins baseline meaning, permits option partial failure and does not mutate input", () => {
    const baselineRevision = { baselineId: "mb1-" + "a".repeat(24), capturedAt: NOW,
        overallV2: overall(20), currentPrice: price(40000), dataQuality: quality("partial") };
    const currentSummary = { marketDate: "2026-08-18", payload: { overallV2: overall(40),
        currentPrice: price(40100) }, dataQuality: quality("complete") };
    const before = structuredClone({ baselineRevision, currentSummary });
    const result = api.createComparison({ marketDate: "2026-08-18", baselineRevision, currentSummary,
        optionChanges: { available: false, reason: "baseline_revision_missing" }, comparedAt: NOW });
    assert.equal(result.available, true); assert.equal(result.optionAvailability, "baseline_revision_missing");
    assert.equal(result.baselineId, baselineRevision.baselineId);
    assert.deepEqual({ baselineRevision, currentSummary }, before);
    assert.equal(api.createComparison({ marketDate: "2026-08-17", baselineRevision, currentSummary,
        optionChanges: {}, comparedAt: NOW }).reason, "market_date_mismatch");
});
