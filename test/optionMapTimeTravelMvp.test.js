"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IDBFactory, IDBDatabase } = require("fake-indexeddb");
const Model = require("../js/timeTravel/optionMapHistoricalReadModel.js");
const View = require("../js/optionMapTimeTravelMvp.js");
const done = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error); transaction.onerror = () => undefined; });
async function createObservationDb(factory, name, records = [], wrong = false) {
    const db = await new Promise((resolve, reject) => { const open = factory.open(name, 1);
        open.onupgradeneeded = () => { const store = open.result.createObjectStore(
            wrong ? "wrong" : "observations", { keyPath: "observationId" });
        if (!wrong) { store.createIndex("byMarketDate", "marketDate");
            store.createIndex("byObservedAt", "observedAt"); } };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    if (!wrong && records.length) { const transaction = db.transaction("observations", "readwrite");
        records.forEach(value => transaction.objectStore("observations").put(value)); await done(transaction); }
    db.close();
}
async function createQriDb(factory, name, entries = []) {
    const db = await new Promise((resolve, reject) => { const open = factory.open(name, 1);
        open.onupgradeneeded = () => { open.result.createObjectStore("qriOptionsHistoryMeta", { keyPath: "id" });
            const store = open.result.createObjectStore("qriOptionsEntries", { keyPath: "entryKey" });
            store.createIndex("bySourceDate", "sourceDateKey");
            open.result.createObjectStore("qriOptionsRevisions", { keyPath: "revisionKey" }); };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    if (entries.length) { const transaction = db.transaction("qriOptionsEntries", "readwrite");
        entries.forEach(value => transaction.objectStore("qriOptionsEntries").put(value)); await done(transaction); }
    db.close();
}
async function createPriceDb(factory, records = [], wrong = false) {
    const db = await new Promise((resolve, reject) => { const open = factory.open("optionMapPriceSnapshots", 1);
        open.onupgradeneeded = () => { const store = open.result.createObjectStore(
            wrong ? "wrong" : "snapshots", { keyPath: "snapshotId" });
        if (!wrong) { store.createIndex("byMarketDate", "marketDate");
            store.createIndex("byObservedAt", "observedAt"); } };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    if (!wrong && records.length) { const transaction = db.transaction("snapshots", "readwrite");
        records.forEach(value => transaction.objectStore("snapshots").put(value)); await done(transaction); }
    db.close();
}
const priceSnapshot = (snapshotId, marketDate, observedAt, price, contract = "26年12月限") =>
    ({ snapshotId, marketDate, observedAt, price, contract });
function observation(id, observedAt, date = "2026-09-18") {
    return { observationId: id, marketDate: date, observedAt,
        overallV2: { available: true, direction: 42, confidence: 80, coverage: 100 },
        currentPrice: { available: true, value: 42000 },
        components: { option: { available: true, normalizedDirection: 0.5 },
            weekly: { available: true, normalizedDirection: -0.2 } },
        dataQuality: { status: "complete", warnings: [] } };
}
test("DB不存在はopen 0、schema mismatchを分離", async () => {
    let opens = 0; const absent = await Model.read({ calendarDate: "2026-09-18", indexedDB: {
        databases: async () => [], open: () => { opens++; throw new Error("must_not_open"); } },
    localStorage: { getItem: () => null } });
    assert.equal(opens, 0); assert.equal(absent.available, false); assert.equal(absent.status, "available");
    const factory = new IDBFactory(), observations = "optionMapMarketObservations";
    await createObservationDb(factory, observations, [], true);
    const mismatch = await Model.read({ calendarDate: "2026-09-18",
        indexedDB: factory, localStorage: { getItem: () => null } });
    assert.equal(mismatch.status, "schema_mismatch");
    const direct = await Model.observationsFor(factory, "2026-09-18");
    assert.equal(direct.status, "schema_mismatch");
});
test("同日複数Observationはlatest、QRIはexact dateだけ", async () => {
    const factory = new IDBFactory(), observationName = "optionMapMarketObservations",
        qriName = "optionMapQriOptionsHistory";
    await createObservationDb(factory, observationName, [observation("a", "2026-09-18T01:00:00.000Z"),
        observation("b", "2026-09-18T08:00:00.000Z")]);
    await createQriDb(factory, qriName, [{ entryKey: "2026-10|2026-09-18", contract: "2026-10",
        sourceDateKey: "2026-09-18", activeVersionKey: "v1" },
    { entryKey: "2026-11|2026-09-17", contract: "2026-11",
        sourceDateKey: "2026-09-17", activeVersionKey: "v2" }]);
    const result = await Model.read({ calendarDate: "2026-09-18", indexedDB: factory,
        localStorage: { getItem: () => null } });
    assert.equal(result.latestObservation.observationId, "b"); assert.equal(result.observationCount, 2);
    assert.deepEqual(result.qri.contracts, ["2026-10"]); assert.equal(result.available, true);
});
test("readonly transactionと成功・失敗時connection close", async () => {
    const factory = new IDBFactory(), name = "optionMapMarketObservations";
    await createObservationDb(factory, name,
        [observation("a", "2026-09-18T01:00:00.000Z")]);
    const modes = [], originalTransaction = IDBDatabase.prototype.transaction,
        originalClose = IDBDatabase.prototype.close; let closes = 0;
    IDBDatabase.prototype.transaction = function (stores, mode) { modes.push(mode);
        return originalTransaction.call(this, stores, mode); };
    IDBDatabase.prototype.close = function () { closes++; return originalClose.call(this); };
    try { const result = await Model.observationsFor(factory, "2026-09-18");
        assert.equal(result.status, "available"); assert.deepEqual(modes, ["readonly"]); assert.equal(closes, 1);
    } finally { IDBDatabase.prototype.transaction = originalTransaction;
        IDBDatabase.prototype.close = originalClose; }
});
function node() { return { children: [], textContent: "", hidden: false, disabled: false,
    listeners: {}, ownerDocument: null, appendChild(value) { this.children.push(value); },
    replaceChildren() { this.children = []; }, addEventListener(type, callback) { this.listeners[type] = callback; },
    click() { this.listeners.click?.(); }, scrollIntoView() {} }; }
function documentFixture() {
    const ids = ["marketCalendarTimeTravelAction", "marketCalendarTimeTravelStatus",
        "marketCalendarTimeTravelButton", "optionMapHistoricalView", "timeTravelReturnToday",
        "timeTravelSelectedDate", "timeTravelObservation", "timeTravelMorning", "timeTravelQriStatus",
        "timeTravelPriceChartSummary", "timeTravelPriceChartRange", "timeTravelPriceChartEmpty",
        "timeTravelPriceChartContainer", "timeTravelPriceChartCanvas", "marketCalendarToday"],
        nodes = Object.fromEntries(ids.map(id => [id, node()]));
    const listeners = {}, document = { getElementById: id => nodes[id],
        addEventListener(type, callback) { listeners[type] = callback; }, createElement() { const value = node();
            value.ownerDocument = document; return value; } };
    Object.values(nodes).forEach(value => { value.ownerDocument = document; });
    nodes.optionMapHistoricalView.querySelector = selector => nodes[selector.slice(1)];
    return { document, nodes, listeners };
}
test("過去日だけ入口を出し、保存なし・非同期競合・今日に戻るを処理", async () => {
    const { document, nodes } = documentFixture(); let resolver, todayClicks = 0;
    nodes.marketCalendarToday.listeners.click = () => { todayClicks++; };
    const first = new Promise(resolve => { resolver = resolve; }); let calls = 0;
    const read = ({ calendarDate }) => ++calls === 1 ? first : Promise.resolve({ calendarDate,
        status: "available", available: false, latestObservation: null, morningBaselines: [],
        qri: { available: false, contracts: [], selectedContract: null } });
    const controller = View.create({ document, read, now: () => new Date("2026-09-21T00:00:00Z") });
    const old = controller.selected({ detail: { calendarDate: "2026-09-18" } });
    await controller.selected({ detail: { calendarDate: "2026-09-19" } });
    resolver({ calendarDate: "2026-09-18", status: "available", available: true,
        latestObservation: observation("x", "2026-09-18T01:00:00Z"), morningBaselines: [],
        qri: { available: false, contracts: [], selectedContract: null } }); await old;
    assert.equal(nodes.marketCalendarTimeTravelButton.hidden, true);
    assert.equal(nodes.marketCalendarTimeTravelStatus.textContent, "この日のOptionMap保存データはありません");
    await controller.selected({ detail: { calendarDate: "2026-09-21" } });
    assert.equal(nodes.marketCalendarTimeTravelAction.hidden, true);
    controller.returnToday(); assert.equal(todayClicks, 1); assert.equal(nodes.optionMapHistoricalView.hidden, true);
});
test("historical viewは保存断面・Morning・QRIを専用領域へ描画", async () => {
    const { document, nodes } = documentFixture(), qriCalls = [];
    const result = { calendarDate: "2026-09-18", status: "available", available: true,
        latestObservation: observation("x", "2026-09-18T06:00:00.000Z"), observationCount: 1,
        morningBaselines: [], priceSnapshots: [],
        qri: { available: true, contracts: ["2026-10"], selectedContract: "2026-10" } };
    const controller = View.create({ document, read: async () => result,
        openQri: value => qriCalls.push(value), now: () => new Date("2026-09-21T00:00:00Z") });
    await controller.selected({ detail: { calendarDate: "2026-09-18" } }); await controller.open();
    assert.equal(nodes.optionMapHistoricalView.hidden, false);
    assert.equal(nodes.timeTravelSelectedDate.textContent, "2026年9月18日");
    const observationText = nodes.timeTravelObservation.children.map(value => value.textContent).join(" ");
    assert.doesNotMatch(observationText, /confidence|coverage|quality|warnings|option|weekly/);
    assert.equal(View.japaneseDate("2026-09-20"), "2026年9月20日");
    assert.match(nodes.timeTravelMorning.children.at(-1).textContent, /保存なし/);
    assert.deepEqual(qriCalls, [{ selectedTradingDate: "2026-09-18", selectedContract: "2026-10" }]);
});
test("Price Snapshotはexact JST観測日だけreadonly取得しconnectionをclose", async () => {
    const factory = new IDBFactory(); await createPriceDb(factory, [
        priceSnapshot("a", "2026-09-18", "2026-09-18T01:00:00.000Z", 42000),
        priceSnapshot("b", "2026-09-19", "2026-09-19T01:00:00.000Z", 42100)]);
    const modes = [], originalTransaction = IDBDatabase.prototype.transaction,
        originalClose = IDBDatabase.prototype.close; let closes = 0;
    IDBDatabase.prototype.transaction = function (stores, mode) { modes.push(mode);
        return originalTransaction.call(this, stores, mode); };
    IDBDatabase.prototype.close = function () { closes++; return originalClose.call(this); };
    try { const result = await Model.priceSnapshotsFor(factory, "2026-09-18");
        assert.equal(result.status, "available"); assert.deepEqual(result.value.map(value => value.snapshotId), ["a"]);
        assert.deepEqual(modes, ["readonly"]); assert.equal(closes, 1);
    } finally { IDBDatabase.prototype.transaction = originalTransaction;
        IDBDatabase.prototype.close = originalClose; }
});
test("価格chartは0点・1点・複数contract・不均等timestampを保持", () => {
    const empty = View.priceChartModel([], null); assert.equal(empty.count, 0);
    const one = View.priceChartModel([
        priceSnapshot("one", "2026-09-18", "2026-09-18T01:00:00.000Z", 42000)], null);
    assert.equal(one.series[0].showLine, false);
    const values = [priceSnapshot("a", "2026-09-18", "2026-09-18T01:00:00.000Z", 42000, "A"),
        priceSnapshot("b", "2026-09-18", "2026-09-18T01:05:00.000Z", 42100, "A"),
        priceSnapshot("c", "2026-09-18", "2026-09-18T03:00:00.000Z", 41900, "A"),
        priceSnapshot("d", "2026-09-18", "2026-09-18T02:00:00.000Z", 43000, "B")];
    const model = View.priceChartModel(values, null);
    assert.equal(model.series.length, 2); assert.equal(model.series[0].showLine, true);
    assert.equal(model.series[1].showLine, false);
    assert.deepEqual(model.series[0].points.map(value => value.x), [Date.parse(values[0].observedAt),
        Date.parse(values[1].observedAt), Date.parse(values[2].observedAt)]);
    assert.notEqual(model.series[0].points[1].x - model.series[0].points[0].x,
        model.series[0].points[2].x - model.series[0].points[1].x);
});
test("最終保存断面markerは同日・同価格・10ms以内の一意snapshotだけ", () => {
    const latest = observation("o", "2026-09-18T06:00:00.000Z");
    const match = priceSnapshot("match", "2026-09-18", "2026-09-18T06:00:00.002Z", 42000);
    assert.equal(View.finalObservationSnapshot([match], latest).snapshotId, "match");
    assert.equal(View.finalObservationSnapshot([{ ...match, price: 42001 }], latest), null);
    assert.equal(View.finalObservationSnapshot([{ ...match, observedAt: "2026-09-18T06:00:00.011Z" }], latest), null);
    assert.equal(View.finalObservationSnapshot([match, { ...match, snapshotId: "ambiguous" }], latest), null);
});
test("runtimeにwriter、readwrite、推測日付補正を持たない", () => {
    const model = fs.readFileSync(path.resolve(__dirname,
        "../js/timeTravel/optionMapHistoricalReadModel.js"), "utf8");
    assert.doesNotMatch(model, /readwrite|\.put\(|\.add\(|createObjectStore|previousBusiness|営業日/);
    const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
    assert.match(html, /⏪ この日のOptionMapを見る/);
    assert.match(html, /過去データ表示中/);
    assert.match(html, /今日に戻る/);
    assert.match(html, /OptionMap保存時点の価格推移/);
    assert.match(html, /保存間の市場値動きは含みません/);
    assert.doesNotMatch(html, /ローソク足|OHLC/);
});
