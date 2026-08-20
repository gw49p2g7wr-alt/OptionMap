const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const config = require("../js/weeklyBrokerConfig.js");
const shadow = require("../js/weeklyFuturesParticipantCodeShadow.js");

function data(value = 100, expiry = "2026年09月限月") {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...config.PARTICIPANTS.map(participant => [
            "1", expiry, null, null, null,
            participant.participantCode, participant.brokerName, value
        ])
    ]);
}

async function candidate(sourceDate, value = 100, expiry) {
    const parsed = data(value, expiry);
    const signature = await weekly.createSignature(parsed);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/2026/${compact}_indexfut_oi_by_tp.xlsx`;
    return {
        sourceDate,
        sourceUrl,
        fetchedAt: "2026-08-20T01:00:00.000Z",
        signature,
        versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`,
        data: parsed,
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

async function history(candidates) {
    return (await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        candidates,
        "2026-08-20T01:05:00.000Z"
    )).history;
}

function version(sourceDate, futureOpenInterest) {
    return { sourceDate, futureOpenInterest };
}

test("完全一致historyのactive revisionと連続pairを全件一致にする", async () => {
    const input = await history([
        await candidate("2026-08-01", 100),
        await candidate("2026-08-08", 110),
        await candidate("2026-08-15", 120)
    ]);
    const before = structuredClone(input);
    const report = await shadow.validateHistoryShadow(input);
    assert.equal(report.status, "matched");
    assert.equal(report.checkedRevisions, 3);
    assert.equal(report.checkedPairs, 2);
    assert.equal(report.matchedPairs, 2);
    assert.equal(report.mismatchedPairs, 0);
    assert.deepEqual(report.mismatches, []);
    assert.deepEqual(input, before);
});

test("unavailable区間も正式方式とshadow方式で一致する", () => {
    const previous = data(100);
    const current = data(110);
    current.records = current.records.filter(record =>
        record.broker !== "ゴールドマン証券"
    );
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    assert.equal(report.matched, true);
    assert.equal(report.formal.available, false);
    assert.equal(report.shadow.available, false);
    assert.equal(report.formal.brokerDiffs.GS.reason, "unpublished_expiry");
    assert.equal(report.shadow.brokerDiffs.GS.reason, "unpublished_expiry");
});

test("expiry_set_changed区間も正式方式とshadow方式で一致する", () => {
    const report = shadow.compareRevisionPair(
        version("2026-08-01", data(100, "2026年09月限月")),
        version("2026-08-08", data(110, "2026年12月限月"))
    );
    assert.equal(report.matched, true);
    assert.equal(report.formal.available, false);
    assert.equal(report.shadow.available, false);
    assert.equal(report.formal.brokerDiffs.JPM.reason, "expiry_set_changed");
    assert.equal(report.shadow.brokerDiffs.JPM.reason, "expiry_set_changed");
});

test("name一致・code差をAとして分類する", () => {
    const previous = data(100);
    const current = data(110);
    current.records.find(record =>
        record.broker === "ＪＰモルガン証券"
    ).participantCode = "99999";
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    assert.equal(report.matched, false);
    assert.ok(report.mismatches.some(item =>
        item.type === shadow.REASON_TYPES.NAME_MATCH_CODE_MISMATCH
    ));
});

test("code一致・name差をBとして分類する", () => {
    const previous = data(100);
    const current = data(110);
    current.records.find(record =>
        record.participantCode === "11714"
    ).broker = "別名称";
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    assert.equal(report.matched, false);
    assert.ok(report.mismatches.some(item =>
        item.type === shadow.REASON_TYPES.CODE_MATCH_NAME_MISMATCH
    ));
});

test("participantCode missingをCとして分類し補完しない", () => {
    const previous = data(100);
    const current = data(110);
    delete current.records.find(record =>
        record.broker === "ＪＰモルガン証券"
    ).participantCode;
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    assert.equal(report.matched, false);
    assert.ok(report.mismatches.some(item =>
        item.type === shadow.REASON_TYPES.PARTICIPANT_CODE_MISSING
    ));
});

test("brokerName missingをDとして分類し補完しない", () => {
    const previous = data(100);
    const current = data(110);
    delete current.records.find(record =>
        record.participantCode === "11714"
    ).broker;
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    assert.equal(report.matched, false);
    assert.ok(report.mismatches.some(item =>
        item.type === shadow.REASON_TYPES.BROKER_NAME_MISSING
    ));
});

test("malformed historyをGとして拒否する", async () => {
    const report = await shadow.validateHistoryShadow({});
    assert.equal(report.status, "invalid_history");
    assert.equal(report.checkedRevisions, 0);
    assert.deepEqual(report.mismatchCounts, {
        [shadow.REASON_TYPES.HISTORY_INVALID]: 1
    });
});

test("正式brokerName判定とscoreDiff・directionを変更しない", () => {
    const previous = data(100);
    const current = data(110);
    const before = weekly.calculateWeeklyBrokerJudgment(previous, current);
    const report = shadow.compareRevisionPair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    const after = weekly.calculateWeeklyBrokerJudgment(previous, current);
    assert.deepEqual(after, before);
    assert.equal(report.formal.scoreDiff, before.scoreDiff);
    assert.equal(report.formal.direction, before.direction);
    assert.equal(report.shadow.scoreDiff, before.scoreDiff);
    assert.equal(report.shadow.direction, before.direction);
    assert.equal(weekly.BROKER_SET_VERSION, 1);
    assert.equal(weekly.SCORING_VERSION, 2);
});
