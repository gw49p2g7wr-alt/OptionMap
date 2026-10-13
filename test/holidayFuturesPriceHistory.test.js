"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { IDBFactory, IDBDatabase } = require("fake-indexeddb");
const Price = require("../js/priceSnapshot.js");
const Prices = require("../js/storage/priceSnapshotStore.js");
const Observation = require("../js/marketObservation.js");
const Observations = require("../js/storage/marketObservationStore.js");
const Model = require("../js/timeTravel/optionMapHistoricalReadModel.js");
const View = require("../js/optionMapTimeTravelMvp.js");
const Identity = require("../js/currentPriceLiveIdentityFact.js");
const Calendar = require("../js/marketCalendarMvp.js");

function input(observedAt, marketDate = "2026-10-13", available = true) {
    return { observedAt, rendererState: { currentPrice: { quotedAt: observedAt } },
        summary: { generatedAt: observedAt, marketDate,
            sourceVersions: [{ source: "qri-options", tradingDate: marketDate, contract: "2026-12",
                versionKey: "fixture-v1", signature: `sha256:${"a".repeat(64)}` }],
            dataQuality: { status: "partial", warnings: [] }, freshness: {},
            payload: { currentPrice: { available, status: available ? "available" : "unavailable",
                value: available ? 68000 : null, source: "qri-nikkei225-futures", mode: "automatic",
                contract: "2026-12", quotedAt: observedAt, fetchedAt: observedAt },
            overallV2: { available: false, direction: null, confidence: null, coverage: null, agreement: null },
            nearestLevels: {}, morningBaseline: {}, changeSinceMorning: {} } } };
}
async function withPrices(run) {
    const indexedDB = new IDBFactory(), store = Prices.createPriceSnapshotStore({ indexedDB });
    try { await run(store, indexedDB); } finally { store.closeStore(); }
}
test("H1 ordinary weekday valid futures price remains savable", () => withPrices(async (store) => {
    assert.equal((await Price.persistBestEffort(input("2026-10-13T01:00:00.000Z"), store)).saved, true);
}));
test("H2 stock holiday with valid session price is saved without a cash-market gate", () =>
    withPrices(async (store) => {
        assert.equal((await Price.persistBestEffort(input("2026-10-12T01:00:00.000Z"), store)).saved, true);
        const [record] = await store.listAll();
        assert.equal(record.calendarDay, "2026-10-12");
        assert.equal(record.marketDate, "2026-10-13");
        assert.equal(record.session, "unknown"); // No invented session authority.
    }));
for (const [id, time] of [["H3 pre-session", "2026-10-11T22:25:00.000Z"],
    ["H4 closed session", "2026-10-12T07:00:00.000Z"]]) {
    test(`${id}: unavailable current-price input is not saved or zero-filled`, async () => {
        let appends = 0;
        const result = await Price.persistBestEffort(input(time, "2026-10-13", false),
            { append: () => { appends++; } });
        assert.equal(result.saved, false); assert.equal(result.error, "current_price_unavailable");
        assert.equal(appends, 0);
    });
}
function node(document) {
    return { ownerDocument: document, children: [], textContent: "", hidden: false,
        appendChild(value) { this.children.push(value); }, replaceChildren() { this.children = []; } };
}
function panelFixture() {
    const document = { createElement() { return node(document); } };
    const elements = new Map();
    return { elements, querySelector(id) {
        if (!elements.has(id)) elements.set(id, node(document));
        return elements.get(id);
    }, ownerDocument: document };
}
function allText(value) { return [value.textContent, ...value.children.map(allText)].join(" "); }
test("H5 saved holiday observation/price is visible on its JST day, not on the next trading day", async () => {
    const indexedDB = new IDBFactory(), prices = Prices.createPriceSnapshotStore({ indexedDB }),
        observations = Observations.createMarketObservationStore({ indexedDB });
    try {
        const fixture = input("2026-10-12T01:00:00.000Z");
        const price = await Price.createSnapshot(fixture), observation = await Observation.createObservation(fixture);
        await prices.append(price); await observations.append(observation);
        prices.closeStore(); observations.closeStore();
        const result = await Model.read({ calendarDate: "2026-10-12", indexedDB,
            localStorage: { getItem: () => null } });
        assert.equal(result.available, true); assert.equal(result.observationCount, 1);
        assert.deepEqual(result.priceSnapshots, [price]);
        assert.deepEqual(result.latestObservation, observation);
        assert.equal(result.latestObservation.marketDate, "2026-10-13");
        assert.equal(result.qri.available, false); // Never remap QRI trading-date authority.
        const panel = panelFixture();
        const chart = View.render(panel, result, function Chart() {});
        assert.match(allText(panel.querySelector("#timeTravelObservation")), /68,000円/);
        assert.equal(chart.model.count, 1); assert.equal(chart.model.finalObservationMatched, true);
        assert.equal(panel.querySelector("#timeTravelPriceChartContainer").hidden, false);
        const next = await Model.read({ calendarDate: "2026-10-13", indexedDB,
            localStorage: { getItem: () => null } });
        assert.equal(next.observationCount, 0); assert.deepEqual(next.priceSnapshots, []);
        assert.deepEqual(await prices.listAll(), [price]);
        assert.deepEqual(await observations.listAll(), [observation]);
    } finally { prices.closeStore(); observations.closeStore(); }
});
test("H6 invalid automatic contract and verified-current-price contract mismatch still reject", async () => {
    const fixture = input("2026-10-12T01:00:00.000Z");
    fixture.summary.payload.currentPrice.contract = null;
    await assert.rejects(Price.createSnapshot(fixture), /automatic_contract_unavailable/);
    const fact = await Identity.buildCurrentPriceLiveIdentityFact({
        priceResult: { available: true, source: "qri-nikkei225-futures", mode: "automatic",
            origin: "live", value: 68000, contract: "26年12月限" }, activeContract: "2026-11" });
    assert.equal(fact.available, false); assert.equal(fact.reason, "contract_mismatch");
});
test("H7 duplicate semantics remain five minutes, not a whole-day save lock", () =>
    withPrices(async (store) => {
        const fixture = input("2026-10-12T01:00:00.000Z");
        assert.equal((await Price.persistBestEffort(fixture, store)).outcome, "appended");
        assert.equal((await Price.persistBestEffort({ ...fixture, observedAt: "2026-10-12T01:04:00.000Z" }, store))
            .outcome, "duplicate");
        assert.equal((await Price.persistBestEffort({ ...fixture, observedAt: "2026-10-12T01:06:00.000Z" }, store))
            .outcome, "appended");
    }));
test("H8 same-date ordinary weekday read is unchanged and stays readonly", () =>
    withPrices(async (store, indexedDB) => {
        await Price.persistBestEffort(input("2026-10-13T01:00:00.000Z"), store); store.closeStore();
        const original = IDBDatabase.prototype.transaction, modes = [];
        IDBDatabase.prototype.transaction = function (names, mode) {
            modes.push(mode); return original.call(this, names, mode);
        };
        try {
            assert.equal((await Model.priceSnapshotsFor(indexedDB, "2026-10-13")).value.length, 1);
            assert.deepEqual(modes, ["readonly"]);
        } finally { IDBDatabase.prototype.transaction = original; }
    }));
test("JST midnight selection supports stored offsets and never uses previous-day fallback", () =>
    withPrices(async (store, indexedDB) => {
        for (const observedAt of ["2026-10-11T14:59:59.999Z", "2026-10-11T15:00:00.000Z",
            "2026-10-12T23:59:59.999+09:00", "2026-10-12T15:00:00.000Z"]) {
            await Price.persistBestEffort(input(observedAt), store);
        }
        store.closeStore();
        const result = await Model.priceSnapshotsFor(indexedDB, "2026-10-12");
        assert.deepEqual(result.value.map(value => value.observedAt),
            ["2026-10-11T15:00:00.000Z", "2026-10-12T23:59:59.999+09:00"]);
        assert.deepEqual((await Model.priceSnapshotsFor(indexedDB, "2026-10-14")).value, []);
    }));
test("holiday event display stays separate from saved-price selection", () => {
    const event = { eventKey: "holiday", sourceId: "jp-jpx-market-holidays",
        logical: { eventType: "JPX_MARKET_HOLIDAY" }, title: { ja: "JPX休場（スポーツの日）" },
        lifecycleStatus: "scheduled", schedule: { kind: "all_day", sourceLocal: {
            startDate: "2026-10-12", endDate: null, timeZone: "Asia/Tokyo" } } };
    const view = Calendar.viewModel(event);
    assert.equal(view.calendarDate, "2026-10-12"); assert.equal(view.timeLabel, "終日");
    assert.equal(view.shortTitle, "日本市場休場");
});
