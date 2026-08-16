const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");
const historyApi = require("../js/weeklyOptionsHistory.js");

const BLOCK_STARTS = [10, 25, 40, 55, 70];
const CONFIRMED_AT = "2026-08-10T07:05:00.000Z";

function rows(sourceDate = "2026-08-07", expiry = "2026-08", value = 100) {
    const result = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    result[0][0] = weekly.SOURCE_TITLE;
    result[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    result[2][0] = `${year}年${month}月10日`;
    result[6][1] = `プット（${expiryYear}年${expiryMonth}月限月）`;
    result[6][11] = `コール（${expiryYear}年${expiryMonth}月限月）`;
    BLOCK_STARTS.forEach((start, block) => {
        result[start - 1][1] = 65000 + block * 125;
        result[start - 1][11] = 65000 + block * 125;
        for (let rank = 1; rank <= 15; rank += 1) {
            result[start + rank - 2][0] = rank;
            result[start + rank - 2][10] = rank;
        }
    });
    result[9][2] = "00123";
    result[9][3] = "ＡＢＮクリアリン証券";
    result[9][4] = value;
    result[9][15] = "12800";
    result[9][16] = "モルガンＭＵＦＧ証券";
    result[9][17] = value + 1;
    return result;
}

async function cache(sourceDate = "2026-08-07", expiry = "2026-08", value = 100) {
    const data = weekly.parseWeeklyOptionsRows(rows(sourceDate, expiry, value));
    const signature = await weekly.createSignature(data);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/${sourceDate.slice(0, 4)}/` +
        `${compact}_nk225op_oi_by_tp.xlsx`;
    return {
        version: 2,
        parserVersion: 2,
        schemaVersion: 2,
        source: "jpx-weekly-nikkei225-options-open-interest",
        sourceDate,
        sourceDateKind: "jpx_open_interest_as_of",
        publishedDate: data.publishedDate,
        publishedAt: null,
        listingUpdatedAt: "2026-08-10T15:31:00+09:00",
        listingUpdatedAtKind: "jpx_listing_updated_at",
        listingUrl: `https://www.jpx.co.jp/automation/markets/derivatives/` +
            `open-interest/json/open_interest_${sourceDate.slice(0, 4)}.json`,
        fetchedAt: "2026-08-10T07:00:00.000Z",
        sourceUrl,
        signatureAlgorithm: "sha256",
        signature,
        versionKey: `weekly-options-v2|${sourceDate}|sha256:${signature}`,
        dateEvidence: {
            excelAsOf: sourceDate,
            listingTradeDate: sourceDate,
            urlDate: sourceDate,
            consistent: true
        },
        versionAssessment: "confirmed",
        data
    };
}

async function candidate(...args) {
    const result = await historyApi.createWeeklyOptionsHistoryCandidate(
        await cache(...args)
    );
    assert.equal(result.ok, true);
    return result.candidate;
}

async function merge(history, item, confirmedAt = CONFIRMED_AT) {
    return historyApi.mergeWeeklyOptionsHistory(history, item, { confirmedAt });
}

test("empty history生成とretention非結合", async () => {
    const history = historyApi.createEmptyWeeklyOptionsHistory({
        configuredMaxEntries: 12
    });
    assert.equal(history.historyVersion, 1);
    assert.equal(history.canonicalParserVersion, 2);
    assert.equal(history.canonicalSchemaVersion, 2);
    assert.equal(history.retentionPolicy.automaticPruning, false);
    assert.equal((await historyApi.validateWeeklyOptionsHistory(history)).valid, true);
    history.retentionPolicy.configuredMaxEntries = 104;
    assert.equal((await historyApi.validateWeeklyOptionsHistory(history)).valid, true);
});

test("canonical v2 cacheからcandidateを生成しrawを保持", async () => {
    const source = await cache();
    const result = await historyApi.createWeeklyOptionsHistoryCandidate(source);
    assert.equal(result.ok, true);
    assert.deepEqual(result.candidate.canonical, source.data);
    assert.equal(result.candidate.canonical.records[0].participantCode, "00123");
    assert.equal(result.candidate.canonical.records[0].broker, "ＡＢＮクリアリン証券");
    assert.equal(result.candidate.canonical.records[0].rank, 1);
});

for (const [name, mutate, reason] of [
    ["cache v1拒否", value => { value.version = 1; }, "unsupported_cache_version"],
    ["parserVersion不一致拒否", value => { value.parserVersion = 1; }, "canonical_version_mismatch"],
    ["schemaVersion不一致拒否", value => { value.schemaVersion = 1; }, "canonical_version_mismatch"],
    ["canonical invalid拒否", value => { value.data.records[0].value = -1; }, "invalid_canonical_cache"],
    ["signature改変拒否", value => { value.signature = "a".repeat(64); }, "invalid_canonical_cache"],
    ["versionKey改変拒否", value => { value.versionKey = "broken"; }, "invalid_canonical_cache"],
    ["date evidence不整合拒否", value => {
        value.dateEvidence.listingTradeDate = "2026-07-31";
    }, "date_evidence_invalid"]
]) {
    test(name, async () => {
        const value = await cache();
        mutate(value);
        const result = await historyApi.createWeeklyOptionsHistoryCandidate(value);
        assert.equal(result.ok, false);
        assert.equal(result.reason, reason);
    });
}

test("PUT/CALL expiry不一致をcandidateで拒否", async () => {
    const value = await cache();
    value.data.optionExpiries.call = "2026-09";
    const result = await historyApi.createWeeklyOptionsHistoryCandidate(value);
    assert.equal(result.ok, false);
});

test("新規2週追加・sourceDate正規化・latestとprevious選択", async () => {
    const newer = await candidate("2026-08-07", "2026-08", 200);
    const older = await candidate("2026-07-31", "2026-08", 100);
    let result = await merge(historyApi.createEmptyWeeklyOptionsHistory(), newer);
    result = await merge(result.history, older, "2026-08-10T07:06:00.000Z");
    assert.deepEqual(result.history.entries.map(entry => entry.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
    const latest = await historyApi.getLatestActiveWeeklyOptionsRevision(result.history);
    assert.equal(latest.sourceDate, "2026-08-07");
    const previous = await historyApi.findPreviousWeeklyOptionsRevision(
        result.history, "2026-08-07"
    );
    assert.equal(previous.previousCalendar.sourceDate, "2026-07-31");
    assert.equal(previous.previousSameExpiry.sourceDate, "2026-07-31");
});

test("同一signature再取得は冪等でrevisionを増やさない", async () => {
    const item = await candidate();
    const first = await merge(historyApi.createEmptyWeeklyOptionsHistory(), item);
    const second = await merge(first.history, item, "2026-08-11T07:00:00.000Z");
    assert.equal(second.outcome, "same_version");
    assert.equal(second.history.entries[0].revisions.length, 1);
    assert.equal(second.history.entries[0].lastSeenAt, "2026-08-11T07:00:00.000Z");
});

test("公式証拠ありsame-date revisionでactive切替とreplacedAt設定", async () => {
    const firstItem = await candidate("2026-08-07", "2026-08", 100);
    const first = await merge(historyApi.createEmptyWeeklyOptionsHistory(), firstItem);
    const revisedCache = await cache("2026-08-07", "2026-08", 101);
    revisedCache.currentOfficialRefetch = true;
    const revisedResult = await historyApi.createWeeklyOptionsHistoryCandidate(revisedCache);
    const changedAt = "2026-08-11T07:00:00.000Z";
    const second = await merge(first.history, revisedResult.candidate, changedAt);
    const entry = second.history.entries[0];
    assert.equal(second.outcome, "revised");
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, changedAt);
    assert.equal(entry.activeVersionKey, entry.revisions[1].versionKey);
    const active = await historyApi.getActiveWeeklyOptionsRevision(
        second.history, "2026-08-07"
    );
    assert.equal(active.revision.canonical.records[0].value, 101);
});

test("証拠なし異signatureを拒否", async () => {
    const first = await merge(
        historyApi.createEmptyWeeklyOptionsHistory(),
        await candidate("2026-08-07", "2026-08", 100)
    );
    const result = await merge(
        first.history,
        await candidate("2026-08-07", "2026-08", 101),
        "2026-08-11T07:00:00.000Z"
    );
    assert.equal(result.outcome, "unconfirmed_revision");
    assert.deepEqual(result.history, first.history);
});

test("mergeはhistoryとcandidateを破壊せず非掲載を生成しない", async () => {
    const history = historyApi.createEmptyWeeklyOptionsHistory();
    const item = await candidate();
    const historyBefore = structuredClone(history);
    const candidateBefore = structuredClone(item);
    const result = await merge(history, item);
    assert.deepEqual(history, historyBefore);
    assert.deepEqual(item, candidateBefore);
    assert.equal(result.history.entries[0].revisions[0].canonical.records.some(
        record => record.published === false || record.value === 0
    ), false);
});

test("previous calendarとsame-expiryを区別しrollを跨がない", async () => {
    let result = await merge(
        historyApi.createEmptyWeeklyOptionsHistory(),
        await candidate("2026-07-24", "2026-08", 100)
    );
    result = await merge(result.history,
        await candidate("2026-07-31", "2026-09", 110),
        "2026-08-10T07:06:00.000Z");
    result = await merge(result.history,
        await candidate("2026-08-07", "2026-08", 120),
        "2026-08-10T07:07:00.000Z");
    const previous = await historyApi.findPreviousWeeklyOptionsRevision(
        result.history, "2026-08-07"
    );
    assert.equal(previous.previousCalendar.sourceDate, "2026-07-31");
    assert.equal(previous.previousSameExpiry.sourceDate, "2026-07-24");
    assert.equal(historyApi.classifyWeeklyOptionsComparison(
        previous.previousCalendar.revision,
        (await historyApi.getActiveWeeklyOptionsRevision(
            result.history, "2026-08-07"
        )).revision
    ).status, "roll_transition");
});

test("same expiry・roll transition・sourceDate逆転を分類", async () => {
    const july = await candidate("2026-07-31", "2026-08", 100);
    const august = await candidate("2026-08-07", "2026-08", 110);
    const roll = await candidate("2026-08-14", "2026-09", 120);
    assert.equal(historyApi.classifyWeeklyOptionsComparison(july, august).status,
        "same_expiry");
    assert.equal(historyApi.classifyWeeklyOptionsComparison(august, roll).status,
        "roll_transition");
    assert.equal(historyApi.classifyWeeklyOptionsComparison(august, july).status,
        "unavailable");
});

test("一部revision破損の位置を特定する", async () => {
    const first = await merge(historyApi.createEmptyWeeklyOptionsHistory(), await candidate());
    const broken = structuredClone(first.history);
    broken.entries[0].revisions[0].signature = "a".repeat(64);
    const result = await historyApi.validateWeeklyOptionsHistory(broken);
    assert.equal(result.valid, false);
    assert.equal(result.invalidEntries[0].index, 0);
    assert.equal(result.invalidEntries[0].invalidRevisions[0].index, 0);
    assert.ok(result.invalidEntries[0].invalidRevisions[0].errors.includes(
        "signature_mismatch"
    ));
});

test("未整列historyはmerge時に正規化する", async () => {
    let result = await merge(historyApi.createEmptyWeeklyOptionsHistory(),
        await candidate("2026-07-31", "2026-08", 100));
    result = await merge(result.history,
        await candidate("2026-08-07", "2026-08", 110),
        "2026-08-10T07:06:00.000Z");
    const unordered = structuredClone(result.history);
    unordered.entries.reverse();
    const merged = await merge(unordered,
        await candidate("2026-08-07", "2026-08", 110),
        "2026-08-11T07:00:00.000Z");
    assert.deepEqual(merged.history.entries.map(entry => entry.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
});

test("非active revision破損は位置を示すがactiveを変更しない", async () => {
    const first = await merge(historyApi.createEmptyWeeklyOptionsHistory(),
        await candidate("2026-08-07", "2026-08", 100));
    const revisedCache = await cache("2026-08-07", "2026-08", 101);
    revisedCache.currentOfficialRefetch = true;
    const revised = (await historyApi.createWeeklyOptionsHistoryCandidate(revisedCache)).candidate;
    const second = await merge(first.history, revised, "2026-08-11T07:00:00.000Z");
    const broken = structuredClone(second.history);
    const activeVersionKey = broken.entries[0].activeVersionKey;
    broken.entries[0].revisions[0].signature = "b".repeat(64);
    const validation = await historyApi.validateWeeklyOptionsHistory(broken);
    assert.equal(validation.invalidRevisionCount, 1);
    assert.equal(validation.recoveryRequired, false);
    assert.equal(broken.entries[0].activeVersionKey, activeVersionKey);
    const active = await historyApi.getActiveWeeklyOptionsRevision(broken, "2026-08-07");
    assert.equal(active.status, "available");
    assert.equal(active.revision.versionKey, activeVersionKey);
});

test("active破損は旧revisionへ自動昇格せずrecovery_required", async () => {
    const first = await merge(historyApi.createEmptyWeeklyOptionsHistory(),
        await candidate("2026-08-07", "2026-08", 100));
    const revisedCache = await cache("2026-08-07", "2026-08", 101);
    revisedCache.currentOfficialRefetch = true;
    const revised = (await historyApi.createWeeklyOptionsHistoryCandidate(revisedCache)).candidate;
    const second = await merge(first.history, revised, "2026-08-11T07:00:00.000Z");
    const broken = structuredClone(second.history);
    broken.entries[0].revisions[1].canonical.records[0].value = -1;
    const validation = await historyApi.validateWeeklyOptionsHistory(broken);
    assert.equal(validation.recoveryRequired, true);
    const active = await historyApi.getActiveWeeklyOptionsRevision(broken, "2026-08-07");
    assert.equal(active.status, "recovery_required");
    assert.equal(active.revision, null);
});

test("outputへ派生signalや方向フィールドを保存しない", async () => {
    const result = await merge(historyApi.createEmptyWeeklyOptionsHistory(), await candidate());
    const serialized = JSON.stringify(result.history);
    for (const forbidden of ["signals", "changes", "bullish", "bearish",
        "directionScore"]) {
        assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    }
});
