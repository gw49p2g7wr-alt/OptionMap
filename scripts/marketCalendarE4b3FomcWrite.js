"use strict";

// E4b-3 explicit one-shot harness. It never imports preload or normal app startup.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");
const FirstWrite = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js").fomc;
const Executor = require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").fomc;
const Authority = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Adapter = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const Legacy = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const NetworkPolicy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");

const { createCumulativeAudit, mergeReadAudit, assertReadOnlyAudit, failureResult } =
  require("./marketCalendarE3aPrewrite.js");

async function installStorageBoundary(probe, fixture = false) {
  return probe.executeJavaScript(`(() => {
    const audit = { opens: 0, readonly: 0, readwrite: 0, forbiddenDatabase: 0,
      forbiddenTransaction: 0, databaseDelete: 0, localStorageWrite: 0,
      runtimeStateRead: 0, runtimeStateWrite: 0, marketHistoryWrite: 0 };
    globalThis.__e3bStorageBoundary = audit;
    const allowed = ${JSON.stringify(BootstrapSchema.STORE_ORDER.map(([, name]) => name))};
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      if (args[0] !== ${JSON.stringify(Schema.DATABASE_NAME)}) {
        audit.forbiddenDatabase++; throw Error("fixed_database_required");
      }
      audit.opens++;
      const request = open(...args);
      request.addEventListener("success", () => {
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (stores, mode = "readonly", ...rest) => {
          const names = typeof stores === "string" ? [stores] : Array.from(stores);
          if (names.some(name => !allowed.includes(name)) ||
              !["readonly", "readwrite"].includes(mode) ||
              mode === "readwrite" && (!globalThis.__e3bStorageAuthorized || audit.readwrite !== 0)) {
            audit.forbiddenTransaction++; throw Error("unexpected_transaction_forbidden");
          }
          audit[mode]++;
          return transaction(stores, mode, ...rest);
        };
      });
      return request;
    };
    indexedDB.deleteDatabase = () => { audit.databaseDelete++; throw Error("database_delete_forbidden"); };
    for (const operation of ["setItem", "removeItem", "clear"]) {
      Storage.prototype[operation] = () => { audit.localStorageWrite++; throw Error("local_storage_write_forbidden"); };
    }
    return { installed: true, fixture: ${JSON.stringify(fixture)} };
  })()`, true);
}

async function runIsolatedDry(probe) {
  const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js"),
    Registry = require("../js/marketCalendar/sourceRegistry.js"),
    Fixtures = require("../test/fixtures/marketCalendar/sourceFixtures.js"),
    Transition = require("../js/marketCalendarHistory/transitionPlanner.js"),
    Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
  const empty = () => Object.fromEntries(BootstrapSchema.STORE_ORDER.map(([field]) => [field, []]));
  const records = async (sourceId, fetchedAt) => Promise.all((sourceId === FirstWrite.SOURCE_ID
    ? ["2026-01-meeting","2026-02-meeting","2026-03-meeting","2026-04-meeting","2026-05-meeting","2026-06-meeting","2026-07-meeting","2026-08-meeting","2026-09-meeting","2026-10-meeting","2026-11-meeting","2026-12-meeting","2027-01-meeting","2027-02-meeting","2027-03-meeting","2027-04-meeting","2027-05-meeting","2027-06-meeting","2027-07-meeting","2027-08-meeting","2027-09-meeting","2027-10-meeting","2027-11-meeting","2027-12-meeting"] : [null]).map(async referencePeriod => {
      const source = Registry.getSource(sourceId), response = await Canonical.canonicalize({
        ...Fixtures.record(sourceId), ...(referencePeriod ? { referencePeriod } : {}), sourceId,
        fetchedAt, rawContentHash: "a".repeat(64), parserId: source.parserId, parserVersion: source.parserVersion });
      if (!response.ok) throw Error("dry_canonical_failed");
      return response.event;
    }));
  const before = empty();
  for (const sourceId of Compare.SOURCE_IDS) {
    const canonicalSet = await records(sourceId, "2026-09-01T00:00:00.000Z"),
      run = { sourceId, runId: "dry-before", acceptedAt: "2026-09-02T00:00:00.000Z",
        fetchedAt: ["2026-09-01T00:00:00.000Z"], status: "accepted",
        semanticSetHash: await Canonical.sha256(canonicalSet.map(value => value.revisionKey).sort()) },
      mapped = Mapper.mapPlan(Transition.planTransition({ snapshot: empty(), run, canonicalSet }).plan);
    for (const [field, key] of [["entries", "appendEntries"], ["revisions", "appendRevisions"],
      ["evidence", "appendEvidence"], ["observations", "appendObservations"],
      ["runs", "appendRuns"], ["cursors", "updateCursors"]]) before[field].push(...mapped[key]);
  }
  // Creation is permitted here only in the dedicated temp profile; never the live branch.
  await probe.executeJavaScript(`new Promise((resolve, reject) => {
    const STORES = ${JSON.stringify(Schema.STORES)}, Schema = { STORES };
    Schema.createInUpgrade = (${Schema.createInUpgrade.toString()});
    const STORE_ORDER = ${JSON.stringify(BootstrapSchema.STORE_ORDER)};
    const createAndPopulate = (${BootstrapSchema.createAndPopulate.toString()});
    const request = indexedDB.open(${JSON.stringify(Schema.DATABASE_NAME)}, 1);
    request.onupgradeneeded = () => createAndPopulate(request.result, request.transaction, ${JSON.stringify(before)});
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(true); };
  })`, true);
  await installStorageBoundary(probe, true);
  const session = FirstWrite.beginPrewrite();
  await FirstWrite.captureFormalRead(session, before, Schema.EXPECTED_FINGERPRINT);
  const fetchedAt = new Date().toISOString(), sourceResults = [];
  for (const sourceId of Compare.SOURCE_IDS) sourceResults.push({ sourceId,
    canonicalRecords: await records(sourceId, fetchedAt), acquisitionOutcome: "complete",
    candidateStatus: "available", failedRoles: [], absenceAuthority: "none",
    routeIdentity: Authority.PRODUCTION_AUTHORITY.entries.find(value => value.sourceId === sourceId).routeIdentity,
    documentHealth: (sourceId === "us-bls-calendar" ? ["cpi", "ppi", "employment_situation", "jolts"] :
      ["primary"]).map(role => ({ role, fetchOutcome: "success", parseOutcome: "success" })) });
  const prewrite = await FirstWrite.completePrewrite(session, { sourceResults,
    endingFormalSnapshot: before, completedAt: new Date().toISOString() });
  if (prewrite.status !== "prewrite_eligible") throw Error(prewrite.reason || "dry_prewrite_failed");
  const auth = FirstWrite.authorizeFirstProductionWrite({ ticket: prewrite.ticket, binding: prewrite.binding }),
    execution = await Executor.executeFirstProductionWrite(probe, auth.authorization, auth.binding);
  if (execution.status !== "verified") throw Error(execution.reason || "dry_execution_failed");
  const storage = await probe.executeJavaScript("globalThis.__e3bStorageBoundary", true);
  if (storage.readwrite !== 1 || storage.opens !== 2 || storage.readonly !== 4 ||
      storage.forbiddenDatabase || storage.forbiddenTransaction || storage.localStorageWrite)
    throw Error("dry_storage_instrumentation_failed");
  return { execution, storage };
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
  let stage = "electron_setup", routeAudit = [], writeExecution = null, prewriteReport = null, storageAudit = null;
  const formalAudit = createCumulativeAudit();
  const sourceResults = [];
  const sequence = [];
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false,
      contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    if (preflight) {
      // Exercise the real core, native IndexedDB and counter wrappers in temp only.
      const dry = await runIsolatedDry(window.webContents);
      output = { status: "preflight_complete", dummyComparisonComplete: true,
        productionProfileUsed: false, dry, network: { requests: 0, activeRequests: 0 } };
      exitCode = 0;
    } else {
    await installStorageBoundary(window.webContents);
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
    shadow = session.fromPartition("optionmap-e4b3-memory-only");
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
    const { ticket: _privateTicket, ...safePrewrite } = prewrite;
    prewriteReport = safePrewrite;
    stage = "one_shot_authorization";
    const authorization = FirstWrite.authorizeFirstProductionWrite({ ticket: prewrite.ticket, binding: prewrite.binding });
    await sendAndConfirm(control, "prewrite", { sourceId: prewrite.sourceId,
      identities: prewrite.identities, expectedMutationCounts: prewrite.expectedMutationCounts,
      plannedReadwriteTransactions: 1, authorityMode: authorization.binding.authorityMode,
      productionAuthority: prewrite.writerAuthorityState });
    stage = "first_production_write";
    writeExecution = await Executor.executeFirstProductionWrite(window.webContents,
      authorization.authorization, authorization.binding);
    if (writeExecution.status !== "verified") throw Error(writeExecution.reason || "write_verification_failed");
    storageAudit = await window.webContents.executeJavaScript("globalThis.__e3bStorageBoundary", true);
    if (storageAudit.opens !== 4 || storageAudit.readonly !== 8 || storageAudit.readwrite !== 1 ||
        storageAudit.forbiddenDatabase || storageAudit.forbiddenTransaction || storageAudit.databaseDelete ||
        storageAudit.localStorageWrite) throw Error("storage_boundary_audit_mismatch");
    stage = "exact_comparison_result";
    const result = await Compare.compare({ sourceResults, formalSnapshot: formal.snapshot });
    const identityAudit = collectIdentityAudit(formal.snapshot, sourceResults);
    output = { status: "committed_verified", reason: null, db: {
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
    prewrite: prewriteReport, execution: writeExecution, storageAudit, writerExecution: 1,
    firstProductionFormalWrite: "COMMITTED", runtimeStateWrite: 0, marketHistoryWrite: 0, localStorageWrite: 0 };
    exitCode = result.status === "compared" && report.sourceSuccessCount === 12 &&
      result.totals.changed === 0 && identityAudit.candidateDuplicateEventKey === 0 &&
      identityAudit.candidateConflictingSemantics === 0 &&
      identityAudit.candidateDuplicateRevisionIdentity === 0 &&
      output.formalAudit.auditComplete && output.formalAudit.readonlyOnly &&
      routeAudit.length === 12 && routeAudit.every(value => value.match) &&
      output.formalAudit.readwrite === 0 && output.formalAudit.createUpgrade === 0 &&
      output.formalAudit.writes === 0 && activeRequests === 0 &&
      report.firstLiveWriteEligible && writeExecution.status === "verified" &&
      writeExecution.audit.readwrite === 1 && writeExecution.audit.committed === 1 &&
      writeExecution.audit.aborted === 0 && writeExecution.audit.openHandles === 0 ? 0 : 2;
    }
    sequence.push("comparison_complete");
  } catch (error) {
    try { storageAudit = await window?.webContents.executeJavaScript("globalThis.__e3bStorageBoundary || null", true); }
    catch (_) {}
    output = { ...failureResult(error, stage, formalAudit, networkRequests, activeRequests, sourceResults, routeAudit),
      execution: writeExecution, prewrite: prewriteReport, storageAudit,
      firstProductionFormalWrite: writeExecution?.committed ? "COMMITTED" : "NOT_COMMITTED",
      runtimeStateWrite: 0, marketHistoryWrite: 0, localStorageWrite: 0 };
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
    await sendAndConfirm(control, "cleanup", { sequence, dbHandles: formalAudit.openHandles + (writeExecution?.audit?.openHandles || 0),
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
  if (args.length !== 1 || !["--execute-fomc-write", "--lifetime-preflight"].includes(args[0]))
    throw Error("explicit_e4b3_one_shot_invocation_required");
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-e4b3-entry-"));
  const preflight = process.argv.includes("--lifetime-preflight");
  try {
    if (preflight) { fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData")); }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap-e4b3-probe",
      version: "1.0.0", main: "probe.cjs" }));
    fs.writeFileSync(path.join(root, "probe.cjs"), `require(${JSON.stringify(__filename)}).runProbe(${JSON.stringify({ root, preflight })});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [root], { env, stdio: ["pipe", "pipe", "pipe"] });
    let result = null, cleanup = null, prewriteSummary = null, protocolFailure = null, stderr = "";
    const lines = require("node:readline").createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.type === "prewrite" && !preflight && !prewriteSummary && !result &&
            message.value?.sourceId === FirstWrite.SOURCE_ID &&
            message.value?.plannedReadwriteTransactions === 1 &&
            message.value?.productionAuthority === "disabled" &&
            message.value?.authorityMode === "E4b3_fomc_explicit_one_shot" &&
            JSON.stringify(message.value.expectedMutationCounts) === JSON.stringify(FirstWrite.EXPECTED_COUNTS)) {
          prewriteSummary = message.value;
          console.log(JSON.stringify({ prewriteSummary }));
        }
        else if (message.type === "result" && !result && message.value &&
            (message.value.status === "failed" || message.value.status === "rejected" && message.value.reason ||
              preflight && message.value.dummyComparisonComplete === true ||
              !preflight && message.value.db && message.value.formalAudit && message.value.totals &&
              Array.isArray(message.value.sources) && message.value.sources.length === 12 &&
              message.value.shadow?.sourceSuccessCount === 12 &&
              message.value.prewrite?.mode === "PREWRITE_ONLY" &&
              message.value.prewrite?.firstLiveWriteEligible === true &&
              message.value.identityAudit && message.value.alternativeParity?.length === 3 &&
              prewriteSummary && message.value.execution?.verification?.valid === true)) result = message.value;
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
    console.log(JSON.stringify({ result, cleanup, prewriteSummary, controller: { resultReceived: result !== null,
      cleanupReceived: cleanup !== null, childExit, protocolFailure,
      success: process.exitCode === 0 }, stderr }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { runProbe };
if (require.main === module) launch().catch(error => { console.error(error.message); process.exitCode = 2; });
