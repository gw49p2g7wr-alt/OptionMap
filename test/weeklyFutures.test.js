const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyFutures.js");

const heading = product => [`＜${product}＞`];
const row = ({
    expiry = "2026年09月限月",
    sellCode = null,
    sellBroker = null,
    sellValue = null,
    buyCode = null,
    buyBroker = null,
    buyValue = null
} = {}) => [
    "1", expiry,
    sellCode, sellBroker, sellValue,
    buyCode, buyBroker, buyValue
];

function parse(rows) {
    return weekly.parseWeeklyFuturesRows([
        heading("日経225先物"),
        ...rows
    ]);
}

function observationData({
    side = "buy",
    value = 100,
    broker = "テスト証券",
    code = "10001",
    expiry = "2026年09月限月"
} = {}) {
    return parse([row(side === "sell" ? {
        expiry, sellCode: code, sellBroker: broker, sellValue: value
    } : {
        expiry, buyCode: code, buyBroker: broker, buyValue: value
    })]);
}

test("実JPX Excelの正式列位置から売買を読む", () => {
    const data = parse([[
        "1", "2026年09月限月",
        "12724", "ＨＳＢＣ証券", "33,597",
        "12400", "野村証券", "33,492"
    ]]);
    assert.deepEqual(data.records, [
        {
            product: "日経225先物",
            participantCode: "12724",
            broker: "ＨＳＢＣ証券",
            expiry: "2026-09",
            side: "sell",
            published: true,
            value: 33597
        },
        {
            product: "日経225先物",
            participantCode: "12400",
            broker: "野村証券",
            expiry: "2026-09",
            side: "buy",
            published: true,
            value: 33492
        }
    ]);
});

test("participantCodeを数量へ混入させない", () => {
    const data = parse([row({
        sellCode: 11714,
        sellBroker: "ＪＰモルガン証券",
        sellValue: 1234
    })]);
    assert.equal(data.records[0].participantCode, "11714");
    assert.equal(data.records[0].value, 1234);
});

test("片側掲載は反対側observationをunpublished nullにする", () => {
    const data = observationData();
    const position = data.products["日経225先物"]
        .brokers["テスト証券"].expiries["2026-09"];
    assert.deepEqual(position.observations.sell, {
        published: false,
        value: null
    });
    assert.deepEqual(position.observations.buy, {
        published: true,
        value: 100
    });
});

test("完全非掲載はbroker keyを作らず照会結果をnullにする", () => {
    const data = observationData();
    assert.equal(data.products["日経225先物"].brokers["未掲載証券"], undefined);
    const result = weekly.getBrokerObservation(
        data, "日経225先物", "未掲載証券"
    );
    assert.equal(result.complete, false);
    assert.equal(result.byExpiry["2026-09"].published, false);
    assert.equal(result.byExpiry["2026-09"].value, null);
});

test("複数限月と両側掲載を会社別に集計する", () => {
    const data = parse([
        row({ sellCode: "10001", sellBroker: "テスト証券", sellValue: 120 }),
        row({
            expiry: "2026年12月限月",
            buyCode: "10001",
            buyBroker: "テスト証券",
            buyValue: 80
        })
    ]);
    const broker = data.products["日経225先物"].brokers["テスト証券"];
    assert.deepEqual(data.products["日経225先物"].expiryKeys, [
        "2026-09", "2026-12"
    ]);
    assert.equal(broker.sell, 120);
    assert.equal(broker.buy, 80);
    assert.equal(broker.net, -40);
    assert.equal(data.brokerTotals["テスト証券"].net, -40);
    assert.equal(weekly.getBrokerObservation(
        data, "日経225先物", "テスト証券"
    ).complete, true);
});

test("schema validatorは正式parser結果だけを受理する", () => {
    const data = observationData();
    assert.equal(weekly.validateWeeklyFuturesData(data), true);
    const broken = structuredClone(data);
    broken.records[0].value = 999;
    assert.equal(weekly.validateWeeklyFuturesData(broken), false);
});

test("signatureは順序に安定し値変更で変化する", async () => {
    const data = parse([
        row({ sellCode: "10001", sellBroker: "A証券", sellValue: 100 }),
        row({ buyCode: "10002", buyBroker: "B証券", buyValue: 200 })
    ]);
    const reordered = structuredClone(data);
    reordered.records.reverse();
    const compatibility = weekly.parseWeeklyFuturesRows([
        heading("日経225先物"),
        row({ buyCode: "10002", buyBroker: "B証券", buyValue: 200 }),
        row({ sellCode: "10001", sellBroker: "A証券", sellValue: 100 })
    ]);
    assert.equal(await weekly.createSignature(data),
        await weekly.createSignature(compatibility));
    const changed = parse([
        row({ sellCode: "10001", sellBroker: "A証券", sellValue: 101 }),
        row({ buyCode: "10002", buyBroker: "B証券", buyValue: 200 })
    ]);
    assert.notEqual(await weekly.createSignature(data),
        await weekly.createSignature(changed));
});

test("旧parserVersion cacheを拒否し新cacheを復元できる", async () => {
    const data = observationData();
    const signature = await weekly.createSignature(data);
    const cache = {
        version: 2,
        parserVersion: weekly.PARSER_VERSION,
        schemaVersion: weekly.SCHEMA_VERSION,
        brokerSetVersion: weekly.BROKER_SET_VERSION,
        scoringVersion: weekly.SCORING_VERSION,
        sourceDate: "2026-08-07",
        signature,
        versionKey: `weekly-futures-v2|2026-08-07|sha256:${signature}`,
        data
    };
    assert.equal(await weekly.validateVersionedCacheData(cache), true);
    assert.equal(await weekly.validateVersionedCacheData({
        ...cache, parserVersion: 1
    }), false);
});

for (const [name, previousSide, previousValue, currentSide, currentValue,
    expected] of [
    ["estimatedBuy", "buy", 100, "buy", 150, "estimatedBuy"],
    ["estimatedSell", "sell", 100, "sell", 150, "estimatedSell"],
    ["reducedBuy", "buy", 100, "buy", 50, "reducedBuy"],
    ["reducedSell", "sell", 100, "sell", 50, "reducedSell"]
]) {
    test(`${name}を正式比較から判定する`, () => {
        const map = { TEST: "テスト証券" };
        const result = weekly.calculateWeeklyBrokerJudgment(
            observationData({ side: previousSide, value: previousValue }),
            observationData({ side: currentSide, value: currentValue }),
            map
        );
        assert.equal(result.available, true);
        assert.equal(result.brokerDiffs.TEST.status, expected);
    });
}

test("非掲載を0比較せずunconfirmedにする", () => {
    const result = weekly.calculateWeeklyBrokerJudgment(
        observationData(),
        observationData({ broker: "別証券", code: "10002" }),
        { TEST: "テスト証券" }
    );
    assert.equal(result.available, false);
    assert.equal(result.brokerDiffs.TEST.status, "unconfirmed");
    assert.equal(result.brokerDiffs.TEST.delta, null);
    assert.equal(result.scoreDiff, null);
    assert.equal(result.direction, null);
});

test("限月集合が変われば比較不能にする", () => {
    const result = weekly.calculateWeeklyBrokerJudgment(
        observationData({ expiry: "2026年09月限月" }),
        observationData({ expiry: "2026年12月限月" }),
        { TEST: "テスト証券" }
    );
    assert.equal(result.available, false);
    assert.equal(result.brokerDiffs.TEST.reason, "expiry_set_changed");
});

test("正式2週のscoreとdirectionを計算する", () => {
    const result = weekly.calculateWeeklyBrokerJudgment(
        observationData({ side: "buy", value: 100 }),
        observationData({ side: "buy", value: 120 }),
        { TEST: "テスト証券" }
    );
    assert.equal(result.buyScore, 0.2);
    assert.equal(result.sellScore, 0);
    assert.equal(result.scoreDiff, 0.2);
    assert.equal(result.direction, "強い買い優勢");
});

test("主要5社の一社でも比較不能ならv1/v2入力を不足扱いにできる", () => {
    const previous = observationData({ broker: "ＪＰモルガン証券" });
    const current = observationData({ broker: "ＪＰモルガン証券", value: 110 });
    const result = weekly.calculateWeeklyBrokerJudgment(previous, current);
    assert.equal(result.available, false);
    assert.equal(result.eligibleBrokerCount, 1);
    assert.equal(result.requiredBrokerCount, 5);
    assert.equal(result.direction, null);
    assert.equal(result.scoreDiff, null);
});
