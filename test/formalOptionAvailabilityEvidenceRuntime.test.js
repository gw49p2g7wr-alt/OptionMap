const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Runtime = require("../js/formalOptionAvailabilityEvidenceRuntime.js");

const PREVIOUS = `qri-options-v2|2026-09|2026-08-20T15:15:00+09:00|sha256:${"a".repeat(64)}`;
const CURRENT = `qri-options-v2|2026-09|2026-08-27T15:15:00+09:00|sha256:${"b".repeat(64)}`;
const revision = (date, pageUpdatedAt, versionKey, signature) => ({ contract: "2026-09",
    tradingDate: date, pageUpdatedAt, versionKey, signature, replacedAt: null });
function input(count = 0) {
    const generation = { source: "qri", sequence: 4, fingerprint: "request-1|current|saved",
        current: true };
    return { historyComparisonResult: { source: "formal_qri_options_history", available: true,
        status: "comparable", reason: null, contract: "2026-09",
        previousSourceDate: "2026-08-20", currentSourceDate: "2026-08-27",
        previousVersionKey: PREVIOUS, currentVersionKey: CURRENT,
        comparison: { byType: { call: { summary: { increaseCount: count,
            decreaseCount: 0 } }, put: { summary: { increaseCount: 0,
            decreaseCount: 0 } } } } },
    previousRevision: revision("2026-08-20", "2026-08-20T15:15:00+09:00",
        PREVIOUS, "a".repeat(64)),
    currentRevision: revision("2026-08-27", "2026-08-27T15:15:00+09:00",
        CURRENT, "b".repeat(64)),
    currentQriFormalIdentity: { sourceClass: "formal_live", sourceKind: "formal_live",
        origin: "live", usingFallback: false, referenceOnly: false, identityVerified: true,
        acquisitionVerified: true, contract: "2026-09", tradingDate: "2026-08-27",
        canonicalVersionKey: CURRENT, canonicalSignature: "b".repeat(64), requestId: "request-1",
        generation },
    runtimeContext: { comparisonExecuted: true, requestId: "request-1", generation,
        sourceFingerprint: generation.fingerprint, mixedAcquisition: false,
        previousEntryIdentity: "2026-09|2026-08-20",
        currentEntryIdentity: "2026-09|2026-08-27",
        previousActiveVersionKey: PREVIOUS, currentActiveVersionKey: CURRENT } };
}
const current = () => true;
async function publish(mutate, count = 0) {
    const value = input(count); if (mutate) mutate(value);
    const runtime = Runtime.createRuntime({ now: () => "2026-08-27T08:10:00.000Z" });
    await runtime.publish(value, { isCurrentRequest: current });
    return runtime;
}

test("valid all-zero runtime publication", async () => {
    const state = (await publish()).getState();
    assert.equal(state.status, "available"); assert.equal(state.comparisonEnvelope.available, true);
});
test("all-zero classification is normal_no_change", async () => assert.equal(
    (await publish()).getState().availabilityEvidence.classification, "normal_no_change"));
test("all-zero evidence is safe", async () => assert.equal(
    (await publish()).getState().availabilityEvidence.safeForPartialApplicability, true));
test("non-zero comparison keeps envelope valid", async () => assert.equal(
    (await publish(null, 1)).getState().comparisonEnvelope.available, true));
test("non-zero comparison is not safe", async () => {
    const evidence = (await publish(null, 1)).getState().availabilityEvidence;
    assert.equal(evidence.classification, "judgment_unavailable");
    assert.equal(evidence.safeForPartialApplicability, false);
});
for (const [name, reason, mutate] of [
    ["comparison unavailable", "history_comparison_unavailable", x => { x.historyComparisonResult.available = false; }],
    ["comparison not executed", "comparison_not_executed", x => { x.runtimeContext.comparisonExecuted = false; }],
    ["previous identity missing", "previous_identity_missing", x => { x.previousRevision = null; }],
    ["current identity missing", "current_identity_missing", x => { x.currentRevision = null; }],
    ["contract mismatch", "contract_mismatch", x => { x.currentRevision.contract = "2026-12"; }],
    ["version mismatch", "version_mismatch", x => { x.currentQriFormalIdentity.canonicalVersionKey = "other"; }],
    ["signature mismatch", "signature_mismatch", x => { x.currentQriFormalIdentity.canonicalSignature = "c".repeat(64); }],
    ["current revision not active", "current_revision_not_active", x => { x.runtimeContext.currentActiveVersionKey = "other"; }],
    ["request mismatch", "request_mismatch", x => { x.runtimeContext.requestId = "request-2"; }],
    ["generation stale", "generation_stale", x => { x.runtimeContext.generation = {
        ...x.runtimeContext.generation, sequence: 3 }; }],
    ["mixed acquisition", "mixed_acquisition", x => { x.runtimeContext.mixedAcquisition = true; }],
    ["QRI identity unavailable", "current_identity_missing", x => { x.currentQriFormalIdentity.identityVerified = false; }]
]) test(name, async () => assert.equal((await publish(mutate)).getState().reason, reason));
test("new request invalidates old evidence", async () => { const runtime = await publish();
    runtime.beginRequest({ requestId: "request-2", isCurrentRequest: current });
    const state = runtime.getState(); assert.equal(state.status, "pending");
    assert.equal(state.comparisonEnvelope, null); assert.equal(state.reason, "acquisition_pending"); });
test("comparison reset invalidates evidence", async () => { const runtime = await publish();
    runtime.invalidate({ requestId: "request-1", reason: "comparison_reset" });
    assert.equal(runtime.getState().reason, "comparison_reset"); });
test("stale async publication is rejected", async () => { let release;
    const runtime = Runtime.createRuntime({ createEnvelope: () => new Promise(resolve => { release = resolve; }) });
    const pending = runtime.publish(input(), { isCurrentRequest: current });
    await Promise.resolve(); runtime.invalidate({ reason: "comparison_reset" });
    release({ available: false, reason: "late" });
    assert.equal((await pending).reason, "stale_publication");
    assert.equal(runtime.getState().reason, "comparison_reset"); });
test("publicationGeneration is monotonic", async () => { const runtime = await publish();
    const first = runtime.getState().publicationGeneration;
    runtime.invalidate({ reason: "comparison_reset" });
    assert.ok(runtime.getState().publicationGeneration > first); });
test("getter returns detached data", async () => { const runtime = await publish();
    const state = runtime.getState(); assert.notEqual(state, runtime.getState()); });
test("getter result is deeply frozen", async () => { const state = (await publish()).getState();
    assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.diagnostics));
    assert.ok(Object.isFrozen(state.comparisonEnvelope.comparison.counts)); });
test("diagnostics getter is detached and frozen", async () => { const runtime = await publish();
    const first = runtime.getDiagnostics(); assert.notEqual(first, runtime.getDiagnostics());
    assert.ok(Object.isFrozen(first)); });
test("legacy source is never used", async () => { const runtime = await publish(x => {
    x.historyComparisonResult.source = "legacy_optionMapJpxSnapshots"; });
    assert.equal(runtime.getState().status, "unavailable");
    assert.equal(runtime.getDiagnostics().legacyUsed, true); });
test("comparison counts are published without coercion", async () => {
    const counts = (await publish(null, 2)).getState().comparisonEnvelope.comparison.counts;
    assert.deepEqual(counts, { callIncrease: 2, callDecrease: 0, putIncrease: 0, putDecrease: 0 }); });
test("original history comparison unavailable reason remains observable", async () => {
    const runtime = await publish(x => { x.historyComparisonResult.available = false;
        x.historyComparisonResult.reason = "contract_not_selected"; });
    assert.equal(runtime.getState().reason, "history_comparison_unavailable");
    assert.equal(runtime.getDiagnostics().historyComparisonReason, "contract_not_selected");
});
test("missing count remains unavailable", async () => assert.equal((await publish(x => {
    delete x.historyComparisonResult.comparison.byType.call.summary.increaseCount;
})).getState().reason, "comparison_counts_invalid"));
test("runtime state exposes required diagnostics", async () => { const diagnostics = (await publish()).getDiagnostics();
    for (const key of ["comparisonAvailable", "comparisonExecuted", "historyComparisonReason", "sourceClass",
        "previousRevisionIdentity", "currentRevisionIdentity", "qriBindingVerified",
        "requestMatched", "generationMatched", "countsAvailable", "allCountsZero",
        "envelopeAvailable", "evidenceAvailable", "classification",
        "safeForPartialApplicability", "legacyUsed", "storageAccessed", "databaseAccessed",
        "fetchTriggered", "formalRecalculationTriggered", "optionJudgmentChanged",
        "overallChanged", "domMutated"]) assert.ok(Object.hasOwn(diagnostics, key)); });
test("runtime has no storage fetch DOM or timers", () => { const source = fs.readFileSync(path.join(
    __dirname, "../js/formalOptionAvailabilityEvidenceRuntime.js"), "utf8");
    for (const token of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "setTimeout",
        "setInterval", "querySelector", "getElementById", "addEventListener"])
        assert.doesNotMatch(source, new RegExp(token.replace("(", "\\("))); });
test("runtime does not mutate Option judgment or Overall", () => { const source = fs.readFileSync(path.join(
    __dirname, "../js/formalOptionAvailabilityEvidenceRuntime.js"), "utf8");
    assert.doesNotMatch(source, /optionMapJudgmentState|calculateOverallJudgmentV2|publishOverall/); });
test("index has no Session Scope or Morning evidence wiring", () => { const html = fs.readFileSync(path.join(
    __dirname, "../index.html"), "utf8"); const block = html.slice(html.indexOf(
        "beginFormalOptionAvailabilityEvidencePublication"), html.indexOf("if (payload.canonicalV2?.openInterestStatus"));
    assert.doesNotMatch(block, /SessionScope|Morning|DataQuality/); });
test("index loads foundations before runtime", () => { const html = fs.readFileSync(path.join(
    __dirname, "../index.html"), "utf8"); assert.ok(html.indexOf("formalOptionAvailabilityEvidence.js") <
        html.indexOf("qriOptionsFormalComparisonEvidence.js"));
    assert.ok(html.indexOf("qriOptionsFormalComparisonEvidence.js") <
        html.indexOf("formalOptionAvailabilityEvidenceRuntime.js")); });
test("existing comparison API is reused", () => { const html = fs.readFileSync(path.join(
    __dirname, "../index.html"), "utf8"); assert.match(html, /compareLatestSavedDates\(loaded\.history, contract\)/); });
test("formal evidence comparison binds explicit verified QRI contract without manifest wait", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const formal = html.slice(html.indexOf("const qriState = window.getQriFormalIdentityFact"),
        html.indexOf("if (payload.canonicalV2?.openInterestStatus"));
    assert.match(formal, /sourceClass === "formal_live"/);
    assert.match(formal, /identityVerified === true/);
    assert.match(formal, /acquisitionVerified === true/);
    assert.match(formal, /\{ contract: formalComparisonContract \}/);
    assert.doesNotMatch(formal, /await updateQriContractManifest/);
    assert.doesNotMatch(formal, /fetch-option-page|setTimeout|setInterval/);
});
test("history comparison explicit contract overrides only when non-null", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const block = html.slice(html.indexOf("async function renderQriOptionsHistoryComparison"),
        html.indexOf("async function renderQriOptionsHistoryStatus"));
    assert.match(block, /explicitContract \?\? selectedQriHistoryContract\(\)/);
    assert.match(block, /compareLatestSavedDates\(loaded\.history, contract\)/);
});
test("runtime never chooses previous or current history entry", () => { const source = fs.readFileSync(path.join(
    __dirname, "../js/formalOptionAvailabilityEvidenceRuntime.js"), "utf8");
    assert.doesNotMatch(source, /\.entries|activeVersionKey|sort\(/); });
test("failed current-request guard does not publish", async () => { const runtime = Runtime.createRuntime();
    const result = await runtime.publish(input(), { isCurrentRequest: () => false });
    assert.equal(result.reason, "stale_request"); assert.equal(runtime.getState().status, "empty"); });
test("begin request rejects stale guard", () => { const runtime = Runtime.createRuntime();
    assert.equal(runtime.beginRequest({ requestId: "x", isCurrentRequest: () => false }).reason,
        "stale_request"); });
