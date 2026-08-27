const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const weekly = require("../js/weeklyFutures.js");
const historyApi = require("../js/weeklyFuturesHistory.js");
const config = require("../js/weeklyBrokerConfig.js");
const shadow = require("../js/weeklyFuturesTwelveGroupShadow.js");

const PHYSICAL_PARTICIPANTS = [
    ...config.PARTICIPANTS,
    shadow.ADDITIONAL_PARTICIPANTS.SG,
    shadow.ADDITIONAL_PARTICIPANTS.MORGAN_MUFG,
    shadow.ADDITIONAL_PARTICIPANTS.SBI,
    shadow.ADDITIONAL_PARTICIPANTS.RAKUTEN,
    shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ,
    shadow.ADDITIONAL_PARTICIPANTS.DAIWA,
    shadow.ADDITIONAL_PARTICIPANTS.CITI,
    shadow.ADDITIONAL_PARTICIPANTS.BARCLAYS
];

function data(values = {}, expiry = "2026年09月限月") {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...PHYSICAL_PARTICIPANTS.map(item => [
            "1", expiry, null, null, null,
            item.participantCode,
            item.brokerName,
            values[item.key] ?? 100
        ])
    ]);
}

function version(sourceDate, input) {
    return {
        sourceDate,
        versionKey: `fixture-${sourceDate}`,
        futureOpenInterest: input
    };
}

function remove(input, ...keys) {
    const codes = new Set(keys.map(key =>
        PHYSICAL_PARTICIPANTS.find(item => item.key === key).participantCode
    ));
    input.records = input.records.filter(record =>
        !codes.has(record.participantCode)
    );
    for (const product of Object.values(input.products)) {
        for (const [broker, value] of Object.entries(product.brokers)) {
            if (codes.has(value.participantCode)) delete product.brokers[broker];
        }
    }
    for (const [broker, value] of Object.entries(input.brokerTotals)) {
        if (codes.has(value.participantCode)) delete input.brokerTotals[broker];
    }
    return input;
}

function pair(current = data(), previous = data()) {
    return shadow.calculatePair(
        version("2026-08-07", previous),
        version("2026-08-14", current)
    );
}

async function candidate(sourceDate, input) {
    const signature = await weekly.createSignature(input);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/2026/${compact}_indexfut_oi_by_tp.xlsx`;
    return {
        sourceDate,
        sourceUrl,
        fetchedAt: "2026-08-20T01:00:00.000Z",
        signature,
        versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`,
        data: input,
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

test("12 scoring groupsと13 physical participantsのidentityを固定する", () => {
    assert.equal(shadow.GROUP_DEFINITIONS.length, 12);
    assert.equal(PHYSICAL_PARTICIPANTS.length, 13);
    assert.deepEqual(shadow.CORE_GROUP_IDS,
        ["JPM", "GS", "NOMURA", "BNP", "ABN"]);
    assert.deepEqual(shadow.GROUP_DEFINITIONS.map(group => group.id), [
        "JPM", "GS", "NOMURA", "BNP", "ABN", "SG", "MORGAN_MUFG",
        "SBI_RAKUTEN", "MITSUBISHI_UFJ", "DAIWA", "CITI", "BARCLAYS"
    ]);
    assert.equal(
        shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ.participantCode,
        "11520"
    );
    assert.equal(
        shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ.brokerName,
        "三菱ＵＦＪ証券"
    );
});

test("12/12・11/12・10/12をqualityStateへ変換する", () => {
    const full = pair();
    const oneMissing = pair(remove(data(), "MITSUBISHI_UFJ"));
    const twoMissing = pair(remove(data(), "MITSUBISHI_UFJ", "CITI"));
    assert.equal(full.qualityState, "full");
    assert.equal(oneMissing.qualityState, "partial_one_missing");
    assert.equal(twoMissing.qualityState, "partial_two_missing");
    assert.deepEqual(oneMissing.missingGroups, ["MITSUBISHI_UFJ"]);
    assert.deepEqual(twoMissing.missingGroups, ["MITSUBISHI_UFJ", "CITI"]);
});

test("9/12以下はinsufficient_group_countでunavailableになる", () => {
    const result = pair(remove(
        data(), "MITSUBISHI_UFJ", "CITI", "BARCLAYS"
    ));
    assert.equal(result.availableGroupCount, 9);
    assert.equal(result.available, false);
    assert.equal(result.qualityState, "unavailable");
    assert.equal(result.reason, "insufficient_group_count");
    assert.equal(result.rawScoreDiff, null);
    assert.equal(result.scaledScoreDiff, null);
});

for (const key of ["JPM", "GS", "NOMURA", "BNP", "ABN"]) {
    test(`${key} missingはgroup数にかかわらずcore_group_missing`, () => {
        const result = pair(remove(data(), key));
        assert.equal(result.availableGroupCount, 11);
        assert.equal(result.coreGroupsAvailable, false);
        assert.equal(result.available, false);
        assert.equal(result.reason, "core_group_missing");
    });
}

test("SBI＋楽天は両社availableの場合だけ1 scoring groupになる", () => {
    const both = pair();
    const sbiOnly = pair(remove(data(), "RAKUTEN"));
    const rakutenOnly = pair(remove(data(), "SBI"));
    const neither = pair(remove(data(), "SBI", "RAKUTEN"));
    assert.equal(both.groups.SBI_RAKUTEN.availability, true);
    for (const result of [sbiOnly, rakutenOnly, neither]) {
        assert.equal(result.groups.SBI_RAKUTEN.availability, false);
        assert.equal(
            result.groups.SBI_RAKUTEN.reason,
            "composite_group_unavailable"
        );
        assert.equal(result.groups.SBI_RAKUTEN.contribution, null);
    }
    assert.deepEqual(sbiOnly.missingGroups, ["SBI_RAKUTEN"]);
    assert.equal(neither.availableGroupCount, 11);
});

test("SBI＋楽天は建玉を先に合算してcontributionを1回だけ算出する", () => {
    const previous = data({ SBI: 100, RAKUTEN: 100 });
    const current = data({ SBI: 110, RAKUTEN: 130 });
    const result = pair(current, previous).groups.SBI_RAKUTEN;
    assert.deepEqual(result.previous, { sell: 0, buy: 200, net: 200 });
    assert.deepEqual(result.current, { sell: 0, buy: 240, net: 240 });
    assert.deepEqual(result.delta, { sell: 0, buy: 40, net: 40 });
    assert.equal(result.status, "estimatedBuy");
    assert.equal(result.contribution, 0.2);
    assert.notEqual(result.contribution, 0.4);
});

test("missingを0補完せず固定denominator 12でscaleする", () => {
    const previous = data();
    const current = remove(data({ SG: 124 }), "MITSUBISHI_UFJ", "CITI");
    const result = pair(current, previous);
    assert.equal(result.availableGroupCount, 10);
    assert.equal(result.rawScoreDiff, 0.24);
    assert.ok(Math.abs(result.scaledScoreDiff - 0.1) < 1e-12);
    assert.deepEqual(result.normalization, {
        method: "raw_score_diff_times_5_over_12",
        numeratorBase: 5,
        denominator: 12
    });
    assert.equal(result.groups.MITSUBISHI_UFJ.contribution, null);
    assert.equal(result.groups.CITI.contribution, null);
});

test("directionとdominanceはscaled scoreの診断metadataとして返す", () => {
    const result = pair(data({ SG: 125 }));
    assert.equal(result.direction, "強い買い優勢");
    assert.equal(result.normalizedDirection, 1);
    assert.equal(result.directionScore, 100);
    assert.equal(result.dominantGroup, "SG");
    assert.equal(result.dominanceRatio, 1);
    assert.equal(result.groups.SG.sourceMetadata.previousSourceDate,
        "2026-08-07");
    assert.equal(result.groups.SG.members[0].participantCode, "11788");
});

test("正式historyをread-onlyでpair reportへ再現する", async () => {
    const history = (await historyApi.mergeCandidates(
        historyApi.createEmptyHistory(),
        [
            await candidate("2026-08-07", data()),
            await candidate("2026-08-14", data({ SG: 124 }))
        ],
        "2026-08-20T01:05:00.000Z"
    )).history;
    const before = structuredClone(history);
    const report = await shadow.analyzeHistory(history);
    assert.equal(report.status, "complete");
    assert.equal(report.checkedRevisions, 2);
    assert.equal(report.checkedPairs, 1);
    assert.equal(report.pairReports[0].qualityState, "full");
    assert.deepEqual(history, before);
});

test("正式5社・overallV2・storage・独立UI計算から隔離する", () => {
    const formalBefore = weekly.calculateWeeklyBrokerJudgment(data(), data());
    pair(data({ SG: 124 }));
    const formalAfter = weekly.calculateWeeklyBrokerJudgment(data(), data());
    const overallV2 = require("../js/overallJudgmentV2.js");
    const source = fs.readFileSync(
        require.resolve("../js/weeklyFuturesTwelveGroupShadow.js"), "utf8"
    );
    const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
    assert.deepEqual(formalAfter, formalBefore);
    assert.equal(weekly.BROKER_SET_VERSION, 1);
    assert.equal(weekly.SCORING_VERSION, 2);
    assert.equal(overallV2.CONFIG.weeklyNormalizationBase, 0.10);
    assert.doesNotMatch(source, /localStorage|indexedDB|setItem|\.put\(/);
    assert.match(html,
        /<script src="js\/weeklyFuturesTwelveGroupShadow\.js"><\/script>/);
    assert.doesNotMatch(source, /document\.|querySelector|createElement/);
    assert.doesNotMatch(html, /TwelveGroup.*(?:Toggle|Weight|History)/);
    assert.match(html,
        /weeklyFuturesTwelveGroupDualRunRuntime\.js[\s\S]*weeklyFuturesTwelveGroupReferenceView\.js/);
});
