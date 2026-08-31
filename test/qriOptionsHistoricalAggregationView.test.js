"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/qriOptionsHistoricalAggregationView.js");
const Aggregation = require("../js/qriOptionsHistoricalAggregation.js");

class Element {
    constructor(id = null) {
        this.id = id; this.hidden = false; this.disabled = false; this.open = false;
        this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
        this.checked = false; this.type = ""; this.parentNode = null;
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this }); }
    replaceChildren(...children) { this.children = children; children.forEach(child => {
        child.parentNode = this;
    }); }
    append(...children) { this.children.push(...children); children.forEach(child => {
        child.parentNode = this;
    }); }
}

const IDS = ["historicalQriAggregationPanel", "historicalQriAggregationContracts",
    "historicalQriAggregationDate", "historicalQriAggregationState",
    "historicalQriAggregationContent", "historicalQriAggregationMetadata",
    "historicalQriAggregationPartialLegend", "historicalQriAggregationChartContainer",
    "historicalQriAggregationChart", "historicalQriAggregationDeveloperDetails"];

function documentFixture() {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.historicalQriAggregationContent.hidden = true;
    nodes.historicalQriAggregationChartContainer.hidden = true;
    nodes.historicalQriAggregationPartialLegend.hidden = true;
    return { nodes, document: { getElementById: id => nodes[id] || null,
        createElement: () => new Element() } };
}

class ChartFake {
    static instances = [];
    constructor(canvas, configuration) {
        this.canvas = canvas; this.configuration = configuration; this.destroyed = false;
        ChartFake.instances.push(this);
    }
    destroy() { this.destroyed = true; }
}

const dates = {
    "2026-10": ["2026-08-31", "2026-08-30"],
    "2026-09": ["2026-08-31", "2026-08-29"],
    "2026-08": ["2026-08-30"]
};

function snapshot(contract, date, partial = false) {
    return { identity: { contract, tradingDate: date, entryKey: `${contract}|${date}`,
        activeVersionKey: `version-${contract}-${date}` }, facts: [
        { strike: 65000, call: { published: true, value: contract === "2026-10" ? 100 : 50 },
            put: partial && contract === "2026-09"
                ? { published: false, value: null } : { published: true, value: 70 } },
        ...(contract === "2026-10" ? [{ strike: 65500,
            call: { published: true, value: 0 }, put: { published: false, value: null } }] : [])
    ] };
}

function historicalBuilder({ selectedContract, selectedTradingDate, history }) {
    if (history?.invalid) return { status: "invalid", reason: "snapshot_invalid", contracts: [] };
    const contracts = ["2026-10", "2026-09", "2026-08"];
    const contract = selectedContract || contracts[0];
    const contractDates = dates[contract] || [];
    const date = selectedTradingDate || contractDates[0];
    if (!contractDates.includes(date)) return { status: "unavailable",
        reason: "selection_not_found", contracts, dates: contractDates };
    return { status: "available", reason: null, contracts, dates: contractDates,
        snapshot: snapshot(contract, date, history?.partial === true) };
}

function harness(overrides = {}) {
    ChartFake.instances = [];
    const dom = documentFixture(); let reads = 0; let aggregationCalls = 0;
    const readHistory = overrides.readHistory || (() => {
        reads += 1; return Promise.resolve({ status: "ready",
            history: { entries: [], partial: overrides.partial === true } });
    });
    const buildHistoricalViewModel = overrides.buildHistoricalViewModel || historicalBuilder;
    const buildAggregation = overrides.buildAggregation || (input => {
        aggregationCalls += 1;
        return Aggregation.buildQriHistoricalAggregation(input);
    });
    const runtime = View.createQriHistoricalAggregationView({
        documentRef: dom.document, ChartConstructor: ChartFake, readHistory,
        buildHistoricalViewModel, buildAggregation,
        optionColors: { call: "#9b4058", put: "#285f9e" },
        partialColors: { call: "rgba-call", put: "rgba-put" },
        now: () => "2026-08-31T12:00:00.000Z"
    });
    runtime.initialize();
    const inputs = () => dom.nodes.historicalQriAggregationContracts.children
        .flatMap(label => label.children).filter(child => child.type === "checkbox");
    return { ...dom, runtime, reads: () => reads,
        aggregationCalls: () => aggregationCalls, inputs };
}

test("initial closedかつclosed中read/chartなし", () => {
    const value = harness(); const state = value.runtime.getState();
    assert.deepEqual([state.status, state.detailsOpen, state.readCount, state.chartRendered],
        ["closed", false, 0, false]);
    assert.equal(value.reads(), 0);
    assert.equal(ChartFake.instances.length, 0);
});

test("open時1 readし保存contract checkboxと最新2限月defaultを生成", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    const state = await value.runtime.open();
    assert.equal(value.reads(), 1);
    assert.deepEqual(value.inputs().map(input => input.value),
        ["2026-10", "2026-09", "2026-08"]);
    assert.deepEqual(value.inputs().filter(input => input.checked).map(input => input.value),
        ["2026-10", "2026-09"]);
    assert.deepEqual(state.selectedContracts, ["2026-09", "2026-10"]);
});

test("共通日intersectionだけを降順表示しPhase 2B snapshotをPhase 3Bへ渡す", async () => {
    const calls = []; const value = harness({ buildHistoricalViewModel: input => {
        calls.push(structuredClone(input)); return historicalBuilder(input);
    } });
    value.nodes.historicalQriAggregationPanel.open = true; await value.runtime.open();
    assert.deepEqual(value.nodes.historicalQriAggregationDate.children.map(item => item.value),
        ["2026-08-31"]);
    assert.equal(value.runtime.getState().selectedTradingDate, "2026-08-31");
    assert.ok(calls.some(call => call.selectedContract === "2026-09" &&
        call.selectedTradingDate === "2026-08-31"));
    assert.equal(value.aggregationCalls(), 1);
});

test("2限月未満はnot_enough_contractsでChartを出さない", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open();
    value.inputs().find(input => input.value === "2026-09").checked = false;
    const state = value.runtime.selectContracts();
    assert.deepEqual([state.status, state.reason, state.chartRendered],
        ["unavailable", "not_enough_contracts", false]);
    assert.match(value.nodes.historicalQriAggregationState.textContent, /2つ以上/);
});

test("共通日なしはno_common_dateでsilent fallbackしない", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open();
    value.inputs().find(input => input.value === "2026-10").checked = false;
    value.inputs().find(input => input.value === "2026-08").checked = true;
    const state = value.runtime.selectContracts();
    assert.equal(state.reason, "no_common_date");
    assert.equal(state.selectedTradingDate, null);
    assert.equal(value.nodes.historicalQriAggregationDate.children.length, 0);
});

test("complete aggregationを専用ChartへCALL赤PUT青で表示", async () => {
    const value = harness({ buildHistoricalViewModel: input => {
        const view = historicalBuilder(input);
        if (view.snapshot) view.snapshot.facts = view.snapshot.facts.slice(0, 1);
        return view;
    } }); value.nodes.historicalQriAggregationPanel.open = true;
    const state = await value.runtime.open(); const config = ChartFake.instances[0].configuration;
    assert.equal(state.aggregationStatus, "available");
    assert.equal(config.data.datasets[0].borderColor, "#9b4058");
    assert.equal(config.data.datasets[1].borderColor, "#285f9e");
    assert.deepEqual(config.data.datasets[0].backgroundColor, ["#9b4058"]);
    assert.deepEqual(config.data.datasets[1].backgroundColor, ["#285f9e"]);
    assert.equal(ChartFake.instances[0].canvas.id, "historicalQriAggregationChart");
});

test("partial pointは淡色・coverage tooltip・近傍凡例で明示", async () => {
    const value = harness({ partial: true });
    value.nodes.historicalQriAggregationPanel.open = true; const state = await value.runtime.open();
    const config = ChartFake.instances[0].configuration;
    assert.equal(state.hasPartialCoverage, true);
    assert.ok(config.data.datasets[1].backgroundColor.includes("rgba-put"));
    const label = config.options.plugins.tooltip.callbacks.label({ dataIndex: 0, datasetIndex: 1 });
    assert.match(label, /合計 70枚.*coverage 1\/2限月/);
    assert.equal(value.nodes.historicalQriAggregationPartialLegend.hidden, false);
});

test("absent/unpublishedはnullのままでsynthetic zeroにしない", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open(); const config = ChartFake.instances[0].configuration;
    assert.equal(config.data.datasets[1].data[1], null);
    assert.equal(config.data.datasets[0].data[1], 0);
});

test("checkbox/date変更はcacheを再利用し再readしない", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open();
    value.runtime.selectDate(); value.runtime.selectContracts();
    assert.equal(value.reads(), 1);
    assert.equal(value.runtime.getState().readCount, 1);
});

test("read中closeは古いasync結果のDOM/chart上書きを拒否", async () => {
    let resolveRead; let reads = 0;
    const value = harness({ readHistory: () => { reads += 1;
        return new Promise(resolve => { resolveRead = resolve; }); } });
    value.nodes.historicalQriAggregationPanel.open = true;
    const pending = value.runtime.open(); await Promise.resolve();
    value.nodes.historicalQriAggregationPanel.open = false; value.runtime.close();
    resolveRead({ status: "ready", history: { entries: [] } });
    const state = await pending;
    assert.equal(reads, 1); assert.equal(state.reason, "stale_render");
    assert.equal(ChartFake.instances.length, 0);
});

test("closeは専用ChartだけdestroyしlastActivityを保持", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open(); const chart = ChartFake.instances[0];
    value.nodes.historicalQriAggregationPanel.open = false; const state = value.runtime.close();
    assert.equal(chart.destroyed, true);
    assert.deepEqual([state.status, state.detailsOpen, state.chartRendered],
        ["closed", false, false]);
    assert.equal(state.lastActivity.readCount, 1);
    assert.equal(state.lastActivity.renderCount, 1);
    assert.deepEqual(state.lastActivity.lastSelectedContracts, ["2026-09", "2026-10"]);
    assert.equal(state.lastActivity.lastSelectedTradingDate, "2026-08-31");
    assert.ok(state.lastActivity.lastAggregationIdentity);
});

test("getterはside-effect freeでdetached/deep frozen", async () => {
    const value = harness(); value.nodes.historicalQriAggregationPanel.open = true;
    await value.runtime.open(); const first = value.runtime.getState();
    const second = value.runtime.getState();
    assert.notEqual(first, second); assert.notEqual(first.lastActivity, second.lastActivity);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.lastActivity.lastSelectedContracts), true);
    assert.throws(() => { first.lastActivity.readCount = 9; }, TypeError);
    assert.equal(value.reads(), 1);
});

test("current/formal protected stateを変更しない", async () => {
    const protectedState = { selector: { mode: "auto", contract: null },
        iv: { active: "iv", selected: null }, chart: { rendererKind: "formal" },
        formal: { contract: "2026-09" }, overall: { status: "available" },
        morning: { status: "unavailable" }, evidence: { status: "available" },
        lastValid: { generation: 2 }, currentPrice: { value: 65000 }, signal: null };
    const before = structuredClone(protectedState); const value = harness();
    value.nodes.historicalQriAggregationPanel.open = true; await value.runtime.open();
    value.inputs()[0].checked = false; value.runtime.selectContracts();
    value.nodes.historicalQriAggregationPanel.open = false; value.runtime.close();
    assert.deepEqual(protectedState, before);
});

test("日本語error taxonomyと独立details/wiringを持つ", () => {
    for (const reason of ["not_enough_contracts", "no_common_date", "snapshot_unavailable",
        "snapshot_invalid", "trading_date_mismatch", "no_records"]) {
        assert.ok(View.ERROR_MESSAGES[reason].length > 5);
    }
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /<details id="historicalQriAggregationPanel"/);
    assert.doesNotMatch(html.match(/<details id="historicalQriAggregationPanel"[^]*?<\/details>/)[0],
        /\sopen(?:\s|>)/);
    assert.match(html, /保存済み履歴からの合算.*現在値ではありません/s);
    assert.match(html, /qriHistoricalAggregationApi\.buildQriHistoricalAggregation/);
    assert.match(html, /window\.getQriHistoricalAggregationViewState/);
});

test("controllerはfetch/refresh/write/timerとprotected runtimeへ非接続", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsHistoricalAggregationView.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /setItem|\.put\s*\(|persist|save|refresh|setTimeout|setInterval/);
    assert.doesNotMatch(source, /qriContractSelect|CurrentPrice|OverallV2|Morning|Formal|Evidence|Last.Valid|optionSignal|adopt.*IV/i);
    assert.doesNotMatch(source,
        /wall|top3|signal|support|resistance|currentPrice|\bATM\b/i);
});
