"use strict";

// Explicit, bounded E4f-1R controller. No arbitrary source/path/authority command.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const Store = require("../js/marketCalendarHistory/writerSafetyCanaryStore.js");
const E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const OldStore = require("../js/marketCalendarHistory/writerSafetyStore.js");
const Canary = require("../js/marketCalendarRuntime/machineryStartupCanary.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const State = require("../js/storage/marketCalendarRuntimeStateStore.js");
const Policy = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const Routes = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Fixture = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");
const HEAD = "e765852dcc927d14be32fb3eed4e40ec2bbc6182", REPO = path.resolve(__dirname, "..");
const emit = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + "\n", e => e ? reject(e) : resolve()));
function completed(id, at = Fixture.OLD) {
  const old = { sourceId: id, lastAttemptAt: at, lastSuccessAt: null, lastOutcome: "failure",
    retryAfter: id === "us-bls-calendar" ? new Date(Date.parse(at) + 3600000).toISOString() : null, lastHttpStatus: id === "us-bls-calendar" ? null : 404,
    lastDiagnosticClass: Policy.APPROVALS[id].allowedDiagnostic, coordinatorVersion: 1 };
  const evaluation = Policy.evaluate({ sourceId: id, state: old, authority: Routes.PRODUCTION_AUTHORITY, requestedAt: at });
  assert.equal(evaluation.eligible, true);
  const reserved = Policy.reserveState(old, evaluation, at), result = Policy.completeState({ state: reserved,
    token: Policy.reservationToken(reserved), authority: Routes.PRODUCTION_AUTHORITY, completedAt: at,
    result: { lastAttemptAt: at, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null } });
  assert.equal(result.valid, true); return result.state;
}
function fixtureOptions(f) {
  const candidate = s => ({ ...Fixture.envelope(s).candidateEnvelope, formalEligible: true, recordCount: s.canonicalRecords.length,
    parserStatus: "success", canonicalDiagnostics: [] });
  return { now: () => Fixture.FRESH, fetchImpl: async () => { throw Error("fixture_network_forbidden"); },
    acquire: async ({ sourceId }) => ({ success: true, sourceId, documents: f.sources.find(s => s.sourceId === sourceId).documentHealth.map(d => ({ ...d, redirects: [] })) }),
    builder: { buildCalendarCandidate: async ({ sourceId }) => candidate(f.sources.find(s => s.sourceId === sourceId)) },
    simulator: { simulateCalendarTransition: async () => ({ simulationStatus: "preview", commitOutcome: "writer_disabled" }) },
    adapterFactory: () => ({ acquire: async ({ sourceId }) => { const s = f.sources.find(s => s.sourceId === sourceId);
      return { ...Fixture.envelope(s), candidateEnvelope: candidate(s), coverage: { coverageState: "sufficient" } }; } }) };
}
async function seed(wc, f, runtimeRecords = Object.keys(Policy.APPROVALS).map(id => completed(id, Fixture.FRESH))) {
  return wc.executeJavaScript(`(async () => {
    for (const [name, definitions, data] of ${JSON.stringify([[Schema.DATABASE_NAME, Schema.STORES,
      Object.fromEntries(Bootstrap.STORE_ORDER.map(([field, name]) => [name, f.snapshot[field]]))],
    [State.DATABASE_NAME, { [State.STORE_NAME]: { keyPath: "sourceId", indexes: [] } }, { [State.STORE_NAME]: runtimeRecords }]])}) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { for (const [name, d] of Object.entries(definitions)) {
          const s = r.result.createObjectStore(name, { keyPath: d.keyPath });
          for (const [name, key, unique] of d.indexes) s.createIndex(name, key, { unique }); } };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { await new Promise((resolve, reject) => { const tx = db.transaction(Object.keys(data), 'readwrite');
        for (const [name, records] of Object.entries(data)) for (const record of records) tx.objectStore(name).add(record);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
    }
  })()`, true);
}
function installAudit(formal, runtime, names, allowWrite) {
  const original = [], handles = new Set(), listeners = new Set();
  const audit = { opens: 0, readonly: 0, readwrite: 0, create: 0, upgrade: 0, formalWrites: 0,
    perStore: Object.fromEntries(names.map(n => [n, 0])), runtimeWrites: 0, marketWrites: 0, localStorageWrites: 0, handles: 0, pending: 0, listeners: 0 };
  const listen = (target, type, fn) => {
    const item = { target, type, handler: null }; item.handler = (...args) => { listeners.delete(item); audit.listeners = listeners.size; fn(...args); };
    listeners.add(item); audit.listeners = listeners.size; target.addEventListener(type, item.handler, { once: true });
  };
  const replace = (o, k, v) => { const old = o[k]; original.push(() => { o[k] = old; }); o[k] = v; return old; };
  const open = indexedDB.open;
  replace(indexedDB, "open", function (name, ...args) {
    if (![formal, runtime].includes(name)) throw Error("fixed_database_required");
    if (name === formal) audit.opens++;
    const r = open.call(this, name, ...args);
    listen(r, "upgradeneeded", event => { if (name === formal) { audit.upgrade++; if (!event.oldVersion) audit.create++;
      r.transaction.abort(); } });
    listen(r, "success", () => { handles.add(r.result); audit.handles = handles.size; }); return r;
  });
  const close = IDBDatabase.prototype.close;
  replace(IDBDatabase.prototype, "close", function (...args) { handles.delete(this); audit.handles = handles.size; return close.apply(this, args); });
  const tx = IDBDatabase.prototype.transaction;
  replace(IDBDatabase.prototype, "transaction", function (stores, mode = "readonly", ...rest) {
    if (this.name === formal) { audit[mode]++;
      if (mode === "readwrite" && (!allowWrite || !globalThis.__e3bStorageAuthorized || audit.readwrite !== 1)) throw Error("formal_write_not_authorized"); }
    const result = tx.call(this, stores, mode, ...rest); audit.pending++;
    let done = false; const finish = () => { if (!done) { done = true; audit.pending--; } };
    listen(result, "complete", finish); listen(result, "abort", finish); return result;
  });
  for (const method of ["add", "put", "delete", "clear"]) {
    const native = IDBObjectStore.prototype[method]; replace(IDBObjectStore.prototype, method, function (...args) {
      if (this.transaction.db.name === formal) { audit.formalWrites++; audit.perStore[this.name]++;
        if (!allowWrite || !globalThis.__e3bStorageAuthorized || ["delete", "clear"].includes(method)) throw Error("formal_mutation_forbidden"); }
      else if (this.transaction.db.name === runtime) audit.runtimeWrites++;
      else { audit.marketWrites++; throw Error("unrelated_write_forbidden"); }
      return native.apply(this, args);
    });
  }
  replace(indexedDB, "deleteDatabase", () => { throw Error("database_delete_forbidden"); });
  for (const method of ["setItem", "removeItem", "clear"]) replace(Storage.prototype, method, () => { audit.localStorageWrites++; throw Error("localstorage_write_forbidden"); });
  globalThis.__canaryAudit = audit;
  globalThis.__canaryDetach = () => { if (audit.handles || audit.pending) throw Error("resources_pending");
    for (const l of listeners) l.target.removeEventListener(l.type, l.handler); listeners.clear(); audit.listeners = 0;
    original.reverse().forEach(fn => fn()); delete globalThis.__canaryDetach; delete globalThis.__canaryAudit; };
}
function preflightProcesses() {
  assert.equal(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(), HEAD);
  assert.equal(cp.execFileSync("git", ["branch", "--show-current"], { cwd: REPO, encoding: "utf8" }).trim(), "main");
  const lines = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const found = lines.filter(s => /Electron\.app\/Contents\/(MacOS\/Electron|Frameworks)/.test(s) &&
    (/OptionMap|optionmap-writer-safety-/.test(s)));
  if (found.length) throw Error("optionmap_process_present");
  // Do not remove LOCK or Singleton files: ask the OS who currently holds files.
  const profile = path.join(os.homedir(), "Library", "Application Support", "OptionMap");
  for (const target of [path.join(profile, "IndexedDB"), path.join(profile, "market-calendar-writer-safety")]) {
    const result = cp.spawnSync("lsof", ["-t", "+D", target], { encoding: "utf8" });
    if (result.error || ![0, 1].includes(result.status)) throw Error("lock_inspection_failed");
    if (result.stdout.trim()) throw Error("profile_lock_holder_present");
  }
  return { optionmapProcesses: 0, dbLockHolders: 0, safetyLockHolders: 0 };
}
async function worker(root, phase, production) {
  if (root !== fs.realpathSync(root) || path.dirname(root) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(root).startsWith("optionmap-writer-safety-") || !fs.existsSync(path.join(root, "canary-marker"))) throw Error("temp_context_required");
  const { app, BrowserWindow, net, session } = require("electron");
  const profile = production ? path.join(app.getPath("appData"), "OptionMap") : root;
  app.setPath("userData", profile); app.setPath("sessionData", production ? profile : path.join(root, "sessionData"));
  app.disableHardwareAcceleration(); const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  let store, window, canary, result = { status: "fail", phase }, activeRequests = 0, observed = 0, instrumented = false;
  const watchdog = setTimeout(() => app.exit(3), 540000);
  const control = require("node:readline").createInterface({ input: process.stdin }); let stopped = false;
  control.on("line", line => { if (line === "STOP") stopped = true; });
  try {
    await app.whenReady();
    if (!production && phase === "dry") {
      const old = OldStore.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
      try { assert.equal((await old.provisionDisabled()).saved, true); } finally { old.close(); }
    }
    store = production ? Store.createProductionStore() : Store.createIsolatedStore(root);
    const before = store.load(); assert.equal(before.available, true, before.reason);
    if (phase === "migrate" || phase === "dry") {
      const migrated = await store.migrate(before.record.safety.sequence); assert.equal(migrated.saved, true, migrated.reason);
      assert.deepEqual(migrated.record.legacyRecord, before.record); assert.equal(migrated.record.safety.persistedAuthorityVersion, 2);
      assert.equal(migrated.record.safety.sequence, before.record.safety.sequence + 1);
    }
    if (phase === "transition" || phase === "dry") {
      const transitioned = await store.transition(store.load().record.safety.sequence); assert.equal(transitioned.saved, true, transitioned.reason);
      assert.equal(transitioned.record.safety.persistedAuthorityVersion, 3);
    }
    if (phase === "read" || phase === "migrate" || phase === "transition") {
      const loaded = store.load(); assert.equal(loaded.available, true);
      result = { status: "pass", phase, record: loaded.record, contentHash: loaded.contentHash, loadMs: loaded.latencyMs };
    } else if (phase === "canary" || phase === "dry") {
      store.close(); store = null;
      window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await window.loadFile(path.join(REPO, "scripts", "marketCalendarD2d4ReadOnlyProbe.html"));
      let f;
      if (!production) { f = await Fixture.fixture({ perSource: 4 }); await seed(window.webContents, f); }
      for (const world of [0, 1741, 1742]) {
        const code = `(${installAudit.toString()})(${JSON.stringify(Schema.DATABASE_NAME)}, ${JSON.stringify(State.DATABASE_NAME)},
          ${JSON.stringify(Bootstrap.STORE_ORDER.map(s => s[1]))}, ${world === 0})`;
        if (world === 0) await window.webContents.executeJavaScript(code, true);
        else await window.webContents.executeJavaScriptInIsolatedWorld(world, [{ code }]);
      }
      instrumented = true;
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, callback) => {
        observed++; callback({ cancel: stopped || !production }); });
      canary = production ? Canary.createProductionCanary(window.webContents) : Canary.createIsolatedCanary({ root,
        wc: window.webContents, runtimeStateStore: Canary.genericStore(window.webContents), runtimeOptions: fixtureOptions(f) });
      const value = await canary.startup();
      if (production) { assert.equal(canary.audit().transportRequests, observed, "network_observer_mismatch");
        assert.equal(canary.audit().pendingTransports, 0, "network_requests_pending"); }
      result = { ...value, phase, packageIdentity: `${app.getName()}/${app.getVersion()}`, userAgent: session.defaultSession.getUserAgent(),
        requestObserverCount: observed, activeRequests, safetyAudit: canary.audit() };
      if (phase === "dry") { assert.equal(value.status, "pass", value.reason); assert.equal(value.execution.result.audit.readwrite, 1);
        assert.equal(value.execution.finalSequence, 7); assert.equal(observed, 0); }
    } else throw Error("fixed_phase_required");
    if (stopped) throw Error("reset_repair_indication");
  } catch (e) { result = { ...result, status: "fail", reason: /^[a-z_]+$/.test(e.message) ? e.message : "native_gate_failed" }; }
  finally {
    if (canary) { canary.close(); result.safetyAudit = canary.audit(); }
    if (store) { store.close(); result.safetyAudit = store.audit(); }
    if (window && !window.isDestroyed()) {
      if (instrumented) {
        result.storageAudits = [];
        for (const world of [0, 1741, 1742]) {
          const code = "(() => { const a = __canaryAudit; __canaryDetach(); return structuredClone(a); })()";
          try { result.storageAudits.push(world === 0 ? await window.webContents.executeJavaScript(code, true) :
            await window.webContents.executeJavaScriptInIsolatedWorld(world, [{ code }])); }
          catch (_) { result.status = "fail"; result.cleanupFailure = "resources_pending"; }
        }
      }
      await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    }
    session.defaultSession.webRequest.onBeforeRequest(null); clearTimeout(watchdog); control.close();
    result.cleanup = { windows: BrowserWindow.getAllWindows().length, requests: activeRequests, watchdogs: 0,
      fileHandles: result.safetyAudit?.fileHandles || 0, lockHandles: result.safetyAudit?.lockHandles || 0 };
    await emit({ type: "result", value: result }); app.off("window-all-closed", keepAlive); app.exit(result.status === "fail" ? 1 : 0);
  }
}
async function controller(production) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  fs.mkdirSync(path.join(root, "sessionData")); fs.writeFileSync(path.join(root, "canary-marker"), "isolated preflight\n");
  const metadata = require("../package.json"); fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, main: "entry.cjs" }));
  fs.writeFileSync(path.join(root, "entry.cjs"), `require(${JSON.stringify(__filename)});\n`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; let running = false;
  async function run(phase, live) {
    let result, unsafe = false;
    const child = cp.spawn(require("electron"), [root, `--canary-root=${root}`, `--canary-phase=${phase}`, ...(live ? ["--production-worker"] : [])],
      { env, stdio: ["pipe", "pipe", "pipe"] }); running = true;
    const lines = require("node:readline").createInterface({ input: child.stdout });
    lines.on("line", line => { try { const value = JSON.parse(line); if (value.type === "result") result = value.value; } catch (_) {} });
    child.stderr.on("data", bytes => { process.stderr.write(bytes); if (/quota.*reset|repair|corrupt/i.test(String(bytes))) {
      unsafe = true; child.stdin.write("STOP\n"); } });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => { running = false; resolve(code); }); });
    lines.close(); if (unsafe || code !== 0 || !result || result.status === "fail") { await emit({ type: "failed_stage", phase, result });
      throw Error(result?.reason || "native_failed"); }
    // Keep full record in memory for preservation checks, emit only compact safety receipt.
    const { record, diagnostics, acquisition, ...compact } = result;
    await emit({ type: "stage", phase, value: { ...compact, safety: record ? { schemaVersion: record.schemaVersion,
      sequence: record.safety.sequence, authorityVersion: record.safety.persistedAuthorityVersion, checksum: record.checksum,
      pending: record.safety.pendingFence, auditEntries: record.transitionAudit.length } : null,
      sources: acquisition?.sources?.map(s => ({ sourceId: s.sourceId, status: s.status, decision: s.planningDecision,
        reason: s.planningReason || s.reasonClass, acquisition: s.acquisitionStatus })) || null } });
    return result;
  }
  try {
    await run("dry", false);
    if (!production) return;
    const preflight = preflightProcesses(); await emit({ type: "production_preflight", value: preflight });
    const legacy = await run("read", true); assert.equal(legacy.record.schemaVersion, 1);
    assert.equal(legacy.record.safety.pendingFence, null); assert.equal(legacy.record.safety.globalSuspend.suspended, false);
    assert.ok(legacy.record.safety.sources.every(s => !s.suspended));
    preflightProcesses(); await run("migrate", true);
    const migrated = await run("read", true); assert.equal(migrated.record.safety.sequence, legacy.record.safety.sequence + 1);
    assert.deepEqual(migrated.record.legacyRecord, legacy.record); assert.equal(migrated.record.safety.persistedAuthorityVersion, 2);
    preflightProcesses(); await run("transition", true);
    const transitioned = await run("read", true); assert.equal(transitioned.record.safety.sequence, migrated.record.safety.sequence + 1);
    assert.equal(transitioned.record.safety.persistedAuthorityVersion, 3); assert.deepEqual(transitioned.record.legacyRecord, legacy.record);
    preflightProcesses(); const live = await run("canary", true), final = await run("read", true);
    if (live.status === "hold") { assert.deepEqual(final.record, transitioned.record); await emit({ type: "gate", value: "HOLD — CANARY NOT EXECUTED (same-day skip)" }); }
    else { assert.equal(final.record.safety.pendingFence, null); assert.equal(final.record.safety.sequence, transitioned.record.safety.sequence + 5);
      assert.equal(final.record.safety.persistedAuthorityVersion, 3); await emit({ type: "gate", value: "PASS — Startup Canary COMMITTED" }); }
    await emit({ type: "final_preflight", value: preflightProcesses() });
  } finally { if (!running) { fs.rmSync(root, { recursive: true }); await emit({ type: "controller_cleanup", tempRemoved: !fs.existsSync(root), processes: 0 }); } }
}
if (require.main === module || process.versions.electron && process.argv.some(a => a.startsWith("--canary-root="))) {
  const root = process.argv.find(a => a.startsWith("--canary-root=")), phase = process.argv.find(a => a.startsWith("--canary-phase="));
  (root && process.versions.electron ? worker(root.slice(14), phase?.slice(15), process.argv.includes("--production-worker")) :
    controller(process.argv.includes("--production"))).catch(e => { process.stderr.write(e.message + "\n"); process.exitCode = 1; });
}
module.exports = Object.freeze({ HEAD, completed, fixtureOptions, seed, installAudit, preflightProcesses, controller });
