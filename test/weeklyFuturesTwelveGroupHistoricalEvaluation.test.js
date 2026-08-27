const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const brokerConfig = require("../js/weeklyBrokerConfig.js");
const shadow = require("../js/weeklyFuturesTwelveGroupShadow.js");
const adapter = require(
    "../js/weeklyFuturesTwelveGroupFormalPairAdapter.js"
);
const Evaluation = require(
    "../js/weeklyFuturesTwelveGroupHistoricalEvaluation.js"
);

const PARTICIPANTS = [
    ...brokerConfig.PARTICIPANTS,
    shadow.ADDITIONAL_PARTICIPANTS.SG,
    shadow.ADDITIONAL_PARTICIPANTS.MORGAN_MUFG,
    shadow.ADDITIONAL_PARTICIPANTS.SBI,
    shadow.ADDITIONAL_PARTICIPANTS.RAKUTEN,
    shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ,
    shadow.ADDITIONAL_PARTICIPANTS.DAIWA,
    shadow.ADDITIONAL_PARTICIPANTS.CITI,
    shadow.ADDITIONAL_PARTICIPANTS.BARCLAYS
];
const CORE = new Set(brokerConfig.PARTICIPANTS.map(item => item.key));
const DATES = ["2026-07-03", "2026-07-10", "2026-07-17",
    "2026-07-24", "2026-07-31", "2026-08-07", "2026-08-14",
    "2026-08-21"];

function data(index, { omitted = [], coreStep = 10, additionalStep = 30 } = {}) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...PARTICIPANTS.filter(item => !omitted.includes(item.key)).map(item => {
            const core = CORE.has(item.key);
            const value = 100 + index * (core ? coreStep : additionalStep);
            return core
                ? ["1", "2026年09月限月", null, null, null,
                    item.participantCode, item.brokerName, value]
                : ["1", "2026年09月限月", item.participantCode,
                    item.brokerName, value, null, null, null];
        })
    ]);
}

async function candidate(sourceDate, canonical, index) {
    const signature = await weekly.createSignature(canonical);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/2026/${compact}_indexfut_oi_by_tp.xlsx`;
    return {
        sourceDate,
        sourceUrl,
        fetchedAt: `2026-08-2${index}T01:00:00.000Z`,
        signature,
        versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`,
        data: canonical,
        officialMetadata: {
            origin: "jpx_open_interest_year_listing",
            listingUrl: "https://www.jpx.co.jp/automation/markets/" +
                "derivatives/open-interest/json/open_interest_2026.json",
            listingUpdatedAt: `2026-08-2${index}T10:00:00+09:00`,
            tradeDate: sourceDate,
            indexFuturesUrl: sourceUrl,
            publishedDate: `2026-08-2${index}`,
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

async function history(configuration = {}) {
    const candidates = [];
    for (let index = 0; index < DATES.length; index += 1) {
        const omitted = index === configuration.missingAt
            ? configuration.omitted || [] : [];
        candidates.push(await candidate(DATES[index], data(index, {
            omitted,
            coreStep: configuration.coreStep ?? 10,
            additionalStep: configuration.additionalStep ?? 30
        }), index));
    }
    return (await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(), candidates,
        "2026-08-29T01:05:00.000Z"
    )).history;
}

test("valid 8-week historyを7 adjacent pairへ評価する", async () => {
    const result = await Evaluation.evaluateHistory(await history());
    assert.equal(result.status, "complete");
    assert.equal(result.historyIdentity.entryCount, 8);
    assert.equal(result.historyIdentity.activeVersionCount, 8);
    assert.equal(result.pairCount, 7);
    assert.deepEqual(result.pairs.map(pair =>
        `${pair.previousDate}->${pair.currentDate}`
    ), DATES.slice(1).map((date, index) => `${DATES[index]}->${date}`));
});

test("全pairでsame formal identityを証明する", async () => {
    const result = await Evaluation.evaluateHistory(await history());
    assert.equal(result.diagnostics.samePairVerifiedCount, 7);
    assert.equal(result.pairs.every(pair => pair.samePairVerified), true);
    assert.equal(result.historyIdentity.fingerprint.startsWith("sha256:"), true);
});

test("invalid history・revision signature・activeVersion mismatchをrejectする",
    async () => {
        for (const mutate of [
            value => { value.version = 99; },
            value => { value.entries[0].revisions[0].signature = "a".repeat(64); },
            value => { value.entries[0].activeVersionKey = "missing"; }
        ]) {
            const value = await history();
            mutate(value);
            const result = await Evaluation.evaluateHistory(value);
            assert.equal(result.status, "invalid_history");
            assert.equal(result.pairCount, 0);
        }
    });

test("Major5と12-groupの既存Pure計算結果を保持する", async () => {
    const result = await Evaluation.evaluateHistory(await history());
    const pair = result.pairs[0];
    assert.equal(pair.major5.available, true);
    assert.equal(pair.major5.requiredBrokerCount, 5);
    assert.equal(pair.major5.brokers.JPM.classification, "estimatedBuy");
    assert.equal(pair.groups12.available, true);
    assert.equal(pair.groups12.groups.SG.status, "estimatedSell");
    assert.equal(pair.groups12.groups.SG.contribution < 0, true);
    assert.equal(Number.isFinite(pair.groups12.rawScoreDiff), true);
    assert.equal(Number.isFinite(pair.groups12.scaledScoreDiff), true);
});

test("Major5 unavailableと12-group unavailableを区別する", async () => {
    const result = await Evaluation.evaluateHistory(await history({
        missingAt: 3, omitted: ["JPM"]
    }));
    const affected = result.pairs.filter(pair =>
        pair.currentDate === DATES[3] || pair.previousDate === DATES[3]
    );
    assert.equal(affected.length, 2);
    for (const pair of affected) {
        assert.equal(pair.major5.available, false);
        assert.equal(pair.groups12.available, false);
        assert.equal(pair.groups12.reason, "core_group_missing");
        assert.equal(pair.agreement, "unavailable");
    }
});

test("追加group missingをzero-fillせずcoverageへ集計する", async () => {
    const result = await Evaluation.evaluateHistory(await history({
        missingAt: 3, omitted: ["CITI"]
    }));
    assert.equal(result.summary.missingByGroup.CITI, 2);
    assert.equal(result.summary.groupSummaries.CITI.missingPairCount, 2);
    assert.equal(result.pairs.filter(pair =>
        pair.groups12.missingGroups.includes("CITI")
    ).every(pair => pair.groups12.groups.CITI.contribution === null), true);
});

test("agreement counts・delta平均・最大差・reversalを集計する", async () => {
    const result = await Evaluation.evaluateHistory(await history());
    assert.equal(Object.values(result.summary.agreementCounts)
        .reduce((sum, value) => sum + value, 0), 7);
    assert.equal(result.summary.agreementCounts.opposite_direction, 7);
    assert.equal(result.summary.reversalPairs.length, 7);
    assert.equal(Number.isFinite(result.summary.averageAbsoluteDelta), true);
    assert.equal(Number.isFinite(
        result.summary.maximumAbsoluteDelta.value
    ), true);
});

test("same/different/opposite/zero/unavailable taxonomyをsummaryへ保持する", () => {
    const groups = adapter.configDescriptor().groups;
    const groupResults = Object.fromEntries(groups.map(group => [group.id, {
        availability: true, status: "unconfirmed", contribution: 0
    }]));
    const pair = agreement => ({
        previousDate: "2026-08-07", currentDate: "2026-08-14",
        agreement,
        delta: { normalizedDirection: agreement === "unavailable" ? null : 0 },
        major5: { available: agreement !== "unavailable" },
        groups12: { missingGroups: [], groups: groupResults,
            dominantGroup: null, dominanceRatio: null }
    });
    const summary = Evaluation.summarizePairs([
        pair("same_direction"), pair("different_strength"),
        pair("opposite_direction"), pair("zero_involved"),
        pair("unavailable")
    ], groups);
    assert.deepEqual(summary.agreementCounts, {
        same_direction: 1, different_strength: 1,
        opposite_direction: 1, zero_involved: 1, unavailable: 1
    });
});

test("group classification・contribution sign・dominant回数を集計する",
    async () => {
        const result = await Evaluation.evaluateHistory(await history());
        const sg = result.summary.groupSummaries.SG;
        assert.equal(sg.availablePairCount, 7);
        assert.equal(sg.estimatedSellCount, 7);
        assert.equal(sg.negativeContributionCount, 7);
        assert.equal(Object.values(result.summary.dominantGroupCounts)
            .reduce((sum, value) => sum + value, 0), 7);
    });

test("dominanceRatio average/max/minを既存値だけから集計する", async () => {
    const ratio = (await Evaluation.evaluateHistory(await history()))
        .summary.dominanceRatio;
    assert.equal(Number.isFinite(ratio.average), true);
    assert.equal(ratio.minimum <= ratio.average, true);
    assert.equal(ratio.average <= ratio.maximum, true);
});

test("config identityとraw/scaled scoreを全pairで保持する", async () => {
    const result = await Evaluation.evaluateHistory(await history());
    assert.equal(result.configIdentity.configVersion,
        "weekly-scoring-groups-v1");
    assert.equal(result.configIdentity.scoringVersion,
        "twelve-group-shadow-scoring-v1");
    assert.equal(result.pairs.every(pair =>
        finite(pair.groups12.rawScoreDiff) &&
        finite(pair.groups12.scaledScoreDiff)
    ), true);
});

function finite(value) {
    return Number.isFinite(value);
}

test("outputはdeep frozenでinputを変更しない", async () => {
    const input = await history();
    const before = structuredClone(input);
    const result = await Evaluation.evaluateHistory(input);
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.pairs[0].groups12.groups), true);
    assert.equal(result.diagnostics.inputMutated, false);
});

test("storage/fetch/DOM/runtime/OverallV2から隔離する", () => {
    const source = fs.readFileSync(require.resolve(
        "../js/weeklyFuturesTwelveGroupHistoricalEvaluation.js"
    ), "utf8");
    const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /document\.|querySelector|createElement/);
    assert.doesNotMatch(source, /calculateOverallJudgmentV2|weightedContribution/);
    assert.doesNotMatch(source, /publish|runtime state|setInterval|setTimeout/i);
    assert.doesNotMatch(html,
        /weeklyFuturesTwelveGroupHistoricalEvaluation\.js/);
});
