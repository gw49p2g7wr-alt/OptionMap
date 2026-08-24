const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Iv = require("../js/qriOptionIv.js");
const Cache = require("../js/qriOptionIvLastValidCache.js");
const Store = require("../js/storage/qriOptionIvLastValidReadOnlyStore.js");
const KEY = "optionMapQriOptionIvLastValidV1";

async function serialized() {
    const canonical = Iv.parseQriOptionIvPage(`<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
      <dt>取引日</dt><dd>2026/08/24</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
      <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table><tr class="row-num">${
        Array(17).fill("-").map((value, index) => `<td>${index === 8 ? "40,000" : value}</td>`).join("")
      }</tr></table>`, "https://svc.qri.jp/jpx/nkopm/");
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
    return { values, calls, getItem(key) { calls.push(key); return values.has(key) ? values.get(key) : null; } };
}
function fingerprint(source) {
    return crypto.createHash("sha256").update(JSON.stringify([...source.values])).digest("hex");
}
test("adapter exposes and reads only the dedicated fixed key", async () => {
    const source = storage([[KEY, await serialized()], ["arbitrary", "secret"]]);
    Store.readQriOptionIvLastValidSerialized(source, "arbitrary");
    assert.equal(Store.STORAGE_KEY, KEY); assert.deepEqual(source.calls, [KEY]);
});
test("valid serialized value restores through delegated modules", async () => {
    const result = await Store.readAndRestoreQriOptionIvLastValid(storage([[KEY, await serialized()]]));
    assert.deepEqual([result.status, result.restore.success, result.cache.canonical.contract],
        ["restored", true, "2026-09"]);
});
test("missing fixed key is normal", () => {
    const result = Store.readQriOptionIvLastValidSerialized(storage());
    assert.deepEqual([result.status, result.reason, result.serialized], ["missing", null, null]);
});
test("null storage missing getItem and getItem throw are contained", () => {
    assert.equal(Store.readQriOptionIvLastValidSerialized(null).reason, "storage_unavailable");
    assert.equal(Store.readQriOptionIvLastValidSerialized({}).reason, "storage_unavailable");
    assert.equal(Store.readQriOptionIvLastValidSerialized({ getItem() { throw Error("x"); } }).reason,
        "storage_read_error");
});
test("malformed and tampered values are invalid without repair", async () => {
    assert.equal((await Store.readAndRestoreQriOptionIvLastValid(storage([[KEY, "{"]]))).status,
        "invalid");
    const changed = JSON.parse(await serialized()); changed.signature = "0".repeat(64);
    assert.equal((await Store.readAndRestoreQriOptionIvLastValid(
        storage([[KEY, JSON.stringify(changed)]]))).status, "invalid");
});
test("read and restore leave storage entries count and fingerprint unchanged", async () => {
    const source = storage([[KEY, await serialized()], ["keep", "value"]]);
    const before = [source.values.size, JSON.stringify([...source.values]), fingerprint(source)];
    await Store.readAndRestoreQriOptionIvLastValid(source);
    assert.deepEqual([source.values.size, JSON.stringify([...source.values]), fingerprint(source)], before);
});
test("write capabilities are never requested", async () => {
    const source = storage([[KEY, await serialized()]]);
    source.setItem = () => { throw Error("write"); };
    source.removeItem = () => { throw Error("remove"); };
    source.clear = () => { throw Error("clear"); };
    assert.equal((await Store.readAndRestoreQriOptionIvLastValid(source)).status, "restored");
});
test("store has no writes arbitrary keys IndexedDB runtime history UI fetch or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/qriOptionIvLastValidReadOnlyStore.js"), "utf8");
    assert.doesNotMatch(source, /setItem|removeItem|\.clear\s*\(|indexedDB|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /currentQriOptionIv|History|document\.|querySelector|Chart|OverallV2/);
    assert.doesNotMatch(source, /optionMapCurrentPrice|optionMapQriOptions/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionIvLastValidReadOnlyStore.js"), true);
    assert.doesNotMatch(html, /OptionMapQriOptionIvLastValidReadOnlyStore\s*\.\s*(setItem|removeItem|clear)/);
});
