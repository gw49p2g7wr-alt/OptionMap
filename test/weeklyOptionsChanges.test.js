const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");
const changes = require("../js/weeklyOptionsChanges.js");

function canonical({ sourceDate, expiry, strikes, values, participants = null }) {
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    const published = new Date(`${sourceDate}T00:00:00.000Z`);
    published.setUTCDate(published.getUTCDate() + 3);
    const publishedDate = published.toISOString().slice(0, 10);
    const [publishedYear, publishedMonth, publishedDay] = publishedDate.split("-");
    const records = [];
    for (const [typeIndex, optionType] of ["put", "call"].entries()) {
        for (const [sideIndex, side] of ["sell", "buy"].entries()) {
            strikes.forEach((strike, strikeIndex) => {
                const entries = participants?.[optionType]?.[side]?.[strikeIndex] || [{
                    code: String(10000 + typeIndex * 1000 + sideIndex * 100 + strikeIndex),
                    broker: `${optionType}-${side}-${strikeIndex}`,
                    value: values[optionType][strikeIndex]
                }];
                entries.forEach((entry, rankIndex) => records.push({
                    product: weekly.PRODUCT,
                    optionType,
                    expiry,
                    strike,
                    rank: entry.rank || rankIndex + 1,
                    participantCode: entry.code,
                    broker: entry.broker,
                    side,
                    published: true,
                    value: entry.value
                }));
            });
        }
    }
    const data = {
        parserVersion: weekly.PARSER_VERSION,
        schemaVersion: weekly.SCHEMA_VERSION,
        product: weekly.PRODUCT,
        sourceTitle: weekly.SOURCE_TITLE,
        sourceDateText: `（ ${year}年${Number(month)}月${Number(day)}日現在 ）`,
        publishedDateText:
            `${publishedYear}年${Number(publishedMonth)}月${Number(publishedDay)}日`,
        sourceHeaders: {
            put: `プット（${expiryYear}年${Number(expiryMonth)}月限月）`,
            call: `コール（${expiryYear}年${Number(expiryMonth)}月限月）`
        },
        sourceDate,
        publishedDate,
        optionExpiries: { put: expiry, call: expiry },
        strikes: { put: [...strikes], call: [...strikes] },
        records
    };
    assert.equal(weekly.validateWeeklyOptionsData(data), true);
    return data;
}

const previousValues = {
    put: [54, 46, 21, 609, 20],
    call: [30, 21, 20, 307, 16]
};
const currentValues = {
    put: [47, 977, 77, 215, 478],
    call: [8, 642, 32, 470, 38]
};

function actualShapePair() {
    return [
        canonical({
            sourceDate: "2026-07-31",
            expiry: "2026-08",
            strikes: [64125, 64250, 64375, 64500, 64625],
            values: previousValues
        }),
        canonical({
            sourceDate: "2026-08-07",
            expiry: "2026-08",
            strikes: [65375, 65500, 65625, 65750, 65875],
            values: currentValues
        })
    ];
}

test("canonicalを変更せずexact strikeとtranslated bucketを分離する", () => {
    const [previous, current] = actualShapePair();
    const beforePrevious = JSON.stringify(previous);
    const beforeCurrent = JSON.stringify(current);
    const result = changes.compareWeeklyOptions(previous, current);

    assert.equal(JSON.stringify(previous), beforePrevious);
    assert.equal(JSON.stringify(current), beforeCurrent);
    assert.equal(result.sameExpiry, true);
    assert.equal(result.status, "partial");
    assert.equal(result.comparisonCoverage.exactCommonStrikeCount, 0);
    assert.equal(result.comparisonCoverage.exactCommonStrikeRatio, 0);
    assert.equal(result.comparisonCoverage.translatedWindowComparable, true);
    assert.equal(result.strikeWindow.translation, 1250);
    assert.equal(result.relativeBucketChanges.length, 20);
    assert.ok(result.relativeBucketChanges.every(change =>
        change.comparisonBasis === "translated_bucket" &&
        change.warning === "different_strikes"
    ));
    assert.ok(result.strikeChanges.every(change =>
        change.comparisonBasis === "exact_strike" && change.delta === null
    ));
});

test("PUT/CALLの相対重心とstrike集中変化を事実値として生成する", () => {
    const [previous, current] = actualShapePair();
    const result = changes.compareWeeklyOptions(previous, current);

    assert.equal(
        result.distributionShift.put.sell.windowRelativeCentroidShift,
        -75.53233
    );
    assert.equal(
        result.distributionShift.call.sell.windowRelativeCentroidShift,
        -93.617498
    );
    assert.equal(result.distributionShift.put.sell.modeBucketShift, -2);
    assert.equal(result.distributionShift.call.sell.modeBucketShift, -2);
    assert.ok(result.concentrationChanges.strikeHhi.put.sell.delta < 0);
    assert.ok(result.concentrationChanges.strikeHhi.call.sell.delta < 0);
    assert.ok(result.labels.some(label =>
        label.code === "put_distribution_shifted_lower_relative_to_window"
    ));
    assert.equal("direction" in result, false);
    assert.equal("normalizedDirection" in result, false);
});

test("日付対応価格があれば支持抵抗の絶対移動と相対位置を比較する", () => {
    const [previous, current] = actualShapePair();
    const result = changes.compareWeeklyOptions(previous, current, {
        previousReferencePrice: 64375,
        currentReferencePrice: 65625,
        referencePriceBasis: "test_center_proxy"
    });

    assert.equal(result.supportChanges.available, true);
    assert.equal(result.supportChanges.previous.strike, 64250);
    assert.equal(result.supportChanges.current.strike, 65500);
    assert.equal(result.supportChanges.absoluteStrikeShift, 1250);
    assert.equal(result.supportChanges.relativeStepShift, 0);
    assert.equal(result.resistanceChanges.previous.strike, 64500);
    assert.equal(result.resistanceChanges.current.strike, 65750);
    assert.equal(result.resistanceChanges.absoluteStrikeShift, 1250);
    assert.equal(result.resistanceChanges.relativeStepShift, 0);
    assert.ok(result.labels.some(label =>
        label.code === "support_candidate_relative_position_unchanged"
    ));
    assert.ok(result.labels.some(label =>
        label.code === "resistance_candidate_relative_position_unchanged"
    ));
});

test("reference price欠落時は支持抵抗だけを利用不能にする", () => {
    const [previous, current] = actualShapePair();
    const result = changes.compareWeeklyOptions(previous, current);

    assert.equal(result.available, true);
    assert.deepEqual(result.supportChanges, {
        available: false, reason: "reference_prices_unavailable"
    });
    assert.equal(result.resistanceChanges.available, false);
    assert.ok(result.warnings.includes("support_resistance_reference_unavailable"));
});

test("非掲載を0にせずexact strike deltaをnullにする", () => {
    const [previous, current] = actualShapePair();
    const removed = current.records.findIndex(record =>
        record.optionType === "put" && record.side === "sell"
    );
    current.records.splice(removed, 1);
    assert.equal(weekly.validateWeeklyOptionsData(current), true);
    const result = changes.compareWeeklyOptions(previous, current);
    const oldStrike = result.strikeChanges.find(change =>
        change.optionType === "put" && change.side === "sell" &&
        change.strike === 64125
    );

    assert.equal(oldStrike.previous.published, true);
    assert.equal(oldStrike.current.published, false);
    assert.equal(oldStrike.current.value, null);
    assert.equal(oldStrike.delta, null);
});

test("slice全体が非掲載でもbreadth・HHI・重心を0比較しない", () => {
    const [previous, current] = actualShapePair();
    current.records = current.records.filter(record =>
        !(record.optionType === "call" && record.side === "buy")
    );
    assert.equal(weekly.validateWeeklyOptionsData(current), true);
    const result = changes.compareWeeklyOptions(previous, current);

    assert.deepEqual(result.breadthChanges.call.buy, {
        previous: 5,
        current: null,
        delta: null
    });
    assert.equal(
        result.concentrationChanges.participantHhi.call.buy.current,
        null
    );
    assert.equal(
        result.concentrationChanges.participantHhi.call.buy.delta,
        null
    );
    assert.equal(
        result.distributionShift.call.buy.windowRelativeCentroidShift,
        null
    );
});

test("participantCode単位で継続・新規掲載・非掲載化を区別する", () => {
    const strikes = [100, 200, 300, 400, 500];
    const values = { put: [10, 10, 10, 10, 10], call: [10, 10, 10, 10, 10] };
    const previousParticipants = {
        put: { sell: [
            [{ code: "001", broker: "旧名称", value: 6 },
                { code: "002", broker: "消える会社", value: 4 }]
        ] }
    };
    const currentParticipants = {
        put: { sell: [
            [{ code: "001", broker: "新名称", value: 8 },
                { code: "003", broker: "新規会社", value: 2 }]
        ] }
    };
    const previous = canonical({
        sourceDate: "2026-07-24", expiry: "2026-08", strikes, values,
        participants: previousParticipants
    });
    const current = canonical({
        sourceDate: "2026-07-31", expiry: "2026-08", strikes, values,
        participants: currentParticipants
    });
    const result = changes.compareWeeklyOptions(previous, current);
    const continued = result.participantChanges.find(change =>
        change.optionType === "put" && change.side === "sell" &&
        change.participantCode === "001"
    );

    assert.equal(continued.status, "continued");
    assert.equal(continued.delta, 2);
    assert.deepEqual(continued.brokerLabels,
        { previous: "旧名称", current: "新名称" });
    assert.ok(result.newlyPublished.some(change => change.participantCode === "003"));
    assert.ok(result.disappeared.some(change => change.participantCode === "002"));
    const disappeared = result.disappeared.find(change =>
        change.participantCode === "002"
    );
    assert.equal(disappeared.current.value, null);
    assert.equal(disappeared.delta, null);
});

test("rank変化には数量とcomparison basisを必ず併記する", () => {
    const [previous, current] = actualShapePair();
    previous.records.find(record =>
        record.optionType === "put" && record.side === "sell" &&
        record.strike === 64250
    ).participantCode = "99999";
    current.records.find(record =>
        record.optionType === "put" && record.side === "sell" &&
        record.strike === 65500
    ).participantCode = "99999";
    assert.equal(weekly.validateWeeklyOptionsData(previous), true);
    assert.equal(weekly.validateWeeklyOptionsData(current), true);
    const result = changes.compareWeeklyOptions(previous, current);
    const participant = result.participantChanges.find(change =>
        change.optionType === "put" && change.side === "sell" &&
        change.participantCode === "99999"
    );
    const rankChange = participant.rankChanges[0];

    assert.equal(rankChange.comparisonBasis, "translated_bucket");
    assert.equal(rankChange.warning, "different_strikes");
    assert.equal(Number.isInteger(rankChange.previousValue), true);
    assert.equal(Number.isInteger(rankChange.currentValue), true);
    assert.equal(Number.isInteger(rankChange.valueDelta), true);
    assert.equal(Number.isInteger(rankChange.previousRank), true);
    assert.equal(Number.isInteger(rankChange.currentRank), true);
});

test("breadthとparticipant HHIをoptionType・side別に比較する", () => {
    const strikes = [100, 200, 300, 400, 500];
    const values = { put: [10, 10, 10, 10, 10], call: [10, 10, 10, 10, 10] };
    const previous = canonical({
        sourceDate: "2026-07-24", expiry: "2026-08", strikes, values
    });
    const participants = { call: { buy: [
        [{ code: "201", broker: "A", value: 5 },
            { code: "202", broker: "B", value: 5 }]
    ] } };
    const current = canonical({
        sourceDate: "2026-07-31", expiry: "2026-08", strikes, values,
        participants
    });
    const result = changes.compareWeeklyOptions(previous, current);

    assert.equal(result.breadthChanges.call.buy.previous, 5);
    assert.equal(result.breadthChanges.call.buy.current, 6);
    assert.equal(result.breadthChanges.call.buy.delta, 1);
    assert.ok(result.concentrationChanges.participantHhi.call.buy.delta < 0);
});

test("異なる限月はroll_transitionで数量比較しない", () => {
    const [previous] = actualShapePair();
    const current = canonical({
        sourceDate: "2026-08-07", expiry: "2026-09",
        strikes: [65375, 65500, 65625, 65750, 65875], values: currentValues
    });
    const result = changes.compareWeeklyOptions(previous, current);

    assert.equal(result.available, false);
    assert.equal(result.sameExpiry, false);
    assert.equal(result.status, "roll_transition");
    assert.equal(result.strikeChanges.length, 0);
    assert.ok(result.warnings.includes("different_expiries_not_compared"));
});

test("不正canonicalとsourceDate逆転を拒否する", () => {
    assert.equal(changes.compareWeeklyOptions({}, {}).reason, "invalid_canonical");
    const [previous, current] = actualShapePair();
    assert.equal(
        changes.compareWeeklyOptions(current, previous).reason,
        "source_date_order_invalid"
    );
});
