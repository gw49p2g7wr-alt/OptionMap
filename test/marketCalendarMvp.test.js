"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB, IDBKeyRange, IDBDatabase } = require("fake-indexeddb");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Consumer = require("../js/marketCalendarHistory/readOnlyCalendarConsumer.js");
const Mvp = require("../js/marketCalendarMvp.js");
const name = () => `calendar-mvp-${Date.now()}-${Math.random()}`;
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error); tx.onerror = () => undefined; });
async function create(databaseName, { wrongSchema = false } = {}) {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open(databaseName, 1);
        open.onupgradeneeded = () => wrongSchema ? open.result.createObjectStore("wrong") :
            Schema.createInUpgrade(open.result);
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    db.close();
}
function revision(index, date, kind = "instant", extra = {}) {
    const eventKey = `event-${index}`, end = kind === "date_range" ? "2026-09-23" : date;
    return { eventKey, revisionKey: `${eventKey}|active`, sourceId: "us-bls-calendar",
        calendarDateStart: date, calendarDateEnd: end, validTo: null, title: { ja: `予定${index}` },
        logical: { eventType: "US_CPI" }, lifecycleStatus: "scheduled", change: { reason: null },
        schedule: { kind, canonicalStart: kind === "instant" ? "2026-09-21T23:30:00.000Z" : null,
            sourceLocal: { startDate: kind === "instant" ? "2026-09-21" : date,
                endDate: kind === "date_range" ? end : null,
                timeZone: kind === "instant" ? "America/New_York" : "Asia/Tokyo" } }, ...extra };
}
async function seed(databaseName) {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open(databaseName);
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(["marketCalendarEventEntries", "marketCalendarSemanticRevisions"], "readwrite");
    for (let i = 0; i < 205; i += 1) {
        const date = i === 0 ? "2026-09-22" : i === 1 ? "2026-09-20" : "2026-10-01";
        const kind = i === 0 ? "instant" : i === 1 ? "date_range" : i === 2 ? "date_only" :
            i === 3 ? "all_day" : "instant";
        const value = revision(i, date, kind, i >= 2 ? { schedule: { kind,
            canonicalStart: kind === "instant" ? "2026-10-01T00:00:00.000Z" : null,
            sourceLocal: { startDate: date, endDate: null, timeZone: "Asia/Tokyo" } } } : {});
        tx.objectStore("marketCalendarEventEntries").put({ eventKey: value.eventKey,
            sourceId: value.sourceId, activeRevisionKey: value.revisionKey });
        tx.objectStore("marketCalendarSemanticRevisions").put(value);
    }
    tx.objectStore("marketCalendarSemanticRevisions").put(revision("old", "2026-09-22", "instant",
        { validTo: "2026-09-21T00:00:00.000Z" }));
    await done(tx); db.close();
}
test("205 active件を参照し、CalendarDate indexから範囲とactive pointerを確定", async () => {
    const databaseName = name(); await create(databaseName); await seed(databaseName);
    const result = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
        startDate: "2026-09-22", endDate: "2026-09-22" });
    assert.equal(result.status, "available"); assert.equal(result.activeEntryCount, 205);
    assert.deepEqual(result.events.map(value => value.eventKey), ["event-1", "event-0"]);
    const twoMonths = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
        startDate: "2026-09-01", endDate: "2026-10-31" });
    assert.equal(twoMonths.status, "available"); assert.equal(twoMonths.events.length, 205);
    const empty = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
        startDate: "2026-09-24", endDate: "2026-09-24" });
    assert.equal(empty.status, "available"); assert.deepEqual(empty.events, []);
});
test("DB不存在ではopen 0、schema不一致は分離", async () => {
    let opens = 0; const absent = await Consumer.query({ indexedDB: { databases: async () => [],
        open: () => { opens++; throw new Error("must not open"); } }, keyRange: IDBKeyRange,
        startDate: "2026-09-22", endDate: "2026-09-22" });
    assert.equal(absent.status, "absent"); assert.equal(opens, 0);
    const databaseName = name(); await create(databaseName, { wrongSchema: true });
    const mismatched = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
        startDate: "2026-09-22", endDate: "2026-09-22" });
    assert.equal(mismatched.status, "schema_mismatch");
});
test("readonlyのみで成功・失敗ともconnectionをclose", async () => {
    const databaseName = name(); await create(databaseName); await seed(databaseName);
    const modes = [], originalTransaction = IDBDatabase.prototype.transaction,
        originalClose = IDBDatabase.prototype.close; let closes = 0;
    IDBDatabase.prototype.transaction = function (stores, mode) { modes.push(mode); return originalTransaction.call(
        this, stores, mode); };
    IDBDatabase.prototype.close = function () { closes++; return originalClose.call(this); };
    try {
        const good = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
            startDate: "2026-09-22", endDate: "2026-09-22" });
        assert.equal(good.status, "available");
        const failed = await Consumer.query({ indexedDB, keyRange: { lowerBound: () => {
            throw new Error("injected_failure"); } }, databaseName,
            startDate: "2026-09-22", endDate: "2026-09-22" });
        assert.equal(failed.status, "unavailable");
        assert.deepEqual(modes, ["readonly"]); assert.equal(closes, 2);
    } finally { IDBDatabase.prototype.transaction = originalTransaction;
        IDBDatabase.prototype.close = originalClose; }
});
test("transaction開始失敗でもconnectionをcloseし、取得不能に留める", async () => {
    const databaseName = name(); await create(databaseName); let closes = 0;
    const originalTransaction = IDBDatabase.prototype.transaction,
        originalClose = IDBDatabase.prototype.close;
    IDBDatabase.prototype.transaction = () => { throw new Error("transaction_failure"); };
    IDBDatabase.prototype.close = function () { closes++; return originalClose.call(this); };
    try { const result = await Consumer.query({ indexedDB, keyRange: IDBKeyRange, databaseName,
        startDate: "2026-09-22", endDate: "2026-09-22" });
        assert.equal(result.status, "unavailable"); assert.equal(closes, 1);
    } finally { IDBDatabase.prototype.transaction = originalTransaction;
        IDBDatabase.prototype.close = originalClose; }
});
test("日曜始まり42日月間grid、前後月移動、JST跨ぎと4 schedule表示", () => {
    assert.equal(Mvp.todayJst(new Date("2026-09-21T16:00:00.000Z")), "2026-09-22");
    const month = Mvp.monthGrid(2026, 9);
    assert.equal(month.cells.length, 42); assert.equal(month.weekStartsOn, "sunday");
    assert.deepEqual(Mvp.monthRange(month), { startDate: "2026-08-30", endDate: "2026-10-10" });
    assert.deepEqual(Mvp.shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
    assert.deepEqual(Mvp.shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
    assert.equal(Mvp.selectedDateHeading("2026-09-21"), "9月21日（月）の予定");
    const exact = Mvp.viewModel(revision(0, "2026-09-22"));
    assert.equal(exact.dateLabel, "2026-09-22"); assert.equal(exact.timeLabel, "08:30");
    assert.equal(exact.shortTitle, "米CPI");
    assert.equal(exact.importanceLabel, "最重要"); assert.equal(exact.sourceLabel, "米労働統計局");
    assert.equal(Mvp.viewModel(revision(1, "2026-09-22", "date_only")).timeLabel, "時刻未定");
    assert.equal(Mvp.viewModel(revision(2, "2026-09-22", "all_day")).timeLabel, "終日");
    const range = Mvp.viewModel(revision(3, "2026-09-20", "date_range"));
    assert.equal(range.dateLabel, "2026-09-20〜2026-09-23");
    assert.equal(range.timeLabel, "期間");
    assert.deepEqual(Mvp.eventsForDate([revision(3, "2026-09-20", "date_range")], "2026-09-22")
        .map(value => value.eventKey), ["event-3"]);
});
test("consumerにwriter/mutation依存がなく、UIは月間gridと日付詳細を持つ", () => {
    const source = fs.readFileSync(path.resolve(__dirname,
        "../js/marketCalendarHistory/readOnlyCalendarConsumer.js"), "utf8");
    assert.doesNotMatch(source, /readwrite|productionHistoryWriter|createObjectStore|\.put\(|\.add\(/);
    const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
    assert.match(html, /id="marketCalendarPanel"/);
    for (const id of ["marketCalendarGrid", "marketCalendarEvents", "marketCalendarToday",
        "marketCalendarPreviousMonth", "marketCalendarNextMonth"]) assert.match(html,
        new RegExp(`id="${id}"`));
    assert.doesNotMatch(html, /data-calendar-mode="(?:today|tomorrow|week)"/);
    const css = fs.readFileSync(path.resolve(__dirname, "../style.css"), "utf8");
    assert.match(css, /\.market-calendar-preview-label[^}]*text-overflow: ellipsis/s);
    assert.match(css, /\.market-calendar-day[^}]*overflow: hidden/s);
    assert.match(css, /\.market-calendar-grid\s*\{[^}]*gap: 0/s);
    assert.match(css, /\.market-calendar-day\s*\{[^}]*min-height: 64px[^}]*margin: 0/s);
    assert.match(css, /\.market-calendar-toolbar button\s*\{[^}]*margin: 0/s);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.market-calendar-day\s*\{ min-height: 55px/s);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.market-calendar-toolbar[^}]*grid-template-columns/);
    assert.match(css, /\.market-calendar-marker\.importance-high[^}]*var\(--calendar-high\)/s);
    assert.match(css, /\.market-calendar-mobile-count\.importance-high[^}]*var\(--calendar-high\)/s);
});
test("月間gridの当日・選択日・前後月・複数件縮約と日付詳細を描画", () => {
    const ownerDocument = { createElement: () => makeNode() };
    const makeNode = () => ({ children: [], className: "", textContent: "", ownerDocument,
        dataset: {}, attributes: {}, listeners: {}, appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; }, setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, callback) { this.listeners[name] = callback; } });
    const nodes = Object.fromEntries(["marketCalendarStatus", "marketCalendarGrid",
        "marketCalendarDetailStatus", "marketCalendarEvents", "marketCalendarDetailTitle"]
        .map(id => [id, makeNode()]));
    const panel = { ownerDocument, querySelector: selector => nodes[selector.slice(1)] };
    const grid = Mvp.monthGrid(2026, 9), picked = [];
    const events = [revision(0, "2026-09-22"), revision(1, "2026-09-20", "date_range"),
        revision(2, "2026-09-22", "all_day"), revision(3, "2026-09-22", "date_only"),
        revision(4, "2026-09-24", "all_day", { sourceId: "jp-jpx-market-holidays",
            logical: { eventType: "JPX_MARKET_HOLIDAY", edition: "initial" } }),
        revision(5, "2026-09-24", "date_only", { sourceId: "us-bea-calendar",
            logical: { eventType: "US_PCE", edition: "initial" } })];
    Mvp.renderMonth(panel, { status: "available", events }, grid, "2026-09-22", "2026-09-21",
        date => picked.push(date));
    assert.equal(nodes.marketCalendarGrid.children.length, 42);
    const cell = date => nodes.marketCalendarGrid.children.find(node => node.dataset.calendarDate === date);
    assert.match(cell("2026-09-22").className, /is-selected/);
    assert.match(cell("2026-09-21").className, /is-today/);
    assert.match(cell("2026-08-30").className, /is-outside/);
    assert.equal(cell("2026-09-22").children[1].children.at(-1).textContent, "＋2件");
    assert.equal(cell("2026-09-22").children[1].children[0].children[1].textContent, "08:30 米CPI");
    assert.match(cell("2026-09-24").children[2].className, /importance-high/);
    assert.match(cell("2026-09-24").children[1].children[0].children[0].className, /importance-high/);
    cell("2026-09-22").listeners.click(); assert.deepEqual(picked, ["2026-09-22"]);
    Mvp.renderDetail(panel, { status: "available", events: Mvp.eventsForDate(events, "2026-09-22") },
        "2026-09-22");
    assert.equal(nodes.marketCalendarDetailStatus.textContent, "4件の予定");
    assert.equal(nodes.marketCalendarDetailTitle.textContent, "9月22日（火）の予定");
    assert.deepEqual(nodes.marketCalendarEvents.children[0].children.map(node => node.textContent),
        ["2026-09-22", "08:30", "予定0", "最重要", "米労働統計局"]);
    assert.equal(nodes.marketCalendarStatus.textContent, "2026年9月の経済イベント");
    assert.doesNotMatch(nodes.marketCalendarStatus.textContent, /保存済み|active 205/);
});
test("日付詳細の0件・DB不在・schema不一致を分離", () => {
    const makeNode = () => ({ children: [], textContent: "", ownerDocument: {
        createElement: () => makeNode() }, appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; } });
    const nodes = Object.fromEntries(["marketCalendarDetailStatus", "marketCalendarEvents",
        "marketCalendarDetailTitle"].map(id => [id, makeNode()]));
    const panel = { querySelector: selector => nodes[selector.slice(1)] };
    Mvp.renderDetail(panel, { status: "available", events: [] }, "2026-09-28");
    assert.equal(nodes.marketCalendarDetailStatus.textContent, "予定なし");
    Mvp.renderDetail(panel, { status: "absent", events: [] }, "2026-09-28");
    assert.match(nodes.marketCalendarDetailStatus.textContent, /この環境にカレンダーデータがありません/);
    Mvp.renderDetail(panel, { status: "schema_mismatch", events: [] }, "2026-09-28");
    assert.match(nodes.marketCalendarDetailStatus.textContent, /形式が一致しません/);
});
