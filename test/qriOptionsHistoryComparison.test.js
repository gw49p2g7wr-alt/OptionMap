const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const qri = require("../js/qriOptions.js");
const historyApi = require("../js/qriOptionsHistory.js");
const comparison = require("../js/qriOptionsHistoryComparison.js");
const viewApi = require("../js/qriOptionsHistoryComparisonView.js");

const url = "https://svc.qri.jp/jpx/nkopm/";
function canonical({ contract = "2026-09", date = "2026-08-18",
    updated = "2026-08-18T06:00:00+09:00", values = {} } = {}) {
    const month = Number(contract.slice(5));
    const all = new Set([40000, 40500, 41000, 41500,
        ...Object.keys(values.call || {}).map(Number), ...Object.keys(values.put || {}).map(Number)]);
    const records = [];
    for (const strike of [...all].sort((a, b) => a - b)) {
        for (const optionType of ["call", "put"]) {
            const supplied = Object.hasOwn(values[optionType] || {}, strike);
            const fallback = optionType === "call" && strike === 40000 ? 10
                : optionType === "put" && strike === 40000 ? 20 : null;
            const value = supplied ? values[optionType][strike] : fallback;
            records.push({ contract, optionType, strike,
                published: value !== null, value });
        }
    }
    return { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
        sourceUrl: url, pageUpdatedAt: updated, tradingDate: date,
        openInterestAsOf: null, contract, gengetsu: contract.replace("-", ""),
        contractLabel: `${month}月限月`, isActiveContract: true,
        lastTradingDate: `${contract}-10`, openInterestStatus: "available",
        availableContracts: [{ contract, label: `${month}月限月`, url, active: true }], records };
}
async function candidate(options, confirmedAt) {
    const data = canonical(options);
    const cache = await qri.createCacheV2(data, confirmedAt);
    return (await historyApi.createHistoryCandidate(cache)).candidate;
}
async function add(history, options, confirmedAt) {
    return (await historyApi.mergeCandidate(history,
        await candidate(options, confirmedAt), { confirmedAt })).history;
}
async function twoDayHistory() {
    let history = historyApi.createEmptyQriOptionsHistory();
    history = await add(history, { date: "2026-08-14", updated: "2026-08-14T06:00:00+09:00",
        values: { call: { 40000: 0, 40500: 100, 41000: 30 },
            put: { 40000: 20, 40500: null, 41000: 80 } } }, "2026-08-14T08:00:00Z");
    history = await add(history, { date: "2026-08-18", updated: "2026-08-18T06:00:00+09:00",
        values: { call: { 40000: 50, 40500: null, 41000: 20, 41500: 200 },
            put: { 40000: 20, 40500: 60, 41000: 100 } } }, "2026-08-18T08:00:00Z");
    return history;
}

test("history 0日とcontract別historyなしを推測比較しない", async () => {
    const history = historyApi.createEmptyQriOptionsHistory();
    assert.equal((await comparison.compareLatestSavedDates(history, "2026-09")).reason,
        "history_empty_for_contract");
    assert.equal(viewApi.createView(await comparison.compareLatestSavedDates(history, "2026-10")).message,
        "2026-10の正式historyはまだありません。");
});

test("history 1日は1日分保存済み・前回比較なし", async () => {
    let history = historyApi.createEmptyQriOptionsHistory();
    history = await add(history, { date: "2026-08-18" }, "2026-08-18T08:00:00Z");
    const result = await comparison.compareLatestSavedDates(history, "2026-09");
    assert.equal(result.status, "waiting_previous");
    assert.equal(viewApi.createView(result).message, "1日分保存済み・前回比較なし");
});

test("連続営業日を推測せず保存済み最新2日を選ぶ", async () => {
    const result = await comparison.compareLatestSavedDates(await twoDayHistory(), "2026-09");
    assert.equal(result.status, "comparable");
    assert.equal(result.previousSourceDate, "2026-08-14");
    assert.equal(result.currentSourceDate, "2026-08-18");
    assert.equal(viewApi.createView(result).comparisonLabel, "2026/08/14 → 2026/08/18");
});

test("CALLとPUTを分離しcomparable/previous_only/current_only/unobservedを保持", async () => {
    const result = await comparison.compareLatestSavedDates(await twoDayHistory(), "2026-09");
    const call = result.comparison.byType.call;
    const put = result.comparison.byType.put;
    assert.equal(call.records.find(item => item.strike === 40000).status, "comparable");
    assert.equal(call.records.find(item => item.strike === 40500).status, "previous_only");
    assert.equal(call.records.find(item => item.strike === 41500).status, "current_only");
    assert.equal(call.records.find(item => item.strike === 40500).delta, null);
    assert.equal(put.records.find(item => item.strike === 41500).status, "unobserved");
    assert.equal(call.summary.comparableCount, 2);
    assert.equal(put.summary.comparableCount, 2);
});

test("previous 0はdeltaを計算するがpercentChangeはnull", async () => {
    const result = await comparison.compareLatestSavedDates(await twoDayHistory(), "2026-09");
    const item = result.comparison.byType.call.records.find(record => record.strike === 40000);
    assert.equal(item.delta, 50);
    assert.equal(item.percentChange, null);
});

test("positive/negative/zeroとTOPをcomparableだけから集計", async () => {
    const result = await comparison.compareLatestSavedDates(await twoDayHistory(), "2026-09");
    const call = result.comparison.byType.call.summary;
    const put = result.comparison.byType.put.summary;
    assert.equal(call.increaseCount, 1);
    assert.equal(call.decreaseCount, 1);
    assert.equal(put.unchangedCount, 1);
    assert.deepEqual(call.topIncreases.map(item => item.strike), [40000]);
    assert.deepEqual(call.topDecreases.map(item => item.strike), [41000]);
    assert.equal(call.topIncreases.some(item => item.strike === 41500), false);
    assert.equal(call.absoluteDeltaTotal, 60);
});

test("同日old revisionを除外しactive revisionだけを比較", async () => {
    let history = await twoDayHistory();
    history = await add(history, { date: "2026-08-18", updated: "2026-08-18T06:05:00+09:00",
        values: { call: { 40000: 70 }, put: { 40000: 20 } } }, "2026-08-18T08:05:00Z");
    const entry = history.entries.find(item => item.sourceDateKey === "2026-08-18");
    assert.equal(entry.revisions.length, 2);
    const result = await comparison.compareLatestSavedDates(history, "2026-09");
    assert.equal(result.currentVersionKey, entry.activeVersionKey);
    assert.equal(result.comparison.byType.call.records.find(item => item.strike === 40000)
        .current.value, 70);
});

test("contract別に分離し他contractへfallbackしない", async () => {
    const history = await twoDayHistory();
    const result = await comparison.compareLatestSavedDates(history, "2026-10");
    assert.equal(result.status, "unavailable");
    assert.equal(result.contract, "2026-10");
});

test("invalid active revision、unavailable、contract mismatchを拒否", async () => {
    const history = await twoDayHistory();
    const invalid = structuredClone(history); invalid.entries.at(-1).activeVersionKey = "missing";
    assert.equal((await comparison.compareLatestSavedDates(invalid, "2026-09")).status, "invalid");
    const previous = history.entries[0].revisions[0];
    const current = structuredClone(history.entries[1].revisions[0]);
    current.openInterestStatus = "unavailable";
    assert.equal(comparison.compareRevisions(previous, current, { contract: "2026-09" }).reason,
        "open_interest_unavailable");
    assert.equal(comparison.compareRevisions(previous, current, { contract: "2026-10" }).reason,
        "contract_mismatch");
});

test("stale contract/sequence resultを拒否", () => {
    assert.equal(comparison.isCurrentResult({ requestedContract: "2026-09",
        currentContract: "2026-10", sequence: 1, currentSequence: 2,
        result: { contract: "2026-09" } }), false);
    assert.equal(comparison.isCurrentResult({ requestedContract: "2026-09",
        currentContract: "2026-09", sequence: 2, currentSequence: 2,
        result: { contract: "2026-09" } }), true);
});

test("UI接続は正式history読取専用でlegacy差分・snapshot・判定へ接続しない", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const block = html.slice(html.indexOf("async function renderQriOptionsHistoryComparison"),
        html.indexOf("async function renderQriOptionsHistoryStatus"));
    assert.match(block, /OptionMapQriOptionsHistoryStore\.loadHistory/);
    assert.doesNotMatch(block, /createDifferenceData|optionMapJpxSnapshots|localStorage|overallJudgment/);
    const selection = html.slice(html.indexOf('qriContractSelect\?\.addEventListener("change"'),
        html.indexOf("window.getQriContractSelectionState"));
    assert.match(selection, /renderQriOptionsHistoryComparison/);
    assert.doesNotMatch(selection, /persistQriOptionsHistory/);
});
