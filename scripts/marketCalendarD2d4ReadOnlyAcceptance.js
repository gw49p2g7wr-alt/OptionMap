"use strict";

// D2d4-only main-process harness. It never imports a writer, preload or app startup.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Authority = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Adapter = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const Legacy = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");

async function runFingerprintFixtures() {
  const test = require("node:test"), assert = require("node:assert/strict");
  const definition = Schema.definition(), permuted = { ...definition,
    stores: Object.fromEntries([...Object.entries(definition.stores)].reverse()) };
  const transaction = material => ({ objectStore(name) {
    const value = material.stores[name];
    return { keyPath: value.keyPath, index(indexName) {
      const [name, keyPath, unique] = value.indexes.find(i => i[0] === indexName);
      return { name, keyPath, unique };
    } };
  } });
  await test("authority definition matches the existing expected fingerprint", async () => {
    assert.equal(await Schema.fingerprint(definition), Schema.EXPECTED_FINGERPRINT);
  });
  await test("raw permuted material is rejected by the existing order-sensitive contract", async () => {
    assert.notEqual(await Schema.fingerprint(permuted), Schema.EXPECTED_FINGERPRINT);
  });
  await test("existing inspection restores authority order from permuted store inventory", async () => {
    const inspected = BootstrapSchema.inspect({ name: Schema.DATABASE_NAME, version: Schema.VERSION },
      transaction(permuted));
    assert.deepEqual(inspected, definition);
    assert.equal(await Schema.fingerprint(inspected), Schema.EXPECTED_FINGERPRINT);
  });
  await test("inspection preserves keyPath and index uniqueness mismatches", async () => {
    for (const mutation of [v => { v.stores.marketCalendarEventEntries.keyPath = "wrong"; },
      v => { v.stores.marketCalendarEventEntries.indexes[0][2] = true; }]) {
      const value = structuredClone(permuted); mutation(value);
      const inspected = BootstrapSchema.inspect({ name: Schema.DATABASE_NAME, version: Schema.VERSION },
        transaction(value));
      assert.notEqual(await Schema.fingerprint(inspected), Schema.EXPECTED_FINGERPRINT);
    }
  });
}

function sendAndConfirm(control, type, value) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => { if (settled) return; settled = true;
      clearTimeout(timer); control.off("line", onLine);
      error ? reject(error) : resolve(); };
    const onLine = line => { if (line === `ACK:${type}`) finish(); };
    const timer = setTimeout(() => finish(Error("result_handoff_timeout")), 10000);
    control.on("line", onLine);
    process.stdout.write(JSON.stringify({ type, value }) + "\n", error => {
      if (error) finish(error);
    });
  });
}
function collectIdentityAudit(snapshot, sourceResults) {
  const duplicates = values => values.length - new Set(values).size;
  const candidates = sourceResults.flatMap(r => r.canonicalRecords), semantic = new Map();
  for (const r of candidates) {
    const values = semantic.get(r.eventKey) || new Set(); values.add(r.canonicalContentHash);
    semantic.set(r.eventKey, values);
  }
  return { candidateDuplicateEventKey: duplicates(candidates.map(r => r.eventKey)),
    candidateConflictingSemantics: [...semantic.values()].filter(v => v.size > 1).length,
    candidateDuplicateRevisionIdentity: duplicates(candidates.map(r => r.revisionKey)),
    formalDuplicateActiveEventKey: duplicates(snapshot.entries.map(r => `${r.sourceId}|${r.eventKey}`)),
    formalMultipleActiveRevision: snapshot.entries.filter(e => snapshot.revisions.filter(r =>
      r.eventKey === e.eventKey && r.validTo === null).length !== 1).length };
}
async function runProbe({ preflight = false, root } = {}) {
  const { app, BrowserWindow, session } = require("electron");
  const profile = preflight ? path.join(root, "userData") : path.join(app.getPath("appData"), "OptionMap");
  if (!fs.existsSync(profile) || !fs.statSync(profile).isDirectory())
    throw Error("production_profile_absent");
  app.setPath("userData", profile);
  app.setPath("sessionData", preflight ? path.join(root, "sessionData") : profile);
  app.disableHardwareAcceleration();
  // Installed Electron defaults to app termination when the last window closes.
  // This controller owns termination until both result and cleanup are acknowledged.
  const keepAlive = () => {};
  app.on("window-all-closed", keepAlive);
  const control = require("node:readline").createInterface({ input: process.stdin });
  const watchdog = setTimeout(() => app.exit(3), 540000);
  let window, shadow, networkRequests = 0, activeRequests = 0, formal, output, exitCode = 2;
  const sequence = [];
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false,
      contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    if (preflight) {
      // Exercise the same controller without opening a database or using network.
      await new Promise(resolve => setTimeout(resolve, 25));
      output = { status: "preflight_complete", dummyComparisonComplete: true,
        productionProfileUsed: false, network: { requests: 0, activeRequests: 0 } };
      exitCode = 0;
    } else {
    formal = await window.webContents.executeJavaScript(`(async () => {
      const name = "optionMapMarketCalendarHistory", version = 1;
      const stores = ${JSON.stringify(BootstrapSchema.STORE_ORDER)}, expected = ${JSON.stringify(Schema.STORES)};
      const Schema = { STORES: expected }, inspect = (${BootstrapSchema.inspect.toString()}),
        fingerprint = (${Schema.fingerprint.toString()});
      const audit = { catalogReads: 1, opens: 0, readonly: 0, readwrite: 0, createUpgrade: 0,
        writes: 0, openHandles: 0 };
      const catalog = await indexedDB.databases(), item = catalog.find(x => x.name === name);
      if (!item) return { status: "formal_database_absent", audit };
      if (item.version !== version) return { status: "schema_version_mismatch", audit };
      let db;
      try {
        db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name); audit.opens++;
          request.onupgradeneeded = () => { audit.createUpgrade++; request.transaction.abort();
            reject(Error("upgrade_forbidden")); };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || Error("open_failed"));
          request.onblocked = () => reject(Error("open_blocked"));
        });
        audit.openHandles++;
        const schemaTx = db.transaction(Object.keys(expected), "readonly"); audit.readonly++;
        const schema = inspect(db, schemaTx);
        await new Promise((resolve, reject) => {
          schemaTx.oncomplete = resolve;
          schemaTx.onabort = () => reject(schemaTx.error || Error("schema_readonly_aborted"));
          schemaTx.onerror = () => undefined;
        });
        if (await fingerprint(schema) !== ${JSON.stringify(Schema.EXPECTED_FINGERPRINT)})
          throw Error("schema_fingerprint_mismatch");
        const tx = db.transaction(stores.map(x => x[1]), "readonly"); audit.readonly++;
        const result = await new Promise((resolve, reject) => {
          const snapshot = {};
          for (const [field, storeName] of stores) {
            const objectStore = tx.objectStore(storeName);
            const request = objectStore.getAll();
            request.onsuccess = () => { snapshot[field] = request.result; };
            request.onerror = () => reject(request.error || Error("get_all_failed"));
          }
          tx.oncomplete = () => resolve({ snapshot, schema });
          tx.onabort = () => reject(tx.error || Error("readonly_aborted"));
          tx.onerror = () => undefined;
        });
        return { status: "ok", ...result, audit };
      } catch (error) { return { status: error?.message || "readonly_failed", audit }; }
      finally { if (db) { db.close(); audit.openHandles--; } }
    })()`, true);
    if (formal.status !== "ok") throw Error(formal.status);
    const fingerprint = await Schema.fingerprint(formal.schema);
    if (fingerprint !== Schema.EXPECTED_FINGERPRINT) throw Error("schema_fingerprint_mismatch");
    const activeAudit = await Compare.compare({ formalSnapshot: formal.snapshot,
      sourceResults: Compare.SOURCE_IDS.map(sourceId => ({ sourceId, canonicalRecords: [],
        acquisitionOutcome: "not_attempted", candidateStatus: "unavailable" })) });
    if (activeAudit.status !== "compared") throw Error(activeAudit.reason || "formal_active_ambiguity");
    // Keep this window alive until comparison, result handoff and cleanup finish.
    shadow = session.fromPartition("optionmap-d2d4-memory-only");
    const fetchImpl = async (...args) => { networkRequests++; activeRequests++;
      try { return await shadow.fetch(...args); } finally { activeRequests--; } };
    const legacy = Legacy.createCalendarAcquisitionService({ fetchImpl, maxRetries: 0 });
    const adapter = Adapter.createRouteAdapter({ fetchImpl,
      getAuthority: () => Authority.PRODUCTION_AUTHORITY,
      assessmentDateJst: process.env.OPTIONMAP_D2D4_ASSESSMENT_DATE,
      legacyAcquire: legacy.acquire });
    const sourceResults = [];
    for (const sourceId of Compare.SOURCE_IDS) {
      const response = await adapter.acquire({ sourceId, operation: "source-document-set" });
      sourceResults.push({ sourceId, canonicalRecords: response.candidateEnvelope?.canonicalRecords || [],
        candidateStatus: response.candidateEnvelope?.candidateStatus || "unavailable",
        acquisitionOutcome: response.acquisitionOutcome, coverage: response.coverage,
        failedRoles: response.failedRoles || [], absenceAuthority: response.absenceAuthority,
        routeKind: response.routeKind, documentHealth: response.documentHealth.map(x => ({
          role: x.role, httpStatus: x.httpStatus, fetchOutcome: x.fetchOutcome,
          parseOutcome: x.parseOutcome })) });
    }
    const result = await Compare.compare({ sourceResults, formalSnapshot: formal.snapshot });
    output = { status: result.status, reason: result.reason, db: {
      name: formal.schema.databaseName, version: formal.schema.version, fingerprint,
      activeCount: result.totals?.formalActive ?? null },
    formalAudit: formal.audit, network: { requests: networkRequests, activeRequests },
    sources: result.summaries?.map(s => ({ ...s, routeKind: sourceResults.find(r =>
      r.sourceId === s.sourceId).routeKind })), totals: result.totals,
    identityAudit: collectIdentityAudit(formal.snapshot, sourceResults),
    alternativeParity: result.summaries?.filter(s => ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"].includes(s.sourceId))
      .map(s => ({ sourceId: s.sourceId, overlapping: s.unchanged + s.changed,
        unchanged: s.unchanged, changed: s.changed, evidenceOnly: s.evidenceOnly })),
    changed: result.differences?.filter(d => d.status === "changed"),
    new: result.differences?.filter(d => d.status === "new"),
    formalOnly: result.differences?.filter(d => d.status === "formal_only_not_evaluated"),
    evidenceOnly: result.differences?.filter(d => d.status === "unchanged" && d.provenanceChanged),
    candidateHealth: sourceResults.map(({ canonicalRecords, documentHealth, ...r }) =>
      ({ ...r, candidateCount: canonicalRecords.length, documentHealth })),
    writerReachability: 0, runtimeStateWrite: 0, marketHistoryWrite: 0, localStorageWrite: 0 };
    exitCode = result.status === "compared" &&
      formal.audit.readwrite === 0 && formal.audit.createUpgrade === 0 &&
      formal.audit.writes === 0 && activeRequests === 0 ? 0 : 2;
    }
    sequence.push("comparison_complete");
  } catch (error) {
    output = { status: "failed", reason: error?.message || "probe_failed",
      formalAudit: formal?.audit || null, networkRequests };
    sequence.push("comparison_failed");
  }
  try {
    await sendAndConfirm(control, "result", output);
    sequence.push("result_handoff_confirmed");
    if (shadow) await shadow.closeAllConnections();
    clearTimeout(watchdog);
    if (window && !window.isDestroyed()) await new Promise(resolve => {
      window.once("closed", resolve); window.close();
    });
    sequence.push("cleanup_complete");
    await sendAndConfirm(control, "cleanup", { sequence, dbHandles: formal?.audit?.openHandles || 0,
      windows: BrowserWindow.getAllWindows().length, activeRequests, watchdogTimers: 0 });
    control.close(); process.stdin.pause(); app.off("window-all-closed", keepAlive);
    app.exit(exitCode);
  } catch (error) {
    clearTimeout(watchdog);
    if (shadow) await shadow.closeAllConnections();
    if (window && !window.isDestroyed()) window.close();
    control.close(); process.stdin.pause(); app.off("window-all-closed", keepAlive);
    process.stderr.write(JSON.stringify({ status: "failed", reason: error.message }) + "\n", () => app.exit(2));
  }
}
async function launch() {
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-d2d4-entry-"));
  const preflight = process.argv.includes("--lifetime-preflight");
  try {
    if (preflight) { fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData")); }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap-d2d4-probe",
      version: "1.0.0", main: "probe.cjs" }));
    fs.writeFileSync(path.join(root, "probe.cjs"), `require(${JSON.stringify(__filename)}).runProbe(${JSON.stringify({ root, preflight })});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [root], { env, stdio: ["pipe", "pipe", "pipe"] });
    let result = null, cleanup = null, protocolFailure = null, stderr = "";
    const lines = require("node:readline").createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "result" && !result && message.value &&
            (message.value.status === "failed" || message.value.status === "rejected" && message.value.reason ||
              preflight && message.value.dummyComparisonComplete === true ||
              !preflight && message.value.db && message.value.formalAudit && message.value.totals &&
              Array.isArray(message.value.sources) && message.value.sources.length === 12 &&
              message.value.identityAudit && message.value.alternativeParity?.length === 3)) result = message.value;
        else if (message.type === "cleanup" && result && !cleanup &&
            JSON.stringify(message.value.sequence) === JSON.stringify([
              result.status === "failed" ? "comparison_failed" : "comparison_complete",
              "result_handoff_confirmed", "cleanup_complete"])) cleanup = message.value;
        else throw Error("result_protocol_invalid");
        child.stdin.write(`ACK:${message.type}\n`);
      } catch (_) { protocolFailure = "result_protocol_invalid"; child.kill("SIGTERM"); }
    });
    child.stderr.on("data", bytes => {
      stderr += bytes.toString();
      if (/resetting|quota.*reset|repair|upgrade_forbidden/i.test(stderr)) {
        protocolFailure = "reset_repair_signal"; child.kill("SIGTERM");
      }
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 550000);
    const childExit = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve(code ?? 2));
    });
    clearTimeout(timeout); lines.close();
    const delivered = result !== null && cleanup !== null && !protocolFailure;
    process.exitCode = delivered && childExit === 0 && cleanup.dbHandles === 0 &&
      cleanup.windows === 0 && cleanup.activeRequests === 0 ? 0 : 2;
    console.log(JSON.stringify({ result, cleanup, controller: { resultReceived: result !== null,
      cleanupReceived: cleanup !== null, childExit, protocolFailure,
      success: process.exitCode === 0 }, stderr }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { runProbe, runFingerprintFixtures };
if (require.main === module) (process.argv.includes("--fingerprint-fixture")
  ? runFingerprintFixtures() : launch()).catch(error => { console.error(error.message); process.exitCode = 2; });
