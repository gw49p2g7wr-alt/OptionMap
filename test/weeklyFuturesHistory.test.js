const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");

function data(value = 100) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ["1", "2026年09月限月", "11714", "ＪＰモルガン証券", value]
    ]);
}

async function candidate(sourceDate, value = 100, fetchedAt = "2026-08-10T07:00:00.000Z") {
    const canonical = data(value);
    const signature = await weekly.createSignature(canonical);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/${sourceDate.slice(0, 4)}/` +
        `${compact}_indexfut_oi_by_tp.xlsx`;
    return {
        sourceDate, sourceUrl, fetchedAt, signature,
        versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`,
        data: canonical,
        officialMetadata: {
            origin: "jpx_open_interest_year_listing",
            listingUrl: `https://www.jpx.co.jp/automation/markets/derivatives/` +
                `open-interest/json/open_interest_${sourceDate.slice(0, 4)}.json`,
            listingUpdatedAt: "2026-08-10T15:31:00+09:00",
            tradeDate: sourceDate,
            indexFuturesUrl: sourceUrl,
            publishedDate: "2026-08-10",
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

const confirmedAt = "2026-08-10T07:05:00.000Z";

test("empty historyは正式versionを持つ", async () => {
    const history = historyApi.createEmptyHistory();
    assert.equal(history.parserVersion, 2);
    assert.equal(history.schemaVersion, 2);
    assert.equal(history.brokerSetVersion, 1);
    assert.equal(history.scoringVersion, 2);
    assert.equal(history.maxEntries, 52);
    assert.equal(await historyApi.validateHistory(history), true);
});

test("初回保存と複数週のsourceDate昇順", async () => {
    const result = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        [await candidate("2026-08-07"), await candidate("2026-07-31")],
        confirmedAt
    );
    assert.equal(result.added, 2);
    assert.deepEqual(result.history.entries.map(entry => entry.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
    assert.equal(await historyApi.validateHistory(result.history), true);
});

test("同一versionはrevisionを増やさずlastSeenAtだけ更新", async () => {
    const item = await candidate("2026-08-07");
    const first = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(), [item], confirmedAt
    );
    const secondAt = "2026-08-11T07:05:00.000Z";
    const second = await historyApi.mergeCandidates(first.history, [item], secondAt);
    assert.equal(second.repeated, 1);
    assert.equal(second.history.entries.length, 1);
    assert.equal(second.history.entries[0].revisions.length, 1);
    assert.equal(second.history.entries[0].lastSeenAt, secondAt);
});

test("same-date公式再取得の異signatureをrevisionにする", async () => {
    const first = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        [await candidate("2026-08-07", 100)], confirmedAt
    );
    const revisedAt = "2026-08-11T07:05:00.000Z";
    const second = await historyApi.mergeCandidates(
        first.history, [await candidate("2026-08-07", 101)], revisedAt
    );
    const entry = second.history.entries[0];
    assert.equal(second.revised, 1);
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, revisedAt);
    assert.equal(entry.revisions[1].replacedAt, null);
    assert.equal(entry.activeVersionKey, entry.revisions[1].versionKey);
});

test("公式再取得証拠のないsame-date revisionを拒否", async () => {
    const first = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        [await candidate("2026-08-07", 100)], confirmedAt
    );
    const revised = await candidate("2026-08-07", 101);
    revised.officialMetadata.currentOfficialRefetch = false;
    const result = await historyApi.mergeCandidates(
        first.history, [revised], "2026-08-11T07:05:00.000Z"
    );
    assert.equal(result.outcome, "unconfirmed_revision");
    assert.deepEqual(result.history, first.history);
});

for (const [name, mutate] of [
    ["parserVersion不一致", history => { history.parserVersion = 1; }],
    ["schemaVersion不一致", history => { history.schemaVersion = 1; }],
    ["signature不一致", history => { history.entries[0].revisions[0].signature = "a".repeat(64); }],
    ["versionKey不一致", history => { history.entries[0].revisions[0].versionKey = "broken"; }]
]) {
    test(name, async () => {
        const result = await historyApi.mergeCandidates(
            historyApi.createEmptyHistory(),
            [await candidate("2026-08-07")], confirmedAt
        );
        mutate(result.history);
        assert.equal(await historyApi.validateHistory(result.history), false);
    });
}

test("壊れたhistoryを安全にinvalid扱い", async () => {
    assert.equal((await historyApi.parseHistory("{broken")).status, "invalid");
    assert.equal((await historyApi.parseHistory(JSON.stringify({}))).status, "invalid");
});

test("invalid revisionを候補段階で拒否", async () => {
    const broken = await candidate("2026-08-07");
    broken.data.records[0].value = -1;
    const result = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(), [broken], confirmedAt
    );
    assert.equal(result.outcome, "invalid_candidate");
    assert.equal(result.history.entries.length, 0);
});

test("53週目で最古をpruneし52週を維持", async () => {
    const start = new Date("2025-01-03T00:00:00.000Z");
    const candidates = [];
    for (let index = 0; index < 53; index += 1) {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + index * 7);
        candidates.push(await candidate(date.toISOString().slice(0, 10), 100 + index));
    }
    const result = await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(), candidates, confirmedAt
    );
    assert.equal(result.history.entries.length, 52);
    assert.equal(result.history.entries[0].sourceDate, "2025-01-10");
    assert.equal(await historyApi.validateHistory(result.history), true);
});
