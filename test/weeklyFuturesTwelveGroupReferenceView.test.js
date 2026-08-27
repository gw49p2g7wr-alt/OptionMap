const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const View = require("../js/weeklyFuturesTwelveGroupReferenceView.js");

function groups() {
    const statuses = [
        ["estimatedBuy", 0.2], ["estimatedSell", -0.1],
        ["reducedBuy", 0], ["reducedSell", 0], ["unconfirmed", 0]
    ];
    return Object.fromEntries(View.GROUP_ORDER.map((id, index) => {
        const [status, contribution] = statuses[index % statuses.length];
        return [id, { id, availability: true, status, contribution,
            composite: id === "SBI_RAKUTEN" }];
    }));
}

function state(overrides = {}) {
    return {
        status: "available",
        reason: null,
        major5: {
            available: true,
            formalApplied: true,
            normalizedDirection: -0.6763504312301407
        },
        groups12: {
            available: true,
            shadowOnly: true,
            referenceOnly: true,
            formalApplied: false,
            overallV2Eligible: false,
            direction: "売り優勢",
            normalizedDirection: -0.5432413362965612,
            qualityState: "full",
            availableGroupCount: 12,
            missingGroups: [],
            dominantGroup: "MORGAN_MUFG",
            dominanceRatio: 0.2639519817718731,
            groups: groups()
        },
        comparison: {
            available: true,
            normalizedDirectionDelta: 0.13310909493357947,
            agreement: "different_strength",
            tradeDecisionEligible: false,
            overallV2Applied: false
        },
        ...overrides
    };
}

test("available stateをcompact reference表示へ変換する", () => {
    const model = View.createViewModel(state());
    assert.equal(model.available, true);
    assert.equal(model.direction, "売り優勢");
    assert.equal(model.normalizedDirection, "-0.543");
    assert.equal(model.delta, "+0.133");
    assert.equal(model.deltaExplanation, "12-groupの方が売り弱め");
});

test("正式判定とreference warningを常に明示する", () => {
    for (const value of [state(), { status: "unavailable", reason: "missing" }]) {
        const model = View.createViewModel(value);
        assert.equal(model.formalLabel, "正式判定：主要5社");
        assert.equal(model.warning, "参考分析・OverallV2には未使用");
    }
});

test("unavailableは旧表示値を返さない", () => {
    const model = View.createViewModel({
        ...state(), status: "unavailable", reason: "source_invalidated"
    });
    assert.equal(model.available, false);
    assert.equal(model.direction, "—");
    assert.equal(model.delta, "—");
    assert.equal(model.reason, "source_invalidated");
});

test("unavailableでもruntimeのcoverageとmissing factを表示できる", () => {
    const value = state();
    value.status = "unavailable";
    value.reason = "core_group_missing";
    value.groups12.available = false;
    value.groups12.availableGroupCount = 11;
    value.groups12.qualityState = "unavailable";
    value.groups12.missingGroups = ["BNP"];
    const model = View.createViewModel(value);
    assert.equal(model.available, false);
    assert.equal(model.coverage, "11 / 12");
    assert.equal(model.missing, "BNP");
    assert.equal(model.direction, "—");
});

test("agreement taxonomyを日本語表示する", () => {
    const expected = {
        same_direction: "同方向",
        different_strength: "同方向・強さ違い",
        opposite_direction: "逆方向",
        zero_involved: "中立を含む",
        unavailable: "比較不可"
    };
    for (const [agreement, label] of Object.entries(expected)) {
        const value = state();
        value.comparison.agreement = agreement;
        assert.equal(View.createViewModel(value).agreement, label);
    }
});

test("group表示名・dominanceRatio・coverageをformatする", () => {
    const model = View.createViewModel(state());
    assert.equal(model.dominant, "MorganMUFG（26.4%）");
    assert.equal(model.coverage, "12 / 12");
    assert.equal(View.GROUP_LABELS.SBI_RAKUTEN, "SBI＋楽天");
});

test("detail rowsをconfig順で12件生成しSBI＋楽天を1行にする", () => {
    const model = View.createViewModel(state());
    assert.equal(model.detailRows.length, 12);
    assert.deepEqual(model.detailRows.map(row => row.id), View.GROUP_ORDER);
    assert.equal(model.detailRows.filter(row => row.id === "SBI_RAKUTEN").length,
        1);
    assert.equal(model.detailRows.find(row => row.id === "SBI_RAKUTEN").group,
        "SBI＋楽天");
});

test("classification taxonomyを日本語presentationへ変換する", () => {
    const rows = View.createViewModel(state()).detailRows;
    assert.equal(rows.find(row => row.id === "JPM").classification, "買い寄与");
    assert.equal(rows.find(row => row.id === "GS").classification, "売り寄与");
    assert.equal(rows.find(row => row.id === "NOMURA").classification,
        "買い縮小");
    assert.equal(rows.find(row => row.id === "BNP").classification, "売り縮小");
    assert.equal(rows.find(row => row.id === "ABN").classification, "未確定");
});

test("contributionの正負・zero・nullを区別する", () => {
    const value = state();
    value.groups12.groups.CITI = { id: "CITI", availability: false,
        status: "unconfirmed", contribution: null, reason: "unpublished" };
    const rows = View.createViewModel(value).detailRows;
    assert.equal(rows.find(row => row.id === "JPM").contributionDirection, "買い");
    assert.equal(rows.find(row => row.id === "GS").contributionDirection, "売り");
    assert.equal(rows.find(row => row.id === "NOMURA").contributionDirection,
        "寄与なし");
    const missing = rows.find(row => row.id === "CITI");
    assert.equal(missing.classification, "利用不可");
    assert.equal(missing.contributionDirection, "—");
});

test("dominantGroupだけ最大寄与label対象にする", () => {
    const rows = View.createViewModel(state()).detailRows;
    assert.deepEqual(rows.filter(row => row.dominant).map(row => row.id),
        ["MORGAN_MUFG"]);
});

test("11/12 coverageとmissing groupを表示する", () => {
    const value = state();
    value.groups12.availableGroupCount = 11;
    value.groups12.qualityState = "partial_one_missing";
    value.groups12.missingGroups = ["SBI_RAKUTEN"];
    const model = View.createViewModel(value);
    assert.equal(model.coverage, "11 / 12");
    assert.equal(model.quality, "1 group欠損");
    assert.equal(model.missing, "SBI＋楽天");
});

test("null値をNaN・undefinedとして表示しない", () => {
    const value = state();
    value.groups12.normalizedDirection = null;
    const model = View.createViewModel(value);
    assert.equal(model.available, false);
    assert.equal(model.normalizedDirection, "—");
    assert.equal(JSON.stringify(model).includes("NaN"), false);
    assert.equal(JSON.stringify(model).includes("undefined"), false);
});

for (const [name, mutate] of [
    ["shadowOnly", value => { value.groups12.shadowOnly = false; }],
    ["referenceOnly", value => { value.groups12.referenceOnly = false; }],
    ["formalApplied", value => { value.groups12.formalApplied = true; }],
    ["overallV2Eligible", value => { value.groups12.overallV2Eligible = true; }],
    ["tradeDecisionEligible", value => {
        value.comparison.tradeDecisionEligible = true;
    }],
    ["overallV2Applied", value => { value.comparison.overallV2Applied = true; }]
]) {
    test(`${name} guard不成立はreference factを拒否する`, () => {
        const value = state();
        mutate(value);
        const model = View.createViewModel(value);
        assert.equal(model.available, false);
        assert.equal(model.guardRejected, true);
        assert.equal(model.direction, "—");
        assert.deepEqual(model.detailRows, []);
    });
}

test("delta説明は符号だけからdeterministicに生成する", () => {
    assert.equal(View.explainDelta(0.4, 0.7, 0.3, "different_strength"),
        "12-groupの方が買い強め");
    assert.equal(View.explainDelta(0.7, 0.4, -0.3, "different_strength"),
        "12-groupの方が買い弱め");
    assert.equal(View.explainDelta(-0.4, -0.7, -0.3, "different_strength"),
        "12-groupの方が売り強め");
    assert.equal(View.explainDelta(-0.7, -0.4, 0.3, "different_strength"),
        "12-groupの方が売り弱め");
    assert.equal(View.explainDelta(0.4, -0.4, -0.8, "opposite_direction"),
        "主要5社と方向が異なります");
});

test("outputはdeep frozen", () => {
    const model = View.createViewModel(state());
    assert.equal(Object.isFrozen(model), true);
    assert.equal(Object.isFrozen(model.detailRows), true);
});

test("UI wiringはgetterのみを使い独立計算・副作用を追加しない", () => {
    const source = fs.readFileSync("js/script.js", "utf8");
    const start = source.indexOf("function renderWeeklyTwelveGroupReference()");
    const end = source.indexOf("renderWeeklyTwelveGroupReference();", start) +
        "renderWeeklyTwelveGroupReference();".length;
    const wiring = source.slice(start, end);
    assert.match(wiring, /getWeeklyFuturesTwelveGroupDualRun/);
    assert.doesNotMatch(wiring, /calculateWeeklyBrokerJudgment|adaptFormalPair/);
    assert.doesNotMatch(wiring, /calculateGroup|calculatePair/);
    assert.doesNotMatch(wiring, /localStorage|indexedDB|fetch\s*\(|setTimeout|setInterval/);
});

test("publication前のinvalidationで旧reference表示を先に消す", () => {
    const source = fs.readFileSync("js/script.js", "utf8");
    const invalidation = source.indexOf(
        '"weekly_formal_identity_changed"'
    );
    const clear = source.indexOf(
        "renderWeeklyTwelveGroupReference();", invalidation
    );
    const publication = source.indexOf(
        "await window.publishWeeklyFuturesTwelveGroupDualRun", invalidation
    );
    assert.ok(invalidation >= 0 && invalidation < clear);
    assert.ok(clear < publication);
});

test("OverallV2とMajor5計算経路へreference viewを混入しない", () => {
    const source = fs.readFileSync("js/script.js", "utf8");
    const weeklyInput = source.slice(
        source.indexOf("function createWeeklyComponentInputV2()"),
        source.indexOf("function calculateOptionMapOverallJudgmentV2()")
    );
    const major5 = source.slice(
        source.indexOf("function calculateWeeklyBrokerJudgment("),
        source.indexOf("async function getConfirmedWeeklyFuturesSnapshotCandidates")
    );
    assert.doesNotMatch(weeklyInput, /TwelveGroupReference|groups12/);
    assert.doesNotMatch(major5, /TwelveGroupReference|groups12/);
});

test("indexは主要5社card内へ最小表示と依存順を追加する", () => {
    const html = fs.readFileSync("index.html", "utf8");
    const major = html.indexOf("id=\"weeklyBrokerSummary\"");
    const reference = html.indexOf("id=\"weeklyTwelveGroupReference\"");
    const runtime = html.indexOf("js/weeklyFuturesTwelveGroupDualRunRuntime.js");
    const view = html.indexOf("js/weeklyFuturesTwelveGroupReferenceView.js");
    const script = html.indexOf("js/script.js");
    assert.ok(major < reference);
    assert.ok(runtime < view && view < script);
    assert.match(html, /参考分析・OverallV2には未使用/);
    assert.match(html,
        /<details[\s\S]*id="weeklyTwelveGroupDetails"[\s\S]*12-group内訳を見る/);
    assert.doesNotMatch(html,
        /<details[^>]*id="weeklyTwelveGroupDetails"[^>]*\sopen(?:\s|>|=)/);
});

test("details wiringはrowsを再構築しstale時に閉じて隠す", () => {
    const source = fs.readFileSync("js/script.js", "utf8");
    const start = source.indexOf("function renderWeeklyTwelveGroupReference()");
    const end = source.indexOf("renderWeeklyTwelveGroupReference();", start);
    const wiring = source.slice(start, end);
    assert.match(wiring, /detailRows\.replaceChildren/);
    assert.match(wiring, /details\.hidden = model\.available !== true/);
    assert.match(wiring, /if \(details\.hidden\) details\.open = false/);
});
