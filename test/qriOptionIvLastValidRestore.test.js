const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const Cache = require("../js/qriOptionIvLastValidCache.js");
const Restore = require("../js/qriOptionIvLastValidRestore.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-"); cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("40,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
      <dt>取引日</dt><dd>2026/08/24</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function cache(html = page()) {
    const canonical = Iv.parseQriOptionIvPage(html, URL);
    const result = await Cache.buildQriOptionIvLastValidCache({ channel: "active",
        available: true, sourceStatus: "acquired", status: "available", canonical,
        canonicalSignature: await Iv.createSignature(canonical),
        canonicalVersionKey: await Iv.createVersionKey(canonical),
        fetchedAt: "2026-08-24T07:00:00.000Z", activeContract: "2026-09",
        acquisitionOrigin: "live", requestContext: { mode: "auto", requestId: "qri-1" } });
    assert.equal(result.success, true); return result.cache;
}

test("valid serialized and parsed cache restore through one validator chain", async () => {
    const source = await cache();
    assert.equal((await Restore.restoreQriOptionIvLastValidCache(JSON.stringify(source))).success, true);
    assert.equal((await Restore.restoreQriOptionIvLastValidCache(source)).success, true);
});
test("parse policy distinguishes null undefined blank malformed and non-object", () => {
    const cases = [[null, "input_null"], [undefined, "input_undefined"], [" ", "input_blank"],
        ["{", "parse_error"], ["[]", "parsed_type_invalid"], ["1", "parsed_type_invalid"]];
    for (const [value, reason] of cases) {
        const result = Restore.parseQriOptionIvLastValidCache(value);
        assert.deepEqual([result.success, result.reason], [false, reason]);
    }
});
test("wrong versions and unknown fields are rejected", async () => {
    for (const mutate of [value => { value.cacheVersion = 2; },
        value => { value.schemaVersion = 2; }, value => { value.extra = true; }]) {
        const changed = structuredClone(await cache()); mutate(changed);
        assert.equal((await Restore.restoreQriOptionIvLastValidCache(changed)).reason,
            "cache_invalid");
    }
});
test("canonical and identity tampering are rejected without partial restore", async () => {
    const mutations = [value => { value.canonical.records[0].iv.value += 1; },
        value => { value.canonicalSignature = "0".repeat(64); },
        value => { value.canonicalVersionKey += "x"; },
        value => { value.signature = "0".repeat(64); },
        value => { value.versionKey += "x"; }];
    for (const mutate of mutations) {
        const changed = structuredClone(await cache()); mutate(changed);
        const result = await Restore.restoreQriOptionIvLastValidCache(changed);
        assert.deepEqual([result.success, result.cache, result.canonical], [false, null, null]);
    }
});
test("specific and selected acquisition context cannot restore", async () => {
    for (const mutate of [value => { value.requestContext.mode = "specific"; },
        value => { value.requestContext.channel = "selected"; }]) {
        const changed = structuredClone(await cache()); mutate(changed);
        assert.equal((await Restore.restoreQriOptionIvLastValidCache(changed)).success, false);
    }
});
test("sparse and all-missing valid canonicals restore successfully", async () => {
    const sparse = page(row("40,000", "20%", "-") + row("40,500", "-", "21%"));
    const missing = page(row("40,000", "-", "") + row("40,500", "-", "-"));
    for (const html of [sparse, missing]) {
        const result = await Restore.restoreQriOptionIvLastValidCache(await cache(html));
        assert.equal(result.success, true);
    }
});
test("restored cache canonical records context and diagnostics are detached and frozen", async () => {
    const source = await cache(); const result = await Restore.restoreQriOptionIvLastValidCache(source);
    assert.notStrictEqual(result.cache, source);
    assert.notStrictEqual(result.canonical, source.canonical);
    assert.notStrictEqual(result.canonical.records, source.canonical.records);
    for (const value of [result, result.cache, result.canonical, result.canonical.records,
        result.canonical.records[0], result.cache.requestContext, result.diagnostics]) {
        assert.equal(Object.isFrozen(value), true);
    }
});
test("restore does not mutate object or serialized input", async () => {
    const source = structuredClone(await cache()); const before = JSON.stringify(source);
    await Restore.restoreQriOptionIvLastValidCache(source);
    assert.equal(JSON.stringify(source), before);
    const serialized = JSON.stringify(source); await Restore.restoreQriOptionIvLastValidCache(serialized);
    assert.equal(serialized, before);
});
test("Freshness uses cache adapter and stays display-only with undetermined calculation", async () => {
    const result = await Restore.restoreQriOptionIvLastValidWithFreshness(await cache());
    assert.deepEqual([result.freshnessInput.origin, result.freshnessInput.displayEligible,
        result.freshnessInput.calculationEligible], ["cache", true, "undetermined"]);
    assert.deepEqual([result.freshness.origin, result.freshness.displayEligible,
        result.freshness.calculationEligible], ["cache", true, "undetermined"]);
    assert.notEqual(result.freshness.status, "fresh");
});
test("restore module has no storage runtime history UI network timer or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionIvLastValidRestore.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|setItem|removeItem|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /currentQriOptionIv|History|document\.|querySelector|Chart|OverallV2/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionIvLastValidRestore.js"), true);
    assert.doesNotMatch(html, /OptionMapQriOptionIvLastValidRestore\s*\.\s*(setItem|removeItem|clear)/);
});
