"use strict";

// Dedicated OptionMap-identity package, disposable profile, lossless receipt.
// This never loads main.js, production userData, safety files or a writer.
const fs = require("node:fs"), cp = require("node:child_process"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict"), { pathToFileURL } = require("node:url"), { createHash } = require("node:crypto");
const A = require("../js/marketCalendarIsolated/calendar13Acquisition.js");
const Shadow = require("../js/marketCalendarIsolated/calendar13Shadow.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const F = require("../test/fixtures/marketCalendar/calendar13Fixture.js");
const TYPE = "G1_3a_isolated13_receipt", digest = b => createHash("sha256").update(b).digest("hex");
const STORE_SETUP_SCRIPT = "globalThis.__g13Store = OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({ indexedDB, targetEnvironment: 'isolated_test' }); void 0;";
async function benchmark() {
  const rows = [];
  for (const [model, historyRuns] of [["current", 3], ["monthly12", 12], ["daily365", 365]]) {
    const f = await F.fixture({ perSource: 21, historyRuns });
    const base = await require("../js/marketCalendarRuntime/automaticFormalShadow.js").evaluate({
      sourceResults: f.sources.filter(s => s.sourceId !== F.S.SOURCE_ID), before: f.snapshot,
      schemaFingerprint: require("../js/marketCalendarHistory/productionSchemaV1.js").EXPECTED_FINGERPRINT });
    const result = await Shadow.evaluate({ sourceResults: f.sources, snapshot: f.snapshot });
    assert.equal(result.status, "evaluated");
    const m = { model, active: f.snapshot.entries.length, candidate: f.sources.reduce((n, s) => n + s.canonicalRecords.length, 0),
      historyCounts: Object.fromEntries(Object.entries(f.snapshot).map(([k, v]) => [k, v.length])),
      baseline12Ms: base.performance.elapsedMs, isolated13Ms: result.performance.elapsedMs, performance: result.performance };
    assert.equal(m.performance.snapshotValidationCount, 1); assert.equal(m.performance.fullSnapshotSortCount, 1);
    assert.equal(m.performance.fullSnapshotHashCount, 1); assert.equal(m.performance.fullMaterialCopies, 0);
    assert.equal(Cycle.activeCount(), 0);
    if (model === "daily365") assert(m.isolated13Ms < 5000, "isolated13_daily365_over_5000ms");
    rows.push(m);
  }
  return rows;
}
async function worker(root) {
  assert.equal(process.type, "browser"); assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith("optionmap-g13a-"));
  assert.equal(fs.readFileSync(path.join(root, "isolated-marker"), "utf8"), "G1.3a");
  const { app, BrowserWindow, net, session } = require("electron"), meta = require("../package.json");
  for (const key of ["appData", "userData", "sessionData"]) app.setPath(key, path.join(root, key));
  app.disableHardwareAcceleration(); assert.equal(app.getName(), meta.name); assert.equal(app.getVersion(), meta.version);
  const hold = () => {}; app.on("window-all-closed", hold);
  const pending = new Map(), observerBySource = {}, observerUrls = []; let unexpectedNetwork = 0, window, runtime, report, observed = 0, stage = "setup";
  const guard = setTimeout(() => app.exit(3), 120000);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (d, done) => {
      const queue = pending.get(d.url), source = queue?.shift(); observed++;
      observerUrls.push(d.url);
      if (!source) unexpectedNetwork++; else observerBySource[source] = (observerBySource[source] || 0) + 1;
      done({ cancel: !source });
    });
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    for (const relative of ["js/marketCalendar/sourceRegistry.js", "js/marketCalendarRuntime/sourceUpdateState.js", "js/storage/marketCalendarRuntimeStateStore.js"])
      await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"));
    stage = "runtime_store_setup";
    await window.webContents.executeJavaScript(STORE_SETUP_SCRIPT);
    const invoke = (name, args) => window.webContents.executeJavaScript(`globalThis.__g13Store.${name}(...${JSON.stringify(args)})`);
    const initial = await invoke("read", [F.S.SOURCE_ID]); assert.equal(initial.value, null);
    let storeAudit = {};
    const store = { read: id => invoke("read", [id]), write: (id, state) => invoke("write", [id, state]), diagnostics: () => storeAudit };
    runtime = A.create({ enablement: A.ENABLEMENT, store, fetchImpl: (url, opts) => net.fetch(url, opts),
      onRequest: (source, url) => { const q = pending.get(url) || []; q.push(source); pending.set(url, q); } });
    stage = "acquisition";
    const started = performance.now(), acquired = await runtime.cycle(), acquisitionMs = performance.now() - started;
    const readonlyBefore = await invoke("readAll", []); storeAudit = await invoke("diagnostics", []);
    const requestBefore = observed, mofComplete = acquired.sourceResults.find(s => s.sourceId === F.S.SOURCE_ID).acquisitionOutcome === "complete";
    // No second attempt for a failed source; success only gets a pure same-day skip.
    const sameDay = mofComplete ? await runtime.acquireOne(F.S.SOURCE_ID,
      new Date(Date.now() + 540 * 60000).toISOString().slice(0, 10), new Date().toISOString()) : { reason: "not_attempted_after_failure" };
    if (mofComplete) assert.equal(sameDay.reason, "already_succeeded_today"); assert.equal(observed, requestBefore);
    assert.deepEqual((await invoke("readAll", [])).value, readonlyBefore.value);
    stage = "shadow";
    const fixture = await F.Existing.fixture(), shadowStart = performance.now();
    const shadow = await Shadow.evaluate({ sourceResults: acquired.sourceResults, snapshot: fixture.snapshot });
    const shadowMs = performance.now() - shadowStart;
    const rows = acquired.sourceResults.map(s => ({ sourceId: s.sourceId, outcome: s.acquisitionOutcome,
      requests: s.requestCount, observer: observerBySource[s.sourceId] || 0, candidate: s.canonicalRecords.length,
      elapsedMs: s.elapsedMs, diagnosticClass: s.diagnosticClass || null, reason: s.reason,
      documents: s.sourceId === F.S.SOURCE_ID ? s.documentHealth : undefined }));
    const mof = acquired.sourceResults.find(s => s.sourceId === F.S.SOURCE_ID);
    const baseline = rows.filter(s => s.sourceId !== F.S.SOURCE_ID).reduce((n, s) => n + s.requests, 0);
    report = { type: TYPE, valid: rows.every(s => s.outcome === "complete" && s.requests === s.observer) &&
      unexpectedNetwork === 0 && acquired.sourceConcurrency <= 3 && shadow.status === "evaluated",
      runtime: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron,
        userAgent: session.defaultSession.getUserAgent(), manualUaOverride: 0 }, rows,
      network: { baseline12: baseline, total: acquired.requests, observer: observed, shadowExtra: 0, unexpectedNetwork },
      mof: { discovered: mof.discovery?.months, fetched: mof.documentHealth.map(d => d.role),
        candidate: mof.canonicalRecords.length, parserCanonicalMs: mof.parserCanonicalMs, elapsedMs: mof.elapsedMs,
        sameDay: sameDay.reason, requestFormula: 1 + (mof.discovery?.months.length || 0) },
      stateAudit: storeAudit, sourceConcurrency: acquired.sourceConcurrency,
      shadow: { status: shadow.status, sourceRows: shadow.sourceRows, counts: shadow.aggregatePlannedCounts,
        performance: shadow.performance, planningMs: shadowMs },
      acquisitionMs, productionAccess: 0, writerExecution: 0, formalWrite: 0, safetyAccess: 0 };
  } catch (e) { report = { type: TYPE, valid: false, stage, reason: /^[a-zA-Z0-9_ :.-]{1,160}$/.test(e.message) ? e.message : "isolated_native_failed",
      observer: observed, productionAccess: 0, writerExecution: 0 }; }
  finally {
    clearTimeout(guard); session.defaultSession.webRequest.onBeforeRequest(null); await session.defaultSession.closeAllConnections();
    if (window && !window.isDestroyed()) window.destroy(); app.removeListener("window-all-closed", hold);
    report.cleanup = { ...runtime?.diagnostics(), dbHandles: report.stateAudit?.openHandles || 0,
      listeners: 0, windows: BrowserWindow.getAllWindows().length, requests: 0, watchdogs: 0, cycleCache: Cycle.activeCount(),
      unexpectedResources: (process.getActiveResourcesInfo?.() || []).filter(x => !["TTYWrap", "PipeWrap"].includes(x)) };
    report.valid &&= !report.cleanup.activeTasks && !report.cleanup.dbHandles && !report.cleanup.windows && !report.cleanup.cycleCache && !report.cleanup.unexpectedResources.length;
    const bytes = Buffer.from(JSON.stringify(report));
    fs.writeFileSync(path.join(root, "receipt.tmp"), bytes, { flag: "wx" }); fs.renameSync(path.join(root, "receipt.tmp"), path.join(root, "receipt.json"));
    fs.writeFileSync(path.join(root, "complete.tmp"), JSON.stringify({ type: TYPE, byteLength: bytes.length, sha256: digest(bytes) }), { flag: "wx" });
    fs.renameSync(path.join(root, "complete.tmp"), path.join(root, "complete.json"));
    process.stdout.write(JSON.stringify({ type: TYPE, valid: report.valid }) + "\n", () => app.exit(report.valid ? 0 : 2));
  }
}
function runNative() {
  if (process.versions.electron) throw Error("node_parent_required");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g13a-"));
  try {
    for (const name of ["appData", "userData", "sessionData"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "isolated-marker"), "G1.3a");
    const meta = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: meta.name, version: meta.version, main: "entry.cjs" }));
    fs.writeFileSync(path.join(root, "entry.cjs"), `import(${JSON.stringify(pathToFileURL(__filename).href)}).then(m => m.default.worker(__dirname));\n`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawnSync(require("electron"), [root, `--user-data-dir=${path.join(root, "userData")}`],
      { env, encoding: "utf8", timeout: 130000, maxBuffer: 65536 });
    if (child.error || child.signal) throw Error("isolated_native_incomplete");
    const bytes = fs.readFileSync(path.join(root, "receipt.json")), marker = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8"));
    assert.equal(marker.type, TYPE); assert.equal(marker.byteLength, bytes.length); assert.equal(marker.sha256, digest(bytes));
    const report = JSON.parse(bytes); assert.equal(report.type, TYPE); assert.equal(child.status, report.valid ? 0 : 2);
    return { ...report, receiptVerified: true, tempRemoved: true, childExited: true };
  } finally { fs.rmSync(root, { recursive: true }); }
}
module.exports = Object.freeze({ worker, runNative, benchmark, STORE_SETUP_SCRIPT });
if (require.main === module) {
  if (process.argv.slice(2).join() === "--benchmark") benchmark().then(r => process.stdout.write(JSON.stringify(r, null, 2) + "\n"));
  else { const r = runNative(); process.stdout.write(JSON.stringify(r, null, 2) + "\n"); process.exitCode = r.valid ? 0 : 2; }
}
