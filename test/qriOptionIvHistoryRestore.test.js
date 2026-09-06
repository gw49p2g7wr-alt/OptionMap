"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Iv = require("../js/qriOptionIv.js");
const History = require("../js/qriOptionIvHistory.js");
const Restore = require("../js/qriOptionIvHistoryRestore.js");

function canonical(contract = "2026-10", tradingDate = "2026-09-07") {
    return { parserVersion: 1, schemaVersion: 1, source: Iv.SOURCE,
        sourceUrl: contract === "2026-09" ? "https://svc.qri.jp/jpx/nkopm/" :
            "https://svc.qri.jp/jpx/nkopm/1", valueUnit: "percent_points", contract,
        tradingDate, pageUpdatedAt: `${tradingDate}T09:30:00+09:00`,
        lastTradingDate: `${contract}-10`, records: [
            { optionType: "call", strike: 40000,
                iv: { status: "available", value: 20, sourceFormat: "plain_number" } },
            { optionType: "put", strike: 40000,
                iv: { status: "available", value: 21, sourceFormat: "plain_number" } }
        ] };
}
async function entry(roles = ["next"], contract = "2026-10", tradingDate = "2026-09-07") {
    let history = History.createEmptyHistory();
    for (const [index, role] of roles.entries()) {
        const built = await History.createHistoryCandidate(canonical(contract, tradingDate), {
            acquisitionRole: role, parentMarketRefreshRequestId: "market-1",
            requestId: `${role}-1`, acquisitionGeneration: index + 1,
            formalPublicationGeneration: 4, parentOptionsVersionKey: "parent-v1",
            fetchedAt: "2026-09-07T01:00:00Z",
            confirmedAt: `2026-09-07T01:00:0${index + 1}Z`,
            formalStatus: "saved", origin: "formal_live"
        });
        history = (await History.mergeCandidate(history, built.candidate)).history;
    }
    return history.entries[0];
}
const context = (role = "next", contract = "2026-10", tradingDate = "2026-09-07") =>
    ({ role, contract, tradingDate, sourceUrl: contract === "2026-09"
        ? "https://svc.qri.jp/jpx/nkopm/" : "https://svc.qri.jp/jpx/nkopm/1" });
function storeFor(value, options = {}) {
    return { calls: [], async getEntry(contract, tradingDate) {
        this.calls.push([contract, tradingDate]);
        if (options.wait) await options.wait();
        return value ? { status: "available", reason: null, entry: structuredClone(value) }
            : { status: "unavailable", reason: "exact_entry_not_found", entry: null };
    } };
}

test("active, next and major_sq restore only their exact role confirmations", async () => {
    for (const [role, contract] of [["active", "2026-09"], ["next", "2026-10"],
        ["major_sq", "2026-12"]]) {
        const store = storeFor(await entry([role], contract));
        const runtime = Restore.createRuntime({ store, now: () => "2026-09-07T02:00:00Z" });
        const result = await runtime.restore(role, context(role, contract));
        assert.deepEqual([result.status, result.source.origin, result.source.sourceClass,
            result.source.formalStatus, result.source.role],
        ["available", "history", "formal_history", "verified", role]);
        assert.deepEqual(store.calls, [[contract, "2026-09-07"]]);
    }
});

test("exact contract/date misses never use another contract or old date", async () => {
    for (const requested of [context("next", "2026-11"),
        context("next", "2026-10", "2026-09-08")]) {
        const store = storeFor(null); const runtime = Restore.createRuntime({ store });
        assert.equal((await runtime.restore("next", requested)).status, "unavailable");
        assert.deepEqual(store.calls, [[requested.contract, requested.tradingDate]]);
    }
});

test("role confirmation mismatch rejects while one revision can serve next and major_sq", async () => {
    const nextOnly = Restore.createRuntime({ store: storeFor(await entry(["next"])) });
    assert.equal((await nextOnly.restore("major_sq", context("major_sq"))).reason,
        "role_confirmation_missing");
    const sharedEntry = await entry(["next", "major_sq"]);
    const shared = Restore.createRuntime({ store: storeFor(sharedEntry) });
    assert.equal((await shared.restore("next", context("next"))).status, "available");
    assert.equal((await shared.restore("major_sq", context("major_sq"))).status, "available");
});

test("signature, version, activeVersion and malformed revision fail closed", async () => {
    for (const mutate of [
        value => { value.revisions[0].signature = "0".repeat(64); },
        value => { value.revisions[0].versionKey += "x"; value.activeVersionKey += "x"; },
        value => { value.activeVersionKey = "missing"; },
        value => { value.revisions[0].canonical.records = []; }
    ]) {
        const value = structuredClone(await entry()); mutate(value);
        const result = await Restore.createRuntime({ store: storeFor(value) })
            .restore("next", context());
        assert.equal(result.status, "unavailable"); assert.equal(result.source, null);
    }
});

test("source URL mismatch fails closed", async () => {
    const runtime = Restore.createRuntime({ store: storeFor(await entry()) });
    const result = await runtime.restore("next", { ...context(),
        sourceUrl: "https://svc.qri.jp/jpx/nkopm/2" });
    assert.equal(result.reason, "source_url_mismatch");
});

test("incomplete role context remains deferred and performs no read", async () => {
    for (const incomplete of [null, {}, { contract: "2026-10" },
        { tradingDate: "2026-09-07" }]) {
        const store = storeFor(await entry()); const runtime = Restore.createRuntime({ store });
        assert.equal((await runtime.restore("next", incomplete)).status, "deferred");
        assert.equal(store.calls.length, 0);
    }
});

test("context change clears old source and stale async completion is ignored", async () => {
    let release; const store = storeFor(await entry(),
        { wait: () => new Promise(resolve => { release = resolve; }) });
    const runtime = Restore.createRuntime({ store });
    const pending = runtime.restore("next", context());
    while (!release) await new Promise(resolve => setImmediate(resolve));
    runtime.defer("next", "target_changed"); release();
    assert.equal((await pending).status, "stale_ignored");
    assert.deepEqual([runtime.getState().roles.next.status,
        runtime.getState().roles.next.source], ["deferred", null]);
});

test("one role read failure does not clear another role source", async () => {
    const majorEntry = await entry(["major_sq"], "2026-12");
    const store = { async getEntry(contract) {
        if (contract === "2026-10") return { status: "unavailable",
            reason: "indexeddb_transaction_failed", entry: null };
        return { status: "available", reason: null, entry: structuredClone(majorEntry) };
    } };
    const runtime = Restore.createRuntime({ store });
    assert.equal((await runtime.restore("next", context("next"))).status, "unavailable");
    assert.equal((await runtime.restore("major_sq", context("major_sq", "2026-12"))).status,
        "available");
    assert.deepEqual([runtime.getState().roles.next.status,
        runtime.getState().roles.major_sq.status], ["unavailable", "available"]);
});

test("repeated restore is deterministic, detached and deeply frozen", async () => {
    const value = await entry(); const runtime = Restore.createRuntime({
        store: storeFor(value), now: () => "2026-09-07T02:00:00Z" });
    const first = await runtime.restore("next", context());
    const second = await runtime.restore("next", context());
    assert.deepEqual({ ...first, generation: 0 }, { ...second, generation: 0 });
    assert.equal(Object.isFrozen(second.source.canonical.records), true);
    const state = runtime.getState(); assert.equal(Object.isFrozen(state.roles.next), true);
    assert.notStrictEqual(state.roles.next.source.canonical, value.revisions[0].canonical);
});

test("restore module is read-only and disconnected from live/calculation systems", () => {
    const source = fs.readFileSync("js/qriOptionIvHistoryRestore.js", "utf8");
    assert.doesNotMatch(source, /persistCandidate|commitHistory|setItem|removeItem|deleteDatabase/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|ipcRenderer|document\.|innerHTML|eval\s*\(|new Function/);
    assert.doesNotMatch(source, /OverallV2|Morning|Mobile|currentQriOptionIv/);
});
