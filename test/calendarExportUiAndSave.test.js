"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"),
  fs = require("node:fs");
const Ui = require("../js/calendarExportUi.js"), Save = require("../js/calendarExportFileSave.js");
const Coverage = require("../js/marketCalendarHistory/calendarPartialCoverage.js");
const artifact = () => ({ schemaVersion: "optionmap-calendar-export-v1",
  exportMeta: { appVersion: "1.1.0-beta.15", generatedAt: "2026-10-28T00:00:00.000Z",
    timeZone: "Asia/Tokyo", readOnly: true, artifactType: "calendar_formal_export",
    schemaVersion: "optionmap-calendar-export-v1" }, selection: { mode: "current" },
  coverage: {}, events: [], calendarSourceStatus: Coverage.EXPECTED_SOURCE_IDS.map(sourceId =>
    ({ sourceId })) });

test("Calendar Export filename is dedicated and JST deterministic", () => {
  assert.equal(Ui.createFileName("2026-10-27T22:15:09.000Z"),
    "OptionMap-Calendar-Export-v1-2026-10-28T071509-JST.json");
});

test("Calendar Export runs only after explicit controller action and uses dedicated save", async () => {
  const calls = [], statuses = [], controller = Ui.createController({
    metadata: async () => ({ success: true, appVersion: "1.1.0-beta.15" }),
    collect: async input => { calls.push(["collect", input]); return artifact(); },
    save: async request => { calls.push(["save", request]); return { success: true }; },
    setStatus: (...args) => statuses.push(args), setBusy: value => calls.push(["busy", value])
  });
  assert.equal(calls.length, 0);
  const result = await controller.run();
  assert.equal(result.success, true);
  assert.equal(calls.filter(value => value[0] === "collect").length, 1);
  assert.equal(calls.filter(value => value[0] === "save").length, 1);
  assert.match(calls.find(value => value[0] === "save")[1].fileName,
    /^OptionMap-Calendar-Export-v1-\d{4}-\d{2}-\d{2}T\d{6}-JST\.json$/);
  assert.equal(statuses.at(-1)[0], "success");
});

test("dedicated save validates exact filename, schema, read-only flag and request shape", () => {
  const valid = { fileName: "OptionMap-Calendar-Export-v1-2026-10-28T071509-JST.json",
    json: JSON.stringify(artifact()) };
  assert.equal(Save.validateRequest(valid).valid, true);
  assert.equal(Save.validateRequest({ ...valid, fileName: "OptionMap-Full-Export-v2-x.json" }).valid, false);
  assert.equal(Save.validateRequest({ ...valid, json: "{}" }).valid, false);
  assert.equal(Save.validateRequest({ ...valid, arbitraryPath: "/tmp/file" }).valid, false);
});

test("dedicated save uses dialog-selected path and atomic temporary rename", async () => {
  const writes = [], service = Save.createSaveService({
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "/chosen/export.json" }) },
    fs: { writeFile: async (...args) => writes.push(["write", ...args]),
      rename: async (...args) => writes.push(["rename", ...args]), rm: async () => {} },
    path, randomUUID: () => "fixed"
  }), request = { fileName: "OptionMap-Calendar-Export-v1-2026-10-28T071509-JST.json",
    json: JSON.stringify(artifact()) }, result = await service.save({}, request);
  assert.equal(result.success, true);
  assert.deepEqual(writes[0].slice(0, 3), ["write", "/chosen/.export.json.fixed.tmp", request.json]);
  assert.deepEqual(writes[1], ["rename", "/chosen/.export.json.fixed.tmp", "/chosen/export.json"]);
});

test("UI and main expose only a dedicated user-initiated Calendar save path", () => {
  const root = path.join(__dirname, ".."), html = fs.readFileSync(path.join(root, "index.html"), "utf8"),
    main = fs.readFileSync(path.join(root, "main.js"), "utf8"),
    runtime = fs.readFileSync(path.join(root, "js/calendarExportRuntime.js"), "utf8");
  assert.match(html, /id="marketCalendarExportButton"/);
  assert.match(html, /js\/calendarExportV1\.js/);
  assert.match(main, /ipcMain\.handle\("save-calendar-export-json"/);
  assert.match(main, /owner !== mainWindow/);
  assert.doesNotMatch(runtime, /requestCalendarSource|checkCalendarSources|fetch\(/);
  assert.doesNotMatch(runtime, /put\(|add\(|delete\(|readwrite/);
});
