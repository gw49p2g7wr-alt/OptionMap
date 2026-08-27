const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Evidence = require("../js/formalOptionAvailabilityEvidence.js");

const VERSION_PREVIOUS = "qri-options-v2|2026-09|2026-08-26T05:41:00+09:00|sha256:" + "a".repeat(64);
const VERSION_CURRENT = "qri-options-v2|2026-09|2026-08-27T05:41:00+09:00|sha256:" + "b".repeat(64);
const REQUEST = "marketRefresh-1";
function fixture() {
    const generation = { source: "qri", sequence: 2, fingerprint: "qri-generation-2", current: true };
    return { classification: "normal_no_change", reason: "no_candidates",
        currentQriIdentity: { sourceClass: "formal_live", origin: "live", identityVerified: true,
            acquisitionVerified: true, usingFallback: false, referenceOnly: false, saved: false,
            canonicalVersionKey: VERSION_CURRENT, canonicalSignature: "b".repeat(64),
            contract: "2026-09", tradingDate: "2026-08-27", requestId: REQUEST,
            generation: structuredClone(generation) },
        comparisonIdentity: { comparisonExecuted: true, source: "formal_qri_options_history",
            previous: { revisionIdentity: VERSION_PREVIOUS, versionKey: VERSION_PREVIOUS,
                signature: "a".repeat(64), contract: "2026-09", sourceDate: "2026-08-26",
                activeRevisionVerified: true },
            current: { revisionIdentity: VERSION_CURRENT, versionKey: VERSION_CURRENT,
                signature: "b".repeat(64), contract: "2026-09", sourceDate: "2026-08-27",
                activeRevisionVerified: true } },
        counts: { callIncrease: 0, callDecrease: 0, putIncrease: 0, putDecrease: 0,
            nearbyCandidates: 0 }, requestIdentity: { currentRequestId: REQUEST,
            comparisonRequestId: REQUEST, mixedAcquisition: false }, generation };
}
const create = mutate => { const value = fixture(); mutate?.(value); return Evidence.createEvidence(value); };
const unsafe = async mutate => { const value = await create(mutate);
    assert.equal(value.safeForPartialApplicability, false); assert.notEqual(value.classification,
        "normal_no_change"); return value; };

test("valid formal normal_no_change is the only safe class", async () => { const value = await create();
    assert.deepEqual([value.available, value.classification, value.safeForPartialApplicability,
        value.reason], [false, "normal_no_change", true, "no_candidates"]); });
for (const key of ["callIncrease", "callDecrease", "putIncrease", "putDecrease",
    "nearbyCandidates"]) test(`${key} greater than zero rejects normal_no_change`, async () => {
    const value = await unsafe(x => { x.counts[key] = 1; });
    assert.equal(value.reason, "change_candidates_present"); });
test("comparison not executed", async () => unsafe(x => { x.comparisonIdentity.comparisonExecuted = false; }));
test("current QRI missing", async () => unsafe(x => { x.currentQriIdentity = null; }));
test("current QRI identity invalid", async () => unsafe(x => { x.currentQriIdentity.identityVerified = false; }));
test("fallback rejected", async () => { const value = await unsafe(x => { x.currentQriIdentity.usingFallback = true; });
    assert.equal(value.classification, "fallback_or_reference"); });
test("reference rejected", async () => unsafe(x => { x.currentQriIdentity.referenceOnly = true; }));
test("saved rejected", async () => unsafe(x => { x.currentQriIdentity.saved = true; }));
test("previous identity missing", async () => unsafe(x => { x.comparisonIdentity.previous = null; }));
test("current identity missing", async () => unsafe(x => { x.comparisonIdentity.current = null; }));
test("contract mismatch", async () => unsafe(x => { x.comparisonIdentity.previous.contract = "2026-12"; }));
test("version mismatch", async () => unsafe(x => { x.comparisonIdentity.current.versionKey = "other"; }));
test("signature mismatch", async () => unsafe(x => { x.comparisonIdentity.current.signature = "c".repeat(64); }));
test("same version acquisition rejected", async () => unsafe(x => { const p = x.comparisonIdentity.previous;
    const c = x.comparisonIdentity.current; p.versionKey = c.versionKey; p.revisionIdentity = c.revisionIdentity; }));
test("same signature acquisition rejected", async () => unsafe(x => { x.comparisonIdentity.previous.signature =
    x.comparisonIdentity.current.signature; }));
test("source date order invalid", async () => unsafe(x => { x.comparisonIdentity.previous.sourceDate = "2026-08-27"; }));
test("inactive revision rejected", async () => unsafe(x => { x.comparisonIdentity.previous.activeRevisionVerified = false; }));
test("legacy comparison rejected", async () => { const value = await unsafe(x => {
    x.comparisonIdentity.source = "legacy_optionMapJpxSnapshots"; });
    assert.equal(value.reason, "legacy_comparison_rejected"); });
test("request mismatch", async () => unsafe(x => { x.requestIdentity.comparisonRequestId = "other"; }));
test("generation stale", async () => unsafe(x => { x.generation.current = false; }));
test("generation mismatch", async () => unsafe(x => { x.generation.sequence = 3; }));
test("mixed acquisition", async () => unsafe(x => { x.requestIdentity.mixedAcquisition = true; }));
test("unavailable reason must be no_candidates", async () => unsafe(x => { x.reason = "unknown"; }));
test("counts reject negative and non-integer input", async () => { for (const value of [-1, 0.5]) {
    const result = await unsafe(x => { x.counts.callIncrease = value; });
    assert.equal(result.classification, "invalid_input"); } });
test("fingerprint is deterministic", async () => assert.equal((await create()).evidenceFingerprint,
    (await create()).evidenceFingerprint));
test("tamper changes fingerprint", async () => assert.notEqual((await create()).evidenceFingerprint,
    (await create(x => { x.currentQriIdentity.requestId = "tampered"; })).evidenceFingerprint));
test("all non-safe taxonomy classes remain unsafe", async () => { for (const classification of
    Evidence.TAXONOMY.filter(value => value !== "normal_no_change")) assert.equal((await create(x => {
        x.classification = classification; x.reason = classification; })).safeForPartialApplicability, false); });
test("output is deeply frozen", async () => { const value = await create();
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.currentQriIdentity), true);
    assert.equal(Object.isFrozen(value.comparisonIdentity.previous), true); });
test("input is not mutated", async () => { const input = fixture(); const before = structuredClone(input);
    await Evidence.createEvidence(input); assert.deepEqual(input, before); });
test("foundation stays pure and is loaded only for the evidence runtime", () => { const source = fs.readFileSync(
    path.join(__dirname, "../js/formalOptionAvailabilityEvidence.js"), "utf8");
    for (const token of ["localStorage", "indexedDB", "fetch(", "OverallV2",
        "MorningBaseline", "setTimeout", "setInterval"]) assert.doesNotMatch(source, new RegExp(token.replace("(", "\\(")));
    assert.doesNotMatch(source, /(^|[^.\w])document\./);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /formalOptionAvailabilityEvidence\.js/);
    assert.ok(html.indexOf("formalOptionAvailabilityEvidence.js") <
        html.indexOf("formalOptionAvailabilityEvidenceRuntime.js")); });
test("taxonomy is exact and frozen", () => { assert.deepEqual([...Evidence.TAXONOMY], [
    "normal_no_change", "source_unavailable", "comparison_unavailable", "fallback_or_reference",
    "judgment_unavailable", "identity_missing", "invalid_input", "stale_or_mixed", "unknown"]);
    assert.equal(Object.isFrozen(Evidence.TAXONOMY), true); });
