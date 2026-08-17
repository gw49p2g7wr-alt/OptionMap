const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");
const historyApi = require("../js/weeklyOptionsHistory.js");
const comparisonApi = require("../js/weeklyOptionsHistoryComparison.js");
const viewApi = require("../js/weeklyOptionsHistoryComparisonView.js");

function rows(sourceDate, expiry, records) {
    const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    rows[0][0] = weekly.SOURCE_TITLE;
    rows[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    rows[2][0] = `${year}年${month}月10日`;
    rows[6][1] = `プット（${expiryYear}年${expiryMonth}月限月）`;
    rows[6][11] = `コール（${expiryYear}年${expiryMonth}月限月）`;
    weekly.BLOCK_START_ROWS.forEach((start, block) => {
        rows[start - 1][1] = rows[start - 1][11] = 65000 + block * 125;
        for (let rank = 1; rank <= 15; rank += 1) {
            rows[start + rank - 2][0] = rows[start + rank - 2][10] = rank;
        }
    });
    for (const record of records) {
        const block = (record.strike - 65000) / 125;
        const row = rows[weekly.BLOCK_START_ROWS[block] + record.rank - 2];
        const strikeColumn = record.optionType === "put" ? 1 : 11;
        const offset = record.side === "sell" ? 1 : 4;
        row[strikeColumn + offset] = record.participantCode;
        row[strikeColumn + offset + 1] = record.broker;
        row[strikeColumn + offset + 2] = record.value;
    }
    return rows;
}
async function candidate(sourceDate, expiry, records, officialRefetch = false) {
    const data = weekly.parseWeeklyOptionsRows(rows(sourceDate, expiry, records));
    const signature = await weekly.createSignature(data);
    const compact = sourceDate.replaceAll("-", "");
    const cache = { version: 2, parserVersion: 2, schemaVersion: 2,
        source: "jpx-weekly-nikkei225-options-open-interest",
        sourceDate, sourceDateKind: "jpx_open_interest_as_of",
        publishedDate: data.publishedDate, publishedAt: null,
        listingUpdatedAt: `${sourceDate}T15:31:00+09:00`,
        listingUpdatedAtKind: "jpx_listing_updated_at",
        listingUrl: `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_${sourceDate.slice(0, 4)}.json`,
        fetchedAt: `${sourceDate}T07:00:00.000Z`,
        sourceUrl: `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/${sourceDate.slice(0, 4)}/${compact}_nk225op_oi_by_tp.xlsx`,
        signatureAlgorithm: "sha256", signature,
        versionKey: `weekly-options-v2|${sourceDate}|sha256:${signature}`,
        dateEvidence: { excelAsOf: sourceDate, listingTradeDate: sourceDate,
            urlDate: sourceDate, consistent: true },
        versionAssessment: "confirmed", currentOfficialRefetch: officialRefetch, data };
    return (await historyApi.createWeeklyOptionsHistoryCandidate(cache)).candidate;
}
async function history(candidates) {
    let value = historyApi.createEmptyWeeklyOptionsHistory();
    for (const item of candidates) value = (await historyApi.mergeWeeklyOptionsHistory(
        value, item, { confirmedAt: "2026-08-20T00:00:00.000Z" }
    )).history;
    return value;
}
const previousRecords = [
    { optionType: "put", side: "sell", strike: 65000, rank: 1,
        participantCode: "001", broker: "Ａ証券", value: 100 },
    { optionType: "call", side: "buy", strike: 65000, rank: 1,
        participantCode: "002", broker: "Ｂ証券", value: 200 }
];
const currentRecords = [
    { optionType: "put", side: "sell", strike: 65000, rank: 1,
        participantCode: "001", broker: "Ａ証券", value: 150 },
    { optionType: "put", side: "buy", strike: 65125, rank: 1,
        participantCode: "003", broker: "Ｃ証券", value: 300 }
];

test("正式history 0週・1週は推測比較しない", async () => {
    assert.equal((await comparisonApi.compareLatestWeeklyOptionsHistory(
        historyApi.createEmptyWeeklyOptionsHistory())).status, "unavailable");
    const one = await history([await candidate("2026-08-07", "2026-08", currentRecords)]);
    const result = await comparisonApi.compareLatestWeeklyOptionsHistory(one);
    assert.equal(result.status, "waiting_previous");
    assert.equal(result.changes, null);
});

test("最新2週active revisionだけをsourceDate順に比較", async () => {
    const old = await candidate("2026-07-24", "2026-08", previousRecords);
    const previous = await candidate("2026-07-31", "2026-08", previousRecords);
    const current = await candidate("2026-08-07", "2026-08", currentRecords);
    const revised = await candidate("2026-08-07", "2026-08", [
        { ...currentRecords[0], value: 175 }, currentRecords[1]
    ], true);
    const value = await history([current, old, previous, revised]);
    const result = await comparisonApi.compareLatestWeeklyOptionsHistory(value);
    assert.equal(result.previousSourceDate, "2026-07-31");
    assert.equal(result.currentSourceDate, "2026-08-07");
    const putSell = result.changes.strikeChanges.find(item =>
        item.optionType === "put" && item.side === "sell" && item.strike === 65000);
    assert.equal(putSell.delta, 75);
    assert.equal(result.currentVersionKey, revised.versionKey);
});

test("CALL/PUT・sell/buy・participantCodeを分離し非掲載を0補完しない", async () => {
    const value = await history([
        await candidate("2026-07-31", "2026-08", previousRecords),
        await candidate("2026-08-07", "2026-08", currentRecords)
    ]);
    const result = await comparisonApi.compareLatestWeeklyOptionsHistory(value);
    const disappeared = result.changes.participantChanges.find(item =>
        item.participantCode === "002" && item.optionType === "call" && item.side === "buy");
    const newly = result.changes.participantChanges.find(item =>
        item.participantCode === "003" && item.optionType === "put" && item.side === "buy");
    assert.equal(disappeared.status, "disappeared");
    assert.equal(disappeared.current.value, null);
    assert.equal(disappeared.delta, null);
    assert.equal(newly.status, "newly_published");
    assert.equal(newly.previous.value, null);
    assert.equal(newly.delta, null);
    assert.ok(result.changes.strikeChanges.some(item => item.status === "unobserved"));
});

test("限月切替は数量比較を拒否し画面警告を生成", async () => {
    const value = await history([
        await candidate("2026-07-03", "2026-07", previousRecords),
        await candidate("2026-07-10", "2026-08", currentRecords)
    ]);
    const result = await comparisonApi.compareLatestWeeklyOptionsHistory(value);
    assert.equal(result.status, "roll_transition");
    assert.equal(result.changes.strikeChanges.length, 0);
    const view = viewApi.createHistoryComparisonView(result);
    assert.match(view.message, /限月切替/);
});

test("壊れたhistory/revisionを拒否", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", currentRecords)]);
    value.entries[0].revisions[0].canonical.records[0].value = -1;
    const result = await comparisonApi.compareLatestWeeklyOptionsHistory(value);
    assert.equal(result.status, "invalid");
    assert.equal(result.changes, null);
});
