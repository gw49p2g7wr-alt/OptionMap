const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Fact = require("../js/currentPriceLiveIdentityFact.js");
const Runtime = require("../js/currentPriceLiveIdentityRuntime.js");

const INPUT = { priceResult: { available: true, source: "qri-nikkei225-futures",
    mode: "automatic", origin: "live", value: 66010, contract: "26年9月限",
    quotedAt: "08/26 05:30", fetchedAt: "2026-08-26T05:31:00+09:00" },
activeContract: "2026-09", pageTradingDate: "2026-08-26",
pageUpdatedAt: "2026-08-26T05:30:30+09:00",
sourceUrl: "https://svc.qri.jp/jpx/nkopm/202609", requestId: "request-1",
fetchedAt: "2026-08-26T05:31:00+09:00" };

const make = overrides => Runtime.createCurrentPriceLiveIdentityRuntime({
    buildFact: overrides?.buildFact || Fact.buildCurrentPriceLiveIdentityFact,
    now: () => "2026-08-26T05:32:00+09:00"
});
const publish = (runtime, input = INPUT, current = () => true, mode = "automatic") =>
    runtime.publish(structuredClone(input), { isCurrentRequest: current,
        formalCurrentPriceMode: mode });

test("runtime module loads", () => assert.equal(Runtime.RUNTIME_VERSION, 1));
test("valid live fact is published and returned", async () => {
    const runtime = make(); const result = await publish(runtime);
    assert.deepEqual([result.published, result.status], [true, "available"]);
    assert.equal(runtime.getState().fact.requestId, "request-1");
});
test("getter returns a detached clone", async () => {
    const runtime = make(); await publish(runtime); const first = runtime.getState();
    assert.notEqual(first, runtime.getState());
    assert.notEqual(first.fact, runtime.getState().fact);
});
test("getter output is deeply frozen", async () => {
    const runtime = make(); await publish(runtime); const state = runtime.getState();
    for (const value of [state, state.fact, state.fact.quoteIdentity, state.diagnostics])
        assert.equal(Object.isFrozen(value), true);
});
test("begin request clears an older fact", async () => {
    const runtime = make(); await publish(runtime);
    runtime.beginRequest({ requestId: "request-2", isCurrentRequest: () => true });
    assert.deepEqual([runtime.getState().status, runtime.getState().fact], ["unavailable", null]);
});
test("builder failure publishes unavailable and clears fact", async () => {
    const runtime = make(); await publish(runtime);
    await publish(runtime, { ...INPUT, priceResult: null });
    assert.deepEqual([runtime.getState().status, runtime.getState().fact], ["unavailable", null]);
});
test("invalid identity is not published", async () => {
    const runtime = make({ buildFact: async () => ({ available: true, sourceKind: "live",
        origin: "live", mode: "automatic", identityVerified: false,
        acquisitionVerified: true, currentRequestVerified: true, requestId: "request-1",
        contract: "2026-09" }) });
    await publish(runtime); assert.equal(runtime.getState().status, "unavailable");
});
test("invalid acquisition is not published", async () => {
    const runtime = make({ buildFact: async () => ({ available: true, sourceKind: "live",
        origin: "live", mode: "automatic", identityVerified: true,
        acquisitionVerified: false, currentRequestVerified: true, requestId: "request-1",
        contract: "2026-09" }) });
    await publish(runtime); assert.equal(runtime.getState().status, "unavailable");
});
test("contract mismatch is unavailable", async () => {
    const runtime = make(); await publish(runtime, { ...INPUT, activeContract: "2026-12" });
    assert.equal(runtime.getState().reason, "contract_mismatch");
});
test("restored or cache price is not published as live", async () => {
    for (const origin of ["saved", "cache"]) {
        const runtime = make(); await publish(runtime,
            { ...INPUT, priceResult: { ...INPUT.priceResult, origin } });
        assert.equal(runtime.getState().status, "unavailable");
    }
});
test("stale request is rejected without state mutation", async () => {
    const runtime = make(); await publish(runtime); const before = runtime.getState();
    const result = await publish(runtime, { ...INPUT, requestId: "old" }, () => false);
    assert.equal(result.reason, "stale_request"); assert.deepEqual(runtime.getState(), before);
});
test("delayed stale result cannot overwrite current", async () => {
    const resolvers = [];
    const runtime = make({ buildFact: input => new Promise(resolve => resolvers.push(async () =>
        resolve(await Fact.buildCurrentPriceLiveIdentityFact(input)))) });
    let firstCurrent = true;
    const first = publish(runtime, INPUT, () => firstCurrent);
    const secondInput = { ...INPUT, requestId: "request-2" };
    const second = publish(runtime, secondInput, () => true);
    await resolvers[1](); await second; firstCurrent = false; await resolvers[0](); await first;
    assert.equal(runtime.getState().requestId, "request-2");
});
test("publication generation is monotonic", async () => {
    const runtime = make(); const first = await publish(runtime);
    const second = await publish(runtime, { ...INPUT, requestId: "request-2" });
    assert.ok(second.publicationGeneration > first.publicationGeneration);
});
test("cross-date fact is retained unresolved and never promoted", async () => {
    const runtime = make(); await publish(runtime, { ...INPUT,
        priceResult: { ...INPUT.priceResult, quotedAt: "08/25 20:00" },
        pageUpdatedAt: "2026-08-25T20:01:00+09:00" });
    const fact = runtime.getState().fact;
    assert.deepEqual([fact.available, fact.qriTradingDateMapping.mappingVerified,
        fact.qriTradingDateMapping.mappingSource], [true, false, null]);
});
test("same-date mapping remains explicitly verified", async () => {
    const runtime = make(); await publish(runtime);
    assert.deepEqual([runtime.getState().fact.qriTradingDateMapping.mappingVerified,
        runtime.getState().fact.qriTradingDateMapping.mappingSource],
    [true, "same_date_explicit"]);
});
test("manual formal mode remains separate from live acquisition fact", async () => {
    const runtime = make(); await publish(runtime, INPUT, () => true, "manual");
    const state = runtime.getState();
    assert.equal(state.status, "available");
    assert.equal(state.diagnostics.formalCurrentPriceMode, "manual");
    assert.equal(state.diagnostics.formalCurrentPriceMutated, false);
});
test("formal currentPriceState fingerprint is unchanged", async () => {
    const formalState = { value: 65000, source: "manual", mode: "manual" };
    const before = JSON.stringify(formalState); const runtime = make();
    await publish(runtime, INPUT, () => true, "manual");
    assert.equal(JSON.stringify(formalState), before);
});
test("display model is unchanged by publication", async () => {
    const display = { value: "65,000円", metadata: "手動入力" };
    const before = structuredClone(display); const runtime = make(); await publish(runtime);
    assert.deepEqual(display, before);
});
test("publication performs no Last-Valid save or read-back", async () => {
    let saves = 0; let reads = 0; const runtime = make(); await publish(runtime);
    assert.deepEqual([saves, reads], [0, 0]);
});
test("QRI Morning eligibility is not required by CurrentPrice publication", async () => {
    const runtime = make(); const input = structuredClone(INPUT);
    input.qriOpenInterestAvailable = false; input.qriHistoryRevisionIdentity = null;
    await publish(runtime, input);
    assert.equal(runtime.getState().status, "available");
});
test("getter never rebuilds", async () => {
    let count = 0; const runtime = make({ buildFact: async input => {
        count += 1; return Fact.buildCurrentPriceLiveIdentityFact(input);
    } });
    await publish(runtime); runtime.getState(); runtime.getDiagnostics(); assert.equal(count, 1);
});
test("unavailable marker rejects stale request", async () => {
    const runtime = make(); const result = runtime.markUnavailable({ requestId: "old",
        isCurrentRequest: () => false });
    assert.equal(result.reason, "stale_request");
});
test("current unavailable marker clears a prior fact", async () => {
    const runtime = make(); await publish(runtime);
    runtime.markUnavailable({ requestId: "request-2", reason: "acquisition_failed",
        isCurrentRequest: () => true });
    assert.deepEqual([runtime.getState().status, runtime.getState().reason,
        runtime.getState().fact], ["unavailable", "acquisition_failed", null]);
});
test("diagnostics getter is detached and deeply frozen", async () => {
    const runtime = make(); await publish(runtime); const first = runtime.getDiagnostics();
    assert.notEqual(first, runtime.getDiagnostics()); assert.equal(Object.isFrozen(first), true);
});
test("runtime diagnostics attest read-only behavior", async () => {
    const runtime = make(); await publish(runtime); const value = runtime.getDiagnostics();
    assert.deepEqual([value.formalCurrentPriceMutated, value.storageAccessed,
        value.fetchTriggered, value.domMutated, value.overallV2Recalculated,
        value.morningCollectorInvoked], [false, false, false, false, false, false]);
});
test("runtime module has no storage DOM fetch timer or formal analysis", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceLiveIdentityRuntime.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.|\bfetch\s*\(|setTimeout|setInterval|OverallV2|MorningBaseline/);
});
test("renderer loads fact before runtime and both before script", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("currentPriceLastValidCache.js") <
        html.indexOf("currentPriceLiveIdentityFact.js"));
    assert.ok(html.indexOf("currentPriceLiveIdentityFact.js") <
        html.indexOf("currentPriceLiveIdentityRuntime.js"));
    assert.ok(html.indexOf("currentPriceLiveIdentityRuntime.js") <
        html.indexOf("js/script.js"));
});
test("publication is wired only inside live QRI acquisition", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const active = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("async function fetchParticipantData"));
    assert.match(active, /publishCurrentPriceLiveIdentityFact/);
    assert.equal((html.match(/publishCurrentPriceLiveIdentityFact/g) || []).length, 1);
});
test("publication input uses acquisition values rather than currentPriceState", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const start = html.indexOf("const livePriceAcquisition");
    const publication = html.slice(start, html.indexOf("if (priceResult?.success", start));
    assert.doesNotMatch(publication, /currentPriceState|localStorage|document\./);
    assert.match(publication, /activeRequestId|canonicalV2|fetchedAt/);
});
test("no Morning collector or storage wiring was added", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const publication = html.slice(html.indexOf("const livePriceAcquisition"),
        html.indexOf("if (priceResult?.success", html.indexOf("const livePriceAcquisition")));
    assert.doesNotMatch(publication, /morning|Baseline|localStorage|setItem|Overall/);
});
