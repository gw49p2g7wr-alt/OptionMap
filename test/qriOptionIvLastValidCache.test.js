const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const Cache = require("../js/qriOptionIvLastValidCache.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-24T07:00:00.000Z";

function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-");
    cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(rows = row("40,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
        <dt>取引日</dt><dd>2026/08/24</dd>
        <dt>取引最終日</dt><dd>2026/09/10</dd>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}

async function input(overrides = {}, html = page()) {
    const canonical = Iv.parseQriOptionIvPage(html, URL);
    return { channel: "active", available: true, sourceStatus: "acquired",
        status: "available", canonical,
        canonicalSignature: await Iv.createSignature(canonical),
        canonicalVersionKey: await Iv.createVersionKey(canonical),
        fetchedAt: FETCHED_AT, activeContract: canonical.contract,
        acquisitionOrigin: "live", requestContext: { mode: "auto", requestId: "qri-1" },
        ...overrides };
}

async function valid(overrides = {}, html) {
    return Cache.buildQriOptionIvLastValidCache(await input(overrides, html));
}

test("valid active automatic IV canonical becomes a signed cache", async () => {
    const result = await valid();
    assert.equal(result.success, true);
    assert.equal(await Cache.validateQriOptionIvLastValidCache(result.cache), true);
    assert.equal(result.cache.canonicalSignature,
        await Iv.createSignature(result.cache.canonical));
    assert.equal(result.cache.canonicalVersionKey,
        await Iv.createVersionKey(result.cache.canonical));
});

test("cache has exact versioned schema and minimal acquisition context", async () => {
    const cache = (await valid()).cache;
    assert.deepEqual(Object.keys(cache).sort(), [...Cache.CACHE_FIELDS].sort());
    assert.deepEqual(cache.requestContext, { channel: "active", mode: "auto",
        acquisitionOrigin: "live", activeContract: "2026-09", requestId: "qri-1" });
    assert.deepEqual([cache.cacheVersion, cache.schemaVersion, cache.signatureAlgorithm],
        [1, 1, "sha256"]);
});

test("specific and selected-only acquisitions are rejected", async () => {
    assert.equal((await valid({ requestContext: { mode: "specific", requestId: "s" } })).reason,
        "automatic_mode_required");
    assert.equal((await valid({ channel: "selected" })).reason, "active_channel_required");
});

test("stale, mismatch, unavailable and restored inputs are rejected", async () => {
    const cases = [
        [{ status: "stale_ignored" }, "stale_ignored"],
        [{ activeContract: "2026-10" }, "contract_mismatch"],
        [{ available: false, sourceStatus: "unavailable" }, "source_not_acquired"],
        [{ restored: true, acquisitionOrigin: "cache" }, "live_acquisition_required"]
    ];
    for (const [change, reason] of cases) assert.equal((await valid(change)).reason, reason);
});

test("zero published IV remains distinct from acquisition failure", async () => {
    const result = await valid({}, page(row("40,000", "-", "") + row("40,500", "-", "-")));
    assert.equal(result.success, true);
    assert.equal(result.cache.canonical.records.every(record =>
        record.iv.status === "missing"), true);
});

test("sparse valid IV canonical is cacheable without interpolation", async () => {
    const result = await valid({}, page(row("40,000", "20%", "-") +
        row("40,500", "-", "21%") + row("41,000", "-", "-")));
    assert.equal(result.success, true);
    assert.equal(result.cache.canonical.records.filter(record =>
        record.iv.status === "available").length, 2);
    assert.equal(result.cache.canonical.records.length, 6);
});

test("malformed fetchedAt is rejected", async () => {
    assert.equal((await valid({ fetchedAt: "bad" })).reason, "fetched_at_invalid");
});

test("same canonical re-fetch changes cache signature but keeps versionKey stable", async () => {
    const first = (await valid()).cache;
    const second = (await valid({ fetchedAt: "2026-08-24T08:00:00.000Z" })).cache;
    assert.equal(first.canonicalSignature, second.canonicalSignature);
    assert.equal(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.notEqual(first.signature, second.signature);
    assert.equal(first.versionKey, second.versionKey);
});

test("canonical identity supplied by caller must match formal recomputation", async () => {
    assert.equal((await valid({ canonicalSignature: "0".repeat(64) })).reason,
        "canonical_identity_mismatch");
    assert.equal((await valid({ canonicalVersionKey: "wrong" })).reason,
        "canonical_identity_mismatch");
});

test("canonical semantic tampering is detected by validator", async () => {
    const cache = structuredClone((await valid()).cache);
    cache.canonical.records[0].iv.value += 0.01;
    assert.equal(await Cache.validateQriOptionIvLastValidCache(cache), false);
});

test("cache metadata and integrity tampering are rejected", async () => {
    const original = (await valid()).cache;
    for (const mutate of [
        value => { value.fetchedAt = "2026-08-24T09:00:00.000Z"; },
        value => { value.signature = "0".repeat(64); },
        value => { value.versionKey += "x"; },
        value => { value.requestContext.mode = "specific"; },
        value => { value.extra = true; }
    ]) {
        const changed = structuredClone(original); mutate(changed);
        assert.equal(await Cache.validateQriOptionIvLastValidCache(changed), false);
    }
});

test("builder does not mutate input and result graph is deeply frozen", async () => {
    const source = await input(); const before = JSON.stringify(source);
    const result = await Cache.buildQriOptionIvLastValidCache(source);
    assert.equal(JSON.stringify(source), before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.cache), true);
    assert.equal(Object.isFrozen(result.cache.canonical), true);
    assert.equal(Object.isFrozen(result.cache.canonical.records[0].iv), true);
    assert.notStrictEqual(result.cache.canonical, source.canonical);
});

test("Freshness adapter preserves cache origin and undetermined calculation", async () => {
    const cache = (await valid()).cache;
    const result = await Cache.createFreshnessInput(cache);
    assert.equal(result.success, true);
    assert.deepEqual(result.input, { policyType: "daily", sourceType: "qri_option_iv",
        origin: "cache", hasData: true, dataTradingDate: "2026-08-24",
        sourceUpdatedAt: "2026-08-24T06:00:00+09:00", fetchedAt: FETCHED_AT,
        mode: "automatic", contract: "2026-09", validation: true,
        signatureValid: true, displayEligible: true,
        calculationEligible: "undetermined" });
    assert.equal(Object.isFrozen(result.input), true);
});

test("invalid cache cannot become a Freshness candidate", async () => {
    const cache = structuredClone((await valid()).cache); cache.signature = "0".repeat(64);
    assert.equal((await Cache.createFreshnessInput(cache)).success, false);
});

test("module proposes a dedicated key and has no storage, runtime, history, UI or network wiring", () => {
    assert.equal(Cache.STORAGE_KEY_CANDIDATE, "optionMapQriOptionIvLastValidV1");
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionIvLastValidCache.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|setItem|removeItem|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /History|currentQriOptionIv|document\.|querySelector|Chart|OverallV2/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionIvLastValidCache.js"), false);
});
