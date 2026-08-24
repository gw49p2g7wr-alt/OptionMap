const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Cache = require("../js/currentPriceLastValidCache.js");
const Shadow = require("../js/currentPriceBootRestoreShadow.js");

const KEY = "optionMapCurrentPriceLastValidV1";
const INPUT = Object.freeze({ source: "qri-nikkei225-futures", mode: "automatic", value: 65660,
    contract: "2026-09", pageTradingDate: "2026-08-25",
    pageUpdatedAt: "2026-08-24T17:48:00+09:00", quotedAtRaw: "08/24 17:47",
    fetchedAt: "2026-08-24T09:04:05.391Z", sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });

async function serialized(overrides = {}) {
    const result = await Cache.buildCurrentPriceLastValidCacheV2({ ...INPUT, ...overrides });
    assert.equal(result.success, true);
    return JSON.stringify(result.cache);
}
function storage(entries = []) {
    const values = new Map(entries); const calls = [];
    return { values, calls, getItem(key) { calls.push(key); return values.get(key) ?? null; } };
}
function fingerprint(source) {
    return crypto.createHash("sha256").update(JSON.stringify([...source.values])).digest("hex");
}
async function valid(context = {}, overrides = {}) {
    const source = storage([[KEY, await serialized(overrides)]]);
    return { source, result: await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source, context }) };
}

test("valid v2 cache becomes a restore candidate", async () => {
    const { result } = await valid({ expectedTradingDate: "2026-08-25", activeContract: "2026-09" });
    assert.deepEqual([result.status, result.reason, result.candidate.value], ["candidate", null, 65660]);
});
test("missing dedicated key is a normal state with no candidate", async () => {
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({ storage: storage() });
    assert.deepEqual([result.status, result.reason, result.candidate], ["missing", null, null]);
});
test("malformed JSON is contained", async () => {
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({ storage: storage([[KEY, "{"]]) });
    assert.deepEqual([result.status, result.reason, result.candidate], ["invalid", "parse_error", null]);
});
test("schema v1 is rejected without migration", async () => {
    const old = await Cache.buildCurrentPriceLastValidCache({ source: INPUT.source, mode: INPUT.mode,
        value: INPUT.value, contract: INPUT.contract, tradingDate: "2026-08-24",
        quotedAtRaw: "08/24 17:47", fetchedAt: INPUT.fetchedAt, sourceUrl: INPUT.sourceUrl });
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({
        storage: storage([[KEY, JSON.stringify(old.cache)]]) });
    assert.deepEqual([result.status, result.reason], ["invalid", "schema_v1_unsupported"]);
});
test("tampered signature produces no candidate", async () => {
    const cache = JSON.parse(await serialized()); cache.signature = "0".repeat(64);
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({
        storage: storage([[KEY, JSON.stringify(cache)]]) });
    assert.deepEqual([result.status, result.candidate], ["invalid", null]);
});
test("unknown cache field produces no candidate", async () => {
    const cache = JSON.parse(await serialized()); cache.unknown = true;
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({
        storage: storage([[KEY, JSON.stringify(cache)]]) });
    assert.deepEqual([result.status, result.candidate], ["invalid", null]);
});
test("candidate preserves required source facts", async () => {
    const { result } = await valid();
    assert.deepEqual(result.candidate, { origin: "cache", value: 65660,
        source: INPUT.source, mode: "automatic", contract: "2026-09", quoteDate: "2026-08-24",
        quotedAt: "2026-08-24T17:47:00+09:00", quotedAtRaw: "08/24 17:47",
        quotedAtNormalized: "2026-08-24T17:47:00+09:00", fetchedAt: INPUT.fetchedAt,
        pageTradingDate: "2026-08-25", pageUpdatedAt: INPUT.pageUpdatedAt });
});
test("result, cache, freshness, candidate and diagnostics are frozen", async () => {
    const { result } = await valid();
    for (const value of [result, result.cache, result.freshness, result.candidate,
        result.diagnostics, result.freshness.diagnostics]) assert.equal(Object.isFrozen(value), true);
});
test("candidate and cache are detached from serialized storage", async () => {
    const { source, result } = await valid();
    const stored = JSON.parse(source.values.get(KEY));
    assert.notEqual(result.cache, stored);
    stored.value = 1;
    assert.equal(result.candidate.value, 65660);
});
test("candidate identity is always cache", async () => {
    const { result } = await valid();
    assert.deepEqual([result.candidate.origin, result.freshness.origin,
        result.diagnostics.candidateOrigin], ["cache", "cache", "cache"]);
});
test("restored cache is stale saved-last-valid", async () => {
    const { result } = await valid({ expectedTradingDate: "2026-08-25", activeContract: "2026-09" });
    assert.deepEqual([result.freshness.status, result.freshness.reason], ["stale", "saved_last_valid"]);
});
test("restored candidate remains display eligible", async () => {
    assert.equal((await valid()).result.displayEligible, true);
});
test("calculation eligibility remains metadata and undetermined", async () => {
    assert.equal((await valid()).result.calculationEligible, "undetermined");
});
test("unresolved quote retains source facts and is never fresh", async () => {
    const { result } = await valid({ expectedTradingDate: "2026-08-25" }, { quotedAtRaw: "07/01 06:00" });
    assert.deepEqual([result.candidate.quoteDate, result.candidate.quotedAtNormalized,
        result.freshness.status, result.displayEligible, result.calculationEligible],
    [null, null, "stale", true, "undetermined"]);
});
test("unknown expected trading date never promotes cache to fresh", async () => {
    const { result } = await valid();
    assert.equal(result.diagnostics.referenceDateEvaluationDeferred, true);
    assert.equal(result.freshness.status, "stale");
});
test("unknown active contract defers contract evaluation", async () => {
    const { result } = await valid();
    assert.deepEqual([result.diagnostics.activeContractContext,
        result.diagnostics.contractEvaluationDeferred], ["unknown", true]);
    assert.equal(result.freshness.diagnostics.secondaryReasons.includes("contract_mismatch"), false);
});
test("active contract can be supplied on a later independent evaluation", async () => {
    const value = await serialized(); const source = storage([[KEY, value]]);
    const first = await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source });
    const later = await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source,
        context: { activeContract: "2026-09" } });
    assert.deepEqual([first.diagnostics.activeContractContext, later.diagnostics.activeContractContext,
        later.freshness.staleReason], ["unknown", "available", "saved_data_origin"]);
});
test("contract mismatch retains candidate but reports stale mismatch", async () => {
    const { result } = await valid({ activeContract: "2026-12" });
    assert.deepEqual([result.status, result.candidate.contract, result.freshness.staleReason],
        ["candidate", "2026-09", "contract_mismatch"]);
});
test("legacy entries are neither read nor changed", async () => {
    const source = storage([["optionMapCurrentPrice", "70000"], ["optionMapPriceMode", "manual"]]);
    const before = JSON.stringify([...source.values]);
    await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source });
    assert.equal(JSON.stringify([...source.values]), before);
    assert.deepEqual(source.calls, [KEY]);
});
test("live current price object is not changed or included", async () => {
    const live = { value: 70000, source: "live", requestId: "live-2" };
    const before = JSON.stringify(live);
    const { result } = await valid({ liveCurrentPrice: live });
    assert.equal(JSON.stringify(live), before);
    assert.equal(Object.hasOwn(result, "currentPrice"), false);
    assert.equal(result.diagnostics.currentPriceApplied, false);
});
test("race metadata never authorizes overwrite of a live acquisition", async () => {
    const { result } = await valid({ bootGeneration: 3, requestId: "boot-3",
        restoredAt: "2026-08-24T09:05:00Z", liveAcquisitionIdentity: "live-4" });
    assert.deepEqual([result.diagnostics.bootGeneration, result.diagnostics.requestId,
        result.restoredAt, result.diagnostics.liveOverwriteAllowed],
    [3, "boot-3", "2026-08-24T09:05:00Z", false]);
});
test("only the fixed key is read", async () => {
    const { source } = await valid();
    assert.deepEqual(source.calls, [KEY]);
});
test("write capabilities are never used", async () => {
    const source = storage([[KEY, await serialized()]]);
    source.setItem = source.removeItem = source.clear = () => { throw new Error("write"); };
    assert.equal((await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source })).status,
        "candidate");
});
test("storage entries and fingerprint remain unchanged", async () => {
    const source = storage([[KEY, await serialized()], ["unrelated", "keep"]]);
    const before = [source.values.size, fingerprint(source), JSON.stringify([...source.values])];
    await Shadow.buildCurrentPriceBootRestoreShadow({ storage: source });
    assert.deepEqual([source.values.size, fingerprint(source), JSON.stringify([...source.values])], before);
});
test("storage read exceptions are contained", async () => {
    const result = await Shadow.buildCurrentPriceBootRestoreShadow({
        storage: { getItem() { throw new Error("blocked"); } } });
    assert.deepEqual([result.status, result.reason, result.candidate],
        ["unavailable", "storage_read_error", null]);
});
test("invalid restoredAt is not replaced with an implicit clock", async () => {
    const { result } = await valid({ restoredAt: "now" });
    assert.equal(result.restoredAt, null);
});
test("module is read-only and has no runtime, UI, mobile, calculation or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceBootRestoreShadow.js"), "utf8");
    assert.equal(/setItem|removeItem|\.clear\s*\(|indexedDB|\bfetch\s*\(|setInterval|setTimeout/.test(source), false);
    assert.equal(/applyCurrentPrice|setCurrentPrice|document\.|MobileSummary|OverallV2|nearestStrike|PriceSnapshot|Observation/.test(source), false);
    assert.equal(/optionMapCurrentPrice(?!LastValid)/.test(source), false);
});
test("renderer loads the shadow module without DOM UI markup", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /<script src="js\/currentPriceBootRestoreShadow\.js"><\/script>/);
});

test("runtime starts once and exposes a valid frozen candidate", async () => {
    const runtime = Shadow.createCurrentPriceBootRestoreShadowRuntime();
    const source = storage([[KEY, await serialized()]]);
    const first = runtime.initialize({ storage: source,
        context: { restoredAt: "2026-08-24T09:05:00Z" } });
    const second = runtime.initialize({ storage: source });
    assert.equal(first, second);
    const result = await first;
    assert.deepEqual([source.calls.length, result.status, result.candidate.origin,
        result.generation], [1, "candidate", "cache", 1]);
    assert.equal(Object.isFrozen(runtime.getState()), true);
});
test("runtime missing and invalid states do not throw or create a candidate", async () => {
    const missing = await Shadow.createCurrentPriceBootRestoreShadowRuntime()
        .initialize({ storage: storage() });
    const invalid = await Shadow.createCurrentPriceBootRestoreShadowRuntime()
        .initialize({ storage: storage([[KEY, "{"]]) });
    assert.deepEqual([missing.status, missing.candidate, invalid.status, invalid.candidate],
        ["missing", null, "invalid", null]);
});
test("diagnostic getter is a detached deeply frozen snapshot", async () => {
    const runtime = Shadow.createCurrentPriceBootRestoreShadowRuntime();
    await runtime.initialize({ storage: storage([[KEY, await serialized()]]) });
    const first = runtime.getState(); const second = runtime.getState();
    assert.notEqual(first, second);
    assert.notEqual(first.candidate, second.candidate);
    assert.equal(Object.isFrozen(first.candidate), true);
});
test("live acquisition supersedes shadow semantics without applying a price", async () => {
    const runtime = Shadow.createCurrentPriceBootRestoreShadowRuntime();
    await runtime.initialize({ storage: storage([[KEY, await serialized()]]) });
    const result = runtime.markLiveAcquisitionSuperseded({ requestId: "qri-2",
        acquisitionIdentity: "2026-09|08/24 18:00|fetch-2",
        acquiredAt: "2026-08-24T09:10:00Z" });
    assert.deepEqual([result.status, result.reason, result.candidate.origin,
        result.diagnostics.currentPriceApplied],
    ["superseded", "replaced_by_live", "cache", false]);
});
test("stale async restore cannot overwrite a newer live generation", async () => {
    let release;
    const runtime = Shadow.createCurrentPriceBootRestoreShadowRuntime({ build: () =>
        new Promise(resolve => { release = resolve; }) });
    const pending = runtime.initialize({ storage: storage() });
    const live = runtime.markLiveAcquisitionSuperseded({ requestId: "live-2" });
    release({ status: "candidate", reason: null, candidate: { origin: "cache" },
        cache: {}, freshness: {}, displayEligible: true,
        calculationEligible: "undetermined", restoredAt: null, diagnostics: {} });
    const completed = await pending;
    assert.deepEqual([live.status, completed.status, runtime.getState().status,
        completed.generation], ["superseded", "superseded", "superseded", 2]);
});
test("renderer wiring runs after legacy script and before initial refresh", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const script = html.indexOf('<script src="js/script.js"></script>');
    const initialize = html.indexOf("initializeCurrentPriceBootRestoreShadow");
    const refresh = html.indexOf(".finally(() => refreshAllMarketData())");
    assert.equal(script < initialize && initialize < refresh, true);
});
test("live QRI path only supersedes shadow before unchanged save wiring", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /applyQriNikkei225FuturesPrice[\s\S]+?markCurrentPriceBootRestoreShadowSuperseded[\s\S]+?buildAndSaveCurrentPriceLastValid/);
});
