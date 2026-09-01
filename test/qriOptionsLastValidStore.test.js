const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Qri = require("../js/qriOptions.js");
const Save = require("../js/storage/qriOptionsLastValidStore.js");
const Read = require("../js/storage/qriOptionsLastValidReadOnlyStore.js");

const KEY = "optionMapQriOptionsLastValidV1";
const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-25T06:10:00.000Z";
function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－");
    cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("65,000"), minute = "50") {
    return `<dt>最終更新時刻</dt><dd>2026/08/25 05:${minute}</dd>
      <div id="futuresContractTab"><li class="active"><a>9月限月</a></li></div>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function input(overrides = {}, html = page(), fetchedAt = FETCHED_AT) {
    const canonical = Qri.parseQriOptionsPage(html, URL);
    const formal = await Qri.createCacheV2(canonical, fetchedAt);
    return { canonical, canonicalSignature: formal.signature,
        canonicalVersionKey: formal.versionKey, fetchedAt,
        activeContract: canonical.contract, responseContract: canonical.contract,
        requestId: "qri-1", ...overrides };
}
const context = overrides => ({ channel: "active", requestMode: "auto",
    acquisitionOrigin: "live", responseStatus: "available",
    sourceStatus: "acquired", isCurrent: true, ...overrides });
function storage(entries = []) {
    const values = new Map(entries); const writes = [];
    return { values, writes, getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
async function save(target = storage(), overrides = {}, guard = {}, html = page(), fetchedAt) {
    return { target, result: await Save.buildAndSaveQriOptionsLastValid(target,
        await input(overrides, html, fetchedAt), context(guard)) };
}
function browserStore(cacheApi) {
    const window = { document: {}, OptionMapQriOptionsLastValidCache: cacheApi };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionsLastValidStore.js"), "utf8"),
    { window, globalThis: window, console });
    return window.OptionMapQriOptionsLastValidStore;
}
function fakeCache(overrides = {}) {
    const value = { canonical: { contract: "2026-09" }, fetchedAt: "x",
        signature: "a", versionKey: "v" };
    return { async buildQriOptionsLastValidCache() {
        return { success: true, cache: value }; },
    async validateQriOptionsLastValidCache() { return true; }, ...overrides };
}

test("available active auto live canonical saves atomically to the fixed key", async () => {
    const { target, result } = await save();
    assert.deepEqual([result.success, result.saved, target.writes.length,
        target.writes[0][0]], [true, true, 1, KEY]);
    assert.doesNotThrow(() => JSON.parse(target.writes[0][1]));
});

test("saved cache passes read-only restore validator and Freshness chain", async () => {
    const { target } = await save();
    const restored = await Read.readAndRestoreQriOptionsLastValid(target);
    assert.deepEqual([restored.status, restored.restore.success,
        restored.freshness.origin], ["restored", true, "cache"]);
});

test("partial unavailable and all-unpublished never write or replace existing cache", async () => {
    const fixtures = [page(row("65,000", "100", "－")),
        page(row("65,000", "－", "－")), page(row("65,000", "", "－"))];
    for (const html of fixtures) {
        const target = storage([[KEY, "known-good"]]);
        const { result } = await save(target, {}, {
            responseStatus: Qri.parseQriOptionsPage(html, URL).openInterestStatus }, html);
        assert.deepEqual([result.saved, result.reason, target.writes.length,
            target.values.get(KEY)], [false, "open_interest_not_fully_available",
            0, "known-good"]);
    }
});

test("selected specific restored stale unavailable invalid and contract mismatch do not save", async () => {
    const valid = await input();
    const cases = [[valid, context({ channel: "selected" })],
        [valid, context({ requestMode: "specific" })],
        [{ ...valid, restored: true }, context()],
        [valid, context({ isCurrent: false })],
        [valid, context({ responseStatus: "stale_ignored" })],
        [valid, context({ sourceStatus: "unavailable" })],
        [{ ...valid, canonical: { invalid: true } }, context()],
        [{ ...valid, activeContract: "2026-10" }, context()]];
    for (const [source, guard] of cases) {
        const target = storage();
        const result = await Save.buildAndSaveQriOptionsLastValid(target, source, guard);
        assert.deepEqual([result.saved, target.writes.length], [false, 0]);
    }
});

test("builder validator serialization and storage failures are isolated", async () => {
    const source = await input();
    const builder = browserStore(fakeCache({ async buildQriOptionsLastValidCache() {
        throw Error("build"); } }));
    assert.equal((await builder.buildAndSaveQriOptionsLastValid(
        storage(), source, context())).reason, "cache_builder_error");
    const validator = browserStore(fakeCache({ async validateQriOptionsLastValidCache() {
        return false; } }));
    assert.equal((await validator.buildAndSaveQriOptionsLastValid(
        storage(), source, context())).reason, "cache_validation_failed");
    const circular = {}; circular.self = circular;
    const serializer = browserStore(fakeCache({ async buildQriOptionsLastValidCache() {
        return { success: true, cache: circular }; } }));
    assert.equal((await serializer.buildAndSaveQriOptionsLastValid(
        storage(), source, context())).reason, "serialization_error");
    assert.equal((await Save.buildAndSaveQriOptionsLastValid(
        { setItem() { throw Error("quota"); } }, source, context())).reason,
    "storage_write_error");
});

test("same canonical refetch updates acquisition signature with stable identity", async () => {
    const target = storage();
    const first = (await save(target)).result.cache;
    const second = (await save(target, {}, {}, page(),
        "2026-08-25T07:10:00.000Z")).result.cache;
    assert.equal(first.canonicalSignature, second.canonicalSignature);
    assert.equal(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.equal(first.versionKey, second.versionKey);
    assert.notEqual(first.signature, second.signature);
    assert.equal(JSON.parse(target.values.get(KEY)).fetchedAt,
        "2026-08-25T07:10:00.000Z");
});

test("new canonical replaces fixed key with a new canonical and wrapper identity", async () => {
    const target = storage(); const first = (await save(target)).result.cache;
    const second = (await save(target, {}, {}, page(row("65,000", "101", "200"), "51")))
        .result.cache;
    assert.notEqual(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.notEqual(first.versionKey, second.versionKey);
    assert.equal(target.writes.length, 2);
});

test("request becoming stale during async build cannot overwrite", async () => {
    const target = storage([[KEY, "newer"]]); let checks = 0;
    const result = await Save.buildAndSaveQriOptionsLastValid(target, await input(),
        context({ isCurrent: () => ++checks === 1 }));
    assert.deepEqual([result.reason, target.writes.length, target.values.get(KEY)],
        ["stale_response", 0, "newer"]);
});

test("only dedicated key changes and input canonical is not mutated", async () => {
    const entries = [["optionMapLastValidQriOpenInterest", "legacy"],
        ["optionMapCurrentPriceLastValidV1", "price"],
        ["optionMapQriOptionIvLastValidV1", "iv"], ["unrelated", "keep"]];
    const target = storage(entries); const source = await input();
    const beforeInput = JSON.stringify(source); const before = new Map(target.values);
    await Save.buildAndSaveQriOptionsLastValid(target, source, context());
    assert.equal(JSON.stringify(source), beforeInput);
    for (const [key, value] of before) assert.equal(target.values.get(key), value);
    assert.deepEqual(target.writes.map(item => item[0]), [KEY]);
});

test("renderer wires active auto after unchanged history and excludes specific paths", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const scripts = ["js/qriOptions.js", "js/qriOptionsLastValidCache.js",
        "js/storage/qriOptionsLastValidStore.js", "js/qriOptionsHistory.js"];
    const positions = scripts.map(item => html.indexOf(`<script src="${item}"></script>`));
    assert.equal(positions.every(position => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const active = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("async function fetchParticipantData"));
    assert.ok(active.indexOf("persistQriOptionsHistory(") <
        active.indexOf("buildAndSaveQriOptionsLastValid(localStorage"));
    assert.ok(active.indexOf("buildAndSaveQriOptionsLastValid(localStorage") <
        active.indexOf("window.saveLastValidQriOpenInterest({"));
    assert.equal((active.match(/optionMapBridge\.fetchQriOptionPage\(/g) || []).length, 1);
    const selected = html.slice(html.indexOf("async function showSpecificQriContract"),
        html.indexOf("async function updateQriContractManifest"));
    assert.equal(selected.includes("buildAndSaveQriOptionsLastValid"), false);
    assert.doesNotMatch(html, /readAndRestoreQriOptionsLastValid\s*\(/);
});

test("module has no IndexedDB history legacy UI Overall fetch timer or boot restore wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionsLastValidStore.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|qriOptionsHistory|optionMapLastValidQriOpenInterest/);
    assert.doesNotMatch(source, /document\.|querySelector|OverallV2|\bfetch\s*\(|setTimeout|setInterval/);
    assert.doesNotMatch(source, /readAndRestore|Boot|migration|backfill/);
});
