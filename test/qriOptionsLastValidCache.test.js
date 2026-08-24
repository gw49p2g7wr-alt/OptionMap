const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriOptions.js");
const Cache = require("../js/qriOptionsLastValidCache.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-25T06:10:00.000Z";

function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－");
    cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(rows = row("65,000"), updated = "05:50") {
    return `<dt>最終更新時刻</dt><dd>2026/08/25 ${updated}</dd>
        <div id="futuresContractTab"><li class="active"><a href="javascript:void(0)">9月限月</a></li></div>
        <dt>取引日</dt><dd>2026/08/25</dd>
        <dt>取引最終日</dt><dd>2026/09/10</dd>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}

async function makeInput(overrides = {}, html = page()) {
    const canonical = Qri.parseQriOptionsPage(html, URL);
    const formal = await Qri.createCacheV2(canonical, FETCHED_AT);
    return { channel: "active", mode: "auto", acquisitionOrigin: "live",
        isCurrent: true, available: true, sourceStatus: "acquired", status: "available",
        canonical, canonicalSignature: formal.signature,
        canonicalVersionKey: formal.versionKey, fetchedAt: FETCHED_AT,
        activeContract: canonical.contract, responseContract: canonical.contract,
        requestContext: { channel: "active", mode: "auto", acquisitionOrigin: "live",
            requestId: "qri-1", requestedContract: "auto",
            responseContract: canonical.contract }, ...overrides };
}

async function build(overrides = {}, html) {
    return Cache.buildQriOptionsLastValidCache(await makeInput(overrides, html));
}

test("available active auto live canonical becomes an exact signed cache", async () => {
    const result = await build();
    assert.equal(result.success, true);
    assert.equal(await Cache.validateQriOptionsLastValidCache(result.cache), true);
    assert.deepEqual(Object.keys(result.cache).sort(), [...Cache.CACHE_FIELDS].sort());
    assert.deepEqual(Object.keys(result.cache.requestContext).sort(),
        [...Cache.CONTEXT_FIELDS].sort());
    assert.deepEqual([result.cache.cacheVersion, result.cache.schemaVersion,
        result.cache.signatureAlgorithm], [1, 1, "sha256"]);
});

test("formal validator, signature and versionKey are reused", async () => {
    const input = await makeInput();
    const result = await Cache.buildQriOptionsLastValidCache(input);
    const formal = await Qri.createCacheV2(result.cache.canonical, result.cache.fetchedAt);
    assert.equal(Qri.validateCanonical(result.cache.canonical,
        { allowUnresolvedContracts: true }), true);
    assert.equal(result.cache.canonicalSignature, formal.signature);
    assert.equal(result.cache.canonicalVersionKey, formal.versionKey);
});

test("selected, specific, restored, stale and unavailable sources are rejected", async () => {
    const cases = [
        [{ channel: "selected" }, "active_channel_required"],
        [{ mode: "specific" }, "automatic_mode_required"],
        [{ acquisitionOrigin: "cache", restored: true }, "live_acquisition_required"],
        [{ status: "stale_ignored" }, "stale_ignored"],
        [{ isCurrent: false }, "stale_ignored"],
        [{ sourceStatus: "unavailable", available: false }, "source_not_acquired"]
    ];
    for (const [overrides, reason] of cases) {
        assert.equal((await build(overrides)).reason, reason);
    }
});

test("contract mismatch and malformed fetchedAt are rejected", async () => {
    assert.equal((await build({ activeContract: "2026-10" })).reason, "contract_mismatch");
    assert.equal((await build({ responseContract: "2026-10" })).reason, "contract_mismatch");
    assert.equal((await build({ fetchedAt: "invalid" })).reason, "fetched_at_invalid");
});

test("partial, unavailable and all unpublished OI never become last-valid", async () => {
    const partial = await build({}, page(row("65,000", "100", "－")));
    const unavailable = await build({}, page(row("65,000", "－", "－")));
    assert.equal(partial.reason, "open_interest_not_fully_available");
    assert.equal(unavailable.reason, "open_interest_not_fully_available");
    assert.equal(partial.cache, null);
    assert.equal(unavailable.cache, null);
});

test("published zero OI remains valid and distinct from unpublished", async () => {
    const result = await build({}, page(row("65,000", "0", "0")));
    assert.equal(result.success, true);
    assert.equal(result.cache.canonical.records.every(record =>
        record.published && record.value === 0), true);
});

test("same canonical re-fetch changes wrapper signature but keeps versionKey stable", async () => {
    const first = (await build()).cache;
    const second = (await build({ fetchedAt: "2026-08-25T07:10:00.000Z" })).cache;
    assert.equal(first.canonicalSignature, second.canonicalSignature);
    assert.equal(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.notEqual(first.signature, second.signature);
    assert.equal(first.versionKey, second.versionKey);
});

test("a new formal canonical identity changes wrapper versionKey", async () => {
    const first = (await build()).cache;
    const changed = (await build({}, page(row("65,000", "101", "200")))).cache;
    assert.notEqual(first.canonicalSignature, changed.canonicalSignature);
    assert.notEqual(first.canonicalVersionKey, changed.canonicalVersionKey);
    assert.notEqual(first.versionKey, changed.versionKey);
});

test("caller-supplied canonical identity must match formal recomputation", async () => {
    assert.equal((await build({ canonicalSignature: "0".repeat(64) })).reason,
        "canonical_identity_mismatch");
    assert.equal((await build({ canonicalVersionKey: "wrong" })).reason,
        "canonical_identity_mismatch");
});

test("canonical and wrapper tampering are rejected", async () => {
    const original = (await build()).cache;
    const canonicalTamper = structuredClone(original);
    canonicalTamper.canonical.records[0].value += 1;
    assert.equal(await Cache.validateQriOptionsLastValidCache(canonicalTamper), false);
    for (const mutate of [
        value => { value.fetchedAt = "2026-08-25T08:10:00.000Z"; },
        value => { value.signature = "0".repeat(64); },
        value => { value.versionKey += "x"; },
        value => { value.requestContext.mode = "specific"; },
        value => { value.extra = true; },
        value => { value.requestContext.extra = true; }
    ]) {
        const changed = structuredClone(original); mutate(changed);
        assert.equal(await Cache.validateQriOptionsLastValidCache(changed), false);
    }
});

test("request context is an exact acquisition fact", async () => {
    const cache = (await build()).cache;
    assert.deepEqual(cache.requestContext, { channel: "active", mode: "auto",
        acquisitionOrigin: "live", requestId: "qri-1", requestedContract: "auto",
        responseContract: "2026-09" });
    assert.equal((await build({ requestContext: { channel: "active", mode: "auto",
        acquisitionOrigin: "live", requestId: "qri-1", requestedContract: "2026-09",
        responseContract: "2026-09" } })).reason, "request_context_invalid");
});

test("builder is non-mutating, detached and deeply frozen", async () => {
    const input = await makeInput(); const before = JSON.stringify(input);
    const result = await Cache.buildQriOptionsLastValidCache(input);
    assert.equal(JSON.stringify(input), before);
    assert.notStrictEqual(result.cache.canonical, input.canonical);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.cache), true);
    assert.equal(Object.isFrozen(result.cache.canonical), true);
    assert.equal(Object.isFrozen(result.cache.canonical.records[0]), true);
    assert.equal(Object.isFrozen(result.diagnostics), true);
});

test("Freshness adapter preserves cache origin and calculation separation", async () => {
    const cache = (await build()).cache;
    const result = await Cache.createFreshnessInput(cache);
    assert.deepEqual(result.input, { policyType: "daily",
        sourceType: "qri_options_open_interest", origin: "cache", hasData: true,
        dataTradingDate: "2026-08-25", sourceUpdatedAt: "2026-08-25T05:50:00+09:00",
        fetchedAt: FETCHED_AT, mode: "automatic", contract: "2026-09",
        validation: true, signatureValid: true, displayEligible: true,
        calculationEligible: "undetermined" });
    assert.equal(Object.isFrozen(result.input), true);
    const tampered = structuredClone(cache); tampered.signature = "0".repeat(64);
    assert.equal((await Cache.createFreshnessInput(tampered)).success, false);
});

test("module proposes a dedicated key and is loaded only for the save wiring", () => {
    assert.equal(Cache.STORAGE_KEY_CANDIDATE, "optionMapQriOptionsLastValidV1");
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsLastValidCache.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|setItem|removeItem|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /qriOptionsHistory|optionMapLastValidQriOpenInterest|document\.|Chart|OverallV2/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const qri = html.indexOf('<script src="js/qriOptions.js"></script>');
    const cache = html.indexOf('<script src="js/qriOptionsLastValidCache.js"></script>');
    const store = html.indexOf('<script src="js/storage/qriOptionsLastValidStore.js"></script>');
    assert.equal(qri >= 0 && qri < cache && cache < store, true);
    assert.equal(html.includes("qriOptionsLastValidRestore.js"), false);
});
