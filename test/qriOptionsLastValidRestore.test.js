const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriOptions.js");
const Cache = require("../js/qriOptionsLastValidCache.js");
const Restore = require("../js/qriOptionsLastValidRestore.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-25T06:10:00.000Z";
function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－");
    cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("65,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/25 05:50</dd>
        <div id="futuresContractTab"><li class="active"><a>9月限月</a></li></div>
        <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function cache() {
    const canonical = Qri.parseQriOptionsPage(page(), URL);
    const formal = await Qri.createCacheV2(canonical, FETCHED_AT);
    const built = await Cache.buildQriOptionsLastValidCache({ channel: "active",
        mode: "auto", acquisitionOrigin: "live", isCurrent: true, available: true,
        sourceStatus: "acquired", status: "available", canonical,
        canonicalSignature: formal.signature, canonicalVersionKey: formal.versionKey,
        fetchedAt: FETCHED_AT, activeContract: canonical.contract,
        responseContract: canonical.contract, requestContext: { channel: "active",
            mode: "auto", acquisitionOrigin: "live", requestId: "qri-1",
            requestedContract: "auto", responseContract: canonical.contract } });
    assert.equal(built.success, true); return built.cache;
}

test("valid serialized and object cache restore through Phase 7.1 validator", async () => {
    const source = await cache();
    assert.equal((await Restore.restoreQriOptionsLastValidCache(JSON.stringify(source))).success, true);
    assert.equal((await Restore.restoreQriOptionsLastValidCache(source)).success, true);
});

test("parse policy distinguishes absent blank malformed primitive and array input", () => {
    const cases = [[null, "input_null"], [undefined, "input_undefined"], [" ", "input_blank"],
        ["{", "parse_error"], ["[]", "parsed_type_invalid"], ["1", "parsed_type_invalid"]];
    for (const [value, reason] of cases) {
        const result = Restore.parseQriOptionsLastValidCache(value);
        assert.deepEqual([result.success, result.reason], [false, reason]);
    }
});

test("non-object direct input and wrong schema or unknown fields fail closed", async () => {
    assert.equal((await Restore.restoreQriOptionsLastValidCache([])).reason,
        "input_type_invalid");
    for (const mutate of [value => { value.cacheVersion = 2; },
        value => { value.schemaVersion = 2; }, value => { value.extra = true; }]) {
        const changed = structuredClone(await cache()); mutate(changed);
        const result = await Restore.restoreQriOptionsLastValidCache(changed);
        assert.deepEqual([result.success, result.cache, result.canonical], [false, null, null]);
    }
});

test("canonical identity wrapper and acquisition context tampering never partially restore", async () => {
    const mutations = [value => { value.canonical.records[0].value += 1; },
        value => { value.canonicalSignature = "0".repeat(64); },
        value => { value.canonicalVersionKey += "x"; },
        value => { value.signature = "0".repeat(64); },
        value => { value.versionKey += "x"; },
        value => { value.requestContext.channel = "selected"; },
        value => { value.requestContext.mode = "specific"; },
        value => { value.requestContext.acquisitionOrigin = "cache"; }];
    for (const mutate of mutations) {
        const changed = structuredClone(await cache()); mutate(changed);
        const result = await Restore.restoreQriOptionsLastValidCache(changed);
        assert.deepEqual([result.success, result.reason, result.cache, result.canonical],
            [false, "cache_invalid", null, null]);
    }
});

test("partial and unavailable canonical cannot restore even with recomputed identities", async () => {
    for (const rows of [row("65,000", "100", "－"), row("65,000", "－", "－")]) {
        const changed = structuredClone(await cache());
        changed.canonical = Qri.parseQriOptionsPage(page(rows), URL);
        const formal = await Qri.createCacheV2(changed.canonical, changed.fetchedAt);
        changed.canonicalSignature = formal.signature;
        changed.canonicalVersionKey = formal.versionKey;
        changed.signature = await Cache.createSignature(changed);
        changed.versionKey = Cache.createVersionKey(changed);
        assert.equal(await Cache.validateQriOptionsLastValidCache(changed), false);
        const result = await Restore.restoreQriOptionsLastValidCache(changed);
        assert.deepEqual([result.success, result.reason, result.cache, result.canonical],
            [false, "cache_invalid", null, null]);
    }
});

test("restore output is detached deeply frozen and leaves caller input unchanged", async () => {
    const source = structuredClone(await cache()); const before = JSON.stringify(source);
    const result = await Restore.restoreQriOptionsLastValidCache(source);
    assert.equal(JSON.stringify(source), before);
    assert.notStrictEqual(result.cache, source);
    assert.notStrictEqual(result.canonical, source.canonical);
    for (const value of [result, result.cache, result.canonical, result.canonical.records,
        result.canonical.records[0], result.cache.requestContext, result.diagnostics]) {
        assert.equal(Object.isFrozen(value), true);
    }
});

test("Freshness reuses cache adapter and remains cache-origin display-only", async () => {
    const result = await Restore.restoreQriOptionsLastValidWithFreshness(await cache());
    assert.deepEqual([result.freshnessInput.origin, result.freshnessInput.displayEligible,
        result.freshnessInput.calculationEligible], ["cache", true, "undetermined"]);
    assert.deepEqual([result.freshness.origin, result.freshness.displayEligible,
        result.freshness.calculationEligible], ["cache", true, "undetermined"]);
    assert.notEqual(result.freshness.status, "fresh");
});

test("contract context is delegated to Freshness rather than internal cache repair", async () => {
    const result = await Restore.restoreQriOptionsLastValidWithFreshness(await cache(), {
        contractMatches: false, expectedTradingDate: "2026-08-25" });
    assert.equal(result.success, true);
    assert.equal(result.freshnessInput.contractMatches, false);
    assert.equal(result.cache.requestContext.responseContract, "2026-09");
});

test("restore module is pure and not renderer-wired", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsLastValidRestore.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|setItem|removeItem|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /qriOptionsHistory|optionMapLastValidQriOpenInterest|document\.|Chart|OverallV2/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsLastValidRestore.js"), false);
});
