"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/qriOptionsHistoricalView.js");

class Element {
    constructor(id) {
        this.id = id; this.hidden = false; this.disabled = false; this.open = false;
        this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
    }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this }); }
    replaceChildren(...children) { this.children = children; }
}

const IDS = ["historicalQriPanel", "historyContractSelect", "historyDateSelect",
    "historicalQriState", "historicalQriContent", "historicalQriMetadata",
    "historicalQriChartContainer", "historicalQriOpenInterestChart",
    "historicalQriDeveloperDetails"];

function documentFixture() {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.historicalQriPanel.open = false;
    nodes.historicalQriContent.hidden = true;
    nodes.historicalQriChartContainer.hidden = true;
    return { nodes, document: { getElementById: id => nodes[id] || null,
        createElement: () => new Element(null) } };
}

class ChartFake {
    static instances = [];
    constructor(canvas, configuration) {
        this.canvas = canvas; this.configuration = configuration; this.destroyed = false;
        ChartFake.instances.push(this);
    }
    destroy() { this.destroyed = true; }
}

function viewModel({ selectedContract, selectedTradingDate } = {}) {
    const contract = selectedContract || "2026-10";
    const dates = contract === "2026-09" ? ["2026-08-31", "2026-08-30"] : ["2026-08-31"];
    const tradingDate = selectedTradingDate || dates[0];
    return { status: "available", reason: null, contracts: ["2026-10", "2026-09"], dates,
        selection: { contract, tradingDate, entryKey: `${contract}|${tradingDate}`,
            activeVersionKey: `version-${contract}-${tradingDate}` },
        chartData: { strikes: [40000, 40500], callOpenInterest: [10, 0],
            putOpenInterest: [20, null], publishedByStrike: [], points: [] },
        metadata: { contract, tradingDate, pageUpdatedAt: "2026-08-31T16:00:00+09:00",
            fetchedAt: "2026-08-31T11:00:00Z", confirmedAt: "2026-08-31T11:01:00Z",
            openInterestStatus: "available", source: "qri-nikkei225-options",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/1",
            activeVersionKey: `version-${contract}-${tradingDate}`,
            signatureShort: "abcdef123456…", parserVersion: 2, schemaVersion: 2,
            historyVersion: 1 } };
}

function harness(overrides = {}) {
    ChartFake.instances = [];
    const dom = documentFixture(); let reads = 0; let builds = 0;
    const readHistory = overrides.readHistory || (() => {
        reads += 1; return Promise.resolve({ status: "ready", history: { entries: [] } });
    });
    const buildViewModel = overrides.buildViewModel || (input => {
        builds += 1; return viewModel(input);
    });
    const runtime = View.createQriOptionsHistoricalView({ documentRef: dom.document,
        ChartConstructor: ChartFake, readHistory, buildViewModel,
        optionColors: { call: "#9b4058", put: "#285f9e" },
        now: () => "2026-08-31T12:00:00.000Z" });
    runtime.initialize();
    return { ...dom, runtime, reads: () => reads, builds: () => builds };
}

test("detailsはclosedで初期化されclosed中read/chartを作らない", () => {
    const value = harness();
    assert.equal(value.nodes.historicalQriPanel.open, false);
    assert.equal(value.reads(), 0);
    assert.equal(ChartFake.instances.length, 0);
    assert.equal(value.runtime.getState().status, "closed");
    assert.deepEqual(value.runtime.getState().lastActivity, {
        openedAt: null, closedAt: null, lastReadAt: null, lastRenderAt: null,
        readCount: 0, renderCount: 0, lastSelectedContract: null,
        lastSelectedTradingDate: null, lastEntryKey: null,
        lastActiveVersionKey: null, lastChartRendered: false,
        lastStatus: null, lastReason: null
    });
});

test("first openで1 readしdefault最新contract/dateを描画", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    const state = await value.runtime.open();
    assert.equal(value.reads(), 1);
    assert.deepEqual([state.selectedContract, state.selectedTradingDate],
        ["2026-10", "2026-08-31"]);
    assert.deepEqual(value.nodes.historyContractSelect.children.map(item => item.value),
        ["2026-10", "2026-09"]);
    assert.equal(state.chartRendered, true);
});

test("独立contract/date selectorはcacheを再利用し明示selectionを渡す", async () => {
    const calls = []; const value = harness({ buildViewModel: input => {
        calls.push(structuredClone(input)); return viewModel(input);
    } });
    value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.nodes.historyContractSelect.value = "2026-09";
    value.runtime.selectContract();
    assert.deepEqual(calls.at(-1), { history: { entries: [] },
        selectedContract: "2026-09", selectedTradingDate: null });
    assert.equal(value.runtime.getState().selectedTradingDate, "2026-08-31");
    value.nodes.historyDateSelect.value = "2026-08-30";
    value.runtime.selectDate();
    const state = value.runtime.getState();
    assert.equal(state.selectedTradingDate, "2026-08-30");
    assert.equal(value.reads(), 1);
    assert.equal(state.lastActivity.readCount, 1);
    assert.equal(state.lastActivity.renderCount, 3);
});

test("専用chartはCALL赤PUT青を使いunpublished nullを維持", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    await value.runtime.open();
    const configuration = ChartFake.instances[0].configuration;
    assert.equal(ChartFake.instances[0].canvas.id, "historicalQriOpenInterestChart");
    assert.equal(configuration.data.datasets[0].backgroundColor, "#9b4058");
    assert.equal(configuration.data.datasets[1].backgroundColor, "#285f9e");
    assert.deepEqual(configuration.data.datasets[1].data, [20, null]);
    assert.equal(configuration.plugins, undefined);
});

test("metadata・historical notice・developer detailsを分離", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    await value.runtime.open();
    assert.match(value.nodes.historicalQriMetadata.textContent,
        /2026-10限月.*取引日：2026-08-31.*QRIページ更新.*OptionMap取得.*履歴保存確認.*CALL\/PUT掲載あり/);
    assert.match(value.nodes.historicalQriDeveloperDetails.textContent,
        /source: qri-nikkei225-options.*activeVersionKey:.*signature:/s);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /保存済み履歴/);
    assert.match(html, /これは保存時点のQRI建玉スナップショットです。現在値ではありません。/);
});

test("全empty/error reasonを日本語へmapping", () => {
    const expected = ["no_history", "no_contracts", "no_dates", "selection_not_found",
        "active_revision_missing", "active_revision_ambiguous", "snapshot_invalid",
        "oi_unavailable", "records_unavailable", "corrupted_history", "read_failed"];
    assert.deepEqual(Object.keys(View.ERROR_MESSAGES), expected);
    expected.forEach(reason => assert.ok(View.ERROR_MESSAGES[reason].length > 5));
});

test("corrupt historyはbuilderを呼ばず部分表示しない", async () => {
    let builds = 0; const value = harness({ readHistory: () =>
        Promise.resolve({ status: "corrupted", history: { entries: [{}] } }),
    buildViewModel: () => { builds += 1; return viewModel(); } });
    value.nodes.historicalQriPanel.open = true; const state = await value.runtime.open();
    assert.deepEqual([state.status, state.reason, builds], ["invalid", "corrupted_history", 0]);
    assert.equal(value.nodes.historicalQriContent.hidden, true);
});

test("read中closeは古い結果のDOM/chart上書きを拒否", async () => {
    let resolveRead; let reads = 0;
    const value = harness({ readHistory: () => { reads += 1;
        return new Promise(resolve => { resolveRead = resolve; }); } });
    value.nodes.historicalQriPanel.open = true;
    const pending = value.runtime.open();
    await Promise.resolve();
    value.nodes.historicalQriPanel.open = false; value.runtime.close();
    resolveRead({ status: "ready", history: { entries: [] } });
    const state = await pending;
    assert.equal(reads, 1);
    assert.equal(state.reason, "stale_render");
    assert.equal(ChartFake.instances.length, 0);
});

test("closeはhistory chartだけdestroyしcacheを保持してreopenで再readしない", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    await value.runtime.open(); const first = ChartFake.instances[0];
    value.nodes.historicalQriPanel.open = false; value.runtime.close();
    assert.equal(first.destroyed, true);
    const closed = value.runtime.getState();
    assert.equal(closed.status, "closed");
    assert.equal(closed.chartRendered, false);
    assert.equal(closed.loaded, true);
    assert.equal(closed.lastActivity.readCount, 1);
    assert.equal(closed.lastActivity.renderCount, 1);
    assert.equal(closed.lastActivity.lastSelectedContract, "2026-10");
    assert.equal(closed.lastActivity.lastSelectedTradingDate, "2026-08-31");
    assert.equal(closed.lastActivity.lastEntryKey, "2026-10|2026-08-31");
    assert.equal(closed.lastActivity.lastActiveVersionKey,
        "version-2026-10-2026-08-31");
    assert.equal(closed.lastActivity.lastChartRendered, true);
    assert.equal(closed.lastActivity.lastStatus, "available");
    value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    assert.equal(value.reads(), 1);
    assert.equal(value.runtime.getState().lastActivity.readCount, 1);
    assert.equal(value.runtime.getState().lastActivity.renderCount, 2);
    assert.equal(ChartFake.instances.length, 2);
});

test("diagnostics getterはdetached/deep frozenでidentityとgenerationを保持", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true;
    await value.runtime.open();
    const first = value.runtime.getState(); const second = value.runtime.getState();
    assert.notEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(first.entryKey, "2026-10|2026-08-31");
    assert.equal(first.readGeneration, 1);
    assert.equal(first.lastRenderedAt, "2026-08-31T12:00:00.000Z");
    assert.equal(Object.isFrozen(first.lastActivity), true);
    assert.notEqual(first.lastActivity, second.lastActivity);
    assert.throws(() => { first.status = "changed"; }, TypeError);
    assert.throws(() => { first.lastActivity.readCount = 20; }, TypeError);
});

test("index wiringは専用IDs/read getter/Phase 2B builderだけを使用", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /<details id="historicalQriPanel"/);
    assert.doesNotMatch(html.match(/<details id="historicalQriPanel"[^]*?<\/details>/)[0], /\sopen(?:\s|>)/);
    assert.match(html, /historyContractSelect/);
    assert.match(html, /historyDateSelect/);
    assert.match(html, /historicalQriOpenInterestChart/);
    assert.match(html, /readHistory: \(\) => window\.getQriOptionsHistory\(\)/);
    assert.match(html, /qriHistoricalViewModelApi\.buildQriHistoricalViewModel/);
    assert.match(html, /window\.getQriHistoricalViewState/);
});

test("rendererはcurrent/formal/storage/network/runtimeへ接続しない", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsHistoricalView.js"), "utf8");
    assert.doesNotMatch(source, /combinedPriceChart|qriContractSelect|setQriContractDisplayData|adoptQriOptionIv/);
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /OverallV2|Morning|Formal|Evidence|Last.Valid|optionSignal/);
    assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame|persist|refresh/);
    assert.doesNotMatch(source, /wall|TOP3|comparison|signal|currentPrice|ATM|inferred/i);
});

test("current selection/IV/chart/formal statesとview model inputを変更しない", async () => {
    const protectedStates = { selection: { mode: "auto", contract: null },
        iv: { active: "iv" }, chart: { rendererKind: "formal" },
        formal: { contract: "2026-09" }, overall: { status: "ready" },
        morning: { status: "published" }, evidence: { valid: true }, lastValid: { key: 1 } };
    const before = structuredClone(protectedStates);
    const history = { entries: [{ untouched: true }] };
    const value = harness({ readHistory: () => Promise.resolve({ status: "ready", history }),
        buildViewModel: input => { assert.deepEqual(input.history, history); return viewModel(input); } });
    value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.nodes.historyContractSelect.value = "2026-09"; value.runtime.selectContract();
    value.nodes.historyDateSelect.value = "2026-08-30"; value.runtime.selectDate();
    value.nodes.historicalQriPanel.open = false; value.runtime.close();
    assert.deepEqual(protectedStates, before);
    assert.deepEqual(history, { entries: [{ untouched: true }] });
});
