const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Envelope = require("../js/qriOptionsFormalComparisonEvidence.js");
const Availability = require("../js/formalOptionAvailabilityEvidence.js");

const PREVIOUS = "qri-options-v2|2026-09|2026-08-26T05:40:00+09:00|sha256:" + "a".repeat(64);
const CURRENT = "qri-options-v2|2026-09|2026-08-27T05:41:00+09:00|sha256:" + "b".repeat(64);
const REQUEST = "marketRefresh-1";
const summary = (increaseCount = 0, decreaseCount = 0) => ({ comparableCount: 2,
    previousOnlyCount: 0, currentOnlyCount: 0, unobservedCount: 0, invalidCount: 0,
    absoluteDeltaTotal: increaseCount + decreaseCount, netDelta: increaseCount - decreaseCount,
    increaseCount, decreaseCount, unchangedCount: 2 - increaseCount - decreaseCount,
    topIncreases: [], topDecreases: [], newlyPublished: [], noLongerPublished: [] });
function fixture() {
    const generation = { source: "qri", sequence: 2, fingerprint: "qri-fingerprint-2", current: true };
    const previousRevision = { contract: "2026-09", tradingDate: "2026-08-26",
        pageUpdatedAt: "2026-08-26T05:40:00+09:00", versionKey: PREVIOUS,
        signature: "a".repeat(64), replacedAt: null };
    const currentRevision = { contract: "2026-09", tradingDate: "2026-08-27",
        pageUpdatedAt: "2026-08-27T05:41:00+09:00", versionKey: CURRENT,
        signature: "b".repeat(64), replacedAt: null };
    return { historyComparisonResult: { source: "formal_qri_options_history", available: true,
        status: "comparable", reason: null, contract: "2026-09",
        previousSourceDate: "2026-08-26", currentSourceDate: "2026-08-27",
        previousVersionKey: PREVIOUS, currentVersionKey: CURRENT,
        comparison: { records: [], byType: { call: { records: [], summary: summary() },
            put: { records: [], summary: summary() } } } }, previousRevision, currentRevision,
        currentQriFormalIdentity: { sourceClass: "formal_live", origin: "live",
            identityVerified: true, acquisitionVerified: true, usingFallback: false,
            referenceOnly: false, contract: "2026-09", tradingDate: "2026-08-27",
            canonicalVersionKey: CURRENT, canonicalSignature: "b".repeat(64),
            requestId: REQUEST, generation: structuredClone(generation) },
        runtimeContext: { comparisonExecuted: true,
            previousEntryIdentity: "2026-09|2026-08-26", currentEntryIdentity: "2026-09|2026-08-27",
            previousActiveVersionKey: PREVIOUS, currentActiveVersionKey: CURRENT,
            requestId: REQUEST, generation, sourceFingerprint: generation.fingerprint,
            mixedAcquisition: false } };
}
const create = mutate => { const value = fixture(); mutate?.(value); return Envelope.createEnvelope(value); };
const failure = async (reason, mutate) => { const value = await create(mutate);
    assert.deepEqual([value.available, value.status, value.reason], [false, "unavailable", reason]);
    return value; };

test("valid formal comparison evidence envelope", async () => { const value = await create();
    assert.deepEqual([value.available, value.status, value.sourceClass], [true, "available", "formal_qri_history"]);
    assert.deepEqual(value.comparison.counts, { callIncrease: 0, callDecrease: 0,
        putIncrease: 0, putDecrease: 0 }); });
test("previous identity missing", async () => failure("previous_identity_missing", x => { x.previousRevision = null; }));
test("current identity missing", async () => failure("current_identity_missing", x => { x.currentRevision = null; }));
test("contract null", async () => failure("contract_mismatch", x => { x.previousRevision.contract = null; }));
test("previous/current contract mismatch", async () => failure("contract_mismatch", x => { x.previousRevision.contract = "2026-12"; }));
test("current/QRI contract mismatch", async () => failure("contract_mismatch", x => { x.currentQriFormalIdentity.contract = "2026-12"; }));
test("tradingDate mismatch", async () => failure("trading_date_mismatch", x => { x.currentQriFormalIdentity.tradingDate = "2026-08-26"; }));
test("current version mismatch", async () => failure("version_mismatch", x => { x.currentQriFormalIdentity.canonicalVersionKey = "other"; }));
test("current signature mismatch", async () => failure("signature_mismatch", x => { x.currentQriFormalIdentity.canonicalSignature = "c".repeat(64); }));
test("current revision mismatch", async () => failure("revision_identity_mismatch", x => { x.currentRevision.revisionIdentity = "other"; }));
test("current not active", async () => failure("current_revision_not_active", x => { x.runtimeContext.currentActiveVersionKey = "other"; }));
test("previous was not selected active revision", async () => failure("previous_identity_missing", x => { x.runtimeContext.previousActiveVersionKey = "other"; }));
test("same version rejected", async () => failure("same_acquisition_rejected", x => { const p = x.previousRevision;
    p.versionKey = CURRENT; p.revisionIdentity = CURRENT; x.historyComparisonResult.previousVersionKey = CURRENT;
    x.runtimeContext.previousActiveVersionKey = CURRENT; }));
test("same signature rejected", async () => failure("same_acquisition_rejected", x => { x.previousRevision.signature = "b".repeat(64); }));
test("same revision rejected", async () => failure("same_acquisition_rejected", x => { x.previousRevision.revisionIdentity = CURRENT; }));
test("sourceDate equal", async () => failure("source_date_order_invalid", x => { x.previousRevision.pageUpdatedAt = x.currentRevision.pageUpdatedAt; }));
test("sourceDate reversed", async () => failure("source_date_order_invalid", x => { x.previousRevision.pageUpdatedAt = "2026-08-28T05:41:00+09:00"; }));
test("same tradingDate revision is allowed when formal source instant increases", async () => { const x = fixture();
    x.previousRevision.tradingDate = "2026-08-27"; x.historyComparisonResult.previousSourceDate = "2026-08-27";
    x.runtimeContext.previousEntryIdentity = "2026-09|2026-08-27";
    assert.equal((await Envelope.createEnvelope(x)).available, true); });
test("request mismatch", async () => failure("request_mismatch", x => { x.runtimeContext.requestId = "other"; }));
test("generation stale", async () => failure("generation_stale", x => { x.runtimeContext.generation.current = false; }));
test("generation fingerprint mismatch", async () => failure("generation_stale", x => { x.runtimeContext.sourceFingerprint = "other"; }));
test("mixed acquisition", async () => failure("mixed_acquisition", x => { x.runtimeContext.mixedAcquisition = true; }));
test("comparison not executed", async () => failure("comparison_not_executed", x => { x.runtimeContext.comparisonExecuted = false; }));
test("history comparison unavailable", async () => failure("history_comparison_unavailable", x => { x.historyComparisonResult.available = false; }));
for (const [name, mutate] of [["count missing", x => { delete x.historyComparisonResult.comparison.byType.call.summary.increaseCount; }],
    ["count negative", x => { x.historyComparisonResult.comparison.byType.put.summary.decreaseCount = -1; }],
    ["count non-integer", x => { x.historyComparisonResult.comparison.byType.call.summary.decreaseCount = 0.5; }]])
    test(name, async () => failure("comparison_counts_invalid", mutate));
test("all counts zero is a valid comparison fact", async () => assert.equal((await create()).available, true));
test("non-zero count is valid envelope", async () => { const value = await create(x => {
    x.historyComparisonResult.comparison.byType.call.summary.increaseCount = 1; });
    assert.deepEqual([value.available, value.comparison.counts.callIncrease], [true, 1]); });
test("published false remains absent rather than a zero observation", async () => { const value = fixture();
    value.historyComparisonResult.comparison.records = [{ status: "current_only", previous: {
        present: false, published: false, value: null }, current: { present: true, published: true, value: 10 }, delta: null }];
    const result = await Envelope.createEnvelope(value); assert.equal(result.available, true);
    assert.equal(value.historyComparisonResult.comparison.records[0].previous.value, null); });
test("fingerprint deterministic", async () => assert.equal((await create()).evidenceFingerprint,
    (await create()).evidenceFingerprint));
test("tamper changes fingerprint", async () => assert.notEqual((await create()).evidenceFingerprint,
    (await create(x => { x.runtimeContext.requestId = x.currentQriFormalIdentity.requestId = "request-2"; })).evidenceFingerprint));
test("fingerprint ignores object key order", async () => { const a = fixture(); const b = fixture();
    b.runtimeContext = Object.fromEntries(Object.entries(b.runtimeContext).reverse());
    assert.equal((await Envelope.createEnvelope(a)).evidenceFingerprint,
        (await Envelope.createEnvelope(b)).evidenceFingerprint); });
test("output is deeply frozen", async () => { const value = await create(); for (const item of [value,
    value.previous, value.current, value.comparison, value.comparison.counts, value.requestIdentity,
    value.generation, value.diagnostics]) assert.equal(Object.isFrozen(item), true); });
test("input is not mutated", async () => { const input = fixture(); const before = structuredClone(input);
    await Envelope.createEnvelope(input); assert.deepEqual(input, before); });
test("legacy source rejected", async () => failure("history_comparison_unavailable", x => {
    x.historyComparisonResult.source = "legacy_optionMapJpxSnapshots"; }));
test("Phase 7.8.6.5 adapter is directly compatible", async () => { const envelope = await create();
    const input = Envelope.toAvailabilityEvidenceInput(envelope); const evidence = await Availability.createEvidence(input);
    assert.deepEqual([evidence.classification, evidence.safeForPartialApplicability], ["normal_no_change", true]); });
test("normal_no_change input is constructible without CurrentPrice", async () => { const input =
    Envelope.toAvailabilityEvidenceInput(await create()); assert.deepEqual([input.classification,
        input.reason, input.counts.nearbyCandidates], ["normal_no_change", "no_candidates", 0]);
    assert.equal(Object.hasOwn(input, "currentPrice"), false); });
test("non-zero envelope does not become normal_no_change", async () => { const envelope = await create(x => {
    x.historyComparisonResult.comparison.byType.put.summary.increaseCount = 1; });
    const input = Envelope.toAvailabilityEvidenceInput(envelope);
    assert.equal(input.classification, "judgment_unavailable");
    assert.equal((await Availability.createEvidence(input)).safeForPartialApplicability, false); });
test("foundation stays pure and is loaded only for the evidence runtime", () => { const source = fs.readFileSync(
    path.join(__dirname, "../js/qriOptionsFormalComparisonEvidence.js"), "utf8");
    for (const token of ["localStorage", "indexedDB", "fetch(", "setTimeout",
        "setInterval", "OptionJudgment", "OverallV2", "SessionScope", "MorningBaseline"])
        assert.doesNotMatch(source, new RegExp(token.replace("(", "\\(")));
    assert.doesNotMatch(source, /(^|[^.\w])document\./);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /qriOptionsFormalComparisonEvidence\.js/);
    assert.ok(html.indexOf("qriOptionsFormalComparisonEvidence.js") <
        html.indexOf("formalOptionAvailabilityEvidenceRuntime.js")); });
