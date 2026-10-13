"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { IDBFactory, IDBDatabase, IDBObjectStore } = require("fake-indexeddb");
const Model = require("../js/timeTravel/optionMapHistoricalReadModel.js"), View = require("../js/optionMapTimeTravelMvp.js");
const Prices = require("../js/storage/priceSnapshotStore.js"), P = require("../js/priceSnapshot.js");
const Observations = require("../js/storage/marketObservationStore.js"), O = require("../js/marketObservation.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"), Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Memory = require("../js/marketCalendarHistory/inMemoryHistory.js"), Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const vm = require("node:vm"), { webcrypto } = require("node:crypto");
const Morning = require("../js/morningBaselineV4.js"), MorningStorage = require("../js/morningBaselineV4Storage.js");
const DAY = "2026-10-12", AT = "2026-10-11T22:25:12.946Z";
function input(at = AT, marketDate = "2026-10-13", value = 68970) {
    return { observedAt: at, rendererState: { currentPrice: { quotedAt: "10/10 06:00" } },
        summary: { generatedAt: at, marketDate, sourceVersions: [], dataQuality: { status: "partial", warnings: [] },
            freshness: {}, payload: { currentPrice: { available: true, value, source: "qri-nikkei225-futures",
                mode: "automatic", contract: "26年12月限", quotedAt: null, fetchedAt: at, status: "available" },
            overallV2: { available: true, direction: 37, confidence: 78, coverage: 50, agreement: null },
            nearestLevels: {}, morningBaseline: {}, changeSinceMorning: {} } } };
}
async function seed(factory, inputs = [input()]) {
    const prices = Prices.createPriceSnapshotStore({ indexedDB: factory }), observations = Observations.createMarketObservationStore({ indexedDB: factory });
    try { for (const i of inputs) { await prices.append(await P.createSnapshot(i));
        await observations.append(await O.createObservation(i)); } }
    finally { prices.closeStore(); observations.closeStore(); }
}
const local = { getItem: () => null }, read = (indexedDB, calendarDate = DAY, localStorage = local) => Model.read({ indexedDB, calendarDate, localStorage });
function element(document) { return { ownerDocument: document, children: [], textContent: "", hidden: false, disabled: false,
    listeners: {}, appendChild(v) { this.children.push(v); }, replaceChildren() { this.children = []; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn(); }, scrollIntoView() {} }; }
function dom() {
    const nodes = new Map(), document = { getElementById: id => nodes.get(id), listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }, createElement() { return element(document); } };
    for (const id of ["marketCalendarTimeTravelAction", "marketCalendarTimeTravelStatus", "marketCalendarTimeTravelButton",
        "optionMapHistoricalView", "timeTravelReturnToday", "marketCalendarToday", "marketCalendarPreviousMonth", "marketCalendarNextMonth",
        "timeTravelSelectedDate", "timeTravelObservation", "timeTravelMorning", "timeTravelQriStatus", "timeTravelTimeline",
        "timeTravelCalendar", "timeTravelArchiveStatus", "timeTravelPriceChartSummary", "timeTravelPriceChartRange",
        "timeTravelPriceChartEmpty", "timeTravelPriceChartContainer", "timeTravelPriceChartCanvas"]) nodes.set(id, element(document));
    nodes.get("optionMapHistoricalView").querySelector = id => nodes.get(id.slice(1));
    return { document, nodes, panel: nodes.get("optionMapHistoricalView") };
}
const text = e => [e.textContent, ...e.children.map(text)].join(" ");
test("T1/T4 selected saved archive: holiday 68970 / observed day12 / trading metadata13 / raw quote unchanged", async () => {
    const factory = new IDBFactory(); await seed(factory);
    const result = await read(factory), { panel, nodes } = dom();
    assert.equal(result.available, true); assert.equal(result.latestPriceSnapshot.price, 68970);
    assert.equal(result.latestPriceSnapshot.calendarDay, DAY); assert.equal(result.latestPriceSnapshot.marketDate, "2026-10-13");
    assert.equal(result.latestPriceSnapshot.quotedAtRaw, "10/10 06:00"); assert.equal(result.latestPriceSnapshot.quotedAtNormalized, null);
    View.render(panel, result, function Chart() {});
    assert.match(text(nodes.get("timeTravelObservation")), /68,970円/);
    assert.match(text(nodes.get("timeTravelObservation")), /marketDate：2026-10-13/);
    assert.equal((await read(factory, "2026-10-13")).priceSnapshots.length, 0);
});
test("T2/T10 archive reader/UI use no fetch, current price, live state or current parser", async () => {
    const factory = new IDBFactory(); await seed(factory); const originalFetch = global.fetch;
    global.fetch = () => { throw Error("network_forbidden"); };
    Object.defineProperty(global, "getMobileSummaryRendererState", { configurable: true, get() { throw Error("live_forbidden"); } });
    try { const result = await read(factory), fixture = dom();
        let currentQriCalls = 0; const controller = View.create({ ...fixture, read: async () => result,
            openQri: () => { currentQriCalls++; }, now: () => new Date("2026-10-13T00:00:00Z"), ChartConstructor: function Chart() {} });
        await controller.selected({ detail: { calendarDate: DAY } }); await controller.open();
        assert.equal(currentQriCalls, 0); assert.equal(fixture.panel.hidden, false);
    } finally { global.fetch = originalFetch; delete global.getMobileSummaryRendererState; }
    for (const file of ["js/timeTravel/optionMapHistoricalReadModel.js", "js/optionMapTimeTravelMvp.js"])
        assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /fetch\(|getMobileSummaryRendererState|currentPriceLiveIdentity|canonicalize\(/);
});
test("T3 reads are readonly and leave existing records byte-identical; absent DB never created", async () => {
    const factory = new IDBFactory(); await seed(factory); const original = IDBDatabase.prototype.transaction,
        writes = IDBObjectStore.prototype.put, modes = [];
    IDBDatabase.prototype.transaction = function (names, mode) { modes.push(mode); assert.equal(mode, "readonly"); return original.call(this, names, mode); };
    IDBObjectStore.prototype.put = () => { throw Error("write_forbidden"); };
    try { const first = await read(factory), second = await read(factory); assert.deepEqual(second, first);
        assert.ok(modes.length); assert.ok(modes.every(m => m === "readonly")); }
    finally { IDBDatabase.prototype.transaction = original; IDBObjectStore.prototype.put = writes; }
    let opens = 0; const result = await read({ databases: async () => [], open() { opens++; throw Error("create_forbidden"); } });
    assert.equal(opens, 0); assert.equal(result.status, "empty");
});
test("T5 ordinary weekday archived Overall is the stored value, not recalculated", async () => {
    const factory = new IDBFactory(); await seed(factory, [input("2026-10-09T01:00:00.000Z", "2026-10-09", 68390)]);
    const result = await read(factory, "2026-10-09"); assert.equal(result.latestObservation.overallV2.direction, 37);
    assert.equal(result.latestPriceSnapshot.price, 68390);
});
test("T6 numeric chronological order, deterministic same-instant tie-break, existing duplicate rule", async () => {
    const factory = new IDBFactory(), inputs = [input("2026-10-12T10:00:00+09:00", "2026-10-13", 69000),
        input("2026-10-12T02:00:00.000Z", "2026-10-13", 69100), input(AT)];
    await seed(factory, inputs); await seed(factory, inputs);
    const result = await read(factory); assert.equal(result.observationCount, 3);
    assert.deepEqual(result.observations.map(v => v.currentPrice.value), [68970, 69000, 69100]);
    assert.equal(result.latestObservation.currentPrice.value, 69100);
    const fixture = dom(); View.render(fixture.panel, result, function Chart() {});
    assert.equal(fixture.nodes.get("timeTravelTimeline").children.length, 4);
});
test("T7 exact JST midnight separates observation day from next trading day", async () => {
    const factory = new IDBFactory(); await seed(factory, [input("2026-10-11T14:59:59.999Z"), input("2026-10-11T15:00:00.000Z"),
        input("2026-10-12T14:59:59.999Z"), input("2026-10-12T15:00:00.000Z")]);
    const result = await read(factory); assert.equal(result.observationCount, 2);
    assert.equal(result.priceSnapshots.length, 2); assert.equal(result.latestObservation.marketDate, "2026-10-13");
});
test("T8 missing/invalid days and read failure are explicit, never a blank crash or fallback", async () => {
    const fixture = dom(), result = await read(new IDBFactory()); View.render(fixture.panel, result);
    assert.match(fixture.nodes.get("timeTravelArchiveStatus").textContent, /保存データなし/);
    assert.equal((await read(new IDBFactory(), "2026-99-99")).status, "invalid");
    const c = View.create({ ...fixture, read: async () => { throw Error("io_failed"); }, now: () => new Date("2026-10-13T00:00:00Z") });
    await c.selected({ detail: { calendarDate: DAY } }); assert.match(fixture.nodes.get("marketCalendarTimeTravelStatus").textContent, /unavailable/);
});
test("T9 corrupt Morning is category-local; available observation/price still render", async () => {
    const factory = new IDBFactory(); await seed(factory); const result = await read(factory, DAY, { getItem: () => "bad-json" });
    assert.equal(result.status, "partial"); assert.equal(result.sections.morning.status, "unavailable");
    assert.equal(result.sections.priceSnapshots.status, "saved");
    const fixture = dom(); View.render(fixture.panel, result, function Chart() {});
    assert.match(text(fixture.nodes.get("timeTravelObservation")), /68,970円/);
    assert.match(text(fixture.nodes.get("timeTravelMorning")), /unavailable/);
});
test("T11 persisted unavailable reason is kept; absent reason is explicitly not reconstructed", () => {
    const recorded = { observedAt: AT, marketDate: "2026-10-13", currentPrice: {
        available: false, value: null, reason: "current_price_identity_mismatch" } };
    assert.equal(View.observationView(recorded).priceReason, "current_price_identity_mismatch");
    assert.match(View.observationView({ ...recorded, currentPrice: { available: false, value: null } }).priceReason, /詳細理由は未保存/);
});
test("T12 date/month navigation and returnToday invalidate pending opens and clear old history", async () => {
    const factory = new IDBFactory(); await seed(factory); const result = await read(factory), fixture = dom(); let destroyed = 0, resolve;
    const controller = View.create({ ...fixture, read: async () => result, now: () => new Date("2026-10-13T00:00:00Z"),
        ChartConstructor: function Chart() { this.destroy = () => { destroyed++; }; } });
    await controller.selected({ detail: { calendarDate: DAY } }); await controller.open();
    fixture.nodes.get("marketCalendarPreviousMonth").click(); assert.equal(fixture.panel.hidden, true);
    assert.equal(text(fixture.nodes.get("timeTravelObservation")).trim(), ""); assert.equal(controller.selectedDate, null);
    await controller.selected({ detail: { calendarDate: DAY } }); await controller.open();
    fixture.nodes.get("marketCalendarNextMonth").click(); assert.equal(fixture.panel.hidden, true);
    controller.returnToday(); assert.equal(controller.selectedDate, null); assert.equal(destroyed, 2);
    const pending = View.create({ ...fixture, read: () => new Promise(r => { resolve = r; }), now: () => new Date("2026-10-13T00:00:00Z") });
    const p = pending.selected({ detail: { calendarDate: DAY } }); pending.returnToday(); resolve(result); await p;
    assert.equal(fixture.nodes.get("marketCalendarTimeTravelButton").hidden, true);
});
async function createDb(factory, name, setup, records) {
    const r = factory.open(name, 1), db = await new Promise((resolve, reject) => {
        r.onupgradeneeded = () => setup(r.result); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(Object.keys(records), "readwrite");
    for (const [store, values] of Object.entries(records)) for (const row of values) tx.objectStore(store).put(row);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
}
test("saved QRI revisions use confirmed day, never later active revision or source-date collapse", async () => {
    const factory = new IDBFactory();
    const old = { versionKey: "old", confirmedAt: AT, canonical: { savedValue: 12 } },
        next = { versionKey: "new", confirmedAt: "2026-10-13T01:00:00.000Z", canonical: { savedValue: 99 } };
    await createDb(factory, Model.DATABASES.qri.name, db => {
        db.createObjectStore("qriOptionsHistoryMeta", { keyPath: "id" });
        db.createObjectStore("qriOptionsEntries", { keyPath: "entryKey" }); db.createObjectStore("qriOptionsRevisions", { keyPath: "revisionKey" });
    }, { qriOptionsEntries: [{ entryKey: "2026-11|2026-10-13", contract: "2026-11", sourceDateKey: "2026-10-13",
        activeVersionKey: "new" }], qriOptionsRevisions: [old, next].map(revision => ({ ...revision,
            entryKey: "2026-11|2026-10-13", revisionKey: `2026-11|2026-10-13|${revision.versionKey}` })) });
    const result = await read(factory); assert.equal(result.qri.revisions[0].revision.versionKey, old.versionKey);
    assert.deepEqual(result.qri.revisions[0].revision.canonical, old.canonical);
    assert.equal(result.qri.revisions[0].sourceDateKey, "2026-10-13");
});
async function event(key, at, title) {
    const semantic = { schemaVersion: 1, logical: { eventKey: key }, schedule: { kind: "date_only",
        canonicalStart: null, canonicalEnd: null, precision: "date_only", sourceLocal: { startDate: DAY,
            startTime: null, endDate: null, endTime: null, timeZone: "Asia/Tokyo", resolvedOffset: null } },
        lifecycleStatus: "scheduled", title: { ja: title, en: null }, change: { reason: null, supersedesRevisionKey: null } },
        acquisitionEvidence = { sourceId: "archive-fixture", fetchedAt: at }, hash = await Canonical.sha256(semantic), eh = await Canonical.sha256(acquisitionEvidence);
    return { ...semantic, eventKey: key, revisionKey: `${key}|sha256:${hash}`, canonicalContentHash: hash,
        acquisitionEvidence, acquisitionEvidenceHash: eh, acquisitionEvidenceKey: `archive-fixture|sha256:${eh}` };
}
test("Calendar public as-known-at projection excludes later additions/changes, preserves historical revision", async () => {
    const factory = new IDBFactory(), firstAt = "2026-10-11T01:00:00.000Z", nextAt = "2026-10-13T01:00:00.000Z";
    const run = (id, at) => ({ sourceId: "archive-fixture", runId: id, acceptedAt: at, fetchedAt: [at], status: "accepted", semanticSetHash: "a".repeat(64) });
    const first = await Memory.accept({}, { run: run("old", firstAt), canonicalSet: [await event("known", firstAt, "当時の予定")] });
    const later = await Memory.accept(first.snapshot, { run: run("next", nextAt), canonicalSet: [
        await event("known", nextAt, "後日改訂"), await event("late", nextAt, "後日追加")] });
    assert.equal(later.committed, true);
    later.snapshot.runs = later.snapshot.runs.map(row => ({ ...row, runKey: Mapper.runKey(row) }));
    later.snapshot.observations = later.snapshot.observations.map(row => ({ ...row, observationKey: Mapper.observationKey(row) }));
    await createDb(factory, Schema.DATABASE_NAME, db => Schema.createInUpgrade(db),
        Object.fromEntries(Bootstrap.STORE_ORDER.map(([field, store]) => [store, later.snapshot[field]])));
    const result = await read(factory); assert.equal(result.calendarEvents.length, 1);
    assert.equal(result.calendarEvents[0].revision.title.ja, "当時の予定");
    assert.equal(result.calendarEvents[0].revision.validTo, nextAt);
    assert.equal(result.knowledgeAt, "2026-10-12T14:59:59.999Z");
});
async function morningBaseline(capturedAt, value, version) {
    const date = DAY, contract = "2026-12", identity = source => ({ source, versionKey: version, signature: null, verified: true });
    const component = name => ({ name, available: true, invalid: false, normalizedDirection: 0.2,
        directionScore: 20, baseWeight: 50, qualityFactor: 1, effectiveWeight: 50, weightedContribution: 10,
        evidenceFactor: 0.2, notes: [], metadata: null });
    const built = await Morning.buildMorningBaselineV4({ capturedAt,
        marketContext: { captureCalendarDate: new Date(Date.parse(capturedAt) + 9 * 3600000).toISOString().slice(0, 10),
            formalTradingDate: date, sessionIdentity: "archive-scope", sessionMappingStatus: "verified" },
        overallV2Context: { origin: "formal_live", formalApplied: true, superseded: false, logicVersion: "fixture-v1",
            evaluatedAt: capturedAt, inputIdentity: identity("overall"), componentIdentities: {
                option: identity("qri-options"), weekly: identity("weekly-futures-history") }, result: {
                status: "complete", direction: 20, confidence: 80, confidenceFactors: { agreement: 100 },
                components: { option: component("option"), weekly: component("weekly") },
                metadata: { calculatedAt: capturedAt, coverage: 100, warnings: [] } } },
        currentPriceContext: { available: true, sourceKind: "live", origin: "live", mode: "automatic", value,
            contract, quoteDate: date, quotedAtNormalized: AT, quoteSignature: "a".repeat(64), versionKey: version,
            wrapperSignature: "b".repeat(64), requestId: version, fetchedAt: capturedAt,
            currentRequestVerified: true, identityVerified: true, acquisitionVerified: true,
            acquisitionIdentity: { requestId: version, fetchedAt: capturedAt, sourceUrl: "https://svc.qri.jp/jpx/nkopm/",
                wrapperSignature: "b".repeat(64) }, qriTradingDateMapping: { status: "verified", quoteDate: date,
                qriTradingDate: date, relation: "same_date", mappingVerified: true, mappingSource: "same_date_explicit" } },
        qriContext: { available: true, origin: "formal_live", sourceKind: "live", formalRevisionAvailable: true,
            referenceOnly: false, usingFallback: false, restored: false, superseded: false, openInterestStatus: "available",
            identity: { verified: true, contract, tradingDate: date, pageUpdatedAt: capturedAt,
                canonicalSignature: "c".repeat(64), canonicalVersionKey: version, historyEntryId: `${contract}|${date}`,
                historyRevisionId: version } },
        weeklyContext: { available: true, origin: "formal_history", formalApplied: true, usingFallback: false,
            superseded: false, sourceDate: date, versionKey: version, signature: null, identityVerified: true,
            normalizedDirection: 0.2, qualityFactor: 1, effectiveWeight: 50, weightedContribution: 10, metadata: null },
        nearestLevelsContext: null, dataQualityContext: { status: "complete", warnings: [],
            sourceAvailability: { overallV2: true, currentPrice: true, qri: true, weekly: true },
            fallbackFlags: { currentPrice: false, qri: false, weekly: false }, componentAvailability: { option: true, weekly: true } } });
    assert.equal(built.success, true, built.reason); return built.baseline;
}
test("Morning reads captured-day revision, not later active baseline or formal trading date", async () => {
    const first = await morningBaseline(AT, 68970, "old"), next = await morningBaseline("2026-10-13T01:00:00.000Z", 69999, "later");
    const initial = await MorningStorage.buildMorningBaselineV4Storage({ baseline: first });
    const changed = await MorningStorage.buildMorningBaselineV4Storage({ baseline: next, existingContainer: initial.container });
    assert.equal(changed.success, true, changed.reason);
    const stored = await MorningStorage.serializeMorningBaselineV4Storage(changed.container);
    const result = await read(new IDBFactory(), DAY, { getItem(key) { assert.equal(key, MorningStorage.STORAGE_KEY); return stored.serialized; } });
    assert.equal(result.morningBaselines.length, 1); assert.equal(result.morningBaselines[0].baselineId, first.baselineId);
    assert.equal(View.morningView(result.morningBaselines)[0].price, 68970);
    assert.equal(result.morningBaselines[0].formalTradingDate, DAY);
});
test("browser public dependency graph follows committed page order without live startup", async () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const required = new Set(["js/calendarDate/calendarDate.js", "js/morningBaselineV4.js", "js/morningBaselineV4Storage.js",
        "js/marketCalendar/marketEventSchedule.js", "js/marketCalendar/eventTaxonomy.js", "js/marketCalendar/sourceRegistry.js",
        "js/marketCalendar/marketEventIdentity.js", "js/marketCalendar/authorityPolicy.js", "js/marketCalendar/sourceContract.js",
        "js/marketCalendar/marketEventCanonicalizer.js", "js/marketCalendar/marketEventRevision.js",
        "js/marketCalendarHistory/historyContract.js", "js/marketCalendarHistory/historyIntegrity.js",
        "js/marketCalendarHistory/productionSchemaV1.js", "js/timeTravel/optionMapHistoricalReadModel.js"]);
    const context = vm.createContext({ crypto: webcrypto, TextEncoder, structuredClone, Intl, console });
    context.window = context; context.document = {};
    for (const match of html.matchAll(/<script src="([^"]+)"/g)) if (required.has(match[1])) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", match[1]), "utf8"), context, { filename: match[1] });
        required.delete(match[1]);
    }
    assert.equal(required.size, 0);
    const result = await context.OptionMapHistoricalReadModel.read({ indexedDB: new IDBFactory(), calendarDate: DAY, localStorage: local });
    assert.equal(result.status, "empty");
    assert.equal(context.OptionMapHistoricalReadModel.knowledgeAtFor(DAY), "2026-10-12T14:59:59.999Z");
    assert.deepEqual(Array.from(context.OptionMapMarketEventRevision.projectForCalendarDate({ entries: [],
        calendarDate: DAY, knowledgeAt: context.OptionMapHistoricalReadModel.knowledgeAtFor(DAY) })), []);
});
