"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Coverage = require("../js/marketCalendarHistory/calendarPartialCoverage.js");
const Consumer = require("../js/marketCalendarHistory/readOnlyCalendarConsumer.js");
const Mvp = require("../js/marketCalendarMvp.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Fixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const ExecutorFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const BLS = "us-bls-calendar", CPI = "jp-stat-cpi", expected = Contract.EXPECTED_SOURCE_IDS;
function projected(sourceIds, runtimeStates = []) {
  return { status: "available", coverage: Coverage.projectPartialCoverage({
    formalSnapshot: Fixture.formalSnapshot(sourceIds), runtimeStates }) };
}
function runtime(sourceId, lastOutcome = "success") {
  return { sourceId, lastOutcome, lastAttemptAt: "2026-10-28T00:00:00.000Z",
    ...(lastOutcome === "failure" ? { lastDiagnosticClass: "transport_failed" } : {}) };
}
function dom() {
  let ownerDocument;
  const makeNode = () => ({ children: [], className: "", textContent: "", hidden: false,
    open: false, dataset: {}, attributes: {}, listeners: {}, ownerDocument,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; } });
  ownerDocument = { createElement: () => makeNode() };
  const ids = ["marketCalendarCoverage", "marketCalendarCoverageStatus",
    "marketCalendarCoverageMessage", "marketCalendarCoverageSources",
    "marketCalendarStatus", "marketCalendarGrid", "marketCalendarDetailStatus",
    "marketCalendarEvents", "marketCalendarDetailTitle"], nodes = Object.fromEntries(
    ids.map(id => [id, makeNode()])), panel = { ownerDocument,
    querySelector: selector => nodes[selector.slice(1)] || null };
  return { nodes, panel };
}
function cpiEvent() {
  return { eventKey: "cpi-event", revisionKey: "cpi-event|active", sourceId: CPI,
    calendarDateStart: "2026-10-28", calendarDateEnd: "2026-10-28", validTo: null,
    title: { ja: "全国消費者物価指数" }, logical: { eventType: "JP_NATIONAL_CPI" },
    lifecycleStatus: "scheduled", change: { reason: null }, schedule: { kind: "instant",
      canonicalStart: "2026-10-27T23:30:00.000Z", sourceLocal: { startDate: "2026-10-28",
        endDate: null, timeZone: "Asia/Tokyo" } } };
}

test("U1 13/13 full coverage has no false warning", () => {
  const f = dom(), result = projected(expected, expected.map(sourceId => runtime(sourceId)));
  const view = Mvp.renderCoverage(f.panel, result);
  assert.equal(view.state, "full");
  assert.match(f.nodes.marketCalendarCoverageStatus.textContent, /13 \/ 13 source/);
  assert.equal(view.issues.length, 0);
  assert.equal(f.nodes.marketCalendarCoverageMessage.hidden, true);
  assert.equal(f.nodes.marketCalendarCoverageSources.hidden, true);
});

test("U2 12/13 and failed BLS distinguish current unavailability while saved events render", () => {
  const f = dom(), sourceIds = expected.filter(sourceId => sourceId !== BLS),
    result = projected(sourceIds, [runtime(BLS, "failure")]),
    view = Mvp.renderCoverage(f.panel, result), grid = Mvp.monthGrid(2026, 10);
  Mvp.renderMonth(f.panel, { status: "available", events: [cpiEvent()] }, grid,
    "2026-10-28", "2026-10-28", () => undefined);
  assert.equal(view.state, "partial");
  assert.match(view.statusText, /12 \/ 13 source/);
  assert.equal(f.nodes.marketCalendarCoverageMessage.textContent,
    "米労働統計局：現在確認できません");
  const day = f.nodes.marketCalendarGrid.children.find(value =>
    value.dataset.calendarDate === "2026-10-28");
  assert.equal(day.attributes["aria-label"], "2026-10-28、1件");
});

test("U3 missing BLS with unknown Runtime State is unsaved, not a false failure", () => {
  const f = dom(), result = projected(expected.filter(sourceId => sourceId !== BLS));
  const view = Mvp.renderCoverage(f.panel, result);
  assert.deepEqual(view.issues, ["米労働統計局：未保存"]);
  assert.doesNotMatch(f.nodes.marketCalendarCoverageMessage.textContent, /確認できません/);
});

test("U4 Formal-present BLS remains counted when its latest Runtime attempt fails", () => {
  const f = dom(), view = Mvp.renderCoverage(f.panel, projected(expected,
    [runtime(BLS, "failure")]));
  assert.equal(view.state, "full");
  assert.match(view.statusText, /13 \/ 13 source/);
  assert.deepEqual(view.issues, ["米労働統計局：保存済みデータあり／最新取得は失敗"]);
  assert.doesNotMatch(view.issues[0], /未保存/);
});

test("U5 absent Formal DB is explicit and never rendered as fake 0/13", () => {
  const f = dom(), view = Mvp.renderCoverage(f.panel,
    { status: "absent", reason: "database_absent", coverage: null });
  assert.equal(view.state, "absent");
  assert.equal(view.statusText, "保存済みカレンダー：まだありません");
  assert.doesNotMatch(view.statusText, /0 \/ 13/);
});

test("U6 invalid/unreadable Formal DB is explicit with no Runtime promotion", () => {
  const broken = Fixture.formalSnapshot([expected[0]]); broken.runs = [];
  const invalid = Mvp.coverageViewModel({ status: "available", coverage:
    Coverage.projectPartialCoverage({ formalSnapshot: broken, runtimeStates: [runtime(BLS)] }) }), unavailable =
    Mvp.coverageViewModel({ status: "unavailable", reason: "readonly_coverage_failed" });
  assert.equal(invalid.state, "invalid");
  assert.match(invalid.statusText, /整合性エラー/);
  assert.equal(unavailable.state, "unavailable");
  assert.doesNotMatch(unavailable.statusText, /13 \/ 13/);
});

test("U7 1/13 renders valid partial state and canonical ordered missing-source details", () => {
  const f = dom(), view = Mvp.renderCoverage(f.panel, projected([expected[0]]));
  assert.equal(view.state, "partial");
  assert.match(view.statusText, /1 \/ 13 source/);
  assert.equal(f.nodes.marketCalendarCoverageSources.hidden, false);
  assert.equal(f.nodes.marketCalendarCoverageSources.children.length, 12);
  const expectedLabels = expected.slice(1).map(sourceId => `${Mvp.SOURCE_NAMES[sourceId]}：未保存`);
  assert.deepEqual(f.nodes.marketCalendarCoverageSources.children.map(value => value.textContent),
    expectedLabels);
});

test("U8 selected-day empty remains distinct from coverage state", () => {
  const f = dom(); Mvp.renderCoverage(f.panel, projected(expected.slice(0, 3)));
  Mvp.renderDetail(f.panel, { status: "available", events: [] }, "2026-10-28");
  assert.equal(f.nodes.marketCalendarDetailStatus.textContent, "予定なし");
  assert.match(f.nodes.marketCalendarCoverageStatus.textContent, /3 \/ 13 source/);
});

test("U9 current Runtime failure does not enter the historical Time Travel reader", () => {
  const historical = fs.readFileSync(path.join(__dirname, "../js/optionMapTimeTravelMvp.js"), "utf8");
  assert.doesNotMatch(historical, /calendarPartialCoverage|marketCalendarRuntimeStateStore|calendar-runtime-state-updated/);
  const view = Mvp.coverageViewModel(projected(expected.slice(0, 2), [runtime(BLS, "failure")]));
  assert(view.issues.some(value => /現在確認できません/.test(value)));
});

test("readonly consumer reads six-store Formal coverage without opening absent DB", async () => {
  const h = ExecutorFixture.harness(), descriptor = await ExecutorFixture.SourceFixture
    .snapshotWithSources([CPI]);
  await ExecutorFixture.seed(h.indexedDB, descriptor);
  const result = await Consumer.readCoverage({ indexedDB: h.indexedDB,
    runtimeStates: [runtime(CPI, "failure")] });
  assert.equal(result.status, "available");
  assert.equal(result.coverage.coverageCount, 1);
  assert.equal(result.coverage.sources.find(value => value.sourceId === CPI).formalState,
    "formal_present");
  let opens = 0;
  const absent = await Consumer.readCoverage({ indexedDB: { databases: async () => [],
    open: () => { opens++; throw new Error("must_not_open"); } } });
  assert.equal(absent.status, "absent");
  assert.equal(opens, 0);
});

test("C1 UI is compact/readable and adds no writer, schema, IPC or Full Export surface", () => {
  const root = path.join(__dirname, ".."), html = fs.readFileSync(path.join(root, "index.html"),
    "utf8"), css = fs.readFileSync(path.join(root, "style.css"), "utf8"), consumer =
    fs.readFileSync(path.join(root, "js/marketCalendarHistory/readOnlyCalendarConsumer.js"), "utf8"),
    mvp = fs.readFileSync(path.join(root, "js/marketCalendarMvp.js"), "utf8"),
    exportSource = fs.readFileSync(path.join(root, "js/fullExportCollector.js"), "utf8");
  assert.match(html, /id="marketCalendarCoverageStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="marketCalendarCoverageSources"[^>]*hidden/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.market-calendar-coverage/);
  assert.doesNotMatch(consumer, /readwrite|\.put\(|\.add\(|ipcRenderer|ipcMain/);
  assert.match(mvp, /optionmap:calendar-runtime-state-updated/);
  assert.doesNotMatch(exportSource, /calendarPartialCoverage|marketCalendarCoverage/);
});
