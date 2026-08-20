const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const config = require("../js/weeklyBrokerConfig.js");
const expansion = require("../js/weeklyFuturesExpansionShadow.js");

const ALL = [...config.PARTICIPANTS,
    expansion.CANDIDATES.UBS, expansion.CANDIDATES.SG];

function data(values = {}, expiry = "2026年09月限月") {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...ALL.map(participant => [
            "1", expiry, null, null, null,
            participant.participantCode,
            participant.brokerName,
            values[participant.key] ?? 100
        ])
    ]);
}

function version(sourceDate, futureOpenInterest) {
    return { sourceDate, futureOpenInterest };
}

async function candidate(sourceDate, values = {}) {
    const parsed = data(values);
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

async function makeHistory(candidates) {
    return (await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(), candidates,
        "2026-08-20T01:05:00.000Z"
    )).history;
}

test("shadow group定義は正式5社を保ちUBSとSGを正しいcodeで追加する", () => {
    assert.deepEqual(expansion.GROUPS.map(group =>
        group.participants.map(item => item.key)
    ), [
        ["JPM", "GS", "NOMURA", "BNP", "ABN"],
        ["JPM", "GS", "NOMURA", "BNP", "ABN", "UBS"],
        ["JPM", "GS", "NOMURA", "BNP", "ABN", "UBS", "SG"]
    ]);
    assert.equal(expansion.CANDIDATES.UBS.participantCode, "11746");
    assert.equal(expansion.CANDIDATES.SG.participantCode, "11788");
});

test("GROUP Aは正式結果と完全一致しBは6社Cは7社になる", () => {
    const previous = data();
    const current = data({ JPM: 110, UBS: 120, SG: 130 });
    const report = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    );
    const formal = weekly.calculateWeeklyBrokerJudgment(previous, current);
    assert.equal(report.groupAFormalMatch, true);
    assert.equal(report.groups.A.scoreDiff, formal.scoreDiff);
    assert.equal(report.groups.A.direction, formal.direction);
    assert.equal(report.groups.A.requiredBrokerCount, 5);
    assert.equal(report.groups.B.requiredBrokerCount, 6);
    assert.equal(report.groups.C.requiredBrokerCount, 7);
});

test("候補missingを0補完せずgroupをunavailableにする", () => {
    const previous = data();
    const current = data();
    current.records = current.records.filter(record =>
        record.participantCode !== "11746"
    );
    const result = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    ).groups.B;
    assert.equal(result.available, false);
    assert.equal(result.eligibleBrokerCount, 5);
    assert.equal(result.companyResults.UBS.current, null);
    assert.equal(result.companyResults.UBS.reason, "unpublished_expiry");
});

test("code/name mismatchとduplicate codeはfallbackせずinvalidにする", () => {
    const previous = data();
    const mismatched = data();
    mismatched.records.find(record =>
        record.participantCode === "11746"
    ).broker = "別名称";
    const mismatch = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", mismatched)
    ).groups.B;
    assert.equal(mismatch.available, false);
    assert.equal(mismatch.unavailableReason, "invalid_participant_identity");
    assert.equal(mismatch.companyResults.UBS.reason, "code_name_mismatch");

    const duplicate = data();
    duplicate.records.push({ ...duplicate.records.find(record =>
        record.participantCode === "11746"
    ) });
    const observation = expansion.getStrictCodeObservation(
        duplicate, expansion.CANDIDATES.UBS
    );
    assert.equal(observation.invalid, true);
    assert.equal(observation.reason, "duplicate_or_unknown_expiry");
});

test("現行式のscoreとnormalizationを平均化せず適用する", () => {
    const previous = data();
    const current = data({ JPM: 110, UBS: 120, SG: 130 });
    const groups = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", current)
    ).groups;
    assert.equal(groups.A.buyScore, 0.1);
    assert.equal(groups.B.buyScore, 0.30000000000000004);
    assert.equal(groups.C.buyScore, 0.6000000000000001);
    assert.equal(groups.C.sellScore, 0);
    assert.equal(groups.C.scoreDiff, groups.C.buyScore - groups.C.sellScore);
    assert.equal(groups.A.normalizedDirection, 1);
    assert.equal(groups.A.directionScore, 100);
    assert.equal(groups.B.scoreDiffDeltaFromA, 0.20000000000000004);
    assert.equal(groups.B.directionChangedFromA, false);
    assert.equal(groups.B.availabilityChangedFromA, false);
});

test("方向とavailabilityのA差分をpair単位で保持する", () => {
    const previous = data();
    const changed = data({ UBS: 110 });
    const result = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", changed)
    );
    assert.equal(result.groups.A.direction, "方向感薄い");
    assert.equal(result.groups.B.direction, "強い買い優勢");
    assert.equal(result.groups.B.directionChangedFromA, true);

    changed.records = changed.records.filter(record =>
        record.participantCode !== "11746"
    );
    const unavailable = expansion.comparePair(
        version("2026-08-01", previous),
        version("2026-08-08", changed)
    );
    assert.equal(unavailable.groups.A.available, true);
    assert.equal(unavailable.groups.B.availabilityChangedFromA, true);
    assert.equal(unavailable.groups.B.scoreDiffDeltaFromA, null);
});

test("history summaryはsaturation・方向変化・score感度を集計する", async () => {
    const input = await makeHistory([
        await candidate("2026-08-01"),
        await candidate("2026-08-08", { UBS: 110 }),
        await candidate("2026-08-15", { UBS: 100, SG: 120 })
    ]);
    const before = structuredClone(input);
    const report = await expansion.analyzeHistory(input);
    assert.equal(report.status, "complete");
    assert.equal(report.checkedRevisions, 3);
    assert.equal(report.checkedPairs, 2);
    assert.equal(report.summaries.A.availablePairs, 2);
    assert.equal(report.summaries.A.saturatedTotalPairs, 0);
    assert.equal(report.summaries.B.saturatedPositivePairs, 1);
    assert.equal(report.summaries.B.saturatedNegativePairs, 0);
    assert.equal(report.summaries.B.directionChangedFromACount, 1);
    assert.equal(report.summaries.C.saturatedTotalPairs, 2);
    assert.equal(report.summaries.C.averageAbsScoreDiff, 0.15000000000000002);
    assert.equal(report.summaries.C.maxAbsScoreDeltaFromA, 0.2);
    assert.deepEqual(input, before);
});

test("malformed historyを拒否し正式weeklyとoverallV2設定を変更しない", async () => {
    const formalBefore = weekly.calculateWeeklyBrokerJudgment(data(), data());
    const report = await expansion.analyzeHistory({});
    const formalAfter = weekly.calculateWeeklyBrokerJudgment(data(), data());
    const overallV2 = require("../js/overallJudgmentV2.js");
    assert.equal(report.status, "invalid_history");
    assert.deepEqual(formalAfter, formalBefore);
    assert.equal(weekly.BROKER_SET_VERSION, 1);
    assert.equal(weekly.SCORING_VERSION, 2);
    assert.equal(overallV2.CONFIG.weeklyNormalizationBase, 0.10);
    assert.equal(overallV2.CONFIG.weights.weekly, 45);
});
