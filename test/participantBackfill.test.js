const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const participant = require("../js/participantData.js");
const historyApi = require("../js/participantHistory.js");
const activity = require("../js/participantActivity.js");
const adapter = require("../js/backfill/adapters/participantBackfillAdapter.js");

const LISTING_URL = adapter.monthListingUrl("202608");
const MASTER = {
    UpdateDate: "2026/08/14 17:41",
    TableDatas: [{ Month: "202608" }, { Month: "202607" }]
};

function path(date, suffix) {
    const compact = date.replaceAll("-", "");
    return `/automation/markets/derivatives/participant-volume/files/daily/` +
        `${compact.slice(0, 6)}/${compact}_${suffix}.xlsx`;
}

function row(date, volume = 100) {
    const compact = date.replaceAll("-", "");
    return {
        TradeDate: compact,
        Night: path(date, "volume_by_participant_night"),
        NightJNet: path(date, "volume_by_participant_night_J-NET"),
        WholeDay: path(date, "volume_by_participant_whole_day"),
        WholeDayJNet: path(date, "volume_by_participant_whole_day_J-NET"),
        volume
    };
}

function listing(dates = ["2026-08-14"]) {
    return { UpdateDate: "2026/08/14 17:41", TableDatas: dates.map(row) };
}

function parsed(date, volume = 100) {
    return participant.parseParticipantExcel([
        ["Trading Date", date.replaceAll("-", "/")],
        ["NK225MF", "M1", "MINI", 1, "00123", "証券会社", "Broker", volume],
        ["NK225F", "L1", "LARGE", 1, "00456", "会社B", "Broker B", volume],
        ["TOPIXF", "T1", "TOPIX", 1, "00789", "会社C", "Broker C", volume]
    ], date);
}

function deps(overrides = {}) {
    const candidates = adapter.parseMonthlyManifest(listing(), LISTING_URL);
    return {
        history: historyApi.createEmptyHistory(),
        candidates,
        fetchExcel: async () => new Uint8Array([1]),
        parseExcel: async (_bytes, candidate) => parsed(candidate.sourceDate),
        now: () => "2026-08-16T01:00:00.000Z",
        ...overrides
    };
}

test("Electron renderer相当でparticipant adapterを公開する", () => {
    const rendererWindow = { document: {} };
    const context = { window: rendererWindow, globalThis: rendererWindow,
        module: { exports: {} }, require };
    vm.createContext(context);
    for (const file of ["js/participantData.js", "js/participantHistory.js",
        "js/backfill/adapters/participantBackfillAdapter.js"]) {
        vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    }
    assert.equal(typeof rendererWindow.OptionMapParticipantBackfill
        .enumerateCandidates, "function");
});

test("公式月次JSONの4リンクだけを候補化する", () => {
    const candidates = adapter.parseMonthlyManifest(listing([
        "2026-08-13", "2026-08-14"
    ]), LISTING_URL);
    assert.deepEqual(candidates.map(item => item.sourceDate), [
        "2026-08-13", "2026-08-14"
    ]);
    assert.deepEqual(Object.keys(candidates[0].sourceUrls).sort(),
        [...participant.FILE_KEYS].sort());
});

test("3/4掲載行は公式候補にしない", () => {
    const incomplete = row("2026-08-14");
    incomplete.NightJNet = "-";
    assert.equal(adapter.parseMonthlyManifest({
        UpdateDate: "2026/08/14 17:41", TableDatas: [incomplete]
    }, LISTING_URL).length, 0);
});

test("公式master掲載月だけを列挙し日付範囲で絞る", async () => {
    const result = await adapter.enumerateCandidates({
        startDate: "2026-08-13", endDate: "2026-08-14",
        fetchJson: async url => url === adapter.MONTH_LIST_URL
            ? MASTER : listing(["2026-08-12", "2026-08-13", "2026-08-14"])
    });
    assert.deepEqual(result.listedMonths, ["202608"]);
    assert.deepEqual(result.candidates.map(item => item.sourceDate), [
        "2026-08-13", "2026-08-14"
    ]);
});

test("公式masterにない月はURLを生成取得せず非掲載として返す", async () => {
    const calls = [];
    const result = await adapter.enumerateCandidates({
        startDate: "2025-08-01", endDate: "2025-09-30",
        fetchJson: async url => {
            calls.push(url);
            return url === adapter.MONTH_LIST_URL ? MASTER : listing([]);
        }
    });
    assert.deepEqual(result.unavailableMonths, ["202508", "202509"]);
    assert.deepEqual(calls, [adapter.MONTH_LIST_URL]);
});

test("4/4 completeだけをstagingして正式historyへmergeする", async () => {
    const result = await adapter.runBackfill(deps());
    assert.equal(result.status, "success");
    assert.equal(result.stagedCount, 1);
    assert.equal(result.history.entries.length, 1);
    assert.equal(await historyApi.validateParticipantHistory(
        result.history, participant.validateParticipantCache
    ), true);
    const record = result.history.entries[0].revisions[0].completeSet
        .files.dayAuction.data.mini.records[0];
    assert.equal(record.participantCode, "00123");
    assert.equal(record.volume, 100);
});

for (const successCount of [3, 2, 1, 0]) {
    test(`${successCount}/4取得は正式historyへ保存しない`, async () => {
        let call = 0;
        const base = historyApi.createEmptyHistory();
        const result = await adapter.runBackfill(deps({
            history: base,
            fetchExcel: async () => {
                call += 1;
                if (call > successCount) throw new Error("network");
                return new Uint8Array([1]);
            }
        }));
        assert.equal(result.results[0].status,
            successCount > 0 ? "partial" : "failed");
        assert.deepEqual(result.history, base);
    });
}

test("Excel Trading Date不一致とmixed-dateを拒否する", async () => {
    const result = await adapter.runBackfill(deps({
        parseExcel: async (_bytes, candidate, fileKey) => parsed(
            fileKey === "nightJnet" ? "2026-08-13" : candidate.sourceDate
        )
    }));
    assert.equal(result.results[0].status, "validation_failed");
    assert.equal(result.results[0].error, "date_or_schema_mismatch");
    assert.equal(result.history.entries.length, 0);
});

test("Excel Trading Date欠損をURL対象日で正式補完しない", async () => {
    const result = await adapter.runBackfill(deps({
        parseExcel: async (_bytes, candidate) => participant.parseParticipantExcel([
            ["NK225MF", "M1", "MINI", 1, "00123", "証券会社", "Broker", 100]
        ], candidate.sourceDate)
    }));
    assert.equal(result.results[0].status, "validation_failed");
    assert.equal(result.results[0].error, "date_or_schema_mismatch");
    assert.equal(result.history.entries.length, 0);
});

test("source URL日付不一致を候補段階で拒否する", () => {
    const bad = row("2026-08-14");
    bad.Night = path("2026-08-13", "volume_by_participant_night");
    assert.equal(adapter.parseMonthlyManifest({
        UpdateDate: "2026/08/14 17:41", TableDatas: [bad]
    }, LISTING_URL).length, 0);
});

test("同一版再実行はentryとrevisionを増やさない", async () => {
    const first = await adapter.runBackfill(deps());
    const second = await adapter.runBackfill(deps({ history: first.history }));
    assert.equal(second.history.entries.length, 1);
    assert.equal(second.history.entries[0].revisions.length, 1);
});

test("公式同日異signatureはrevision追加しactiveを切り替える", async () => {
    const first = await adapter.runBackfill(deps());
    const second = await adapter.runBackfill(deps({
        history: first.history,
        parseExcel: async (_bytes, candidate) => parsed(candidate.sourceDate, 200),
        now: () => "2026-08-16T02:00:00.000Z"
    }));
    const entry = second.history.entries[0];
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, "2026-08-16T02:00:00.000Z");
    assert.equal(entry.activeVersionKey, entry.revisions[1].versionKey);
});

test("古いsourceDateも安全にmergeし昇順にする", async () => {
    const newer = await adapter.runBackfill(deps());
    const oldCandidate = adapter.parseMonthlyManifest(
        listing(["2026-08-13"]), LISTING_URL
    );
    const result = await adapter.runBackfill(deps({
        history: newer.history, candidates: oldCandidate
    }));
    assert.deepEqual(result.history.entries.map(entry => entry.sourceDate), [
        "2026-08-13", "2026-08-14"
    ]);
});

test("31日候補は最新30 sourceDateを維持しrevisionを件数に含めない", async () => {
    const dates = Array.from({ length: 31 }, (_value, index) =>
        new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10)
    );
    const candidates = adapter.parseMonthlyManifest(listing(dates),
        adapter.monthListingUrl("202607"));
    const result = await adapter.runBackfill(deps({ candidates }));
    assert.equal(result.history.entries.length, 30);
    assert.equal(result.history.entries[0].sourceDate, "2026-07-02");
    assert.equal(result.merged.pruneCount, 1);
    const revised = await adapter.runBackfill(deps({
        history: result.history,
        candidates: candidates.slice(-1),
        parseExcel: async (_b, candidate) => parsed(candidate.sourceDate, 200)
    }));
    assert.equal(revised.history.entries.length, 30);
    assert.equal(revised.history.entries.at(-1).revisions.length, 2);
});

test("一部日通信失敗でも成功日のみstaging後に統合する", async () => {
    const candidates = adapter.parseMonthlyManifest(listing([
        "2026-08-13", "2026-08-14"
    ]), LISTING_URL);
    const result = await adapter.runBackfill(deps({
        candidates,
        fetchExcel: async url => {
            if (url.includes("20260813")) throw new Error("network");
            return new Uint8Array([1]);
        }
    }));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.history.entries.map(entry => entry.sourceDate), [
        "2026-08-14"
    ]);
});

test("キャンセルとstaging validation失敗は既存historyを不変にする", async () => {
    const base = historyApi.createEmptyHistory();
    let calls = 0;
    const cancelled = await adapter.runBackfill(deps({
        history: base, isCancelled: () => calls++ > 1
    }));
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.history, base);

    const invalid = historyApi.createEmptyHistory();
    invalid.version = 99;
    const failed = await adapter.runBackfill(deps({ history: invalid }));
    assert.equal(failed.status, "staging_failed");
    assert.deepEqual(failed.history, invalid);
});

test("Local Storage失敗時は既存値を破壊せず専用keyへ1回だけ保存する", async () => {
    const result = await adapter.runBackfill(deps());
    const failedStorage = {
        value: "existing",
        setItem() { throw new Error("QuotaExceededError"); }
    };
    const failed = await adapter.commitHistory(failedStorage,
        "optionMapParticipantHistory", result.history);
    assert.equal(failed.saved, false);
    assert.equal(failedStorage.value, "existing");

    const writes = [];
    const saved = await adapter.commitHistory({
        setItem: (key, value) => writes.push([key, value])
    }, "optionMapParticipantHistory", result.history);
    assert.equal(saved.saved, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "optionMapParticipantHistory");
});

test("Backfill historyをparticipantActivityがactive revisionから複数点化する", async () => {
    const candidates = adapter.parseMonthlyManifest(listing([
        "2026-08-13", "2026-08-14"
    ]), LISTING_URL);
    const result = await adapter.runBackfill(deps({ candidates }));
    const view = activity.createActivityViewModel(result.history, "mini");
    assert.equal(view.status, "ready");
    assert.equal(view.series.length, 2);
    assert.equal(view.comparison.previousSourceDate, "2026-08-13");
    for (const day of activity.buildCanonicalHistory(result.history).days) {
        assert.deepEqual([...new Set(day.rows.map(item =>
            `${item.session}|${item.marketType}`
        ))], ["day|auction", "day|jnet", "night|auction", "night|jnet"]);
    }
});

test("previewは30日上限とprune見込みを返す", () => {
    const candidates = Array.from({ length: 31 }, (_value, index) => ({
        sourceDate: new Date(Date.UTC(2026, 6, index + 1))
            .toISOString().slice(0, 10)
    }));
    const impact = adapter.previewImpact(historyApi.createEmptyHistory(), candidates);
    assert.equal(impact.officialCandidateCount, 31);
    assert.equal(impact.estimatedFileCount, 124);
    assert.equal(impact.projectedSavedCount, 30);
    assert.equal(impact.projectedPruneCount, 1);
});
