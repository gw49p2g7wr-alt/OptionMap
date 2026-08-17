const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");
const history = require("../js/weeklyOptionsHistory.js");
const adapter = require("../js/backfill/adapters/weeklyOptionsBackfillAdapter.js");

const LISTING = "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_2026.json";
function url(date) {
    return `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/${date.replaceAll("-", "")}_nk225op_oi_by_tp.xlsx`;
}
function rows(date = "2026-08-07", value = 100) {
    const result = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [y, m, d] = date.split("-");
    result[0][0] = weekly.SOURCE_TITLE;
    result[1][0] = `（ ${y}年${m}月${d}日現在 ）`;
    result[2][0] = `${y}年${m}月10日`;
    result[6][1] = "プット（2026年08月限月）";
    result[6][11] = "コール（2026年08月限月）";
    weekly.BLOCK_START_ROWS.forEach((start, block) => {
        result[start - 1][1] = result[start - 1][11] = 65000 + block * 125;
        for (let rank = 1; rank <= 15; rank += 1) {
            result[start + rank - 2][0] = result[start + rank - 2][10] = rank;
        }
    });
    result[9][2] = "00123"; result[9][3] = "ＡＢＮクリアリン証券";
    result[9][4] = value;
    result[9][15] = "12800"; result[9][16] = "モルガンＭＵＦＧ証券";
    result[9][17] = value + 1;
    return result;
}
function listing(items) {
    return { UpdateDate: "2026/08/10 15:31", TableDatas: items.map(date => ({
        TradeDate: date.replaceAll("-", ""), IndexOptions: url(date)
    })) };
}
function parsed(date, value) { return { data: weekly.parseWeeklyOptionsRows(rows(date, value)) }; }

test("IndexOptionsだけを列挙しURL日付不一致と重複を除外", () => {
    const data = listing(["2026-07-31", "2026-08-07", "2026-08-07"]);
    data.TableDatas.push({ TradeDate: "20260814", IndexOptions: url("2026-08-07") });
    data.TableDatas.push({ TradeDate: "20260814", IndexFutures: "ignored.xlsx" });
    assert.deepEqual(adapter.parseListingManifest(data, LISTING).map(x => x.sourceDate),
        ["2026-07-31", "2026-08-07"]);
    assert.equal(adapter.parseSourceUrlDate(url("2026-08-07")), "2026-08-07");
});

test("複数年一覧を期間filterし一覧通信失敗を不存在と混同しない", async () => {
    const result = await adapter.enumerateCandidates({
        startDate: "2026-07-31", endDate: "2027-01-08",
        fetchListing: async listingUrl => {
            if (listingUrl.includes("2027")) throw new Error("network");
            return listing(["2026-07-24", "2026-07-31", "2026-08-07"]);
        }
    });
    assert.deepEqual(result.candidates.map(x => x.sourceDate), ["2026-07-31", "2026-08-07"]);
    assert.equal(result.failures.length, 1);
});

test("1週・複数週をparse/validateしてmemory staging", async () => {
    const candidates = adapter.parseListingManifest(
        listing(["2026-07-31", "2026-08-07"]), LISTING);
    const output = await adapter.runBackfill({ history: history.createEmptyWeeklyOptionsHistory(),
        candidates, fetchExcel: async sourceUrl => sourceUrl,
        parseExcel: async (_bytes, item) => parsed(item.sourceDate,
            item.sourceDate === "2026-07-31" ? 100 : 110),
        now: () => "2026-08-10T07:00:00.000Z" });
    assert.equal(output.status, "success");
    assert.equal(output.staged.length, 2);
    assert.deepEqual(output.history.entries.map(x => x.sourceDate),
        ["2026-07-31", "2026-08-07"]);
    assert.equal((await history.validateWeeklyOptionsHistory(output.history)).valid, true);
});

test("404・parse失敗・日付不一致は個別失敗し成功週だけstaging", async () => {
    const candidates = adapter.parseListingManifest(
        listing(["2026-07-24", "2026-07-31", "2026-08-07"]), LISTING);
    const output = await adapter.runBackfill({ history: history.createEmptyWeeklyOptionsHistory(),
        candidates,
        fetchExcel: async sourceUrl => {
            if (sourceUrl.includes("20260724")) throw new Error("404");
            return sourceUrl;
        },
        parseExcel: async (_bytes, item) => item.sourceDate === "2026-07-31"
            ? parsed("2026-07-30", 100) : parsed(item.sourceDate, 110),
        now: () => "2026-08-10T07:00:00.000Z" });
    assert.equal(output.status, "partial");
    assert.equal(output.staged.length, 1);
    assert.deepEqual(output.results.map(x => x.status), ["failed", "failed", "success"]);
});

test("キャンセルはstagingを破棄し入力historyを不変", async () => {
    const original = history.createEmptyWeeklyOptionsHistory();
    let cancelled = false;
    const output = await adapter.runBackfill({ history: original,
        candidates: adapter.parseListingManifest(listing(["2026-07-31", "2026-08-07"]), LISTING),
        fetchExcel: async sourceUrl => { cancelled = true; return sourceUrl; },
        parseExcel: async () => parsed("2026-07-31", 100), isCancelled: () => cancelled });
    assert.equal(output.status, "cancelled");
    assert.deepEqual(output.staged, []);
    assert.deepEqual(original.entries, []);
});

test("同じ候補の再実行はpreview historyのrevisionを増やさない", async () => {
    const item = adapter.parseListingManifest(listing(["2026-08-07"]), LISTING)[0];
    const candidate = await adapter.createHistoryCandidate(item, parsed("2026-08-07", 100),
        "2026-08-10T07:00:00.000Z");
    const first = await history.mergeWeeklyOptionsHistory(
        history.createEmptyWeeklyOptionsHistory(), candidate,
        { confirmedAt: "2026-08-10T07:00:00.000Z" });
    const output = await adapter.runBackfill({ history: first.history, candidates: [item],
        fetchExcel: async x => x, parseExcel: async () => parsed("2026-08-07", 100),
        now: () => "2026-08-11T07:00:00.000Z" });
    assert.equal(output.history.entries[0].revisions.length, 1);
});
