const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const diagnostic = require(
    "../js/weeklyFuturesHistoryReadOnlyDiagnostic.js"
);

function data(value = 100) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...Object.entries(weekly.CORE_BROKERS).map(([_key, broker], index) => [
            index + 1,
            "2026年09月限月",
            null,
            null,
            null,
            String(11700 + index),
            broker,
            value + index
        ])
    ]);
}

async function candidate(sourceDate) {
    const input = data();
    const signature = await weekly.createSignature(input);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/2026/${compact}_indexfut_oi_by_tp.xlsx`;
    return {
        sourceDate,
        sourceUrl,
        fetchedAt: "2026-08-20T01:00:00.000Z",
        signature,
        versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`,
        data: input,
        officialMetadata: {
            origin: "jpx_open_interest_year_listing",
            listingUrl: "https://www.jpx.co.jp/automation/markets/" +
                "derivatives/open-interest/json/open_interest_2026.json",
            listingUpdatedAt: "2026-08-20T10:00:00+09:00",
            tradeDate: sourceDate,
            indexFuturesUrl: sourceUrl,
            publishedDate: "2026-08-20",
            currentOfficialRefetch: true,
            dateEvidence: {
                listingTradeDate: sourceDate,
                excelSourceDate: sourceDate,
                urlDate: sourceDate,
                consistent: true
            }
        }
    };
}

async function history() {
    return (await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        [await candidate("2026-08-07"), await candidate("2026-08-14")],
        "2026-08-20T01:05:00.000Z"
    )).history;
}

function storageWith(serialized, otherValues = {}) {
    const values = new Map([
        [diagnostic.STORAGE_KEY, serialized],
        ...Object.entries(otherValues)
    ]);
    const calls = { get: [], set: 0, remove: 0, clear: 0 };
    return {
        calls,
        values,
        getItem(key) {
            calls.get.push(key);
            return values.has(key) ? values.get(key) : null;
        },
        setItem() { calls.set += 1; },
        removeItem() { calls.remove += 1; },
        clear() { calls.clear += 1; }
    };
}

test("正式historyを固定keyからreadし既存validatorで検証する", async () => {
    const original = await history();
    const storage = storageWith(JSON.stringify(original));
    const result = await diagnostic.listWeeklyFuturesHistoryReadOnly(storage);
    assert.equal(result.status, "ready");
    assert.equal(result.valid, true);
    assert.equal(result.entryCount, 2);
    assert.equal(result.revisionCount, 2);
    assert.deepEqual(result.sourceDates, ["2026-08-07", "2026-08-14"]);
    assert.deepEqual(result.history, original);
    assert.equal(result.history.version, original.version);
    assert.equal(result.history.schemaVersion, weekly.SCHEMA_VERSION);
    assert.equal(result.history.parserVersion, weekly.PARSER_VERSION);
    assert.deepEqual(storage.calls.get, [diagnostic.STORAGE_KEY]);
});

test("empty historyをvalidなread-only snapshotとして返す", async () => {
    const storage = storageWith(null);
    const result = await diagnostic.listWeeklyFuturesHistoryReadOnly(storage);
    assert.equal(result.status, "empty");
    assert.equal(result.valid, true);
    assert.equal(result.entryCount, 0);
    assert.equal(result.revisionCount, 0);
    assert.deepEqual(result.sourceDates, []);
    assert.deepEqual(result.history, historyApi.createEmptyHistory());
});

test("返却値はdeep cloneかつdeep freezeされ保存元と隔離される", async () => {
    const original = await history();
    const serialized = JSON.stringify(original);
    const storage = storageWith(serialized);
    const result = await diagnostic.listWeeklyFuturesHistoryReadOnly(storage);
    assert.notEqual(result.history, original);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.history));
    assert.ok(Object.isFrozen(result.history.entries));
    assert.throws(() => {
        "use strict";
        result.history.entries.push({ sourceDate: "2099-01-01" });
    }, TypeError);
    assert.equal(storage.values.get(diagnostic.STORAGE_KEY), serialized);
    assert.deepEqual(original, JSON.parse(serialized));
});

test("read前後で全storage値と件数を変更しない", async () => {
    const original = await history();
    const storage = storageWith(JSON.stringify(original), {
        optionMapMorningBaseline: "morning-fingerprint",
        optionMapObservationHistory: "observation-fingerprint",
        unrelatedIndexedDbFingerprint: "indexeddb-fingerprint"
    });
    const before = [...storage.values.entries()];
    await diagnostic.listWeeklyFuturesHistoryReadOnly(storage);
    assert.deepEqual([...storage.values.entries()], before);
    assert.deepEqual(storage.calls, {
        get: [diagnostic.STORAGE_KEY], set: 0, remove: 0, clear: 0
    });
});

test("invalid historyをrepair・migrationせず拒否する", async () => {
    const malformed = JSON.stringify({ version: 999, entries: [] });
    const storage = storageWith(malformed);
    const result = await diagnostic.listWeeklyFuturesHistoryReadOnly(storage);
    assert.equal(result.status, "invalid");
    assert.equal(result.valid, false);
    assert.equal(result.history, null);
    assert.equal(storage.values.get(diagnostic.STORAGE_KEY), malformed);
    assert.equal(storage.calls.set, 0);
});

test("moduleはfetch・write・shadow・overallV2・UIから隔離される", () => {
    const overallV2 = require("../js/overallJudgmentV2.js");
    const moduleText = fs.readFileSync(
        require.resolve("../js/weeklyFuturesHistoryReadOnlyDiagnostic.js"),
        "utf8"
    );
    const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
    assert.doesNotMatch(moduleText,
        /\bfetch\s*\(|setItem|removeItem|\.clear\s*\(|indexedDB|ipcRenderer/);
    assert.doesNotMatch(moduleText,
        /TwelveGroupShadow|overallJudgmentV2|OverallV2|migration|backfill/);
    assert.doesNotMatch(moduleText,
        /textContent|innerHTML|appendChild|replaceChildren/);
    assert.equal(weekly.BROKER_SET_VERSION, 1);
    assert.equal(weekly.SCORING_VERSION, 2);
    assert.equal(overallV2.CONFIG.weights.weekly, 45);
    assert.equal(overallV2.CONFIG.weeklyNormalizationBase, 0.10);
    assert.match(html,
        /<script src="js\/weeklyFuturesHistoryReadOnlyDiagnostic\.js"><\/script>/);
    assert.doesNotMatch(html,
        /listWeeklyFuturesHistoryReadOnly\s*\([^)]*\)\s*;|HistoryReadOnlyDiagnostic\.[a-z]+\(/);
});

test("storage unavailableでも例外・writeなしで停止する", async () => {
    const result = await diagnostic.listWeeklyFuturesHistoryReadOnly({
        getItem() { throw new Error("denied"); }
    });
    assert.equal(result.status, "storage_unavailable");
    assert.equal(result.valid, false);
    assert.equal(result.history, null);
});
