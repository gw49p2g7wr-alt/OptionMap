const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const adapter = require("../js/backfill/adapters/weeklyFuturesBackfillAdapter.js");

test("Electron renderer相当でもwindowへadapterを公開する", () => {
    const rendererWindow = { document: {} };
    const context = {
        window: rendererWindow,
        globalThis: rendererWindow,
        module: { exports: {} },
        require
    };
    vm.createContext(context);
    for (const file of [
        "js/weeklyFutures.js",
        "js/weeklyFuturesHistory.js",
        "js/backfill/adapters/weeklyFuturesBackfillAdapter.js"
    ]) {
        vm.runInContext(
            fs.readFileSync(file, "utf8"), context, { filename: file }
        );
    }
    assert.equal(
        typeof rendererWindow.OptionMapWeeklyFuturesBackfill
            .enumerateCandidates,
        "function"
    );
});

const listingUrl = adapter.listingUrlForYear(2026);
const listing = {
    UpdateDate: "2026/08/10 15:31",
    TableDatas: [
        { TradeDate: "20260807", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20260807_indexfut_oi_by_tp.xlsx" },
        { TradeDate: "20260731", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20260731_indexfut_oi_by_tp.xlsx" },
        { TradeDate: "20260724", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20260724_indexfut_oi_by_tp.xlsx" },
        { TradeDate: "20260807", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20260807_indexfut_oi_by_tp.xlsx" }
    ]
};

function parsed(candidate, value = 100) {
    return {
        excelSourceDate: candidate.sourceDate,
        publishedDate: "2026-08-10",
        data: weekly.parseWeeklyFuturesRows([
            ["＜日経225先物＞"],
            ["1", "2026年09月限月", "11714", "ＪＰモルガン証券", value]
        ])
    };
}

function dependencies(overrides = {}) {
    return {
        history: historyApi.createEmptyHistory(),
        candidates: adapter.parseListingManifest(listing, listingUrl),
        fetchExcel: async () => new Uint8Array([1]),
        parseExcel: async (_bytes, candidate) => parsed(candidate),
        now: () => "2026-08-10T07:00:00.000Z",
        ...overrides
    };
}

test("2026公式一覧からTradeDateとExcel URLを重複なく列挙", () => {
    const candidates = adapter.parseListingManifest(listing, listingUrl);
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].sourceDate, "2026-07-24");
    assert.match(candidates[2].sourceUrl, /20260807_indexfut_oi_by_tp\.xlsx$/);
});

test("期間filterで範囲外を除外", () => {
    const candidates = adapter.filterCandidates(
        adapter.parseListingManifest(listing, listingUrl),
        "2026-07-31", "2026-08-07"
    );
    assert.deepEqual(candidates.map(item => item.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
});

test("複数年の公式一覧だけから候補を取得", async () => {
    const result = await adapter.enumerateCandidates({
        startDate: "2025-12-01", endDate: "2026-08-07",
        fetchListing: async url => url.endsWith("2026.json") ? listing : {
            UpdateDate: "2025/12/31 15:31", TableDatas: []
        }
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.candidates.length, 3);
});

test("1週と複数週をstaging後に正式historyへ統合", async () => {
    const oneCandidate = adapter.parseListingManifest(listing, listingUrl).slice(0, 1);
    const one = await adapter.runBackfill(dependencies({ candidates: oneCandidate }));
    assert.equal(one.status, "success");
    assert.equal(one.history.entries.length, 1);
    const many = await adapter.runBackfill(dependencies());
    assert.equal(many.history.entries.length, 3);
    assert.equal(await historyApi.validateHistory(many.history), true);
});

for (const [name, overrides, expectedError] of [
    ["404", { fetchExcel: async () => { throw new Error("HTTP 404"); } }, "HTTP 404"],
    ["通信失敗", { fetchExcel: async () => { throw new Error("network"); } }, "network"],
    ["parse失敗", { parseExcel: async () => { throw new Error("parse"); } }, "parse"],
    ["validation失敗", { parseExcel: async (_b, c) => ({ ...parsed(c), data: {} }) }, "date_or_schema_mismatch"]
]) {
    test(`${name}でも既存historyを変更しない`, async () => {
        const base = historyApi.createEmptyHistory();
        const result = await adapter.runBackfill(dependencies({
            history: base,
            candidates: adapter.parseListingManifest(listing, listingUrl).slice(0, 1),
            ...overrides
        }));
        assert.equal(result.status, "partial");
        assert.equal(result.results[0].error, expectedError);
        assert.deepEqual(result.history, base);
    });
}

test("date mismatchを正式historyへ入れない", async () => {
    const result = await adapter.runBackfill(dependencies({
        candidates: adapter.parseListingManifest(listing, listingUrl).slice(0, 1),
        parseExcel: async (_bytes, candidate) => ({
            ...parsed(candidate), excelSourceDate: "2026-01-01"
        })
    }));
    assert.equal(result.stagedCount, 0);
    assert.equal(result.results[0].error, "date_or_schema_mismatch");
});

test("一部週失敗でも成功週だけをstaging後に保存候補化", async () => {
    const candidates = adapter.parseListingManifest(listing, listingUrl);
    const result = await adapter.runBackfill(dependencies({
        candidates,
        fetchExcel: async url => {
            if (url.includes("20260731")) throw new Error("HTTP 404");
            return new Uint8Array([1]);
        }
    }));
    assert.equal(result.status, "partial");
    assert.equal(result.history.entries.length, 2);
});

test("再実行しても履歴件数とrevision数は不変", async () => {
    const first = await adapter.runBackfill(dependencies());
    const second = await adapter.runBackfill(dependencies({ history: first.history }));
    assert.equal(second.history.entries.length, first.history.entries.length);
    assert.equal(historyApi.summarizeHistory(second.history).revisionCount,
        historyApi.summarizeHistory(first.history).revisionCount);
});

test("中断時はstaging結果を正式候補へ返さない", async () => {
    let calls = 0;
    const base = historyApi.createEmptyHistory();
    const result = await adapter.runBackfill(dependencies({
        history: base,
        isCancelled: () => calls++ > 1
    }));
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.history, base);
});

test("staging統合失敗は既存historyを維持", async () => {
    const broken = historyApi.createEmptyHistory();
    broken.parserVersion = 1;
    const result = await adapter.runBackfill(dependencies({ history: broken }));
    assert.equal(result.status, "staging_failed");
    assert.deepEqual(result.history, broken);
});

test("quota失敗は保存失敗を返し既存値を破壊しない", async () => {
    const base = historyApi.createEmptyHistory();
    const result = await adapter.runBackfill(dependencies());
    const storage = {
        value: "existing",
        setItem() { throw new Error("QuotaExceededError"); }
    };
    const saved = await adapter.commitHistory(storage, "history", result.history);
    assert.equal(saved.saved, false);
    assert.equal(storage.value, "existing");
});

test("正式historyだけを単一keyへ保存", async () => {
    const result = await adapter.runBackfill(dependencies());
    const writes = [];
    const storage = { setItem: (key, value) => writes.push([key, value]) };
    const saved = await adapter.commitHistory(
        storage, "optionMapWeeklyFuturesHistory", result.history
    );
    assert.equal(saved.saved, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "optionMapWeeklyFuturesHistory");
});
