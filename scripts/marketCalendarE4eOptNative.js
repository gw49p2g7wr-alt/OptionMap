"use strict";

// Isolated native IndexedDB reader + Electron/Node planner benchmark only.
// Never imports OptionMap startup, acquisition, Runtime State, or any writer.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js");
const Automatic = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Fixtures = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");

async function worker(root) {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("optionmap-e4e-opt-") ||
      !fs.existsSync(path.join(root, "isolated-only"))) throw Error("isolated_profile_required");
  const { app, BrowserWindow, session } = require("electron");
  app.setPath("userData", path.join(root, "userData"));
  app.setPath("sessionData", path.join(root, "sessionData"));
  app.disableHardwareAcceleration();
  process.stdout.write(JSON.stringify({ type: "isolated_setup", productionProfileUsed: false,
    tempUserData: app.getPath("userData") === path.join(root, "userData"),
    tempSessionData: app.getPath("sessionData") === path.join(root, "sessionData") }) + "\n");
  const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  let window, network = 0, report, exitCode = 1;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/i.test(details.url)) { network++; callback({ cancel: true }); }
      else callback({});
    });
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false,
      contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    const rows = [];
    for (const [model, historyRuns] of [["current", 3], ["daily365", 365]]) {
      const f = await Fixtures.fixture({ perSource: 21, historyRuns });
      const seedStarted = performance.now();
      await window.webContents.executeJavaScript(`(async () => {
        // Test DB only, in a dedicated disposable Chromium profile. Reset between models only.
        await new Promise((resolve, reject) => {
          const r = indexedDB.deleteDatabase(${JSON.stringify(Schema.DATABASE_NAME)});
          r.onsuccess = resolve; r.onerror = () => reject(Error("isolated_delete_failed"));
          r.onblocked = () => reject(Error("isolated_delete_blocked"));
        });
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open(${JSON.stringify(Schema.DATABASE_NAME)}, ${Schema.VERSION});
          r.onupgradeneeded = () => {
            const definition = ${JSON.stringify(Schema.STORES)};
            for (const [name, shape] of Object.entries(definition)) {
              const s = r.result.createObjectStore(name, { keyPath: shape.keyPath });
              for (const [key, keyPath, unique] of shape.indexes) s.createIndex(key, keyPath, { unique });
            }
          };
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error("isolated_seed_open_failed"));
        });
        globalThis.__e4eOptSeedDB = db;
      })()`);
      // Bounded batch transfer. No full 143MB serialization or twelve snapshot clones.
      for (const [field, store] of Bootstrap.STORE_ORDER) {
        for (let offset = 0; offset < f.snapshot[field].length; offset += 2000) {
          const chunk = f.snapshot[field].slice(offset, offset + 2000);
          await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const tx = globalThis.__e4eOptSeedDB.transaction(${JSON.stringify(store)}, "readwrite");
            const store = tx.objectStore(${JSON.stringify(store)});
            for (const value of ${JSON.stringify(chunk)}) store.add(value);
            tx.oncomplete = resolve; tx.onabort = () => reject(Error("isolated_seed_failed"));
            tx.onerror = () => undefined;
          })`);
        }
      }
      await window.webContents.executeJavaScript("globalThis.__e4eOptSeedDB.close(); delete globalThis.__e4eOptSeedDB;");
      f.snapshot = null; // Release generated snapshot before receiving the one native readonly snapshot.
      const seedMs = performance.now() - seedStarted;
      await window.webContents.executeJavaScript(`(() => {
        const audit = { readonly: 0, readwrite: 0, getAll: 0, writes: 0, digestInsideTransaction: 0, pending: 0 };
        const transaction = IDBDatabase.prototype.transaction, getAll = IDBObjectStore.prototype.getAll,
          digest = crypto.subtle.digest, methods = {};
        IDBDatabase.prototype.transaction = function (...args) {
          audit[args[1] || "readonly"]++; const tx = transaction.apply(this, args); audit.pending++;
          const finish = () => { audit.pending--; tx.removeEventListener("complete", finish); tx.removeEventListener("abort", finish); };
          tx.addEventListener("complete", finish); tx.addEventListener("abort", finish); return tx;
        };
        IDBObjectStore.prototype.getAll = function (...args) { audit.getAll++; return getAll.apply(this, args); };
        for (const method of ["add", "put", "delete", "clear"]) {
          methods[method] = IDBObjectStore.prototype[method];
          IDBObjectStore.prototype[method] = function (...args) { audit.writes++; return methods[method].apply(this, args); };
        }
        crypto.subtle.digest = function (...args) { if (audit.pending) audit.digestInsideTransaction++;
          return digest.apply(this, args); };
        globalThis.__e4eOptReadAudit = audit;
        globalThis.__e4eOptRestore = () => {
          IDBDatabase.prototype.transaction = transaction; IDBObjectStore.prototype.getAll = getAll;
          crypto.subtle.digest = digest;
          for (const method of Object.keys(methods)) IDBObjectStore.prototype[method] = methods[method];
          delete globalThis.__e4eOptReadAudit; delete globalThis.__e4eOptRestore;
        };
      })()`);
      const start = performance.now(), read = await Reader.createReader(window.webContents)(), readMs = performance.now() - start;
      assert.equal(read.status, "ok", read.reason);
      assert.deepEqual(read.audit, { opens: 1, readonly: 1, readwrite: 0, create: 0, upgrade: 0, writes: 0, handles: 0 });
      const planStarted = performance.now();
      const shadow = await Automatic.evaluate({ sourceResults: f.sources, before: read.snapshot,
        schemaFingerprint: read.schemaFingerprint });
      const planningMs = performance.now() - planStarted, totalMs = performance.now() - start;
      const nativeReadAudit = await window.webContents.executeJavaScript("({ ...globalThis.__e4eOptReadAudit })");
      await window.webContents.executeJavaScript("globalThis.__e4eOptRestore();");
      assert.deepEqual(nativeReadAudit, { readonly: 1, readwrite: 0, getAll: 6, writes: 0, digestInsideTransaction: 0, pending: 0 });
      assert.equal(shadow.status, "evaluated", shadow.reason); assert.equal(shadow.eligibleCount, 11);
      assert.equal(shadow.writerExecution, 0); assert.equal(shadow.readwriteTransactions, 0);
      assert.equal(shadow.performance.cacheDisposed, true); assert.equal(Cycle.activeCount(), 0);
      const measurement = { model, seedMs, readMs, planningMs, totalMs,
        perSourceAverageMs: totalMs / 12, performance: shadow.performance, readerAudit: read.audit, nativeReadAudit };
      rows.push(measurement);
      process.stdout.write(JSON.stringify({ type: "measurement", value: measurement }) + "\n");
      if (model === "daily365" && totalMs >= 5000) throw Error("native_daily365_over_5_seconds");
    }
    assert.equal(network, 0);
    report = { status: "pass", electron: process.versions.electron, models: rows, network,
      productionUserDataAccess: 0, writerExecution: 0, activeCacheContexts: Cycle.activeCount() };
    exitCode = 0;
  } catch (error) { report = { status: "fail", reason: error.message, network, activeCacheContexts: Cycle.activeCount() }; }
  finally {
    if (window && !window.isDestroyed()) {
      await window.webContents.executeJavaScript("globalThis.__e4eOptSeedDB?.close(); delete globalThis.__e4eOptSeedDB; globalThis.__e4eOptRestore?.();").catch(() => {});
      await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    }
    session.defaultSession.webRequest.onBeforeRequest(null);
    report.cleanup = { windows: BrowserWindow.getAllWindows().length, readerHandles: 0,
      instrumentationListeners: 0, cacheContexts: Cycle.activeCount() };
    // Result is flushed to the controller before app termination. Exit code alone is not evidence.
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ type: "result", value: report }) + "\n",
      error => error ? reject(error) : resolve()));
    app.off("window-all-closed", keepAlive); app.exit(exitCode);
  }
}
async function controller() {
  const { spawn } = require("node:child_process"), { createInterface } = require("node:readline");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-e4e-opt-"));
  fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
  fs.writeFileSync(path.join(root, "isolated-only"), "E4e-Opt temp fixture only\n");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let result, closed = false;
  try {
    const child = spawn(require("electron"), [__filename, `--isolated-root=${root}`], { env, stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      process.stdout.write(line + "\n");
      try { const value = JSON.parse(line); if (value.type === "result") result = value.value; } catch (_) {}
    });
    child.stderr.on("data", data => process.stderr.write(data));
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject); child.on("close", code => { closed = true; resolve(code); });
    });
    lines.close();
    assert.equal(exit, 0, result?.reason || "native_process_failed"); assert.equal(result?.status, "pass");
  } finally {
    // Remove only this validated, disposable directory after Electron has fully exited.
    if (closed) {
      fs.rmSync(root, { recursive: true });
      process.stdout.write(JSON.stringify({ type: "controller_cleanup", tempRemoved: !fs.existsSync(root), processExited: true }) + "\n");
    }
  }
}
// Electron's application loader does not guarantee require.main === module.
if (process.versions.electron || require.main === module) {
  const rootArg = process.argv.find(value => value.startsWith("--isolated-root="));
  (process.versions.electron && rootArg ? worker(rootArg.slice("--isolated-root=".length)) : controller())
    .catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
module.exports = Object.freeze({ controller });
