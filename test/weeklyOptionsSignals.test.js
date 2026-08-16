const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");
const signals = require("../js/weeklyOptionsSignals.js");

const BLOCK_STARTS = [10, 25, 40, 55, 70];

function rowsFixture({
    sourceDate = "2026-08-07",
    putExpiry = "2026-08",
    callExpiry = putExpiry,
    populate = true
} = {}) {
    const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [putYear, putMonth] = putExpiry.split("-");
    const [callYear, callMonth] = callExpiry.split("-");
    rows[0][0] = weekly.SOURCE_TITLE;
    rows[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    rows[2][0] = `${year}年${month}月10日`;
    rows[6][1] = `プット（${putYear}年${putMonth}月限月）`;
    rows[6][11] = `コール（${callYear}年${callMonth}月限月）`;

    BLOCK_STARTS.forEach((start, block) => {
        const strike = 65375 + block * 125;
        rows[start - 1][1] = strike;
        rows[start - 1][11] = strike;
        for (let rank = 1; rank <= 15; rank += 1) {
            const row = rows[start + rank - 2];
            row[0] = rank;
            row[10] = rank;
            if (!populate) continue;
            for (const [typeIndex, optionType] of ["put", "call"].entries()) {
                const base = optionType === "put" ? 1 : 11;
                for (const [sideIndex, side] of ["sell", "buy"].entries()) {
                    const offset = side === "sell" ? 1 : 4;
                    row[base + offset] = String(
                        10000 + typeIndex * 3000 + sideIndex * 1500 + block * 20 + rank
                    );
                    row[base + offset + 1] =
                        `${optionType}-${side}-${block}-${rank}`;
                    const baseValue = optionType === "put"
                        ? (side === "sell" ? 80 : 40)
                        : (side === "sell" ? 60 : 100);
                    row[base + offset + 2] = baseValue + rank + block;
                }
            }
        }
    });
    return rows;
}

function canonical(options) {
    return weekly.parseWeeklyOptionsRows(rowsFixture(options));
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}

test("canonicalを変更せずrank 1〜15を全strike・全sideで集計する", () => {
    const data = canonical();
    const before = JSON.stringify(data);
    deepFreeze(data);
    const result = signals.deriveWeeklyOptionsSignals(data, { currentPrice: 65625 });

    assert.equal(result.available, true);
    assert.equal(JSON.stringify(data), before);
    assert.equal(result.strikeMetrics.length, 10);
    const put = result.strikeMetrics.find(metric =>
        metric.optionType === "put" && metric.strike === 65500
    );
    assert.deepEqual(put.sell.ranks, Array.from({ length: 15 }, (_, index) => index + 1));
    assert.equal(put.sell.participantCount, 15);
    assert.equal(put.buy.participantCount, 15);
    assert.equal(put.sell.participants.length, 15);
    assert.equal(typeof put.sell.participants[0].participantCode, "string");
    assert.equal(Number.isSafeInteger(put.sell.participants[0].value), true);
});

test("PUT/CALLとbuy/sellを混合せず4種類の派生材料を生成する", () => {
    const result = signals.deriveWeeklyOptionsSignals(canonical(), {
        currentPrice: 65625
    });

    assert.equal(result.lowerSupport.published, true);
    assert.equal(result.upperResistance.published, true);
    assert.equal(result.upsideAppetite.published, true);
    assert.equal(result.downsideProtection.published, true);
    assert.ok(result.upsideAppetite.weightedValue > result.upperResistance.weightedValue);
    assert.ok(result.lowerSupport.weightedValue > result.downsideProtection.weightedValue);
    assert.equal(result.label, "bullish");
    assert.ok(result.normalizedDirection > 0);
});

test("非掲載sideはvalue:nullのままで0へ変換しない", () => {
    const rows = rowsFixture({ populate: false });
    const first = BLOCK_STARTS[0] - 1;
    rows[first][2] = "10001";
    rows[first][3] = "PUT売り証券";
    rows[first][4] = 100;
    rows[first][12] = "13001";
    rows[first][13] = "CALL売り証券";
    rows[first][14] = 100;
    const data = weekly.parseWeeklyOptionsRows(rows);
    const result = signals.deriveWeeklyOptionsSignals(data, { currentPrice: 65375 });
    const metric = result.strikeMetrics.find(item =>
        item.optionType === "put" && item.strike === 65375
    );

    assert.equal(result.available, false);
    assert.equal(result.reason, "insufficient_published_observations");
    assert.equal(metric.buy.published, false);
    assert.equal(metric.buy.value, null);
    assert.equal(metric.sideBalance, -1);
});

test("participantCodeのbreadthと数量ベースのconcentrationを生成する", () => {
    const result = signals.deriveWeeklyOptionsSignals(canonical(), {
        currentPrice: 65625
    });

    assert.equal(result.breadth.factor, 1);
    assert.ok(result.breadth.participantCount >= 8);
    assert.ok(result.concentration.meanHhi > 0);
    assert.ok(result.concentration.meanHhi < 1);
    assert.ok(result.evidenceFactor > 0);
    assert.ok(result.evidenceFactor <= 1);
});

test("current priceからの距離をstrike中央値間隔で減衰する", () => {
    const result = signals.deriveWeeklyOptionsSignals(canonical(), {
        currentPrice: 65625
    });
    const exact = result.strikeMetrics.find(metric =>
        metric.optionType === "call" && metric.strike === 65625
    );
    const oneStep = result.strikeMetrics.find(metric =>
        metric.optionType === "call" && metric.strike === 65750
    );
    const twoSteps = result.strikeMetrics.find(metric =>
        metric.optionType === "call" && metric.strike === 65875
    );

    assert.equal(result.strikeStep, 125);
    assert.equal(exact.distanceWeight, 1);
    assert.equal(oneStep.distanceWeight, 0.5);
    assert.equal(twoSteps.distanceWeight, 0);
});

test("現在値が利用可能strike帯から外れる場合は材料不足にする", () => {
    const result = signals.deriveWeeklyOptionsSignals(canonical(), {
        currentPrice: 70000
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "current_price_outside_strike_range");
    assert.equal(result.normalizedDirection, null);
});

test("PUT/CALLの限月不一致は統合しない", () => {
    const result = signals.deriveWeeklyOptionsSignals(canonical({
        putExpiry: "2026-08", callExpiry: "2026-09"
    }), { currentPrice: 65625 });
    assert.equal(result.available, false);
    assert.equal(result.reason, "expiry_mismatch");
});

test("cache・remote状態は方向ではなくqualityだけを減衰する", () => {
    const data = canonical();
    const live = signals.deriveWeeklyOptionsSignals(data, {
        currentPrice: 65625,
        sourceMetadata: { origin: "live", remoteCheckStatus: "current" }
    });
    const staleCache = signals.deriveWeeklyOptionsSignals(data, {
        currentPrice: 65625,
        sourceMetadata: { origin: "cache", remoteCheckStatus: "newer_available" }
    });
    assert.equal(live.normalizedDirection, staleCache.normalizedDirection);
    assert.equal(live.qualityFactor, 0.65);
    assert.equal(staleCache.qualityFactor, 0.234);
});

test("同じ数量でも参加者集中が高い方はevidenceが低い", () => {
    const broad = canonical();
    const concentrated = structuredClone(broad);
    for (const record of concentrated.records) {
        record.participantCode = String(90000 + record.rank);
    }
    assert.equal(weekly.validateWeeklyOptionsData(concentrated), true);
    const broadResult = signals.deriveWeeklyOptionsSignals(broad, { currentPrice: 65625 });
    const concentratedResult = signals.deriveWeeklyOptionsSignals(
        concentrated, { currentPrice: 65625 }
    );
    assert.ok(broadResult.breadth.participantCount >
        concentratedResult.breadth.participantCount);
    assert.ok(broadResult.evidenceFactor > concentratedResult.evidenceFactor);
});

test("不正canonicalとcurrent price欠落を方向判定しない", () => {
    assert.equal(signals.deriveWeeklyOptionsSignals({}, {
        currentPrice: 65625
    }).reason, "invalid_canonical");
    const result = signals.deriveWeeklyOptionsSignals(canonical(), {});
    assert.equal(result.available, false);
    assert.equal(result.reason, "current_price_unavailable");
});
