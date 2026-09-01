const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Iv = require("../js/qriOptionIv.js");
const Runtime = require("../js/qriOptionIvRuntime.js");
const Save = require("../js/storage/qriOptionIvLastValidStore.js");
const Read = require("../js/storage/qriOptionIvLastValidReadOnlyStore.js");

const KEY = "optionMapQriOptionIvLastValidV1";
const URL = "https://svc.qri.jp/jpx/nkopm/";
function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-"); cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("40,000"), minute = "00") {
    return `<dt>最終更新時刻</dt><dd>2026/08/24 06:${minute}</dd>
      <dt>取引日</dt><dd>2026/08/24</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function runtimeCandidate(html = page(), fetchedAt = "2026-08-24T07:00:00.000Z",
    requestContext = { mode: "auto", requestId: "qri-1" }) {
    return Runtime.createCandidate({ canonical: Iv.parseQriOptionIvPage(html, URL),
        fetchedAt, requestContext });
}
const context = overrides => ({ channel: "active", requestMode: "auto",
    acquisitionOrigin: "live", responseStatus: "available", isCurrent: true, ...overrides });
async function input(overrides = {}, html, fetchedAt, requestContext) {
    const candidate = await runtimeCandidate(html, fetchedAt, requestContext);
    return { candidate, activeContract: "2026-09", responseContract: "2026-09", ...overrides };
}
function storage(entries = []) {
    const values = new Map(entries); const writes = [];
    return { values, writes, getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
async function save(target = storage(), inputOverrides = {}, contextOverrides = {}, html,
    fetchedAt, requestContext) {
    return { target, result: await Save.buildAndSaveQriOptionIvLastValid(target,
        await input(inputOverrides, html, fetchedAt, requestContext), context(contextOverrides)) };
}
function browserStore(cacheApi) {
    const window = { document: {}, OptionMapQriOptionIvLastValidCache: cacheApi };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionIvLastValidStore.js"), "utf8"),
    { window, globalThis: window, console });
    return window.OptionMapQriOptionIvLastValidStore;
}
function fakeCache(overrides = {}) {
    const value = { canonical: { contract: "2026-09" }, fetchedAt: "x",
        signature: "a", versionKey: "v" };
    return { async buildQriOptionIvLastValidCache() {
        return { success: true, cache: value }; },
    async validateQriOptionIvLastValidCache() { return true; }, ...overrides };
}

test("valid active auto live candidate saves once to the fixed key", async () => {
    const { target, result } = await save();
    assert.deepEqual([result.success, result.saved, target.writes.length,
        target.writes[0][0]], [true, true, 1, KEY]);
    assert.doesNotThrow(() => JSON.parse(target.writes[0][1]));
});
test("saved cache passes read-only restore and Freshness chain", async () => {
    const { target } = await save();
    const restored = await Read.readAndRestoreQriOptionIvLastValid(target);
    assert.deepEqual([restored.status, restored.restore.success,
        restored.freshness.origin], ["restored", true, "cache"]);
});
test("sparse and all-missing valid IV are saved", async () => {
    const pages = [page(row("40,000", "20%", "-") + row("40,500", "-", "21%")),
        page(row("40,000", "-", "") + row("40,500", "-", "-"))];
    for (const html of pages) assert.equal((await save(storage(), {}, {}, html)).result.saved, true);
});
test("specific selected stale unavailable invalid mismatch restored and non-current do not save", async () => {
    const valid = await input();
    const cases = [
        [valid, context({ requestMode: "specific" })],
        [valid, context({ channel: "selected" })],
        [valid, context({ responseStatus: "stale_ignored" })],
        [{ ...valid, candidate: { ...valid.candidate, available: false,
            sourceStatus: "unavailable", reason: "source_unavailable" } }, context()],
        [{ ...valid, candidate: { ...valid.candidate, available: false,
            sourceStatus: "unavailable", reason: "canonical_invalid" } }, context()],
        [{ ...valid, activeContract: "2026-10" }, context()],
        [{ ...valid, restored: true }, context()],
        [valid, context({ isCurrent: false })]
    ];
    for (const [source, guard] of cases) {
        const target = storage();
        const result = await Save.buildAndSaveQriOptionIvLastValid(target, source, guard);
        assert.deepEqual([result.saved, target.writes.length], [false, 0]);
    }
});
test("builder and validator failures are isolated", async () => {
    for (const [api, reason] of [[fakeCache({ async buildQriOptionIvLastValidCache() {
        throw Error("build"); } }), "cache_builder_error"],
    [fakeCache({ async validateQriOptionIvLastValidCache() { return false; } }),
        "cache_validation_failed"]]) {
        const target = storage(); const result = await browserStore(api)
            .buildAndSaveQriOptionIvLastValid(target, await input(), context());
        assert.deepEqual([result.reason, target.writes.length], [reason, 0]);
    }
});
test("serialization setItem and quota failures are isolated", async () => {
    const circular = {}; circular.self = circular;
    const api = browserStore(fakeCache({ async buildQriOptionIvLastValidCache() {
        return { success: true, cache: circular }; } }));
    const serialized = await api.buildAndSaveQriOptionIvLastValid(storage(), await input(), context());
    assert.equal(serialized.reason, "serialization_error");
    const write = await Save.buildAndSaveQriOptionIvLastValid({ setItem() { throw Error("quota"); } },
        await input(), context());
    assert.equal(write.reason, "storage_write_error");
});
test("same canonical refetch updates fetchedAt and signature with stable versionKey", async () => {
    const target = storage();
    const first = (await save(target)).result.cache;
    const second = (await save(target, {}, {}, undefined,
        "2026-08-24T08:00:00.000Z")).result.cache;
    assert.equal(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.equal(first.versionKey, second.versionKey);
    assert.notEqual(first.signature, second.signature);
    assert.equal(JSON.parse(target.values.get(KEY)).fetchedAt, "2026-08-24T08:00:00.000Z");
});
test("new canonical changes canonical and last-valid versionKey", async () => {
    const first = (await save()).result.cache;
    const second = (await save(storage(), {}, {}, page(row("40,000", "22%", "21%"), "01")))
        .result.cache;
    assert.notEqual(first.canonicalVersionKey, second.canonicalVersionKey);
    assert.notEqual(first.versionKey, second.versionKey);
});
test("request becoming stale during async build cannot write", async () => {
    const target = storage(); let checks = 0;
    const result = await Save.buildAndSaveQriOptionIvLastValid(target, await input(),
        context({ isCurrent: () => ++checks === 1 }));
    assert.deepEqual([result.reason, target.writes.length], ["stale_response", 0]);
});
test("only dedicated key changes; existing caches and unrelated entries stay intact", async () => {
    const entries = [["optionMapCurrentPriceLastValidV1", "price"],
        ["optionMapLastValidQriData", "oi"], ["unrelated", "keep"]];
    const target = storage(entries); const before = new Map(target.values);
    await save(target);
    for (const [key, value] of before) assert.equal(target.values.get(key), value);
    assert.deepEqual(target.writes.map(item => item[0]), [KEY]);
});
test("input runtime candidate and graph canonical remain unchanged", async () => {
    const source = await input(); const before = JSON.stringify(source);
    await Save.buildAndSaveQriOptionIvLastValid(storage(), source, context());
    assert.equal(JSON.stringify(source), before);
});
test("module has no IndexedDB history fetch UI Chart Mobile Overall timer or boot restore", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionIvLastValidStore.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|\bfetch\s*\(|History|document\.|querySelector|Chart/);
    assert.doesNotMatch(source, /Mobile|OverallV2|setTimeout|setInterval|readAndRestore/);
});
test("renderer wires only active adopted result with dependency order and no extra fetch", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const scripts = ["js/qriOptionIvRuntime.js", "js/qriOptionIvLastValidCache.js",
        "js/storage/qriOptionIvLastValidStore.js", "js/qriIvGraphView.js"];
    const positions = scripts.map(item => html.indexOf(`<script src="${item}"></script>`));
    assert.equal(positions.every(position => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const active = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("async function fetchParticipantData"));
    assert.match(active, /const ivAdoption = await adoptQriOptionIv\("active"/);
    assert.match(active, /ivAdoption\.adopted && ivAdoption\.status === "available"/);
    assert.match(active, /buildAndSaveQriOptionIvLastValid\(localStorage/);
    assert.equal((active.match(/optionMapBridge\.fetchQriOptionPage\(/g) || []).length, 1);
    const selected = html.slice(html.indexOf("async function fetchSelectedQriContract"),
        html.indexOf("async function updateQriContractManifest"));
    assert.equal(selected.includes("buildAndSaveQriOptionIvLastValid"), false);
    assert.doesNotMatch(html, /readAndRestoreQriOptionIvLastValid\s*\(/);
});
