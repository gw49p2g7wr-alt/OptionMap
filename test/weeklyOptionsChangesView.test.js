const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../js/weeklyOptionsChangesView.js");

function shadowFixture() {
    const slice = (previous, current, delta) => ({ previous, current, delta });
    return {
        status: "partial",
        changes: {
            status: "partial",
            previousSourceDate: "2026-07-31",
            currentSourceDate: "2026-08-07",
            expiry: "2026-08",
            comparisonCoverage: {
                exactCommonStrikeCount: 0,
                exactCommonStrikeRatio: 0,
                translatedWindowComparable: true
            },
            strikeWindow: {
                previous: { step: 125 },
                current: { step: 125 },
                translation: 1250
            },
            distributionShift: {
                put: { sell: { windowRelativeCentroidShift: -75.53233 } },
                call: { sell: { windowRelativeCentroidShift: -93.617498 } }
            },
            breadthChanges: {
                put: { sell: slice(12, 13, 1), buy: slice(7, 9, 2) },
                call: { sell: slice(7, 9, 2), buy: slice(9, 14, 5) }
            },
            concentrationChanges: {
                participantHhi: {
                    put: {
                        sell: slice(0.495445, 0.314708, -0.180737),
                        buy: slice(0.192789, 0.308649, 0.11586)
                    },
                    call: {
                        sell: slice(0.334884, 0.385202, 0.050318),
                        buy: slice(0.539656, 0.265844, -0.273812)
                    }
                },
                strikeHhi: {
                    put: {
                        sell: slice(0.669785, 0.384465, -0.28532),
                        buy: slice(0.669785, 0.384465, -0.28532)
                    },
                    call: {
                        sell: slice(0.619998, 0.448836, -0.171162),
                        buy: slice(0.619998, 0.448836, -0.171162)
                    }
                }
            },
            supportChanges: {
                available: true,
                previous: { strike: 64250 },
                current: { strike: 65500 },
                absoluteStrikeShift: 1250,
                relativeStepShift: 0
            },
            resistanceChanges: {
                available: true,
                previous: { strike: 64500 },
                current: { strike: 65750 },
                absoluteStrikeShift: 1250,
                relativeStepShift: 0
            },
            labels: [
                { code: "strike_window_moved_up", facts: { translation: 1250 } },
                { code: "put_distribution_shifted_lower_relative_to_window",
                    facts: { shift: -75.53233 } }
            ],
            warnings: [
                "published_rankings_only",
                "absence_is_not_zero",
                "no_common_strikes",
                "translated_bucket_is_not_exact_strike",
                "no_direction_forecast"
            ]
        }
    };
}

test("データなしは前週待ちとして安全に表示する", () => {
    const result = view.createWeeklyOptionsChangesView({
        status: "waiting_previous",
        changes: null,
        currentSourceMetadata: { sourceDate: "2026-08-07" }
    }, {
        status: "available",
        signal: { sourceDate: "2026-08-07", expiry: "2026-08" }
    });

    assert.equal(result.state, "waiting");
    assert.equal(result.statusText, "前週データ待ち");
    assert.match(result.message, /週次オプション変化データはまだありません/);
    assert.deepEqual(result.metadata.map(item => item.value),
        ["2026-08-07", "2026-08", "available"]);
});

test("shadow検証エラーはunavailableとして表示する", () => {
    const result = view.createWeeklyOptionsChangesView({
        status: "invalid", changes: null
    });
    assert.equal(result.state, "invalid");
    assert.equal(result.statusText, "unavailable（比較不可）");
    assert.match(result.message, /検証できません/);
});

test("partial理由と比較coverageを日本語表示する", () => {
    const result = view.createWeeklyOptionsChangesView(shadowFixture());

    assert.equal(result.statusText, "partial（一部比較）");
    assert.equal(result.partialReason,
        "共通strike 0本のため、exact strike比較不可。掲載窓内の相対比較のみ。");
    assert.deepEqual(result.metadata.map(item => item.value), [
        "2026-07-31 → 2026-08-07",
        "2026-08",
        "partial（一部比較）",
        "0本",
        "0%",
        "+1,250円"
    ]);
});

test("PUT/CALL分布とbreadthを予測表現なしで要約する", () => {
    const result = view.createWeeklyOptionsChangesView(shadowFixture());

    assert.deepEqual(result.summaries, [
        { label: "PUT分布", value: "下方（-75.5円）" },
        { label: "CALL分布", value: "下方（-93.6円）" },
        { label: "公表参加者breadth", value: "増加（区分別合計 +10）" }
    ]);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["bullish", "bearish", "買い優勢", "売り優勢",
        "上昇予測", "下落予測", "direction score"]) {
        assert.equal(serialized.includes(forbidden), false);
    }
});

test("participant HHIとstrike HHIをoptionType・side別に整形する", () => {
    const result = view.createWeeklyOptionsChangesView(shadowFixture());

    assert.deepEqual(result.participantConcentrationRows.map(row =>
        [row.label, row.change]
    ), [
        ["PUT sell", "集中低下（-0.181）"],
        ["PUT buy", "集中増加（+0.116）"],
        ["CALL sell", "集中増加（+0.050）"],
        ["CALL buy", "集中低下（-0.274）"]
    ]);
    assert.equal(result.strikeConcentrationRows.length, 4);
});

test("支持抵抗のstrikeと相対位置維持を表示する", () => {
    const result = view.createWeeklyOptionsChangesView(shadowFixture());

    assert.deepEqual(result.candidates, [
        {
            label: "支持候補strike",
            value: "64,250円 → 65,500円",
            detail: "絶対移動 +1,250円 ／ 相対位置 維持（0.0 step）"
        },
        {
            label: "抵抗候補strike",
            value: "64,500円 → 65,750円",
            detail: "絶対移動 +1,250円 ／ 相対位置 維持（0.0 step）"
        }
    ]);
});

test("warningsとlabelsを短い日本語へ変換する", () => {
    const result = view.createWeeklyOptionsChangesView(shadowFixture());

    assert.ok(result.labels.includes("掲載strike窓が上へ1,250円移動"));
    assert.ok(result.labels.includes("PUT分布が掲載窓比で下方へ75.5円移動"));
    assert.ok(result.warnings.includes(
        "非掲載は数量0ではなく、観測されていない状態です。"
    ));
    assert.ok(result.warnings.includes(
        "掲載窓内の相対bucket比較は、同一strike比較ではありません。"
    ));
});

test("roll_transitionを数量比較せず表示する", () => {
    const result = view.createWeeklyOptionsChangesView({
        status: "roll_transition",
        changes: {
            status: "roll_transition",
            previousSourceDate: "2026-07-03",
            currentSourceDate: "2026-07-10",
            previousExpiry: "2026-07",
            currentExpiry: "2026-08",
            comparisonCoverage: null,
            strikeWindow: null,
            supportChanges: { available: false },
            resistanceChanges: { available: false },
            labels: [],
            warnings: ["roll_transition", "different_expiries_not_compared"]
        }
    });

    assert.equal(result.statusText, "roll_transition（限月切替）");
    assert.match(result.message, /数量比較は行いません/);
    assert.ok(result.warnings.includes(
        "異なる限月は直接比較していません。"
    ));
});
