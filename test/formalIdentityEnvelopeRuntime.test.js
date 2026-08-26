const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriFormalIdentityRuntime.js");
const Weekly = require("../js/weeklyFormalIdentityRuntime.js");
const Overall = require("../js/overallV2FormalEnvelopeRuntime.js");

const qriInput = { canonical: { contract: "2026-09", tradingDate: "2026-08-26",
    pageUpdatedAt: "2026-08-26T08:00:00+09:00", openInterestStatus: "available" },
canonicalValid: true, canonicalSignature: "qri-signature", canonicalVersionKey: "qri-v1",
persistenceResult: { status: "saved", versionKey: "qri-v1" }, sourceKind: "formal_live",
origin: "live", mode: "auto", usingFallback: false, referenceOnly: false,
requestId: "request-1", fetchedAt: "2026-08-26T08:01:00+09:00" };
const weeklyInput = { sourceClass: "formal_history",
    previous: { sourceDate: "2026-08-19", versionKey: "weekly-v0", signature: "sig-0" },
    current: { sourceDate: "2026-08-26", versionKey: "weekly-v1", signature: "sig-1" },
    activeVersionKey: "weekly-v1", activeVersionMatched: true, candidateComplete: true,
    requestId: "request-1", requestContext: { requestId: "request-1",
        marketRefreshRequestId: "request-1" }, component: { normalizedDirection: 0.4,
        qualityFactor: 1, evidenceFactor: 0.4, effectiveWeight: 45,
        weightedContribution: 18, metadata: { current: { versionKey: "weekly-v1" } } } };
const overallResult = { status: "complete", direction: 30, confidence: 80,
    effectiveWeightTotal: 100, components: {
        option: { available: true, normalizedDirection: 0.2, qualityFactor: 1,
            evidenceFactor: 0.2, effectiveWeight: 55, weightedContribution: 11,
            metadata: { usingFallback: false, sourceDate: "2026-08-25T23:00:00.000Z" } },
        weekly: { available: true, normalizedDirection: 0.4, qualityFactor: 1,
            evidenceFactor: 0.4, effectiveWeight: 45, weightedContribution: 18,
            metadata: { current: { versionKey: "weekly-v1" } } }
    }, metadata: { calculatedAt: "2026-08-26T08:02:00+09:00", warnings: [] } };
const current = () => true;
async function facts() { const qr = Qri.createRuntime(); await qr.publish(structuredClone(qriInput), { isCurrentRequest: current });
    const wr = Weekly.createRuntime(); await wr.publish(structuredClone(weeklyInput), { isCurrentRequest: current });
    return { qri: qr.getState().fact, weekly: wr.getState().fact }; }

test("QRI valid formal identity published", async () => { const r = Qri.createRuntime();
    await r.publish(structuredClone(qriInput), { isCurrentRequest: current });
    assert.equal(r.getState().status, "available"); });
for (const [name, patch] of [["saved", { sourceKind: "saved" }], ["legacy", { sourceKind: "legacy" }],
    ["fallback", { usingFallback: true }]]) test(`QRI ${name} rejected`, async () => {
        const r = Qri.createRuntime(); await r.publish({ ...structuredClone(qriInput), ...patch }, { isCurrentRequest: current });
        assert.equal(r.getState().status, "unavailable"); });
test("QRI persist identity missing", async () => { const r = Qri.createRuntime();
    await r.publish({ ...structuredClone(qriInput), persistenceResult: null }, { isCurrentRequest: current });
    assert.equal(r.getState().status, "unavailable"); });
test("QRI stale request rejected", async () => { const r = Qri.createRuntime();
    assert.equal((await r.publish(qriInput, { isCurrentRequest: () => false })).reason, "stale_request"); });
test("QRI delayed publication cannot overwrite current", async () => { const r = Qri.createRuntime();
    let live = true; const first = r.publish(qriInput, { isCurrentRequest: () => live }); live = false;
    r.beginRequest({ requestId: "request-2", isCurrentRequest: current }); await first;
    assert.equal(r.getState().requestId, "request-2"); });
test("QRI revision identity is deterministic", async () => { const r = Qri.createRuntime();
    await r.publish(qriInput, { isCurrentRequest: current }); const fact = r.getState().fact;
    assert.deepEqual([fact.historyEntryIdentity, fact.historyRevisionIdentity],
        ["2026-09|2026-08-26", "qri-v1"]); });
test("QRI current failure clears prior identity", async () => { const r = Qri.createRuntime();
    await r.publish(qriInput, { isCurrentRequest: current });
    r.markUnavailable({ requestId: "request-2", reason: "failed", isCurrentRequest: current });
    assert.equal(r.getState().fact, null); });

test("Weekly valid formal envelope", async () => { const r = Weekly.createRuntime();
    await r.publish(weeklyInput, { isCurrentRequest: current }); assert.equal(r.getState().status, "available"); });
test("Weekly active version mismatch", async () => { const r = Weekly.createRuntime();
    await r.publish({ ...weeklyInput, activeVersionKey: "old" }, { isCurrentRequest: current });
    assert.equal(r.getState().status, "unavailable"); });
test("Weekly signature missing", async () => { const r = Weekly.createRuntime(); const input = structuredClone(weeklyInput);
    input.current.signature = null; await r.publish(input, { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Weekly stale candidate", async () => { const r = Weekly.createRuntime();
    assert.equal((await r.publish(weeklyInput, { isCurrentRequest: () => false })).reason, "stale_candidate"); });
test("Weekly component/source binding retained", async () => { const r = Weekly.createRuntime(); await r.publish(weeklyInput, { isCurrentRequest: current });
    const fact = r.getState().fact; assert.deepEqual([fact.currentVersionKey, fact.normalizedDirection], ["weekly-v1", 0.4]); });
test("Weekly fingerprint deterministic", async () => assert.equal(
    await Weekly.createWeeklyInputFingerprint(weeklyInput), await Weekly.createWeeklyInputFingerprint(structuredClone(weeklyInput))));
test("Weekly source change changes fingerprint", async () => { const changed = structuredClone(weeklyInput); changed.current.versionKey = "weekly-v2";
    assert.notEqual(await Weekly.createWeeklyInputFingerprint(weeklyInput), await Weekly.createWeeklyInputFingerprint(changed)); });
test("Weekly invalidation clears prior identity", async () => { const r = Weekly.createRuntime();
    await r.publish(weeklyInput, { isCurrentRequest: current }); r.markUnavailable("invalidated");
    assert.equal(r.getState().fact, null); });

test("Overall formal envelope published", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1",
        result: overallResult, qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    assert.equal(r.getState().status, "available"); });
test("Overall logicVersion retained", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1", result: overallResult,
        qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    assert.equal(r.getState().envelope.logicVersion, Overall.OVERALL_V2_LOGIC_VERSION); });
test("Overall QRI option binding", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1", result: overallResult,
        qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    assert.equal(r.getState().envelope.optionSourceIdentity.canonicalVersionKey, "qri-v1"); });
test("Overall option source binds by equal instant across timezone offsets", async () => {
    assert.equal(Overall.sameTimestampInstant("2026-08-25T23:00:00.000Z",
        "2026-08-26T08:00:00+09:00"), true); });
test("Overall option source instant mismatch rejected", async () => { const f = await facts();
    const changed = structuredClone(overallResult);
    changed.components.option.metadata.sourceDate = "2026-08-25T23:00:01.000Z";
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION,
        requestId: "request-1", result: changed, qriFact: f.qri, weeklyFact: f.weekly },
    { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall invalid option source timestamp rejected", async () => { const f = await facts();
    const changed = structuredClone(overallResult); changed.components.option.metadata.sourceDate = "2026-08-26";
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION,
        requestId: "request-1", result: changed, qriFact: f.qri, weeklyFact: f.weekly },
    { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall impossible option source calendar timestamp rejected", async () => { const f = await facts();
    const changed = structuredClone(overallResult);
    changed.components.option.metadata.sourceDate = "2026-02-30T23:00:00.000Z";
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION,
        requestId: "request-1", result: changed, qriFact: f.qri, weeklyFact: f.weekly },
    { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall QRI tradingDate remains independent from source instant", async () => { const f = await facts();
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION,
        requestId: "request-1", result: overallResult, qriFact: f.qri, weeklyFact: f.weekly },
    { isCurrentRequest: current }); assert.equal(f.qri.tradingDate, "2026-08-26");
    assert.equal(r.getState().status, "available"); });
test("Overall QRI request binding mismatch rejected", async () => { const f = await facts();
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION,
        requestId: "other", result: overallResult, qriFact: f.qri, weeklyFact: f.weekly },
    { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall Weekly binding", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1", result: overallResult,
        qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    assert.equal(r.getState().envelope.weeklySourceIdentity.currentVersionKey, "weekly-v1"); });
test("Overall input fingerprint deterministic", async () => { const f = await facts(); const input = {
    logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, result: overallResult,
    optionSourceIdentity: { canonicalVersionKey: f.qri.canonicalVersionKey },
    weeklySourceIdentity: { currentVersionKey: f.weekly.currentVersionKey } };
    assert.equal(await Overall.createInputFingerprint(input), await Overall.createInputFingerprint(structuredClone(input))); });
test("Overall input source change changes fingerprint", async () => { const input = { logicVersion: "v1", result: overallResult,
    optionSourceIdentity: { canonicalVersionKey: "a" }, weeklySourceIdentity: null };
    assert.notEqual(await Overall.createInputFingerprint(input), await Overall.createInputFingerprint({ ...input,
        optionSourceIdentity: { canonicalVersionKey: "b" } })); });
test("Overall source binding mismatch rejected", async () => { const f = await facts(); const changed = structuredClone(overallResult);
    changed.components.weekly.metadata.current.versionKey = "old"; const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, result: changed,
        qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall stale envelope rejected", async () => { const r = Overall.createRuntime();
    assert.equal((await r.publish({}, { isCurrentRequest: () => false })).reason, "stale_envelope"); });
test("Overall unknown logic version rejected", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: "unknown", result: overallResult, qriFact: f.qri,
        weeklyFact: f.weekly }, { isCurrentRequest: current }); assert.equal(r.getState().status, "unavailable"); });
test("Overall partial formal envelope policy", async () => { const f = await facts(); const result = structuredClone(overallResult);
    result.status = "partial"; result.components.weekly = { available: false }; const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1", result, qriFact: f.qri,
        weeklyFact: null }, { isCurrentRequest: current }); assert.equal(r.getState().status, "available"); });
test("Overall score weights and quality unchanged", async () => { const f = await facts(); const before = structuredClone(overallResult);
    const r = Overall.createRuntime(); await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, requestId: "request-1",
        result: overallResult, qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    assert.deepEqual(r.getState().envelope.result, before); });
test("Overall invalidation clears prior envelope", async () => { const f = await facts(); const r = Overall.createRuntime();
    await r.publish({ logicVersion: Overall.OVERALL_V2_LOGIC_VERSION, result: overallResult,
        qriFact: f.qri, weeklyFact: f.weekly }, { isCurrentRequest: current });
    r.markUnavailable("invalidated"); assert.equal(r.getState().envelope, null); });

test("all getters are detached", async () => { const f = await facts(); assert.notEqual(f.qri, (await facts()).qri); });
test("all getter outputs are deeply frozen", async () => { const r = Weekly.createRuntime(); await r.publish(weeklyInput, { isCurrentRequest: current });
    assert.equal(Object.isFrozen(r.getState().fact.componentMetadata), true); });
test("getters do not recalculate", async () => { const r = Overall.createRuntime(); const before = r.getState(); r.getState(); assert.deepEqual(r.getState(), before); });
test("modules have no storage fetch DOM Morning or timer", () => { for (const file of ["qriFormalIdentityRuntime.js",
    "weeklyFormalIdentityRuntime.js", "overallV2FormalEnvelopeRuntime.js"]) { const source = fs.readFileSync(path.join(__dirname, "../js", file), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|\bfetch\s*\(|document\.|MorningBaseline|setTimeout|setInterval/); } });
test("renderer loads identity modules before script", () => { const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    for (const file of ["qriFormalIdentityRuntime.js", "weeklyFormalIdentityRuntime.js", "overallV2FormalEnvelopeRuntime.js"])
        assert.ok(html.indexOf(file) < html.indexOf("js/script.js")); });
test("QRI publication follows history persistence", () => { const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const block = html.slice(html.indexOf("const qriPersistenceResult"), html.indexOf("if (", html.indexOf("const qriPersistenceResult") + 20));
    assert.ok(block.indexOf("persistQriOptionsHistory") < block.indexOf("publishQriFormalIdentityFact")); });
test("no Morning collector or storage publication wiring", () => { const sources = ["../js/qriFormalIdentityRuntime.js",
    "../js/weeklyFormalIdentityRuntime.js", "../js/overallV2FormalEnvelopeRuntime.js"].map(file => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
    assert.doesNotMatch(sources, /morningV4|setItem|openHistoryStore|persistCandidate/); });
test("formal calculation module is unchanged by envelope", () => { const source = fs.readFileSync(path.join(__dirname, "../js/overallJudgmentV2.js"), "utf8");
    assert.doesNotMatch(source, /FormalEnvelope|LOGIC_VERSION/); });
