const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Qri = require("../js/qriOptions.js");
const Cache = require("../js/qriOptionsLastValidCache.js");
const Store = require("../js/storage/qriOptionsLastValidReadOnlyStore.js");
const KEY = "optionMapQriOptionsLastValidV1";

async function serialized() {
    const cells = Array(17).fill("－"); cells[1] = "100"; cells[8] = "65,000"; cells[15] = "200";
    const canonical = Qri.parseQriOptionsPage(`<dt>最終更新時刻</dt><dd>2026/08/25 05:50</dd>
      <div id="futuresContractTab"><li class="active"><a>9月限月</a></li></div>
      <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table><tr class="row-num">${
        cells.map(value => `<td>${value}</td>`).join("")}</tr></table>`,
    "https://svc.qri.jp/jpx/nkopm/");
    const fetchedAt = "2026-08-25T06:10:00.000Z";
    const formal = await Qri.createCacheV2(canonical, fetchedAt);
    const result = await Cache.buildQriOptionsLastValidCache({ channel: "active",
        mode: "auto", acquisitionOrigin: "live", isCurrent: true, available: true,
        sourceStatus: "acquired", status: "available", canonical,
        canonicalSignature: formal.signature, canonicalVersionKey: formal.versionKey,
        fetchedAt, activeContract: canonical.contract, responseContract: canonical.contract,
        requestContext: { channel: "active", mode: "auto", acquisitionOrigin: "live",
            requestId: "qri-1", requestedContract: "auto",
            responseContract: canonical.contract } });
    assert.equal(result.success, true); return JSON.stringify(result.cache);
}
function storage(entries = []) {
    const values = new Map(entries); const calls = [];
    return { values, calls, getItem(key) {
        calls.push(key); return values.has(key) ? values.get(key) : null;
    } };
}
function fingerprint(source) {
    return crypto.createHash("sha256").update(JSON.stringify([...source.values])).digest("hex");
}

test("adapter exposes and reads only the dedicated fixed key", async () => {
    const source = storage([[KEY, await serialized()], ["arbitrary", "secret"]]);
    Store.readQriOptionsLastValidSerialized(source, "arbitrary");
    assert.equal(Store.STORAGE_KEY, KEY); assert.deepEqual(source.calls, [KEY]);
});

test("valid fixed-key value delegates restore and Freshness", async () => {
    const result = await Store.readAndRestoreQriOptionsLastValid(
        storage([[KEY, await serialized()]]));
    assert.deepEqual([result.status, result.restore.success, result.cache.canonical.contract],
        ["restored", true, "2026-09"]);
    assert.deepEqual([result.freshness.origin, result.freshness.displayEligible,
        result.freshness.calculationEligible], ["cache", true, "undetermined"]);
});

test("missing key including legacy-only storage is normal", () => {
    for (const source of [storage(), storage([["optionMapLastValidQriOpenInterest", "legacy"]])]) {
        const result = Store.readQriOptionsLastValidSerialized(source);
        assert.deepEqual([result.status, result.reason, result.serialized],
            ["missing", null, null]);
        assert.deepEqual(source.calls, [KEY]);
    }
});

test("null storage missing getItem and read exceptions are contained", () => {
    assert.equal(Store.readQriOptionsLastValidSerialized(null).reason, "storage_unavailable");
    assert.equal(Store.readQriOptionsLastValidSerialized({}).reason, "storage_unavailable");
    assert.equal(Store.readQriOptionsLastValidSerialized({ getItem() { throw Error("x"); } }).reason,
        "storage_read_error");
});

test("malformed and tampered values return invalid without repair", async () => {
    assert.equal((await Store.readAndRestoreQriOptionsLastValid(storage([[KEY, "{"]]))).status,
        "invalid");
    const changed = JSON.parse(await serialized()); changed.signature = "0".repeat(64);
    const result = await Store.readAndRestoreQriOptionsLastValid(
        storage([[KEY, JSON.stringify(changed)]]));
    assert.deepEqual([result.status, result.cache, result.canonical], ["invalid", null, null]);
});

test("read and restore do not alter entries count values or fingerprint", async () => {
    const source = storage([[KEY, await serialized()], ["keep", "value"]]);
    const before = [source.values.size, JSON.stringify([...source.values]), fingerprint(source)];
    await Store.readAndRestoreQriOptionsLastValid(source);
    assert.deepEqual([source.values.size, JSON.stringify([...source.values]), fingerprint(source)], before);
});

test("write capabilities are never requested and results are deeply frozen", async () => {
    const source = storage([[KEY, await serialized()]]);
    source.setItem = () => { throw Error("write"); };
    source.removeItem = () => { throw Error("remove"); };
    source.clear = () => { throw Error("clear"); };
    const result = await Store.readAndRestoreQriOptionsLastValid(source);
    assert.equal(result.status, "restored");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.canonical), true);
});

test("store has no writes IndexedDB history UI network or timer wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionsLastValidReadOnlyStore.js"), "utf8");
    assert.doesNotMatch(source, /setItem|removeItem|\.clear\s*\(|indexedDB|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /qriOptionsHistory|optionMapLastValidQriOpenInterest|document\.|Chart|OverallV2/);
    assert.doesNotMatch(source, /setTimeout|setInterval/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const restore = html.indexOf('<script src="js/qriOptionsLastValidRestore.js"></script>');
    const store = html.indexOf(
        '<script src="js/storage/qriOptionsLastValidReadOnlyStore.js"></script>');
    const shadow = html.indexOf('<script src="js/qriOptionsBootRestoreShadow.js"></script>');
    assert.equal(restore >= 0 && restore < store && store < shadow, true);
});
