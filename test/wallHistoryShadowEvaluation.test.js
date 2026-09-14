"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Evaluation = require("../js/wallHistoryShadowEvaluation.js");
const Runtime = require("../js/wallHistoryShadowRuntime.js");

const sig = value => value.repeat(64);
function canonical(contract, date, records) { const month = Number(contract.slice(5)); return {
    parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options",
    sourceUrl: "https://svc.qri.jp/jpx/nkopm/", pageUpdatedAt: `${date}T06:00:00+09:00`,
    tradingDate: date, openInterestAsOf: null, contract, gengetsu: contract.replace("-", ""),
    contractLabel: `${month}月限月`, isActiveContract: true, lastTradingDate: `${contract}-10`,
    openInterestStatus: "available", availableContracts: [{ contract, label: `${month}月限月`,
        url: "https://svc.qri.jp/jpx/nkopm/", active: true }],
    records: records.map(record => ({ contract, ...record })) }; }
function revision(contract, date, version, records, marker) { return { contract, tradingDate: date,
    versionKey: version, signature: sig(marker), replacedAt: null, openInterestStatus: "available",
    pageUpdatedAt: `${date}T06:00:00+09:00`, canonical: canonical(contract, date, records) }; }
function fixture() { const contract = "2026-10", dates = ["2026-09-10", "2026-09-11", "2026-09-15"];
    const values = [[100, 200, null, 30], [300, 150, 10, 30], [250, 0, 50, null]];
    const entries = dates.map((date, index) => { const records = [
        { optionType: "call", strike: 64000, published: true, value: values[index][0] },
        { optionType: "call", strike: 64500, published: true, value: values[index][1] },
        { optionType: "put", strike: 64000, published: values[index][2] !== null, value: values[index][2] },
        { optionType: "put", strike: 64500, published: values[index][3] !== null, value: values[index][3] }];
        const rev = revision(contract, date, `oi-${index}`, records, String.fromCharCode(97 + index));
        return { entryKey: `${contract}|${date}`, contract, sourceDateKey: date,
            activeVersionKey: rev.versionKey, firstSeenAt: `${date}T08:00:00Z`,
            lastSeenAt: `${date}T08:00:00Z`, revisions: [rev] }; });
    const ivEntries = dates.slice(1).map((date, index) => ({ entryKey: `${contract}|${date}`, contract,
        tradingDate: date, activeVersionKey: `iv-${index}`, revisions: [{ versionKey: `iv-${index}`,
            replacedAt: null, canonical: { records: [
                { optionType: "call", strike: 64000, iv: { status: "available", value: 20 + index } },
                { optionType: "put", strike: 64000, iv: { status: "missing", value: null } }] } }] }));
    const last = entries.at(-1).revisions[0]; return { qriOptionsHistory: { historyVersion: 1,
        parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options", signatureAlgorithm: "sha256",
        createdAt: "2026-09-10T08:00:00Z", updatedAt: "2026-09-15T08:00:00Z", entries },
        qriOptionIvHistory: { entries: ivEntries }, priceSnapshots: [{ price: 63800, contract,
            tradingDate: dates.at(-1), observedAt: "2026-09-15T08:00:00Z", snapshotId: "price-1",
            quotedAtNormalized: "2026-09-15T07:59:00Z", sourceVersionReference: { contract,
                tradingDate: dates.at(-1), versionKey: last.versionKey, signature: last.signature } }] }; }

test("代表カテゴリと人間確認用の完全なwall diagnosticを生成", async () => {
    const result = await Evaluation.evaluate(fixture());
    for (const category of ["longestCall", "longestPut", "rankedTop3", "largestGrowth",
        "largestShrink", "zeroConfirmed", "ivJoined", "ivMissing", "referenceJoined",
        "referenceMissing", "crossesGap"]) assert.ok(result.representatives[category].length > 0, category);
    const sample = result.representatives.longestCall[0];
    assert.ok(sample.wallIdentity); assert.ok(sample.observedPeriod.from); assert.ok(sample.firstSeen);
    assert.ok(sample.observations.every(item => Object.hasOwn(item, "previousObservationDelta") &&
        Object.hasOwn(item, "rankChange") && Object.hasOwn(item, "ivChange") &&
        Object.hasOwn(item, "priceDistance") && Object.hasOwn(item, "sourceRevision")));
});

test("既存保存履歴、最大建玉、前回比較と完全一致", async () => {
    const result = await Evaluation.evaluate(fixture());
    assert.equal(result.consistency.historical.mismatchCount, 0);
    assert.equal(result.consistency.maximum.mismatchCount, 0);
    assert.equal(result.consistency.previousComparison.mismatchCount, 0);
    assert.equal(result.betaAssessment.worthShowing, true);
});

test("前回比較で当日レコード自体がない壁はmissingのまま一致扱い", async () => {
    const input = fixture();
    const latest = input.qriOptionsHistory.entries.at(-1);
    const revision = latest.revisions.find(item => item.versionKey === latest.activeVersionKey);
    revision.canonical.records = revision.canonical.records.filter(record =>
        !(record.optionType === "call" && record.strike === 64000));
    revision.versionKey = "oi-latest-absent";
    revision.signature = sig("z");
    latest.activeVersionKey = revision.versionKey;
    const result = await Evaluation.evaluate(input);
    assert.equal(result.consistency.previousComparison.mismatchCount, 0);
    const wall = result.projection.walls.find(item => item.side === "call" && item.strike === 64000);
    assert.equal(wall.observations.at(-1).state, "missing");
    assert.equal(wall.observations.at(-1).openInterest, null);
    assert.equal(wall.observations.at(-1).previousObservationDelta, null);
});

function openDb(name, version, upgrade) { return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function txDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error); tx.onerror = () => undefined; }); }
async function seed() { const source = fixture();
    const oi = await openDb("optionMapQriOptionsHistory", 1, db => {
        db.createObjectStore("qriOptionsHistoryMeta", { keyPath: "id" });
        db.createObjectStore("qriOptionsEntries", { keyPath: "entryKey" });
        db.createObjectStore("qriOptionsRevisions", { keyPath: "revisionKey" }); });
    let tx = oi.transaction(["qriOptionsHistoryMeta", "qriOptionsEntries", "qriOptionsRevisions"], "readwrite");
    const meta = { ...source.qriOptionsHistory, id: "history" }; delete meta.entries;
    tx.objectStore("qriOptionsHistoryMeta").add(meta);
    for (const entry of source.qriOptionsHistory.entries) { const stored = { ...entry }; delete stored.revisions;
        tx.objectStore("qriOptionsEntries").add(stored); for (const rev of entry.revisions)
            tx.objectStore("qriOptionsRevisions").add({ ...rev, entryKey: entry.entryKey,
                revisionKey: `${entry.entryKey}|${rev.versionKey}` }); } await txDone(tx); oi.close();
    const iv = await openDb("optionMapQriOptionIvHistory", 1, db => {
        db.createObjectStore("qriOptionIvHistoryMeta", { keyPath: "id" });
        db.createObjectStore("qriOptionIvEntries", { keyPath: "entryKey" });
        db.createObjectStore("qriOptionIvRevisions", { keyPath: "revisionKey" }); });
    tx = iv.transaction(["qriOptionIvHistoryMeta", "qriOptionIvEntries", "qriOptionIvRevisions"], "readwrite");
    tx.objectStore("qriOptionIvHistoryMeta").add({ id: "history" });
    for (const entry of source.qriOptionIvHistory.entries) { const stored = { ...entry }; delete stored.revisions;
        tx.objectStore("qriOptionIvEntries").add(stored); for (const rev of entry.revisions)
            tx.objectStore("qriOptionIvRevisions").add({ ...rev, entryKey: entry.entryKey,
                revisionKey: `${entry.entryKey}|${rev.versionKey}` }); } await txDone(tx); iv.close();
    const prices = await openDb("optionMapPriceSnapshots", 1, db => db.createObjectStore("snapshots",
        { keyPath: "snapshotId" })); tx = prices.transaction("snapshots", "readwrite");
    source.priceSnapshots.forEach(item => tx.objectStore("snapshots").add(item)); await txDone(tx); prices.close();
}

test("実DB runtimeは既存DBをreadonlyで読みshadow diagnostics getterへ公開", async () => {
    await seed(); const result = await Runtime.run({ indexedDB });
    assert.equal(result.status, "ready"); assert.equal(result.indexedDbUpgradeAttempted, false);
    assert.equal(result.evaluation.betaAssessment.worthShowing, true);
    assert.deepEqual(Runtime.getDiagnostics(), result);
});

test("UI、write、Full Export、Overall、Morningへ接続しない", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    assert.match(html, /wallHistoryShadowEvaluation\.js[\s\S]*wallHistoryShadowRuntime\.js/);
    for (const file of ["js/fullExportCollector.js", "js/overallJudgmentV2.js", "js/morningBaselineV4.js",
        "js/morningBaselineV5.js", "js/script.js"]) assert.doesNotMatch(
            fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /WallHistoryShadow/);
    const runtime = fs.readFileSync(path.join(__dirname, "..", "js/wallHistoryShadowRuntime.js"), "utf8");
    assert.doesNotMatch(runtime, /readwrite|objectStore\([^)]*\)\.(?:add|put|delete|clear)\(/);
});
