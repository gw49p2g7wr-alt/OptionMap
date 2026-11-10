"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/qriTimeTravelView.js");
const State = require("../js/qriTimeTravelState.js");

class Element {
    constructor(id) {
        this.id = id; this.hidden = false; this.disabled = false; this.open = false;
        this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
        this.style = {}; this.attributes = {}; this.clientWidth = 800; this.className = "";
        this.classList = { add() {}, remove() {} };
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this }); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    querySelectorAll() { return []; }
}

const IDS = ["historicalQriPanel", "historyContractSelect", "historyDateSelect",
    "historyRevisionSelect", "timeTravelRevisionControl", "timeTravelPreviousDate",
    "timeTravelNextDate", "timeTravelReturnCurrent", "timeTravelSingleMode",
    "timeTravelAggregateMode", "timeTravelAggregateContracts", "timeTravelSingleContractControl",
    "timeTravelBanner", "timeTravelBannerText", "historicalQriState", "historicalQriContent",
    "timeTravelResultHeader", "timeTravelResultTitle", "timeTravelResultFeedback",
    "timeTravelChartTitle", "historicalQriMetadata", "timeTravelTopCall", "timeTravelTopPut",
    "timeTravelComparison", "timeTravelCoverage", "timeTravelIvCoverage",
    "historicalQriChartLegend", "historicalQriChartContainer", "historicalQriChartPlot",
    "historicalQriOpenInterestChart", "historicalQriDeveloperDetails"];

function documentFixture() {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.historicalQriContent.hidden = true;
    nodes.historicalQriChartContainer.hidden = true;
    return { nodes, document: { getElementById: id => nodes[id] || null,
        createElement: () => new Element(null), createTextNode: text => ({ textContent: text }) } };
}

class ChartFake {
    static instances = [];
    constructor(canvas, configuration) {
        this.canvas = canvas; this.configuration = configuration; this.data = configuration.data;
        this.destroyed = false; ChartFake.instances.push(this);
    }
    destroy() { this.destroyed = true; }
}

const ACTIVE = `qri-options-v2|2026-11|current|sha256:${"a".repeat(64)}`;
const OLD = `qri-options-v2|2026-11|old|sha256:${"b".repeat(64)}`;

function projection(state) {
    if (state.viewMode === "aggregate") return { status: "available", reason: null,
        contracts: ["2026-11", "2026-12"], dates: ["2026-11-11"], availability: [
            { tradingDate: "2026-11-11", contracts: ["2026-11", "2026-12"] }],
        revisionOptions: [], selectedRevision: [ACTIVE, `${ACTIVE}-next`],
        identity: "aggregate|2026-11-11", metadata: { contracts: ["2026-11", "2026-12"],
            activeVersionKeys: [ACTIVE, `${ACTIVE}-next`] },
        chartData: { strikes: [65000, 65125], callOpenInterest: [110, 220],
            putOpenInterest: [33, 44] }, previousTradingDate: null,
        top3: { call: [{ rank: 1, strike: 65125, oi: 220,
            previousSavedObservationDelta: null, iv: { status: "missing" } }],
        put: [{ rank: 1, strike: 65125, oi: 44,
            previousSavedObservationDelta: null, iv: { status: "missing" } }] },
        coverage: { observed: 4, total: 4, notPublished: 0, comparable: 0 },
        ivCoverage: { observed: 0, eligible: 0, missing: 0,
            reason: "aggregate_not_applicable" }, quality: { complete: true } };
    const old = state.selectedRevision?.policy === "version" &&
        state.selectedRevision.versionKey === OLD;
    const selectedRevision = old ? OLD : ACTIVE;
    const call = old ? [10, 20] : [100, 200], put = old ? [30, 40] : [10, 20];
    return { status: "available", reason: null, contracts: ["2026-11"],
        dates: ["2026-11-10", "2026-11-11"], availability: [
            { tradingDate: "2026-11-10", contracts: ["2026-11"] },
            { tradingDate: "2026-11-11", contracts: ["2026-11"] }],
        revisionOptions: [
            { value: ACTIVE, label: "18:00 / aaaaaaaa", active: true },
            { value: OLD, label: "17:30 / bbbbbbbb", active: false }],
        selectedRevision, identity: "2026-11|2026-11-11",
        metadata: { contract: "2026-11", tradingDate: "2026-11-11",
            activeVersionKey: ACTIVE, selectedVersionKey: selectedRevision,
            selectedVersionShort: old ? "bbbbbbbb" : "aaaaaaaa",
            selectedRevisionIsActive: !old, confirmedAt: old
                ? "2026-11-11T08:30:00Z" : "2026-11-11T09:00:00Z",
            evidence: old ? { status: "unavailable", reason: "pre_activation" }
                : { status: "available", reason: null } },
        chartData: { strikes: [65000, 65125], callOpenInterest: call,
            putOpenInterest: put }, previousTradingDate: "2026-11-10",
        top3: { call: [{ rank: 1, strike: 65125, oi: call[1],
            previousSavedObservationDelta: null, iv: { status: "missing" } }],
        put: [{ rank: 1, strike: 65125, oi: put[1],
            previousSavedObservationDelta: null, iv: { status: "missing" } }] },
        coverage: { observed: 4, total: 4, notPublished: 0, comparable: 0 },
        ivCoverage: { observed: 0, eligible: 4, missing: 4 }, quality: { complete: true } };
}

function harness() {
    ChartFake.instances = [];
    const dom = documentFixture();
    const projectionApi = { inventory: () => ({ dates: ["2026-11-10", "2026-11-11"],
        contracts: ["2026-11"], availability: [
            { tradingDate: "2026-11-10", contracts: ["2026-11"] },
            { tradingDate: "2026-11-11", contracts: ["2026-11"] }] }),
    build: ({ state }) => projection(state) };
    const runtime = View.create({ documentRef: dom.document, ChartConstructor: ChartFake,
        readHistory: async () => ({ status: "ready", history: { entries: [{}] } }),
        readIvHistory: async () => null, stateApi: State, projectionApi,
        optionColors: { call: "#9b4058", put: "#285f9e" },
        now: () => "2026-11-11T10:00:00Z" });
    runtime.initialize(); return { ...dom, runtime };
}

test("G2 saved dates/revisionsだけを列挙しlatest activeをdefault表示する", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    const state = await value.runtime.open();
    assert.equal(state.status, "available");
    assert.deepEqual(value.nodes.historyDateSelect.children.map(item => item.value),
        ["2026-11-11", "2026-11-10"]);
    assert.deepEqual(value.nodes.historyRevisionSelect.children.map(item => item.value),
        [ACTIVE, OLD]);
    assert.equal(value.nodes.historyRevisionSelect.value, ACTIVE);
});

test("G2 historical graphはG1 mirror adapterでCALL左/PUT右・共通scale・高Strike上", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    const config = ChartFake.instances.at(-1).configuration;
    assert.equal(config.options.indexAxis, "y");
    assert.deepEqual(config.data.labels, ["65,125", "65,000"]);
    assert.deepEqual(config.data.datasets[0].data, [-200, -100]);
    assert.deepEqual(config.data.datasets[1].data, [20, 10]);
    assert.deepEqual([config.options.scales.x.min, config.options.scales.x.max], [-200, 200]);
    assert.equal(config.options.scales.x.ticks.callback(-5000), "5,000");
    assert.deepEqual(config.plugins.map(plugin => plugin.id), ["centerStrikeLabels"]);
    assert.equal(config.data.datasets.every(dataset => dataset.grouped === false), true);
});

test("G2 old same-day revisionはexact OIへ切替えlive marker/Volumeを混入しない", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    const first = ChartFake.instances.at(-1);
    value.nodes.historyRevisionSelect.value = OLD; value.runtime.selectRevision();
    const config = ChartFake.instances.at(-1).configuration;
    assert.equal(first.destroyed, true);
    assert.deepEqual(config.data.datasets[0].data, [-20, -10]);
    assert.deepEqual(config.data.datasets[1].data, [40, 30]);
    assert.equal(value.runtime.getState().projection.metadata.selectedRevisionIsActive, false);
    assert.equal(config.plugins.some(plugin => /current/i.test(plugin.id)), false);
    assert.match(value.nodes.historicalQriMetadata.textContent, /pre_activation/);
});

test("G2 Currentへ戻るとhistory chartだけを破棄しselectionを保持する", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.nodes.historyRevisionSelect.value = OLD; value.runtime.selectRevision();
    const chart = ChartFake.instances.at(-1); value.nodes.timeTravelReturnCurrent.dispatch("click");
    assert.equal(chart.destroyed, true);
    assert.equal(value.runtime.getState().status, "closed");
    assert.equal(value.runtime.getState().session.selectedRevision.versionKey, OLD);
});

test("G2は既存の複数限月合算を維持しrevision selectorを隠す", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.nodes.timeTravelAggregateMode.dispatch("click");
    const config = ChartFake.instances.at(-1).configuration;
    assert.deepEqual(config.data.datasets[0].data, [-220, -110]);
    assert.equal(value.nodes.timeTravelRevisionControl.hidden, true);
    assert.equal(config.options.plugins.tooltip.callbacks.title([{ dataIndex: 0 }]),
        "Strike 65,125円 / 取引日 2026-11-11 / 複数限月合算");
    assert.equal(config.options.plugins.tooltip.callbacks.afterLabel(),
        "保存済みFormal QRI合算（IV合成なし）");
});

test("G2 UIはhistorical Volumeを明示unavailableにし新storage/live authorityを持たない", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const source = fs.readFileSync(path.join(root, "js/qriTimeTravelView.js"), "utf8");
    const style = fs.readFileSync(path.join(root, "style.css"), "utf8");
    const block = html.match(/<details id="historicalQriPanel"[\s\S]*?<\/details>/)?.[0] || "";
    assert.match(block, /id="historyVolumeButton"[^>]*disabled/);
    assert.match(block, /この保存断面には取引高履歴がありません/);
    assert.match(block, /<select id="historyDateSelect"/);
    assert.match(style, /historical-qri-chart-container\.strike-bar-chart-scroll\s*\{[^}]*overflow-y:\s*auto/);
    assert.doesNotMatch(source, /currentPriceLinePlugin|\bcurrentPrice\b|livePrice|latestJpx/);
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|fetch\s*\(|persist|write/);
});
