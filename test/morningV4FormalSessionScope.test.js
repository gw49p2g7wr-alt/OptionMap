const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Scope = require("../js/morningV4FormalSessionScope.js");

const gen = (source, fingerprint) => ({ source, sequence: 1, fingerprint, current: true });
function fixture() {
    const requestId = "request-1";
    const qri = { sourceClass: "formal_live", origin: "live", usingFallback: false,
        referenceOnly: false, superseded: false, identityVerified: true, acquisitionVerified: true,
        tradingDate: "2026-08-26", contract: "2026-09", canonicalVersionKey: "qri-v1",
        canonicalSignature: "qri-signature", requestId, generation: gen("qri", "qri-gen") };
    const price = { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        identityVerified: true, acquisitionVerified: true, currentRequestVerified: true,
        contract: "2026-09", requestId, versionKey: "price-v1", quoteDate: "2026-08-26",
        qriTradingDateMapping: { status: "verified", mappingVerified: true,
            mappingSource: "same_date_explicit", qriTradingDate: "2026-08-26" } };
    const weekly = { sourceClass: "formal_history", activeVersionMatched: true,
        currentVersionKey: "weekly-v1", currentSignature: "weekly-signature",
        sourceFingerprint: "weekly-fingerprint", requestId,
        generation: gen("weekly", "weekly-gen") };
    const overall = { formalApplied: true, referenceOnly: false, identityVerified: true,
        inputFingerprint: "overall-fingerprint", logicVersion: "overall-v2-v1", requestId,
        optionSourceIdentity: { canonicalVersionKey: "qri-v1", canonicalSignature: "qri-signature" },
        weeklySourceIdentity: { currentVersionKey: "weekly-v1",
            sourceFingerprint: "weekly-fingerprint" } };
    return { capturedAt: "2026-08-26T00:15:00+09:00", qriFormalIdentity: qri,
        currentPriceLiveIdentity: price, overallV2Envelope: overall,
        weeklyFormalIdentity: weekly, marketRefreshContext: { requestId,
            startGenerationFingerprint: "collection-1", endGenerationFingerprint: "collection-1",
            sourceGenerationChanged: false } };
}
const evaluate = mutate => { const input = fixture(); mutate?.(input);
    return Scope.evaluateFormalSessionScope(input); };

test("same-date verified scope", () => { const result = evaluate();
    assert.deepEqual([result.status, result.comparisonEligible, result.sessionClass],
        ["verified", true, "same_date_verified"]); });
test("cross-date unresolved", () => { const result = evaluate(x => { x.currentPriceLiveIdentity.quoteDate = "2026-08-25";
    Object.assign(x.currentPriceLiveIdentity.qriTradingDateMapping, { status: "date_context_unresolved",
        mappingVerified: false, mappingSource: null }); }); assert.equal(result.status, "unresolved"); });
test("cross-date is not promoted to night session", () => { const result = evaluate(x => {
    x.currentPriceLiveIdentity.quoteDate = "2026-08-25"; x.currentPriceLiveIdentity.qriTradingDateMapping.mappingVerified = false;
    x.currentPriceLiveIdentity.qriTradingDateMapping.mappingSource = null; });
    assert.deepEqual([result.mappingVerified, result.diagnostics.overnightInferred], [false, false]); });
test("missing QRI tradingDate", () => assert.equal(evaluate(x => { x.qriFormalIdentity.tradingDate = null; }).reason, "identity_unverified"));
test("QRI invalid", () => assert.equal(evaluate(x => { x.qriFormalIdentity.identityVerified = false; }).reason, "identity_unverified"));
test("price mapping unresolved", () => assert.equal(evaluate(x => { x.currentPriceLiveIdentity.qriTradingDateMapping.mappingVerified = false; }).reason, "price_mapping_unresolved"));
test("contract mismatch", () => assert.equal(evaluate(x => { x.currentPriceLiveIdentity.contract = "2026-12"; }).reason, "contract_mismatch"));
test("contract roll comparison", () => { const before = evaluate(); const after = evaluate(x => { x.qriFormalIdentity.contract = "2026-12";
    x.currentPriceLiveIdentity.contract = "2026-12"; }); assert.equal(Scope.compareFormalSessionScopes(before, after).reason, "contract_roll"); });
test("overall binding mismatch", () => assert.equal(evaluate(x => { x.overallV2Envelope.optionSourceIdentity.canonicalVersionKey = "old"; }).reason, "source_binding_mismatch"));
test("weekly binding mismatch", () => assert.equal(evaluate(x => { x.overallV2Envelope.weeklySourceIdentity.currentVersionKey = "old"; }).reason, "source_binding_mismatch"));
test("same scopeId is deterministic", () => assert.equal(evaluate().scopeId, evaluate().scopeId));
test("source identity mismatch fails closed", () => assert.equal(evaluate(x => { x.qriFormalIdentity.canonicalVersionKey = "qri-v2"; }).comparisonEligible, false));
test("capturedAt change alone does not alter scopeId", () => { const first = evaluate(); const second = evaluate(x => { x.capturedAt = "2026-08-26T12:00:00+09:00"; }); assert.equal(first.scopeId, second.scopeId); });
test("JST date alone does not verify", () => { const input = { capturedAt: "2026-08-26T12:00:00+09:00" };
    assert.equal(Scope.evaluateFormalSessionScope(input).mappingVerified, false); });
test("00:00 crossing is decided by formal scope not clock", () => { const first = evaluate(x => { x.capturedAt = "2026-08-25T23:59:00+09:00"; });
    const second = evaluate(x => { x.capturedAt = "2026-08-26T00:01:00+09:00"; }); assert.equal(Scope.compareFormalSessionScopes(first, second).comparisonEligible, true); });
test("weekend is not inferred", () => { const result = evaluate(x => { x.capturedAt = "2026-08-29T10:00:00+09:00"; }); assert.equal(result.diagnostics.previousTradingDayInferred, false); });
test("holiday is not inferred", () => { const result = evaluate(x => { x.capturedAt = "2026-08-11T10:00:00+09:00"; }); assert.equal(result.diagnostics.calendarAccessed, false); });
test("no previous trading day inference", () => assert.equal(evaluate().diagnostics.previousTradingDayInferred, false));
test("no calendar service", () => assert.equal(evaluate().diagnostics.calendarAccessed, false));
test("comparisonEligible true only when verified", () => { const unresolved = evaluate(x => { x.currentPriceLiveIdentity.qriTradingDateMapping.mappingVerified = false; });
    assert.deepEqual([evaluate().comparisonEligible, unresolved.comparisonEligible], [true, false]); });
test("tradingDate change stops comparison", () => { const before = evaluate(); const after = evaluate(x => { x.qriFormalIdentity.tradingDate = "2026-08-27";
    x.currentPriceLiveIdentity.quoteDate = "2026-08-27"; x.currentPriceLiveIdentity.qriTradingDateMapping.qriTradingDate = "2026-08-27"; });
    assert.equal(Scope.compareFormalSessionScopes(before, after).reason, "trading_date_changed"); });
test("input is not mutated", () => { const input = fixture(); const before = structuredClone(input);
    Scope.evaluateFormalSessionScope(input); assert.deepEqual(input, before); });
test("output checks and diagnostics are deeply frozen", () => { const result = evaluate();
    for (const value of [result, result.checks, result.diagnostics, result.sourceIdentities,
        result.generation]) assert.equal(Object.isFrozen(value), true); });
test("marketSession fact contract fields are compatible", () => { const result = evaluate();
    assert.deepEqual([result.sessionScopeId, result.sessionMappingStatus, result.mappingVerified,
        result.source, result.generation.source], [result.scopeId, "verified", true,
        "formal_identity_binding", "marketSession"]); });
test("Baseline and Comparison session identity fields are compatible", () => { const result = evaluate();
    assert.deepEqual([result.sessionIdentity, result.sessionMappingStatus], [result.scopeId, "verified"]); });
test("pure policy has no storage runtime DOM fetch calendar or timer", () => { const source = fs.readFileSync(path.join(__dirname,
    "../js/morningV4FormalSessionScope.js"), "utf8"); assert.doesNotMatch(source,
        /localStorage|sessionStorage|indexedDB|document\.|\bfetch\s*\(|setTimeout|setInterval|holidayApi|calendarService/); });
test("index remains disconnected", () => { const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("morningV4FormalSessionScope.js"), false); });
