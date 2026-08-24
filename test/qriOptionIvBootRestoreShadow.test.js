const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const Cache = require("../js/qriOptionIvLastValidCache.js");
const Shadow = require("../js/qriOptionIvBootRestoreShadow.js");
const KEY = "optionMapQriOptionIvLastValidV1";

function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-"); cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("40,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
      <dt>取引日</dt><dd>2026/08/24</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function serialized(html = page()) {
    const canonical = Iv.parseQriOptionIvPage(html, "https://svc.qri.jp/jpx/nkopm/");
    const result = await Cache.buildQriOptionIvLastValidCache({ channel: "active",
        available: true, sourceStatus: "acquired", status: "available", canonical,
        canonicalSignature: await Iv.createSignature(canonical),
        canonicalVersionKey: await Iv.createVersionKey(canonical),
        fetchedAt: "2026-08-24T07:00:00.000Z", activeContract: "2026-09",
        acquisitionOrigin: "live", requestContext: { mode: "auto", requestId: "qri-1" } });
    return JSON.stringify(result.cache);
}
function storage(entries = []) {
    const values = new Map(entries); const calls = [];
    return { values, calls, getItem(key) { calls.push(key); return values.get(key) ?? null; } };
}

test("valid saved cache becomes a cache-origin shadow candidate", async () => {
    const result = await Shadow.buildQriOptionIvBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]),
        context: { restoredAt: "2026-08-24T08:00:00Z" } });
    assert.deepEqual([result.status, result.candidate.origin, result.candidate.contract,
        result.candidate.recordCount], ["candidate", "cache", "2026-09", 2]);
    assert.equal(result.cache.requestContext.channel, "active");
});
test("missing malformed tampered specific and selected inputs create no candidate", async () => {
    const valid = JSON.parse(await serialized());
    const inputs = [null, "{", JSON.stringify({ ...valid, signature: "0".repeat(64) })];
    for (const mutate of [value => { value.requestContext.mode = "specific"; },
        value => { value.requestContext.channel = "selected"; },
        value => { value.canonical.records[0].iv.value += 1; }]) {
        const changed = structuredClone(valid); mutate(changed); inputs.push(JSON.stringify(changed));
    }
    for (const value of inputs) {
        const result = await Shadow.buildQriOptionIvBootRestoreShadow({
            storage: storage(value === null ? [] : [[KEY, value]]) });
        assert.equal(result.candidate, null);
        assert.equal(["missing", "invalid"].includes(result.status), true);
    }
});
test("sparse and all-missing canonical remain valid candidates with factual counts", async () => {
    const fixtures = [[page(row("40,000", "20%", "-") + row("40,500", "-", "21%")),
        { call: 1, put: 1, total: 2 }],
    [page(row("40,000", "-", "") + row("40,500", "-", "-")),
        { call: 0, put: 0, total: 0 }]];
    for (const [html, counts] of fixtures) {
        const result = await Shadow.buildQriOptionIvBootRestoreShadow({
            storage: storage([[KEY, await serialized(html)]]) });
        assert.equal(result.status, "candidate");
        assert.deepEqual(result.candidate.availablePointCounts, counts);
    }
});
test("Freshness retains cache origin display eligibility and undetermined calculation", async () => {
    const result = await Shadow.buildQriOptionIvBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]) });
    assert.deepEqual([result.freshness.origin, result.displayEligible,
        result.calculationEligible], ["cache", true, "undetermined"]);
    assert.notEqual(result.freshness.status, "fresh");
});
test("unknown calendar and active contract remain deferred without inference", async () => {
    const result = await Shadow.buildQriOptionIvBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]) });
    assert.deepEqual([result.diagnostics.activeContractContext,
        result.diagnostics.contractEvaluationDeferred,
        result.diagnostics.referenceDateEvaluationDeferred,
        result.diagnostics.activeContract], ["unknown", true, true, null]);
});
test("later active contract context is evaluated without changing candidate identity", async () => {
    const result = await Shadow.buildQriOptionIvBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]), context: { activeContract: "2026-09" } });
    assert.deepEqual([result.diagnostics.contractMatches,
        result.diagnostics.contractEvaluationDeferred, result.candidate.origin],
    [true, false, "cache"]);
});
test("cache canonical records and candidate are detached and deeply frozen", async () => {
    const source = await serialized(); const parsed = JSON.parse(source);
    const result = await Shadow.buildQriOptionIvBootRestoreShadow({
        storage: storage([[KEY, source]]) });
    assert.notStrictEqual(result.canonical, parsed.canonical);
    assert.notStrictEqual(result.candidate.canonical, result.canonical);
    for (const value of [result, result.cache, result.canonical, result.canonical.records,
        result.canonical.records[0], result.candidate, result.candidate.canonical,
        result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});
test("runtime initializes once and diagnostic getter returns detached frozen snapshots", async () => {
    const runtime = Shadow.createQriOptionIvBootRestoreShadowRuntime();
    const source = storage([[KEY, await serialized()]]);
    const first = runtime.initialize({ storage: source });
    assert.equal(first, runtime.initialize({ storage: source }));
    await first;
    const one = runtime.getState(); const two = runtime.getState();
    assert.deepEqual([source.calls.length, one.status, one.generation], [1, "candidate", 1]);
    assert.notStrictEqual(one, two); assert.equal(Object.isFrozen(one.candidate.canonical), true);
});
test("live supersede prevents a stale restore from rewinding generation", async () => {
    let release;
    const runtime = Shadow.createQriOptionIvBootRestoreShadowRuntime({ build: () =>
        new Promise(resolve => { release = resolve; }) });
    const pending = runtime.initialize({ storage: storage() });
    const live = runtime.markLiveAcquisitionSuperseded({ requestId: "live-2",
        acquisitionIdentity: "2026-09|signature", acquiredAt: "2026-08-24T09:00:00Z" });
    release({ status: "candidate", reason: null, candidate: { origin: "cache" },
        cache: {}, canonical: {}, freshness: {}, displayEligible: true,
        calculationEligible: "undetermined", restoredAt: null, diagnostics: {} });
    const completed = await pending;
    assert.deepEqual([live.status, live.reason, completed.status,
        runtime.getState().generation], ["superseded", "replaced_by_live", "superseded", 2]);
});
test("shadow never applies saved IV to runtime Graph UI storage history or calculation", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionIvBootRestoreShadow.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|setItem|removeItem|indexedDB|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /currentQriOptionIv|buildCurrentQriIvGraphViewModel|renderQriIvGraph/);
    assert.doesNotMatch(source, /document\.|querySelector|Chart|History|OverallV2|setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionIvBootRestoreShadow.js"), false);
});
test("read-only input storage and serialized cache are not mutated", async () => {
    const value = await serialized(); const source = storage([[KEY, value]]);
    const before = JSON.stringify([...source.values]);
    await Shadow.buildQriOptionIvBootRestoreShadow({ storage: source });
    assert.equal(JSON.stringify([...source.values]), before);
});
