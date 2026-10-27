"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Controller = require("../js/marketCalendarRuntime/calendarUpdateUiController.js");

function node() { return { textContent: "", hidden: false, disabled: false, dataset: {}, listeners: {},
  addEventListener(name, callback) { this.listeners[name] = callback; } }; }
function fixture({ enabled = true, check } = {}) {
  const nodes = { marketCalendarPanel: { dataset: { calendarUpdateUiEnabled: String(enabled) } },
    marketCalendarUpdateRegion: node(), marketCalendarUpdateStatus: node(),
    marketCalendarUpdateButton: node(), marketCalendarUpdateDetails: node(),
    marketCalendarUpdateQualifier: node(), marketCalendarGrid: { sentinel: "grid" },
    marketCalendarTimeTravelButton: { sentinel: "time-travel" } }, events = [], document = {
    getElementById: id => nodes[id] || null,
    defaultView: { CustomEvent: class { constructor(type) { this.type = type; } } },
    dispatchEvent: event => { events.push(event.type); return true; } }, bridge = { checkCalendarSources: check ||
      (async () => ({ state: "success", checkedAt: "2026-09-25T05:32:00.000Z",
        requestedSourceCount: 12, successfulSourceCount: 12, sources: [], failedSourceIds: [] })) };
  return { nodes, events, controller: Controller.mount({ document, bridge }) };
}

test("idle→checking→12/12 successをbackground表示しgrid/Time Travelを保持", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), f = fixture({ check:
    async () => { await gate; return { state: "success", checkedAt: "2026-09-25T05:32:00.000Z",
      requestedSourceCount: 12, successfulSourceCount: 12, sources: [], failedSourceIds: [] }; } });
  assert.match(f.nodes.marketCalendarUpdateStatus.textContent, /未確認/);
  const pending = f.controller.check();
  assert.equal(f.nodes.marketCalendarUpdateButton.disabled, true);
  assert.match(f.nodes.marketCalendarUpdateStatus.textContent, /確認中/);
  assert.equal(f.nodes.marketCalendarGrid.sentinel, "grid");
  assert.equal(f.nodes.marketCalendarTimeTravelButton.sentinel, "time-travel");
  release(); await pending;
  assert.match(f.nodes.marketCalendarUpdateStatus.textContent, /12 \/ 12 source/);
  assert.equal(f.nodes.marketCalendarUpdateButton.disabled, false);
  assert.deepEqual(f.events, ["optionmap:calendar-runtime-state-updated"]);
});

test("checking中の連打はcontrollerでも同一Promiseを共有", async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; }), f = fixture({
    check: async () => { calls += 1; await gate; return { state: "failed", requestedSourceCount: 12,
      successfulSourceCount: 0, sources: [], failedSourceIds: [] }; } }), first = f.controller.check(),
    second = f.controller.check();
  assert.equal(first, second); assert.equal(calls, 1); release(); await first;
});

test("partial後は失敗sourceだけを再確認しdetailsをtextContentへ設定", async () => {
  const requests = [], f = fixture({ check: async request => { requests.push(request);
    return requests.length === 1 ? { state: "partial", requestedSourceCount: 12,
      successfulSourceCount: 10, failedSourceIds: ["source-b", "source-d"], sources: [
        { sourceId: "source-b", displayName: "<b>B</b>", status: "failed", reasonClass: "timeout" },
        { sourceId: "source-d", displayName: "D", status: "failed", reasonClass: "mime_mismatch" }
      ] } : { state: "success", requestedSourceCount: 2, successfulSourceCount: 2,
        failedSourceIds: [], sources: [] }; } });
  await f.controller.check(); assert.match(f.nodes.marketCalendarUpdateStatus.textContent, /一部失敗/);
  assert.equal(f.nodes.marketCalendarUpdateDetails.textContent.includes("<b>B</b>"), true);
  f.nodes.marketCalendarUpdateButton.listeners.click(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(requests[1], { sourceIds: ["source-b", "source-d"] });
});

test("feature switch OFFは新UIだけ非表示でlistener/network 0", () => {
  let calls = 0; const f = fixture({ enabled: false, check: async () => { calls += 1; } });
  assert.equal(f.controller.enabled, false); assert.equal(f.nodes.marketCalendarUpdateRegion.hidden, true);
  assert.deepEqual(f.nodes.marketCalendarUpdateButton.listeners, {}); assert.equal(calls, 0);
});

test("HTML/CSSはaccessibility・mobile・既存Calendar/Time Travel境界を保持", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8"), css =
    fs.readFileSync(path.join(__dirname, "../style.css"), "utf8"), controller =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarRuntime/calendarUpdateUiController.js"), "utf8");
  assert.match(html, /id="marketCalendarUpdateStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="marketCalendarUpdateButton" type="button"/);
  assert.match(html, /data-calendar-update-ui-enabled="true"/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*market-calendar-update-region/);
  for (const id of ["marketCalendarGrid", "marketCalendarPreviousMonth", "marketCalendarNextMonth",
    "marketCalendarToday", "marketCalendarTimeTravelButton"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(controller, /innerHTML|outerHTML|insertAdjacentHTML|indexedDB|localStorage/);
});
