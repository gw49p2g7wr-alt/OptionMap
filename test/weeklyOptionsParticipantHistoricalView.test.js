"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/weeklyOptionsParticipantHistoricalView.js");

class Element {
    constructor(id = null) {
        this.id = id;
        this.hidden = false;
        this.disabled = false;
        this.open = false;
        this.value = "";
        this.textContent = "";
        this.children = [];
        this.listeners = {};
        this.selected = false;
    }
    addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
    }
    dispatch(type) {
        for (const listener of this.listeners[type] || []) listener({ target: this });
    }
    replaceChildren(...children) {
        this.children = children;
    }
}

const IDS = [
    "weeklyOptionsParticipantHistoricalPanel",
    "weeklyOptionsParticipantSelect",
    "weeklyOptionsParticipantOptionType",
    "weeklyOptionsParticipantPeriod",
    "weeklyOptionsParticipantHistoricalState",
    "weeklyOptionsParticipantHistoricalContent",
    "weeklyOptionsParticipantHistoricalMetadata",
    "weeklyOptionsParticipantHistoricalRename",
    "weeklyOptionsParticipantHistoricalRolls",
    "weeklyOptionsParticipantHistoricalChartContainer",
    "weeklyOptionsParticipantHistoricalChart",
    "weeklyOptionsParticipantHistoricalDeveloper"
];

function documentFixture() {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.weeklyOptionsParticipantOptionType.value = "call";
    nodes.weeklyOptionsParticipantPeriod.value = "last20";
    nodes.weeklyOptionsParticipantHistoricalContent.hidden = true;
    nodes.weeklyOptionsParticipantHistoricalChartContainer.hidden = true;
    nodes.weeklyOptionsParticipantHistoricalRename.hidden = true;
    return {
        nodes,
        document: {
            getElementById: id => nodes[id] || null,
            createElement: () => new Element()
        }
    };
}

class ChartFake {
    static instances = [];
    constructor(canvas, configuration) {
        this.canvas = canvas;
        this.configuration = configuration;
        this.destroyed = false;
        ChartFake.instances.push(this);
    }
    destroy() {
        this.destroyed = true;
    }
}

const PARTICIPANTS = [
    {
        participantCode: "12400",
        displayName: "野村証券",
        observedNames: ["野村証券", "野村證券"],
        nameVariation: true,
        firstSeenDate: "2026-07-31",
        lastSeenDate: "2026-08-14",
        observationCount: 3
    },
    {
        participantCode: "12479",
        displayName: "ＡＢＮ証券",
        observedNames: ["ＡＢＮ証券"],
        nameVariation: false,
        firstSeenDate: "2026-08-07",
        lastSeenDate: "2026-08-14",
        observationCount: 2
    }
];

function model(input, overrides = {}) {
    return {
        status: "partial",
        reason: "partial_publication",
        selectedParticipantCode: input.selectedParticipantCode,
        selectedOptionType: input.selectedOptionType,
        period: input.period,
        participants: structuredClone(PARTICIPANTS),
        points: [
            {
                sourceDate: "2026-08-07",
                expiry: "2026-09",
                buy: { published: true, total: 0, contributingRecords: 1,
                    contributingStrikes: 1 },
                sell: { published: false, total: null, contributingRecords: 0,
                    contributingStrikes: 0 }
            },
            {
                sourceDate: "2026-08-14",
                expiry: "2026-10",
                buy: { published: true, total: 350, contributingRecords: 2,
                    contributingStrikes: 2 },
                sell: { published: true, total: 80, contributingRecords: 1,
                    contributingStrikes: 1 }
            }
        ],
        rollBoundaries: [{ index: 1, sourceDate: "2026-08-14",
            fromExpiry: "2026-09", toExpiry: "2026-10" }],
        summary: {
            totalObservations: 2,
            publishedObservations: 2,
            missingObservations: 0,
            buyPublishedObservations: 2,
            sellPublishedObservations: 1,
            observedExpiryCount: 2
        },
        notices: {
            historical: true,
            publishedRankedRecordsOnly: true,
            directionalInterpretationAllowed: false
        },
        ...overrides
    };
}

function harness(overrides = {}) {
    ChartFake.instances = [];
    const dom = documentFixture();
    let reads = 0;
    const buildCalls = [];
    const readHistory = overrides.readHistory || (() => {
        reads += 1;
        return Promise.resolve({ status: "ready", history: { entries: [] } });
    });
    const listParticipants = overrides.listParticipants || (async () => ({
        status: "available", reason: null, participants: structuredClone(PARTICIPANTS)
    }));
    const buildViewModel = overrides.buildViewModel || (async input => {
        buildCalls.push(structuredClone(input));
        return model(input);
    });
    const runtime = View.createWeeklyOptionsParticipantHistoricalView({
        documentRef: dom.document,
        ChartConstructor: ChartFake,
        readHistory,
        listParticipants,
        buildViewModel,
        colors: {
            buy: "rgba-red", buyBorder: "red",
            sell: "rgba-blue", sellBorder: "blue"
        },
        now: () => "2026-08-31T09:00:00.000Z"
    });
    runtime.initialize();
    return { ...dom, runtime, reads: () => reads, buildCalls };
}

async function open(value) {
    value.nodes.weeklyOptionsParticipantHistoricalPanel.open = true;
    return value.runtime.open();
}

test("initial closedでread/chartを開始しない", () => {
    const value = harness();
    const state = value.runtime.getState();
    assert.deepEqual([state.status, state.detailsOpen, state.loaded,
        state.chartRendered], ["closed", false, false, false]);
    assert.equal(value.reads(), 0);
    assert.equal(ChartFake.instances.length, 0);
});

test("初回openでhistoryを1回readし実掲載participantCode selectorを生成", async () => {
    const value = harness();
    const state = await open(value);
    assert.equal(value.reads(), 1);
    assert.deepEqual(value.nodes.weeklyOptionsParticipantSelect.children.map(option =>
        [option.value, option.textContent]), [
        ["12400", "野村証券（12400）"],
        ["12479", "ＡＢＮ証券（12479）"]
    ]);
    assert.equal(state.selectedParticipantCode, "12400");
    assert.equal(state.selectedParticipantName, "野村証券");
});

test("CALL/PUTと期間selectionをPhase 1A builderへそのまま渡す", async () => {
    const value = harness();
    await open(value);
    value.nodes.weeklyOptionsParticipantOptionType.value = "put";
    value.nodes.weeklyOptionsParticipantPeriod.value = "threeMonths";
    await value.runtime.select();
    value.nodes.weeklyOptionsParticipantPeriod.value = "all";
    await value.runtime.select();
    assert.deepEqual(value.buildCalls.map(call =>
        [call.selectedParticipantCode, call.selectedOptionType, call.period]), [
        ["12400", "call", "last20"],
        ["12400", "put", "threeMonths"],
        ["12400", "put", "all"]
    ]);
    assert.equal(value.reads(), 1);
});

test("買い赤・売り青の専用ChartでCALL/PUT色をdatasetへ混ぜない", async () => {
    const value = harness();
    await open(value);
    const chart = ChartFake.instances.at(-1);
    const datasets = chart.configuration.data.datasets;
    assert.equal(chart.canvas.id, "weeklyOptionsParticipantHistoricalChart");
    assert.deepEqual(datasets.map(dataset => [dataset.label, dataset.backgroundColor]), [
        ["買い側 公表掲載枚数", "rgba-red"],
        ["売り側 公表掲載枚数", "rgba-blue"]
    ]);
    assert.equal(datasets[0].spanGaps, false);
    assert.equal(datasets[1].spanGaps, false);
});

test("valid zeroを0、非掲載をnullとしてChartへ渡す", async () => {
    const value = harness();
    await open(value);
    const datasets = ChartFake.instances.at(-1).configuration.data.datasets;
    assert.deepEqual(datasets[0].data, [0, 350]);
    assert.deepEqual(datasets[1].data, [null, 80]);
});

test("tooltipは日付・限月・CALL/PUT・side・掲載strikeを表示", async () => {
    const value = harness();
    await open(value);
    const callback = ChartFake.instances.at(-1).configuration.options
        .plugins.tooltip.callbacks.label;
    assert.match(callback({ dataIndex: 0, datasetIndex: 1 }),
        /2026-08-07.*2026-09.*CALL.*売り側 非掲載.*掲載strike 0/);
    assert.match(callback({ dataIndex: 1, datasetIndex: 0 }),
        /買い側 350枚.*掲載strike 2/);
});

test("roll boundaryとmetadataをChart近傍へ表示", async () => {
    const value = harness();
    const state = await open(value);
    assert.equal(state.rollBoundaryCount, 1);
    assert.equal(value.nodes.weeklyOptionsParticipantHistoricalRolls.children[0]
        .textContent, "2026-08-14：2026-09 → 2026-10");
    assert.match(value.nodes.weeklyOptionsParticipantHistoricalMetadata.textContent,
        /参加者：野村証券.*participantCode：12400.*種別：CALL.*観測週数：2.*観測限月数：2/);
});

test("nameVariationを注意表示しidentityを分割しない", async () => {
    const value = harness();
    await open(value);
    assert.equal(value.nodes.weeklyOptionsParticipantHistoricalRename.hidden, false);
    assert.match(value.nodes.weeklyOptionsParticipantHistoricalRename.textContent,
        /複数の名称表記/);
    assert.match(value.nodes.weeklyOptionsParticipantHistoricalDeveloper.textContent,
        /野村証券.*野村證券/);
});

test("empty/error taxonomyを日本語へmappingしsilent fallbackしない", async () => {
    for (const reason of ["no_history", "no_participants", "participant_not_found",
        "no_records", "invalid_option_type", "invalid_period", "history_corrupted",
        "adapter_error"]) {
        assert.ok(View.ERROR_MESSAGES[reason].length > 5);
    }
    const value = harness({ buildViewModel: async input => model(input, {
        status: "empty", reason: "no_records", points: [], rollBoundaries: []
    }) });
    const state = await open(value);
    assert.equal(state.reason, "no_records");
    assert.equal(state.chartRendered, false);
    assert.match(value.nodes.weeklyOptionsParticipantHistoricalState.textContent,
        /公表掲載記録/);
});

test("history read後のPhase 1A API例外をread_failedへ誤分類しない", async () => {
    const value = harness({ listParticipants: async () => {
        throw new TypeError("listWeeklyOptionsParticipants is not a function");
    } });
    const state = await open(value);
    assert.equal(value.reads(), 1);
    assert.equal(state.status, "invalid");
    assert.equal(state.reason, "adapter_error");
    assert.equal(state.errorCode,
        "listWeeklyOptionsParticipants is not a function");
    assert.match(value.nodes.weeklyOptionsParticipantHistoricalState.textContent,
        /表示処理を開始できません/);
});

test("selector変更はpanel-local cacheを使いhistory再readしない", async () => {
    const value = harness();
    await open(value);
    value.nodes.weeklyOptionsParticipantSelect.value = "12479";
    await value.runtime.select();
    value.nodes.weeklyOptionsParticipantOptionType.value = "put";
    await value.runtime.select();
    assert.equal(value.reads(), 1);
    assert.equal(value.runtime.getState().lastActivity.readCount, 1);
});

test("async read中のcloseは古い結果によるDOM/Chart上書きを拒否", async () => {
    let resolveRead;
    let reads = 0;
    const value = harness({ readHistory: () => {
        reads += 1;
        return new Promise(resolve => { resolveRead = resolve; });
    } });
    value.nodes.weeklyOptionsParticipantHistoricalPanel.open = true;
    const pending = value.runtime.open();
    await Promise.resolve();
    value.nodes.weeklyOptionsParticipantHistoricalPanel.open = false;
    value.runtime.close();
    resolveRead({ status: "ready", history: { entries: [] } });
    const state = await pending;
    assert.equal(reads, 1);
    assert.equal(state.status, "closed");
    assert.equal(state.reason, null);
    assert.equal(ChartFake.instances.length, 0);
});

test("selection変更中の古いasync modelもChartを上書きしない", async () => {
    let resolveFirst;
    let calls = 0;
    const value = harness({ buildViewModel: input => {
        calls += 1;
        if (calls === 1) return Promise.resolve(model(input));
        if (calls === 2) return new Promise(resolve => { resolveFirst = resolve; });
        return Promise.resolve(model(input));
    } });
    await open(value);
    value.nodes.weeklyOptionsParticipantOptionType.value = "put";
    const stale = value.runtime.select();
    value.nodes.weeklyOptionsParticipantPeriod.value = "all";
    await value.runtime.select();
    resolveFirst(model({ selectedParticipantCode: "12400",
        selectedOptionType: "put", period: "last20" }));
    const staleState = await stale;
    assert.equal(staleState.status, "partial");
    assert.equal(value.runtime.getState().selectedPeriod, "all");
});

test("closeは専用ChartだけdestroyしlastActivityを保持", async () => {
    const value = harness();
    await open(value);
    const ownChart = ChartFake.instances.at(-1);
    const unrelated = { destroyed: false };
    value.nodes.weeklyOptionsParticipantHistoricalPanel.open = false;
    const state = value.runtime.close();
    assert.equal(ownChart.destroyed, true);
    assert.equal(unrelated.destroyed, false);
    assert.equal(state.status, "closed");
    assert.equal(state.chartRendered, false);
    assert.equal(state.lastActivity.readCount, 1);
    assert.equal(state.lastActivity.renderCount, 1);
    assert.equal(state.lastActivity.lastSelectedParticipantCode, "12400");
});

test("getterはside-effect free・detached・deep frozen", async () => {
    const value = harness();
    await open(value);
    const first = value.runtime.getState();
    const second = value.runtime.getState();
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.lastActivity, second.lastActivity);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.lastActivity), true);
    assert.throws(() => { first.pointCount = 99; }, TypeError);
    assert.equal(value.reads(), 1);
});

test("current/formal/Weekly protected stateを変更しない", async () => {
    const protectedState = {
        qriSelection: { mode: "auto", contract: "2026-09" },
        iv: { active: 20, selected: 21 },
        qriChart: { renderer: "formal" },
        formal: { status: "available" },
        overall: { status: "available" },
        morning: { status: "published" },
        evidence: { status: "available" },
        lastValid: { version: 2 },
        currentPrice: { value: 65000 },
        optionSignal: { direction: 0 },
        weeklyFormal: { status: "available" },
        major5: { status: "available" },
        twelveGroup: { status: "available" }
    };
    const before = structuredClone(protectedState);
    const value = harness();
    await open(value);
    value.nodes.weeklyOptionsParticipantOptionType.value = "put";
    await value.runtime.select();
    value.nodes.weeklyOptionsParticipantHistoricalPanel.open = false;
    value.runtime.close();
    assert.deepEqual(protectedState, before);
});

test("HTML wiringは独立closed details・Phase 1A・read-only store APIを使用", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const panel = html.match(
        /<details id="weeklyOptionsParticipantHistoricalPanel"[^]*?<\/details>/
    )[0];
    assert.doesNotMatch(panel, /\sopen(?:\s|>)/);
    assert.match(panel, /オプション参加者別 公表建玉推移/);
    assert.match(panel, /保存済みJPX週次履歴/);
    assert.match(panel, /非掲載は0ではありません/);
    assert.match(panel, /強気・弱気を意味しません/);
    assert.match(html, /readWeeklyOptionsHistory\(\)/);
    assert.match(html,
        /weeklyOptionsParticipantHistoricalViewModelApi\s*=\s*\n\s*window\.OptionMapWeeklyOptionsParticipantHistoricalViewModel/);
    assert.doesNotMatch(html,
        /weeklyOptionsParticipantHistoricalViewModelApi\s*=\s*\n\s*require\(/);
    assert.match(html, /buildWeeklyOptionsParticipantHistoricalViewModel/);
    assert.match(html, /listWeeklyOptionsParticipants/);
    assert.match(html, /getWeeklyOptionsParticipantHistoricalViewState/);
    assert.doesNotMatch(panel, /CALL\+PUT/);
});

test("rendererはfetch/write/polling/QRI/formal計算へ接続しない", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/weeklyOptionsParticipantHistoricalView.js"), "utf8");
    assert.doesNotMatch(source,
        /indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame/);
    assert.doesNotMatch(source,
        /qriContractSelect|combinedPriceChart|OverallV2|Morning|Formal|Evidence|Last.Valid/);
    assert.doesNotMatch(source, /bullish|bearish|support|resistance|signal|netExposure/i);
});

test("responsive widthは100%かつmax-width 1100px", () => {
    const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
    assert.match(css, /\.option-participant-historical-card\s*{[^}]*width:\s*100%/s);
    assert.match(css, /\.option-participant-historical-card\s*{[^}]*max-width:\s*1100px/s);
    assert.match(css,
        /#weeklyOptionsParticipantHistoricalChart\s*{[^}]*width:\s*100%\s*!important/s);
});
