const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../js/weeklyBrokerConfig.js");
const weekly = require("../js/weeklyFutures.js");
const overallV2 = require("../js/overallJudgmentV2.js");

const expectedParticipants = [
    ["JPM", "11714", "ＪＰモルガン証券", "JPM", 1, "weeklyStatusJPM"],
    ["GS", "11560", "ゴールドマン証券", "GS", 2, "weeklyStatusGS"],
    ["NOMURA", "12400", "野村証券", "野村", 3, "weeklyStatusNOMURA"],
    ["BNP", "12428", "ＢＮＰパリバ証券", "BNP", 4, "weeklyStatusBNP"],
    ["ABN", "12479", "ＡＢＮクリアリン証券", "ABN", 5, "weeklyStatusABN"]
];

const observation = (values, expiry = "2026年09月限月") =>
    weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...config.PARTICIPANTS.map(participant => {
            const value = values[participant.key];
            return value.side === "sell"
                ? ["1", expiry, participant.participantCode,
                    participant.brokerName, value.value]
                : ["1", expiry, null, null, null, participant.participantCode,
                    participant.brokerName, value.value];
        })
    ]);

test("主要5社configは正式schema・値・表示順を固定する", () => {
    assert.deepEqual(config.GROUP, {
        groupId: "core-weekly",
        groupLabel: "主要5社",
        groupVersion: 1
    });
    assert.deepEqual(config.PARTICIPANTS.map(participant => [
        participant.key,
        participant.participantCode,
        participant.brokerName,
        participant.displayName,
        participant.order,
        participant.statusElementId
    ]), expectedParticipants);
    assert.deepEqual(config.BROKER_MAP, {
        JPM: "ＪＰモルガン証券",
        GS: "ゴールドマン証券",
        NOMURA: "野村証券",
        BNP: "ＢＮＰパリバ証券",
        ABN: "ＡＢＮクリアリン証券"
    });
    assert.strictEqual(weekly.CORE_BROKERS, config.BROKER_MAP);
});

test("5社fixtureのscore・direction・overallV2入力意味を固定する", () => {
    const previous = observation({
        JPM: { side: "buy", value: 200 },
        GS: { side: "sell", value: 100 },
        NOMURA: { side: "buy", value: 200 },
        BNP: { side: "sell", value: 200 },
        ABN: { side: "buy", value: 100 }
    });
    const current = observation({
        JPM: { side: "buy", value: 225 },
        GS: { side: "sell", value: 100 },
        NOMURA: { side: "buy", value: 200 },
        BNP: { side: "sell", value: 200 },
        ABN: { side: "buy", value: 100 }
    });
    const judgment = weekly.calculateWeeklyBrokerJudgment(previous, current);
    assert.equal(judgment.requiredBrokerCount, 5);
    assert.equal(judgment.eligibleBrokerCount, 5);
    assert.equal(judgment.available, true);
    assert.equal(judgment.buyScore, 0.125);
    assert.equal(judgment.sellScore, 0);
    assert.equal(judgment.scoreDiff, 0.125);
    assert.equal(judgment.direction, "強い買い優勢");

    const normalizedDirection = overallV2.clamp(
        judgment.scoreDiff / overallV2.CONFIG.weeklyNormalizationBase,
        -1,
        1
    );
    assert.ok(Math.abs(normalizedDirection - 1) < Number.EPSILON);
    const result = overallV2.calculateOverallJudgmentV2({
        option: { available: false },
        weekly: {
            available: true,
            normalizedDirection,
            qualityFactor: 1,
            evidenceFactor: Math.abs(normalizedDirection)
        }
    });
    assert.equal(result.components.weekly.directionScore, 100);
    assert.equal(result.components.weekly.effectiveWeight, 45);
    assert.equal(result.direction, 100);
});

test("UIの主要5社行とselectorはconfig生成で固定HTMLを持たない", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
    assert.match(html, /<select id="cumulativeBrokerSelect"><\/select>/);
    assert.match(html, /<div id="weeklyBrokerSummary"><\/div>/);
    assert.match(script, /weeklyBrokerParticipants\.map/);
    for (const participant of config.PARTICIPANTS) {
        assert.doesNotMatch(html, new RegExp(`value="${participant.key}"`));
    }
});

test("weekly versionはPhase 1以前の値を維持する", () => {
    assert.equal(weekly.BROKER_SET_VERSION, 1);
    assert.equal(weekly.SCORING_VERSION, 2);
});
