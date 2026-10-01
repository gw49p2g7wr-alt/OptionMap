"use strict";

// Explicit runtime-equivalent acceptance, not app startup. Production execution is opt-in,
// once, after a disposable native preflight. No writer is imported or executed.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const Runtime = require("../js/marketCalendarRuntime/automaticFormalShadowRuntime.js");
const SafetyReader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const Integration = require("../js/marketCalendarRuntime/calendarRuntimeStateIntegration.js");
const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Policy = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const Routes = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const StateStore = require("../js/storage/marketCalendarRuntimeStateStore.js");
const Fixture = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");
const Manual = require("../js/marketCalendarRuntime/calendarManualCheckService.js");
const BlsRoute = require("../js/marketCalendarIsolated/blsFixedRoute.js");
const Adapter = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");
const WORLD = 1742, WORLDS = [0, 1741, WORLD];
const emit = (type, value) => new Promise((resolve, reject) => process.stdout.write(
  JSON.stringify({ type, value }) + "\n", error => error ? reject(error) : resolve()));
const execute = (wc, world, code) => world === 0 ? wc.executeJavaScript(code) :
  wc.executeJavaScriptInIsolatedWorld(world, [{ code }]);

// Installed separately in every world used by the fixed stores/reader. Count attempted
// operations and block Formal writes *before* invoking a native mutation.
function installAudit(formalName, runtimeName, storeNames) {
  const audit = { formal: { opens: 0, readonly: 0, readwrite: 0, create: 0, upgrade: 0, writes: 0,
    perStoreWrites: Object.fromEntries(storeNames.map(n => [n, 0])) }, runtimeWrites: 0,
    marketHistoryWrites: 0, localStorageWrites: 0, handles: 0, pending: 0, listeners: 0 };
  const originals = [], handles = new Set();
  const replace = (object, key, value) => { const old = object[key]; originals.push(() => { object[key] = old; }); object[key] = value; return old; };
  function listen(target, type, fn, once = true) {
    let active = true;
    audit.listeners++; const handler = (...args) => { if (once && active) { audit.listeners--; active = false; } fn(...args); };
    target.addEventListener(type, handler, { once });
    return () => { target.removeEventListener(type, handler); if (active) { audit.listeners--; active = false; } };
  }
  const open = indexedDB.open;
  replace(indexedDB, "open", function (name, ...args) {
    if (name === formalName) audit.formal.opens++;
    const request = open.call(this, name, ...args);
    const offUpgrade = listen(request, "upgradeneeded", event => {
      if (name === formalName) { audit.formal.upgrade++; if (!event.oldVersion) audit.formal.create++;
        request.transaction.abort(); }
    });
    const offError = listen(request, "error", () => { offSuccess(); offUpgrade(); });
    const offSuccess = listen(request, "success", () => {
      offError(); offUpgrade(); handles.add(request.result); audit.handles = handles.size;
    });
    return request;
  });
  const close = IDBDatabase.prototype.close;
  replace(IDBDatabase.prototype, "close", function (...args) {
    handles.delete(this); audit.handles = handles.size; return close.apply(this, args);
  });
  const transaction = IDBDatabase.prototype.transaction;
  replace(IDBDatabase.prototype, "transaction", function (stores, mode = "readonly", ...args) {
    if (this.name === formalName) { audit.formal[mode]++; if (mode !== "readonly") throw Error("formal_readwrite_forbidden"); }
    const tx = transaction.call(this, stores, mode, ...args); audit.pending++;
    let offComplete, offAbort;
    const done = () => { audit.pending--; };
    offComplete = listen(tx, "complete", () => { offAbort(); done(); });
    offAbort = listen(tx, "abort", () => { offComplete(); done(); }); return tx;
  });
  for (const method of ["add", "put", "delete", "clear"]) {
    const native = IDBObjectStore.prototype[method];
    replace(IDBObjectStore.prototype, method, function (...args) {
      const name = this.transaction.db.name;
      if (name === formalName) { audit.formal.writes++; audit.formal.perStoreWrites[this.name]++;
        throw Error("formal_write_forbidden"); }
      if (name === runtimeName) audit.runtimeWrites++;
      else { audit.marketHistoryWrites++; throw Error("unrelated_write_forbidden"); }
      return native.apply(this, args);
    });
  }
  for (const method of ["setItem", "removeItem", "clear"]) {
    replace(Storage.prototype, method, function () { audit.localStorageWrites++; throw Error("localstorage_write_forbidden"); });
  }
  const remove = indexedDB.deleteDatabase;
  replace(indexedDB, "deleteDatabase", function (name) { if (name === formalName || name === runtimeName)
    throw Error("database_delete_forbidden"); return remove.call(this, name); });
  globalThis.__runtimeShadowAudit = audit;
  globalThis.__runtimeShadowDetach = () => {
    if (audit.pending || audit.handles || audit.listeners) throw Error("instrumentation_resources_pending");
    originals.reverse().forEach(restore => restore()); delete globalThis.__runtimeShadowDetach;
    delete globalThis.__runtimeShadowAudit;
  };
}
function completed(sourceId) {
  const at = Fixture.OLD, diagnostic = Policy.APPROVALS[sourceId].allowedDiagnostic;
  const old = { sourceId, lastAttemptAt: at, lastSuccessAt: null, lastOutcome: "failure",
    retryAfter: diagnostic === "network_failure" ? "2026-09-01T01:00:00.000Z" : null,
    lastHttpStatus: diagnostic === "http_404" ? 404 : null, lastDiagnosticClass: diagnostic, coordinatorVersion: 1 };
  const evaluation = Policy.evaluate({ sourceId, state: old, authority: Routes.PRODUCTION_AUTHORITY, requestedAt: at });
  if (!evaluation.eligible) throw Error("fixture_activation_invalid");
  const state = Policy.reserveState(old, evaluation, at);
  const result = Policy.completeState({ state, token: Policy.reservationToken(state), authority: Routes.PRODUCTION_AUTHORITY,
    result: { lastAttemptAt: at, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null }, completedAt: at });
  if (!result.valid) throw Error("fixture_completion_invalid"); return result.state;
}
async function seedTemp(wc, fixture) {
  const definitions = [[Schema.DATABASE_NAME, Schema.STORES,
    Object.fromEntries(Bootstrap.STORE_ORDER.map(([field, name]) => [name, fixture.snapshot[field]]))],
  [StateStore.DATABASE_NAME, { [StateStore.STORE_NAME]: { keyPath: "sourceId", indexes: [] } },
    { [StateStore.STORE_NAME]: Object.keys(Policy.APPROVALS).map(completed) }]];
  await execute(wc, 0, `(async () => {
    for (const [name, definition, records] of ${JSON.stringify(definitions)}) {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1); r.onupgradeneeded = () => {
          for (const [name, shape] of Object.entries(definition)) {
            const s = r.result.createObjectStore(name, { keyPath: shape.keyPath });
            for (const [name, keyPath, unique] of shape.indexes) s.createIndex(name, keyPath, { unique });
          }
        }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('temp_seed_failed'));
      });
      try { await new Promise((resolve, reject) => {
        const tx = db.transaction(Object.keys(records), 'readwrite');
        for (const [store, values] of Object.entries(records)) for (const v of values) tx.objectStore(store).add(v);
        tx.oncomplete = resolve; tx.onabort = () => reject(Error('temp_seed_failed'));
      }); } finally { db.close(); }
    }
  })()`);
}
function genericStore(wc) {
  const source = ["../js/marketCalendar/sourceRegistry.js", "../js/marketCalendarRuntime/sourceUpdateState.js",
    "../js/storage/marketCalendarRuntimeStateStore.js"].map(f => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  const call = (method, args) => execute(wc, WORLD, `(async () => { ${source}\n
    const store = window.OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({ indexedDB, targetEnvironment: 'browser_runtime' });
    return store.${method}(...${JSON.stringify(args)}); })()`);
  return { readAll: () => call("readAll", []), write: (id, value) => call("write", [id, value]) };
}
function combineAudits(values) {
  const total = structuredClone(values[0]);
  const add = (a, b) => { for (const key of Object.keys(a)) if (typeof a[key] === "number") a[key] += b[key]; else add(a[key], b[key]); };
  values.slice(1).forEach(v => add(total, v)); return total;
}
const safeReason = value => typeof value === "string" && /^[a-z0-9_:-]{1,120}$/.test(value) ? value : null;
function compactSummary(acquisition, diagnostics) {
  const shadow = diagnostics?.shadow, metrics = diagnostics?.metrics || null;
  const sourceRows = Manual.ACTIVE_SOURCE_IDS.map(sourceId => {
    const a = acquisition?.sources?.find(s => s.sourceId === sourceId);
    const d = diagnostics?.sourceDiagnostics?.find(s => s.sourceId === sourceId);
    const r = shadow?.sourceRows?.find(s => s.sourceId === sourceId);
    const failed = ["failed", "partial"].includes(d?.acquisition || r?.acquisition) || a?.status === "failed";
    const reason = failed ? safeReason(a?.reasonClass) || d?.diagnostics?.[0] ||
      d?.documentHealth?.flatMap(h => h.diagnostics || [])[0] || "acquisition_failed" : null;
    return { sourceId, acquisition: d?.acquisition || r?.acquisition ||
      (a?.planningDecision === "skip" ? "skipped" : a?.acquisitionStatus || "not_reached"),
      resultStatus: a?.status || "not_reached", sourceReason: safeReason(a?.reasonClass), failureClass: reason, failureReasons: failed ?
        [...new Set([reason, ...(d?.diagnostics || []), ...(d?.documentHealth || []).flatMap(h => h.diagnostics || [])].filter(Boolean))] : [],
      candidate: r?.candidate ?? d?.candidateCount ?? a?.recordCount ?? null,
      formalActive: r?.formalActive ?? null, unchanged: r?.unchanged ?? null, changed: r?.changed ?? null,
      new: r?.new ?? null, evidenceOnly: r?.evidenceOnly ?? null, notEvaluated: r?.notEvaluated ?? null,
      comparisonReached: !!r, eligible: r?.eligible === true,
      eligibilityReason: r?.reason || shadow?.reason || "not_evaluated",
      counts: r?.counts || Object.fromEntries(Gate.FIELDS.map(key => [key, 0])),
      documentHealth: d?.documentHealth || [], failedRoles: d?.failedRoles || [],
      coverage: d?.coverage || null, absenceAuthority: "none", writeAllowed: false };
  });
  const metricsComplete = metrics?.complete === true && ["readonlyMs", "planningMs", "totalShadowMs"]
    .every(key => Number.isFinite(metrics[key]) && metrics[key] >= 0);
  return { acquisition: { state: acquisition?.state || "not_reached",
    successfulSourceCount: acquisition?.successfulSourceCount ?? null },
    shadowStatus: shadow?.status || "not_reached", shadowReason: shadow?.reason || null,
    sourceRows, sourceRowCount: sourceRows.length, metrics, metricsComplete,
    safety: diagnostics?.safety || null,
    formalRead: diagnostics?.formalRead || null, performance: shadow?.performance || null,
    aggregatePlannedCounts: shadow?.aggregatePlannedCounts || Object.fromEntries(Gate.FIELDS.map(key => [key, 0])),
    eligibleCount: sourceRows.filter(r => r.eligible).length,
    writerExecution: shadow?.writerExecution ?? 0, productionAuthority: "disabled",
    futureWriteRequiresFreshPlan: true };
}

// Read-only diagnostic transport tap. The existing production adapter remains the
// acquisition/decoder/parser authority; bytes are observed on that SAME bounded read.
async function diagnoseBls(fetchImpl, assessmentDateJst, redirects = new Map()) {
  const observations = new Map(); let requests = 0, pending = 0, pendingBody = 0, readers = 0;
  const adapter = Adapter.createRouteAdapter({ getAuthority: () => Routes.PRODUCTION_AUTHORITY,
    assessmentDateJst, fetchImpl: async (url, options) => {
      const role = BlsRoute.ROLES.find(r => r.url === url);
      if (!role || observations.has(role.role)) throw Error("diagnostic_request_boundary_invalid");
      const observation = { role: role.role, requestedUrl: url, requestAttempted: true,
        httpStatus: null, contentType: null, byteLength: 0, bodyComplete: false, chunks: [] };
      observations.set(role.role, observation); requests++; pending++;
      let response;
      try { response = await fetchImpl(url, options); }
      catch (error) { observation.transportReason = safeReason(error?.code) || "network_failure"; throw error; }
      finally { pending--; }
      Object.assign(observation, { httpStatus: response.status, contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"), contentLength: response.headers.get("content-length"),
        responseUrl: response.url, redirected: response.redirected, location: response.headers.get("location") });
      const body = response.body;
      return { status: response.status, headers: response.headers, url: response.url, redirected: response.redirected,
        body: body && { get locked() { return body.locked; }, cancel: () => body.cancel(), getReader: () => {
          const reader = body.getReader(); readers++;
          return { cancel: () => reader.cancel(), releaseLock: () => { reader.releaseLock(); readers--; }, read: async () => {
            pendingBody++; let value;
            try { value = await reader.read(); } finally { pendingBody--; }
            if (value.done) observation.bodyComplete = true;
            else { observation.byteLength += value.value.byteLength;
              if (observation.byteLength <= BlsRoute.MAX_BYTES) observation.chunks.push(value.value.slice()); }
            return value;
          } };
        } } };
    } });
  const result = await adapter.acquire({ sourceId: BlsRoute.SOURCE_ID, operation: Network.OPERATION });
  const rows = BlsRoute.ROLES.map(role => {
    const o = observations.get(role.role), health = result.documentHealth.find(d => d.role === role.role),
      coverage = result.coverage?.roleCoverage?.find(d => d.role === role.role);
    let charset = { status: "not_evaluated", reason: "body_not_read" }, strictUtf8 = "not_evaluated";
    if (o?.bodyComplete && o.byteLength <= BlsRoute.MAX_BYTES) {
      const bytes = new Uint8Array(o.byteLength); let offset = 0;
      for (const chunk of o.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const decoded = BlsRoute.decode(bytes, o.contentType,
        { sourceId: BlsRoute.SOURCE_ID, role: role.role, requestedUrl: role.url });
      charset = { status: decoded.ok ? "accepted" : "rejected", reason: decoded.reason || null,
        evidence: decoded.evidence || null, warnings: decoded.warnings || [] };
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); strictUtf8 = "valid"; }
      catch (_) { strictUtf8 = "invalid"; }
    }
    const row = { role: role.role, requestAttempted: !!o, httpStatus: o?.httpStatus ?? null,
      redirectCount: redirects.get(role.url) || 0, redirected: o?.redirected ?? null, locationPresent: !!o?.location,
      contentType: o?.contentType ?? null, mime: o?.contentType?.split(";")[0].trim().toLowerCase() || null,
      contentEncoding: o?.contentEncoding ?? null, contentLength: o?.contentLength ?? null,
      byteLength: o?.byteLength ?? null, bodyComplete: o?.bodyComplete || false,
      strictUtf8, charset, fetchOutcome: health?.fetchOutcome || "not_attempted",
      parser: health?.parseOutcome || "not_attempted", candidates: health?.candidateCount ?? 0,
      coverage: coverage ? { state: coverage.state, reason: coverage.reason } : null,
      failureClass: health?.fetchOutcome !== "success" ? "fetch_failure" : health?.parseOutcome !== "success" ?
        "parser_failure" : coverage?.state !== "sufficient" ? "coverage_ineligible" : null,
      failureReasons: [...new Set([...(health?.diagnostics || []), o?.transportReason,
        coverage?.state !== "sufficient" ? coverage?.reason : null].filter(Boolean))] };
    if (o) o.chunks.length = 0; return row;
  });
  return { assessmentDateJst, acquisitionOutcome: result.acquisitionOutcome, rows,
    parserOutcome: result.candidateEnvelope?.parserStatus || "not_attempted",
    productionAcceptanceEligible: rows.every(r => r.fetchOutcome === "success" && r.parser === "success" &&
      r.candidates > 0 && r.coverage?.state === "sufficient") && result.acquisitionOutcome === "complete" &&
      result.candidateEnvelope?.formalEligible === true && result.candidateEnvelope?.canonicalDiagnostics?.length === 0,
    candidateCount: result.candidateEnvelope?.recordCount || 0, failedRoles: result.failedRoles,
    diagnostics: result.diagnostics, coverage: result.coverage?.coverageState || null,
    requestCount: requests, retryCount: 0, absenceAuthority: "none", resources: adapter.diagnostics(),
    pendingTransport: pending, pendingBody, readers, formalAccess: 0, formalWrites: 0, runtimeStateAccess: 0, writerExecution: 0 };
}
async function worker(root, production) {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("optionmap-e4e-runtime-") ||
      !fs.existsSync(path.join(root, "isolated-only"))) throw Error("temp_context_required");
  const { app, BrowserWindow, net, session } = require("electron");
  const profile = production ? path.join(app.getPath("appData"), "OptionMap") : path.join(root, "userData");
  if (!fs.existsSync(profile)) throw Error("profile_absent");
  app.setPath("userData", profile); app.setPath("sessionData", production ? profile : path.join(root, "sessionData"));
  app.disableHardwareAcceleration();
  const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  const control = require("node:readline").createInterface({ input: process.stdin });
  const watchdog = setTimeout(() => app.exit(3), 540000);
  let window, result, code = 1, runtime, instruments = false, network = 0, activeNetwork = 0, observed = 0,
    shadowNetworkDelta = 0, shadowStateDelta = 0, audit, acquisition, diagnostics, records = [], stage = "native_setup";
  control.on("line", line => { if (line === "STOP") app.exit(2); });
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      observed++; callback({});
    });
    if (!production) {
      // Local Electron network counter proof, never an official endpoint.
      const server = require("node:http").createServer((request, response) => { response.end("ok"); });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try { await (await net.fetch(`http://127.0.0.1:${server.address().port}/dry-probe`)).arrayBuffer();
        assert.equal(observed, 1); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      observed = 0;
    }
    const fixture = production ? null : await Fixture.fixture();
    if (fixture) await seedTemp(window.webContents, fixture);
    for (const world of WORLDS) await execute(window.webContents, world,
      `(${installAudit.toString()})(${JSON.stringify(Schema.DATABASE_NAME)}, ${JSON.stringify(StateStore.DATABASE_NAME)},
        ${JSON.stringify(Bootstrap.STORE_ORDER.map(s => s[1]))})`);
    instruments = true;
    const collect = async () => combineAudits(await Promise.all(WORLDS.map(world => execute(window.webContents, world, "structuredClone(__runtimeShadowAudit)"))));
    const store = genericStore(window.webContents);
    stage = "runtime_state_restore";
    const before = await store.readAll(); assert.equal(before.status, "ok", before.reason);
    assert.equal(before.invalidSources.length, 0);
    const read = Reader.createReader(window.webContents);
    const safetyReader = SafetyReader.createReader(profile);
    const options = { webContents: window.webContents, loadSafety: safetyReader.load, fetchImpl: async (url, settings) => {
      network++; activeNetwork++; try { return await net.fetch(url, settings); } finally { activeNetwork--; }
    }, readFormal: async () => {
      stage = "formal_readonly_shadow";
      const n = network, writes = (await collect()).runtimeWrites;
      const value = await read(); shadowNetworkDelta += network - n;
      shadowStateDelta += (await collect()).runtimeWrites - writes; return value;
    } };
    if (fixture) {
      // Actual service composition/normal completion; only transport/parser data are fixtures.
      options.now = () => Fixture.FRESH;
      options.acquire = async ({ sourceId }) => ({ success: true, sourceId,
        documents: fixture.sources.find(s => s.sourceId === sourceId).documentHealth.map(d => ({ ...d, redirects: [] })) });
      options.builder = { buildCalendarCandidate: async ({ sourceId }) => {
        const s = fixture.sources.find(s => s.sourceId === sourceId); return { ...Fixture.envelope(s).candidateEnvelope,
          formalEligible: true, recordCount: s.canonicalRecords.length, parserStatus: "success" }; } };
      options.simulator = { simulateCalendarTransition: async () => ({ simulationStatus: "preview", commitOutcome: "writer_disabled" }) };
      options.adapterFactory = () => ({ acquire: async ({ sourceId }) => {
        const s = fixture.sources.find(s => s.sourceId === sourceId); return { ...Fixture.envelope(s),
          candidateEnvelope: { ...Fixture.envelope(s).candidateEnvelope, formalEligible: true,
            parserStatus: "success", recordCount: s.canonicalRecords.length, canonicalDiagnostics: [] },
          coverage: { coverageState: "sufficient" } }; } });
    }
    runtime = Runtime.createRuntime(options);
    const integration = Integration.createRuntimeStateIntegration({ service: runtime, store, targetEnvironment: "browser_runtime" });
    stage = "normal_manual_acquisition";
    // The existing manual contract is used, including its legitimate daily-update decision.
    // No state reset, synthetic timestamp, route override or forced retry in production.
    acquisition = await integration.check({ trigger: "manual", ...(fixture ? {
      sourceIds: ["jp-esri-machinery-orders-calendar", "jp-stat-labor"] } : {}) });
    diagnostics = runtime.diagnostics(); const shadow = diagnostics.shadow;
    assert.equal(diagnostics.safety.storeStatus, "missing", "unexpected_safety_store_state");
    assert.equal(diagnostics.safety.sourceRows.length, 12);
    assert.ok(diagnostics.safety.sourceRows.every(row => row.writeAllowed === false));
    assert.equal(safetyReader.audit().loads, 1);
    assert.equal(safetyReader.audit().writes, 0); assert.equal(safetyReader.audit().handles, 0);
    audit = await collect();
    const after = await store.readAll(); assert.equal(after.status, "ok");
    records = after.value.map(r => ({ sourceId: r.sourceId, lastOutcome: r.lastOutcome,
      routeBinding: r.routeBinding || null, reevaluationStatus: r.reevaluation?.status || null }));
    assert.equal(acquisition.state, "success", "normal_acquisition_failed");
    assert.equal(shadow.status, "evaluated", shadow.reason); assert.equal(shadow.writerExecution, 0);
    assert.equal(shadowNetworkDelta, 0); assert.equal(shadowStateDelta, 0);
    assert.equal(network, observed); assert.equal(audit.formal.readwrite, 0); assert.equal(audit.formal.writes, 0);
    assert.equal(audit.formal.create, 0); assert.equal(audit.formal.upgrade, 0);
    assert.equal(audit.marketHistoryWrites, 0); assert.equal(audit.localStorageWrites, 0);
    assert.equal(audit.pending, 0); assert.equal(audit.handles, 0); assert.equal(audit.listeners, 0);
    assert.equal(Cycle.activeCount(), 0);
    assert.equal(shadow.performance.snapshotValidationCount, 1); assert.equal(shadow.performance.fullSnapshotHashCount, 1);
    if (production) {
      assert.equal(shadow.sourceRows.length, 12); assert.equal(shadow.eligibleCount, 11);
      assert.equal(shadow.sourceRows.find(r => r.sourceId === "jp-boj-calendar").reason, "writer_ineligible_identity_transition");
    }
    assert.equal(compactSummary(acquisition, diagnostics).metricsComplete, true, "shadow_metrics_missing");
    result = { status: "pass" };
    code = 0;
  } catch (error) { result = { status: "fail", failureStage: stage,
    reason: safeReason(error.message.split("\n")[0]) || "runtime_acceptance_failed" }; }
  finally {
    // Identical compact reached-stage envelope on PASS and FAIL. Never serialize plans,
    // canonical records, raw bodies or assertion dumps; NYSE is always one of 12 rows.
    Object.assign(result, compactSummary(acquisition, diagnostics || runtime?.diagnostics()), {
      environment: production ? "production" : "native_temp", trigger: "manual",
      network: { official: network, observed, shadowAdditional: shadowNetworkDelta, active: activeNetwork },
      audit: audit || null, shadowRuntimeStateWrites: shadowStateDelta, runtimeRecords: records });
    if (window && !window.isDestroyed()) {
      if (instruments) {
        const values = await Promise.all(WORLDS.map(world => execute(window.webContents, world, "structuredClone(__runtimeShadowAudit)")));
        result.finalAudit = combineAudits(values);
        for (const world of WORLDS) {
          try { await execute(window.webContents, world, "__runtimeShadowDetach()"); }
          catch (_) { result.status = "fail"; result.cleanupFailure = "instrumentation_resources_pending"; code = 1; }
        }
      }
      await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    }
    session.defaultSession.webRequest.onBeforeRequest(null);
    clearTimeout(watchdog); control.close();
    result.cleanup = { windows: BrowserWindow.getAllWindows().length, requests: activeNetwork,
      cacheContexts: Cycle.activeCount(), instrumentationListeners: result.finalAudit?.listeners || 0, watchdogs: 0 };
    await emit("result", result);
    app.off("window-all-closed", keepAlive); app.exit(code);
  }
}
async function blsDiagnosticWorker(root) {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("optionmap-e4e-runtime-") ||
      !fs.existsSync(path.join(root, "isolated-only"))) throw Error("temp_context_required");
  const { app, net, session } = require("electron");
  app.setPath("userData", path.join(root, "userData")); app.setPath("sessionData", path.join(root, "sessionData"));
  app.disableHardwareAcceleration(); let observed = 0, result, code = 1;
  const redirects = new Map();
  const control = require("node:readline").createInterface({ input: process.stdin });
  const stop = line => { if (line === "STOP") app.exit(2); }; control.on("line", stop);
  const watchdog = setTimeout(() => app.exit(3), 120000);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: BlsRoute.ROLES.map(r => r.url) },
      (_, callback) => { observed++; callback({}); });
    session.defaultSession.webRequest.onBeforeRedirect({ urls: BlsRoute.ROLES.map(r => r.url) },
      details => redirects.set(details.url, (redirects.get(details.url) || 0) + 1));
    const assessmentDateJst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const diagnostic = await diagnoseBls((url, options) => net.fetch(url, options), assessmentDateJst, redirects);
    assert.equal(diagnostic.requestCount, 4); assert.equal(observed, 4);
    assert.equal(diagnostic.resources.bls.activeTasks, 0); assert.equal(diagnostic.resources.bls.activeTimers, 0);
    assert.equal(diagnostic.pendingBody, 0); assert.equal(diagnostic.pendingTransport, 0); assert.equal(diagnostic.readers, 0);
    // A failed acquisition is a completed diagnostic, not a passing acquisition Gate.
    result = { status: "pass", diagnosticComplete: true, environment: "dedicated_temp_bls_readonly",
      diagnostic, observedRequests: observed }; code = 0;
  } catch (error) { result = { status: "fail", diagnosticComplete: false,
    reason: safeReason(error.message.split("\n")[0]) || "diagnostic_failed", observedRequests: observed }; }
  finally {
    session.defaultSession.webRequest.onBeforeRequest(null); session.defaultSession.webRequest.onBeforeRedirect(null);
    clearTimeout(watchdog); control.removeListener("line", stop); control.close();
    result.cleanup = { windows: 0, dbHandles: 0, pendingPromises: 0, activeRequests: 0,
      instrumentationListeners: 0, watchdogs: 0 };
    await emit("result", result); app.exit(code);
  }
}
function nativeLaunchIdentity() {
  // Same main-side package authority as the original successful BLS isolated
  // launcher. Let Electron generate its normal UA; never synthesize a UA/header.
  const metadata = require("../package.json");
  if (typeof metadata.name !== "string" || !metadata.name || typeof metadata.version !== "string" || !metadata.version)
    throw Error("native_package_identity_invalid");
  return { name: metadata.name, version: metadata.version, main: "entry.cjs" };
}
function prepareNativeEntry(root) {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("optionmap-e4e-runtime-") ||
      !fs.existsSync(path.join(root, "isolated-only"))) throw Error("temp_context_required");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(nativeLaunchIdentity()));
  // The existing Electron worker dispatch retains its fixed root/production/diagnostic
  // arguments. Requiring it once from a package entry changes launch identity only.
  fs.writeFileSync(path.join(root, "entry.cjs"), `require(${JSON.stringify(__filename)});\n`);
  return root;
}
async function controller(production, diagnostic = false) {
  const { spawn } = require("node:child_process"), { createInterface } = require("node:readline");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-e4e-runtime-"));
  fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
  fs.writeFileSync(path.join(root, "isolated-only"), "Disposable native preflight only\n");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let childActive = false;
  try {
    const entry = prepareNativeEntry(root);
    for (const live of production ? [false, true] : [false]) {
      let result, unsafe = false;
      const child = spawn(require("electron"), [entry, `--runtime-root=${root}`,
        ...(diagnostic ? ["--bls-diagnostic-worker"] : live ? ["--production-worker"] : [])],
        { env, stdio: ["pipe", "pipe", "pipe"] }); childActive = true;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => { process.stdout.write(line + "\n");
        try { const value = JSON.parse(line); if (value.type === "result") result = value.value; } catch (_) {} });
      child.stderr.on("data", value => { process.stderr.write(value);
        if (/quota.*reset|repair|corrupt/i.test(String(value))) { unsafe = true; child.stdin.write("STOP\n"); } });
      const code = await new Promise((resolve, reject) => { child.on("error", reject);
        child.on("close", code => { childActive = false; resolve(code); }); });
      lines.close();
      assert.equal(unsafe, false, "reset_repair_indication"); assert.equal(code, 0, result?.reason || "native_failed");
      assert.equal(result?.status, "pass", "result_handoff_missing");
      // A failed native preflight never proceeds to the production worker.
    }
  } finally {
    if (!childActive) { fs.rmSync(root, { recursive: true }); await emit("controller_cleanup", {
      tempRemoved: !fs.existsSync(root), diagnosticProcesses: 0 }); }
  }
}
if (process.versions.electron || require.main === module) {
  const root = process.argv.find(arg => arg.startsWith("--runtime-root="));
  const diagnostic = process.argv.includes("--bls-diagnostic");
  if (diagnostic && process.argv.includes("--production")) throw Error("diagnostic_production_profile_forbidden");
  (process.versions.electron && root ? process.argv.includes("--bls-diagnostic-worker") ?
    blsDiagnosticWorker(root.slice("--runtime-root=".length)) :
    worker(root.slice("--runtime-root=".length), process.argv.includes("--production-worker")) :
    controller(process.argv.includes("--production"), diagnostic))
    .catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
module.exports = Object.freeze({ installAudit, combineAudits, compactSummary, diagnoseBls, nativeLaunchIdentity, prepareNativeEntry });
