"use strict";

// E3a PREWRITE_ONLY harness. It never imports a writer, preload or app startup.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");
const FirstWrite = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
const Authority = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Adapter = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const Legacy = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const NetworkPolicy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");

const AUDIT_COUNTS = Object.freeze(["catalogReads", "opens", "readonly", "readwrite", "create",
  "upgrade", "createUpgrade", "writes"]);
function createCumulativeAudit() {
  return { ...Object.fromEntries(AUDIT_COUNTS.map(key => [key, 0])),
    perStoreWrites: Object.fromEntries(BootstrapSchema.STORE_ORDER.map(([, name]) => [name, 0])),
    openHandles: 0, auditComplete: true, readonlyOnly: true, stages: [] };
}
function mergeReadAudit(total, stage, observation) {
  const audit = observation?.audit;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  let valid = !!audit && AUDIT_COUNTS.every(key => count(audit[key])) && count(audit.openHandles) &&
    audit.perStoreWrites && Object.keys(audit.perStoreWrites).sort().join("|") ===
      Object.keys(total.perStoreWrites).sort().join("|");
  for (const key of AUDIT_COUNTS) {
    if (count(audit?.[key])) total[key] += audit[key];
  }
  for (const name of Object.keys(total.perStoreWrites)) {
    if (count(audit?.perStoreWrites?.[name])) total.perStoreWrites[name] += audit.perStoreWrites[name];
    else valid = false;
  }
  // Historical operation counts accumulate; handles describe resources still live now.
  if (count(audit?.openHandles)) total.openHandles += audit.openHandles;
  total.auditComplete = total.auditComplete && valid && audit?.auditComplete === true;
  total.readonlyOnly = total.readonlyOnly && valid && audit?.readonlyOnly === true &&
    audit.readwrite === 0 && audit.create === 0 && audit.upgrade === 0 && audit.createUpgrade === 0 &&
    audit.writes === 0 && Object.values(audit.perStoreWrites).every(value => value === 0);
  total.stages.push({ stage, status: observation?.status || "audit_unavailable",
    audit: audit ? structuredClone(audit) : null });
  return total;
}
function assertReadOnlyAudit(audit) {
  if (!audit.auditComplete) throw Error("cumulative_audit_incomplete");
  if (!audit.readonlyOnly) throw Error("readonly_boundary_violated");
}
function failureResult(error, stage, formalAudit, networkRequests, activeRequests, sourceResults, routeAudit) {
  return { status: "failed", reason: error?.message || "probe_failed", failureStage: stage,
    formalAudit: structuredClone(formalAudit), network: { requests: networkRequests, activeRequests },
    networkRequests, routeAudit,
    candidateHealth: sourceResults.map(r => ({ sourceId: r.sourceId,
      acquisitionOutcome: r.acquisitionOutcome, candidateStatus: r.candidateStatus,
      candidateCount: r.canonicalRecords.length, documentHealth: r.documentHealth })) };
}

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
  let stage = "electron_setup", routeAudit = [];
  const formalAudit = createCumulativeAudit();
  const sourceResults = [];
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
    const prewriteSession = FirstWrite.beginPrewrite();
    const readFormal = async readStage => {
      stage = readStage;
      let observation;
      try { observation = await window.webContents.executeJavaScript(`(async () => {
      const name = "optionMapMarketCalendarHistory", version = 1;
      const stores = ${JSON.stringify(BootstrapSchema.STORE_ORDER)}, expected = ${JSON.stringify(Schema.STORES)};
      const Schema = { STORES: expected }, inspect = (${BootstrapSchema.inspect.toString()}),
        fingerprint = (${Schema.fingerprint.toString()});
      const audit = ${JSON.stringify(createCumulativeAudit())};
      delete audit.stages;
      globalThis.__e3aFormalAudit = { stage: ${JSON.stringify(readStage)}, audit };
      let db;
      try {
        audit.catalogReads++;
        const catalog = await indexedDB.databases(), item = catalog.find(x => x.name === name);
        if (!item) return { status: "formal_database_absent", audit };
        if (item.version !== version) return { status: "schema_version_mismatch", audit };
        db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name); audit.opens++;
          request.onupgradeneeded = () => { audit.createUpgrade++; audit.upgrade++;
            audit.readonlyOnly = false; request.transaction.abort();
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
    })()`, true); }
      catch (error) {
        // Recover the reached-stage counters even when script execution rejects.
        let recovered = null;
        try {
          const reached = await window.webContents.executeJavaScript("globalThis.__e3aFormalAudit || null", true);
          if (reached?.stage === readStage) recovered = reached.audit;
        }
        catch (_) {}
        if (recovered) recovered.auditComplete = false;
        observation = { status: error?.message || "readonly_execution_failed", audit: recovered };
      }
      mergeReadAudit(formalAudit, readStage, observation);
      assertReadOnlyAudit(formalAudit);
      return observation;
    };
    formal = await readFormal("initial_formal_read");
    if (formal.status !== "ok") throw Error(formal.status);
    const fingerprint = await Schema.fingerprint(formal.schema);
    if (fingerprint !== Schema.EXPECTED_FINGERPRINT) throw Error("schema_fingerprint_mismatch");
    stage = "formal_validation";
    const activeAudit = await Compare.compare({ formalSnapshot: formal.snapshot,
      sourceResults: Compare.SOURCE_IDS.map(sourceId => ({ sourceId, canonicalRecords: [],
        acquisitionOutcome: "not_attempted", candidateStatus: "unavailable" })) });
    if (activeAudit.status !== "compared") throw Error(activeAudit.reason || "formal_active_ambiguity");
    const captured = await FirstWrite.captureFormalRead(prewriteSession, formal.snapshot, fingerprint);
    if (captured.status !== "captured") throw Error(captured.reason);
    // Keep this window alive until comparison, result handoff and cleanup finish.
    shadow = session.fromPartition("optionmap-e3a-memory-only");
    const fetchImpl = async (...args) => { networkRequests++; activeRequests++;
      try { return await shadow.fetch(...args); } finally { activeRequests--; } };
    const legacy = Legacy.createCalendarAcquisitionService({ fetchImpl, maxRetries: 0 });
    const dateParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const jst = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
    const assessmentDateJst = `${jst.year}-${jst.month}-${jst.day}`;
    const adapter = Adapter.createRouteAdapter({ fetchImpl,
      getAuthority: () => Authority.PRODUCTION_AUTHORITY,
      assessmentDateJst,
      legacyAcquire: legacy.acquire });
    for (const sourceId of Compare.SOURCE_IDS) {
      stage = `acquisition:${sourceId}`;
      const response = await adapter.acquire({ sourceId, operation: NetworkPolicy.OPERATION });
      sourceResults.push({ sourceId, canonicalRecords: response.candidateEnvelope?.canonicalRecords || [],
        candidateStatus: response.candidateEnvelope?.candidateStatus || "unavailable",
        candidateIdentity: response.candidateEnvelope?.candidateIdentity || null,
        acquisitionOutcome: response.acquisitionOutcome, coverage: response.coverage,
        failedRoles: response.failedRoles || [], absenceAuthority: response.absenceAuthority,
        routeKind: response.routeKind, routeIdentity: response.routeIdentity,
        documentHealth: response.documentHealth.map(x => ({
          role: x.role, httpStatus: x.httpStatus, fetchOutcome: x.fetchOutcome,
          parseOutcome: x.parseOutcome })) });
      if (response.acquisitionOutcome !== "complete" ||
          response.candidateEnvelope?.candidateStatus !== "available" ||
          response.failedRoles?.length ||
          !response.candidateEnvelope?.canonicalRecords?.length ||
          !response.documentHealth?.length || response.documentHealth.some(x =>
            x.fetchOutcome !== "success" || x.parseOutcome !== "success"))
        throw Error(`source_incomplete:${sourceId}`);
    }
    const endingFormal = await readFormal("ending_formal_read");
    if (endingFormal.status !== "ok") throw Error(endingFormal.status);
    stage = "precondition_validation";
    const startingPreconditionIdentity = await Gate.formalPreconditionIdentity(formal.snapshot,
      fingerprint);
    const endingPreconditionIdentity = await Gate.formalPreconditionIdentity(endingFormal.snapshot,
      fingerprint);
    if (startingPreconditionIdentity !== endingPreconditionIdentity)
      throw Error("stale_readonly_shadow");
    stage = "shadow_comparison";
    const report = await Gate.buildReadOnlyShadowReport({ formalSnapshot: formal.snapshot,
      sourceResults, schemaFingerprint: fingerprint, completedAt: new Date().toISOString(),
      startingPreconditionIdentity, endingPreconditionIdentity });
    if (report.status !== "evaluated") throw Error(report.reason || "shadow_plan_rejected");
    stage = "first_write_eligibility";
    const prewrite = await FirstWrite.completePrewrite(prewriteSession, { sourceResults,
      endingFormalSnapshot: endingFormal.snapshot, completedAt: new Date().toISOString() });
    routeAudit = prewrite.routeAudit || [];
    if (prewrite.status !== "prewrite_eligible") throw Error(prewrite.reason || "prewrite_not_ready");
    const { ticket: _privateTicket, ...prewriteReport } = prewrite;
    stage = "exact_comparison_result";
    const result = await Compare.compare({ sourceResults, formalSnapshot: formal.snapshot });
    const identityAudit = collectIdentityAudit(formal.snapshot, sourceResults);
    output = { status: result.status, reason: result.reason, db: {
      name: formal.schema.databaseName, version: formal.schema.version, fingerprint,
      activeCount: result.totals?.formalActive ?? null },
    formalAudit: structuredClone(formalAudit), routeAudit,
    network: { requests: networkRequests, activeRequests },
    assessmentDateJst, sources: report.sourceRows, totals: result.totals,
    identityAudit,
    alternativeParity: result.summaries?.filter(s => ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"].includes(s.sourceId))
      .map(s => ({ sourceId: s.sourceId, overlapping: s.unchanged + s.changed,
        unchanged: s.unchanged, changed: s.changed, evidenceOnly: s.evidenceOnly })),
    changed: result.differences?.filter(d => d.status === "changed"),
    formalOnly: result.differences?.filter(d => d.status === "formal_only_not_evaluated"),
    candidateHealth: sourceResults.map(r => ({ sourceId: r.sourceId,
      acquisitionOutcome: r.acquisitionOutcome, candidateStatus: r.candidateStatus,
      candidateCount: r.canonicalRecords.length, routeKind: r.routeKind,
      documentHealth: r.documentHealth })),
    shadow: { aggregatePlannedCounts: report.aggregatePlannedCounts,
      firstWriteCandidateEligible: report.firstWriteCandidateEligible,
      firstLiveWriteEligible: report.firstLiveWriteEligible,
      firstWrite: report.firstWrite, formalPreconditionIdentity: report.formalPreconditionIdentity,
      sourceSuccessCount: report.sourceSuccessCount, writerAuthorityState: report.writerAuthorityState,
      writerExecution: report.writerExecution },
    prewrite: prewriteReport, writerExecution: 0, runtimeStateWrite: 0, marketHistoryWrite: 0, localStorageWrite: 0 };
    exitCode = result.status === "compared" && report.sourceSuccessCount === 12 &&
      result.totals.changed === 0 && identityAudit.candidateDuplicateEventKey === 0 &&
      identityAudit.candidateConflictingSemantics === 0 &&
      identityAudit.candidateDuplicateRevisionIdentity === 0 &&
      output.formalAudit.auditComplete && output.formalAudit.readonlyOnly &&
      routeAudit.length === 12 && routeAudit.every(value => value.match) &&
      output.formalAudit.readwrite === 0 && output.formalAudit.createUpgrade === 0 &&
      output.formalAudit.writes === 0 && activeRequests === 0 &&
      report.firstLiveWriteEligible ? 0 : 2;
    }
    sequence.push("comparison_complete");
  } catch (error) {
    output = failureResult(error, stage, formalAudit, networkRequests, activeRequests, sourceResults, routeAudit);
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
    await sendAndConfirm(control, "cleanup", { sequence, dbHandles: formalAudit.openHandles,
      auditComplete: formalAudit.auditComplete, readonlyOnly: formalAudit.readonlyOnly,
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
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--prewrite-only", "--lifetime-preflight"].includes(args[0]))
    throw Error("explicit_prewrite_only_invocation_required");
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-e3a-entry-"));
  const preflight = process.argv.includes("--lifetime-preflight");
  try {
    if (preflight) { fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData")); }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap-e3a-probe",
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
              message.value.shadow?.sourceSuccessCount === 12 &&
              message.value.prewrite?.mode === "PREWRITE_ONLY" &&
              message.value.prewrite?.firstLiveWriteEligible === true &&
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
    process.exitCode = delivered && childExit === 0 && cleanup.auditComplete && cleanup.readonlyOnly &&
      (preflight || result.formalAudit?.auditComplete && result.formalAudit?.readonlyOnly) &&
      cleanup.watchdogTimers === 0 && cleanup.dbHandles === 0 &&
      cleanup.windows === 0 && cleanup.activeRequests === 0 ? 0 : 2;
    console.log(JSON.stringify({ result, cleanup, controller: { resultReceived: result !== null,
      cleanupReceived: cleanup !== null, childExit, protocolFailure,
      success: process.exitCode === 0 }, stderr }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { runProbe, runFingerprintFixtures, createCumulativeAudit, mergeReadAudit,
  assertReadOnlyAudit, failureResult };
if (require.main === module) (process.argv.includes("--fingerprint-fixture")
  ? runFingerprintFixtures() : launch()).catch(error => { console.error(error.message); process.exitCode = 2; });
