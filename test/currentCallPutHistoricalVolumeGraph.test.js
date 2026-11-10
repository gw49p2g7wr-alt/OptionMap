"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Projection = require("../js/qriVolumeHistoricalProjection.js");
const View = require("../js/qriTimeTravelView.js");
const State = require("../js/qriTimeTravelState.js");

const ROOT = path.join(__dirname, "..");
const CONTRACT = "2026-11", DATE = "2026-11-11";
const OI_A = `qri-options-v2|${CONTRACT}|a|sha256:${"a".repeat(64)}`;
const OI_B = `qri-options-v2|${CONTRACT}|b|sha256:${"b".repeat(64)}`;

function observation(seed, confirmedAt, related = OI_A, call = 100, put = 200,
    contract = CONTRACT, date = DATE) {
    return { contractVersion: "qri-volume-candidate-v1", authorityVersion: "qri-volume-v1",
        parserId: "qri-volume", parserVersion: 1, schemaVersion: 1,
        source: "qri-nikkei225-options", sourceUrl: "https://svc.qri.jp/jpx/nkopm/1",
        contract, tradingDate: date, pageUpdatedAt: `${date}T17:00:00+09:00`,
        acquiredAt: confirmedAt, confirmedAt,
        acquisitionId: `qri-acquisition-v1|sha256:${seed.repeat(64)}`,
        occurrenceId: `source-occurrence-v1|sha256:${seed.repeat(64)}`,
        relatedQriOiVersionKey: related, signatureAlgorithm: "sha256",
        semanticSignature: seed.repeat(64),
        observationId: `qri-volume-observation-v1|sha256:${seed.repeat(64)}`,
        canonical: { authorityVersion: "qri-volume-v1", parserId: "qri-volume",
            parserVersion: 1, schemaVersion: 1, source: "qri-nikkei225-options",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/1", contract, tradingDate: date,
            pageUpdatedAt: `${date}T17:00:00+09:00`, records: [
                { contract, strike: 65000, call: { published: call !== null, value: call },
                    put: { published: put !== null, value: put } },
                { contract, strike: 65125, call: { published: true, value: 0 },
                    put: { published: false, value: null } }
            ] }, sourceEvidence: { status: "available" } };
}

function history(observations = []) {
    return { historyVersion: 1, authorityVersion: "qri-volume-v1", parserId: "qri-volume",
        parserVersion: 1, schemaVersion: 1, source: "qri-nikkei225-options",
        signatureAlgorithm: "sha256", createdAt: "2026-11-11T08:00:00Z",
        updatedAt: observations.at(-1)?.confirmedAt || "2026-11-11T08:00:00Z",
        entries: observations.length ? [{ entryKey: `${CONTRACT}|${DATE}`, contract: CONTRACT,
            tradingDate: DATE, firstObservedAt: observations[0].confirmedAt,
            lastObservedAt: observations.at(-1).confirmedAt, observations }] : [] };
}

function oiProjection(version = OI_A) {
    return { status: "available", selectedRevision: version, metadata: { contract: CONTRACT,
        tradingDate: DATE, activeVersionKey: OI_A, selectedVersionKey: version,
        selectedVersionShort: version === OI_A ? "aaaaaaaa" : "bbbbbbbb",
        confirmedAt: "2026-11-11T08:00:00Z", evidence: { status: "available" } } };
}

function build(volumeHistory, overrides = {}) {
    return Projection.build({ history: volumeHistory, historyStatus: "ready",
        oiProjection: oiProjection(), ...overrides });
}

const FIRST = observation("1", "2026-11-11T08:30:00Z", OI_A, 100, 200);
const LATEST = observation("2", "2026-11-11T09:00:00Z", OI_A, 120, 220);
const OTHER_REVISION = observation("3", "2026-11-11T09:30:00Z", OI_B, 300, 400);

test("G4-1 Historical OI only leaves Volume unavailable", () => {
    assert.equal(Projection.build({ history: null, historyStatus: "empty",
        oiProjection: oiProjection() }).reason, "pre_activation_or_not_recorded");
});

test("G4-2 exact OI versionKey match enables Volume", () => {
    assert.equal(build(history([FIRST])).status, "available");
});

test("G4-3 one matching observation returns exact saved facts", () => {
    const value = build(history([FIRST]));
    assert.deepEqual([value.chartData.callVolume, value.chartData.putVolume], [[100, 0], [200, null]]);
});

test("G4-4 multiple matching observations expose a bounded selector", () => {
    const value = build(history([FIRST, LATEST]));
    assert.equal(value.observationOptions.length, 2);
    assert.match(value.observationOptions[0].label, /2026-11-11 18:00 \/ 22222222/);
});

test("G4-5 latest matching observation is deterministic default", () => {
    assert.equal(build(history([FIRST, LATEST])).selectedObservationId, LATEST.observationId);
});

test("G4-6 explicit older observation selection returns its exact values", () => {
    const value = build(history([FIRST, LATEST]), { selectedObservationId: FIRST.observationId });
    assert.deepEqual([value.selectedObservationId, value.chartData.callVolume[0]],
        [FIRST.observationId, 100]);
});

test("G4-7 OI revision A and B observations never cross-bind", () => {
    const value = build(history([FIRST, OTHER_REVISION]));
    assert.deepEqual(value.observationOptions.map(item => item.value), [FIRST.observationId]);
    assert.equal(Projection.build({ history: history([FIRST, OTHER_REVISION]), historyStatus: "ready",
        oiProjection: oiProjection(OI_B) }).selectedObservationId, OTHER_REVISION.observationId);
});

test("G4-8 unchanged OI exposes every matching Volume change", () => {
    assert.deepEqual(build(history([FIRST, LATEST])).observationOptions.map(item => item.value),
        [LATEST.observationId, FIRST.observationId]);
});

test("G4-9 pre-G3 dates are not fabricated", () => {
    assert.equal(build(history()).reason, "pre_activation_or_not_recorded");
});

test("G4-10 missing Volume remains unpublished null", () => {
    assert.deepEqual(build(history([FIRST])).chartData.points[1].put,
        { published: false, value: null });
});

test("G4-11 actual zero remains a published zero", () => {
    assert.deepEqual(build(history([FIRST])).chartData.points[1].call,
        { published: true, value: 0 });
});

class Element {
    constructor(id) { this.id = id; this.hidden = false; this.disabled = false; this.open = false;
        this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
        this.attributes = {}; this.style = {}; this.clientWidth = 800;
        this.classList = { add() {}, remove() {} }; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ target: this }); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    querySelectorAll() { return []; }
}
const IDS = ["historicalQriPanel", "historyContractSelect", "historyDateSelect",
    "historyRevisionSelect", "timeTravelRevisionControl", "historyOpenInterestButton",
    "historyVolumeButton", "historicalVolumeUnavailable", "historyVolumeObservationSelect",
    "timeTravelVolumeObservationControl", "timeTravelPreviousDate", "timeTravelNextDate",
    "timeTravelReturnCurrent", "timeTravelSingleMode", "timeTravelAggregateMode",
    "timeTravelAggregateContracts", "timeTravelSingleContractControl", "timeTravelBanner",
    "timeTravelBannerText", "historicalQriState", "historicalQriContent", "timeTravelResultHeader",
    "timeTravelResultTitle", "timeTravelResultFeedback", "timeTravelChartTitle",
    "historicalQriMetadata", "timeTravelTopCall", "timeTravelTopPut", "timeTravelComparison",
    "timeTravelCoverage", "timeTravelIvCoverage", "timeTravelOiSummary", "timeTravelOiComparison",
    "timeTravelQuality", "historicalQriChartLegend", "historicalQriChartContainer",
    "historicalQriChartPlot", "historicalQriOpenInterestChart", "historicalQriDeveloperDetails"];
class ChartFake {
    static instances = [];
    constructor(canvas, configuration) { this.canvas = canvas; this.configuration = configuration;
        this.data = configuration.data; this.destroyed = false; ChartFake.instances.push(this); }
    destroy() { this.destroyed = true; }
}
function viewProjection(state) {
    const version = state.selectedRevision?.policy === "version"
        ? state.selectedRevision.versionKey : OI_A;
    return { status: "available", reason: null, contracts: [CONTRACT], dates: [DATE],
        availability: [{ tradingDate: DATE, contracts: [CONTRACT] }],
        revisionOptions: [{ value: OI_A, label: "18:00 / aaaaaaaa", active: true },
            { value: OI_B, label: "18:30 / bbbbbbbb", active: false }],
        selectedRevision: version, identity: `${CONTRACT}|${DATE}`,
        metadata: { ...oiProjection(version).metadata },
        chartData: { strikes: [65000, 65125], callOpenInterest: [10, 20],
            putOpenInterest: [30, 40] }, previousTradingDate: null,
        top3: { call: [], put: [] }, coverage: { observed: 4, total: 4,
            notPublished: 0, comparable: 0 }, ivCoverage: { observed: 0, eligible: 4, missing: 4 },
        quality: { complete: true } };
}
function harness(volume = history([FIRST, LATEST])) {
    ChartFake.instances = [];
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
    nodes.historicalQriContent.hidden = true; nodes.historicalQriChartContainer.hidden = true;
    const documentRef = { getElementById: id => nodes[id] || null,
        createElement: () => new Element(null), createTextNode: text => ({ textContent: text }) };
    const projectionApi = { inventory: () => ({ dates: [DATE], contracts: [CONTRACT],
        availability: [{ tradingDate: DATE, contracts: [CONTRACT] }] }),
    build: ({ state }) => viewProjection(state) };
    const runtime = View.create({ documentRef, ChartConstructor: ChartFake,
        readHistory: async () => ({ status: "ready", history: { entries: [{}] } }),
        readIvHistory: async () => null,
        readVolumeHistory: async () => ({ status: "ready", history: volume }),
        stateApi: State, projectionApi, volumeProjectionApi: Projection,
        optionColors: { call: "#9b4058", put: "#285f9e" } });
    runtime.initialize(); return { nodes, runtime };
}

test("G4-12/13 UI reuses mirrored CALL-left PUT-right shared scale", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.runtime.selectVolume(); const config = ChartFake.instances.at(-1).configuration;
    assert.deepEqual(config.data.datasets[0].data, [-0, -120]);
    assert.deepEqual(config.data.datasets[1].data, [null, 220]);
    assert.deepEqual([config.options.scales.x.min, config.options.scales.x.max], [-220, 220]);
    assert.deepEqual(config.data.labels, ["65,125", "65,000"]);
});

test("G4-14 historical Volume has no live marker or OI wall interaction", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.runtime.selectVolume(); const config = ChartFake.instances.at(-1).configuration;
    assert.deepEqual(config.plugins.map(item => item.id), ["centerStrikeLabels"]);
    assert.match(value.nodes.timeTravelChartTitle.textContent, /取引高/);
    assert.equal(value.nodes.timeTravelOiSummary.hidden, true);
});

test("G4-15 contract isolation rejects a date-matched foreign contract", () => {
    const foreign = observation("4", "2026-11-11T10:00:00Z", OI_A, 1, 2, "2026-12");
    const value = build({ ...history([foreign]), entries: [{ ...history([foreign]).entries[0],
        entryKey: `2026-12|${DATE}`, contract: "2026-12" }] });
    assert.equal(value.reason, "pre_activation_or_not_recorded");
});

test("G4-16 restart/read reconstruction chooses the same latest observation", () => {
    const persisted = JSON.parse(JSON.stringify(history([FIRST, LATEST])));
    assert.deepEqual(build(persisted), build(JSON.parse(JSON.stringify(persisted))));
});

test("G4-17 corrupt Volume is isolated while OI projection remains intact", async () => {
    const value = Projection.build({ history: history([FIRST]), historyStatus: "corrupted",
        oiProjection: oiProjection() });
    assert.deepEqual([value.status, value.reason, oiProjection().status],
        ["invalid", "volume_history_corrupted", "available"]);
});

test("G4-18 Current return destroys historical Volume chart and preserves live boundary", async () => {
    const value = harness(); value.nodes.historicalQriPanel.open = true; await value.runtime.open();
    value.runtime.selectVolume(); const chart = ChartFake.instances.at(-1);
    value.nodes.timeTravelReturnCurrent.dispatch("click");
    assert.equal(chart.destroyed, true); assert.equal(value.runtime.getState().status, "closed");
    assert.equal(value.runtime.getState().session.selectedMetric, "volume");
});

test("G4-19 historical projection performs no raw replay", () => {
    const source = fs.readFileSync(path.join(ROOT, "js/qriVolumeHistoricalProjection.js"), "utf8");
    assert.doesNotMatch(source, /rawBytes|parserInput|fetch\s*\(|XMLHttpRequest|EvidenceVault|replay|backfill/);
});

test("G4-20 UI integration adds no storage, acquisition, or parser authority", () => {
    const sources = ["js/qriVolumeHistoricalProjection.js", "js/qriTimeTravelView.js"]
        .map(file => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
    assert.doesNotMatch(sources, /indexedDB|localStorage|sessionStorage|persistCandidate|commitHistory|requestOnce/);
    assert.doesNotMatch(sources, /parseVolumeCanonical|createEvidenceCandidate/);
});
