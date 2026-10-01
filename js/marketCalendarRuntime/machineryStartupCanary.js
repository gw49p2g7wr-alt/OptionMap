"use strict";

// Dedicated main-owned startup adapter. No check(request), renderer token or manual issuer.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const Auth = require("../marketCalendarHistory/formalWriterAuthorizationV2.js");
const E = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Store = require("../marketCalendarHistory/writerSafetyCanaryStore.js");
const Core = require("../marketCalendarHistory/formalControlledWriterCore.js");
const Boundary = require("../marketCalendarHistory/firstProductionWriteBoundary.js");
const Executor = require("../marketCalendarHistory/firstProductionWriteExecutor.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../marketCalendarHistory/bootstrapSchemaV1.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Shadow = require("./automaticFormalShadow.js"), Runtime = require("./automaticFormalShadowRuntime.js");
const Reader = require("./formalShadowElectronRead.js"), Safety = require("./automaticFormalSafetyRuntime.js");
const Integration = require("./calendarRuntimeStateIntegration.js");
const Routes = require("./calendarRouteAuthority.js"), Network = require("./calendarNetworkPolicy.js");
const executions = new WeakMap();
function consumeExecution(token) {
  const value = executions.get(token); executions.delete(token); return value || null;
}
function genericStore(wc) {
  const code = ["../marketCalendar/sourceRegistry.js", "./sourceUpdateState.js", "../storage/marketCalendarRuntimeStateStore.js"]
    .map(p => fs.readFileSync(path.resolve(__dirname, p), "utf8")).join("\n");
  const call = (method, args) => wc.executeJavaScriptInIsolatedWorld(1742, [{ code: `(async () => { ${code}\n
    const s = window.OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({ indexedDB, targetEnvironment: 'browser_runtime' });
    return s.${method}(...${JSON.stringify(args)}); })()` }]);
  return { readAll: () => call("readAll", []), write: (id, record) => call("write", [id, record]) };
}
function nativeProgram(context) {
  const source = fs.readFileSync(require.resolve("../marketCalendarHistory/formalControlledWriterCore.js"), "utf8");
  return `(async () => {
    const Schema = ${JSON.stringify({ STORES: Schema.STORES, EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT })};
    const stable = (${Canonical.stable.toString()}), module = { exports: {} };
    const deps = { './productionSchemaV1.js': Schema, './bootstrapSchemaV1.js': { STORE_ORDER: ${JSON.stringify(Bootstrap.STORE_ORDER)} },
      '../marketCalendar/marketEventCanonicalizer.js': { stable } };
    ((module, require) => { ${source}\n })(module, key => { if (!Object.hasOwn(deps, key)) throw Error('unexpected_core_dependency'); return deps[key]; });
    return (${Executor.machineryCanaryExecutionSource})(${JSON.stringify(context)}, module.exports, Schema,
      (${Bootstrap.inspect.toString()}), (${Schema.fingerprint.toString()}), ${JSON.stringify(E.SOURCE)}, 'E4f_startup_canary', ${JSON.stringify(E.COUNTS)});
  })()`;
}
async function prepare(source, before, safety, wc) {
  const planningStart = performance.now();
  before = Core.sorted(before);
  const shadow = await Shadow.evaluate({ sourceResults: [source], before, schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  const row = shadow.sourceRows?.find(r => r.sourceId === E.SOURCE), plan = shadow.plans?.find(p => p.sourceId === E.SOURCE);
  if (shadow.status !== "evaluated" || !row?.eligible || row.candidate !== 4 || row.formalActive !== 4 || row.unchanged !== 4 ||
    row.changed !== 0 || row.new !== 0 || row.evidenceOnly !== 0 || row.notEvaluated !== 0) throw Error("machinery_contract_mismatch");
  const validation = await Boundary.validateFirstWritePlan(plan, before);
  if (!validation.valid) throw Error(validation.reason);
  const ceiling = Boundary.MUTATION_CEILING, expectedAfter = Core.applyToMemory(before, plan, Core.expectedWrites(plan, before));
  Core.prepareExecution(plan, before, ceiling); // All expensive material is prepared before persistence/transaction.
  if (!await Shadow.integrity(expectedAfter) || Core.STORE_ORDER.some(([field]) => !Core.same(
    before[field].filter(r => r.sourceId !== E.SOURCE), expectedAfter[field].filter(r => r.sourceId !== E.SOURCE))))
    throw Error("other_source_mutation");
  const selected = Routes.selectRoute({ sourceId: E.SOURCE, operation: Network.OPERATION }, Routes.PRODUCTION_AUTHORITY);
  if (!selected.valid || selected.routeIdentity !== source.routeIdentity) throw Error("route_identity_mismatch");
  const cycleIdentity = A.hash({ cycle: randomUUID() }), attemptIdentity = A.hash({ attempt: randomUUID() });
  const context = A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity });
  const input = { policy: E.policyFor(3), safety: E.safetyInput(safety), sourceId: E.SOURCE, operation: "startup", context, cycleIdentity,
    acquisition: { outcome: source.acquisitionOutcome, failedRoles: source.failedRoles }, routeIdentity: source.routeIdentity,
    expectedRouteIdentity: selected.routeIdentity, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, integrityValid: true,
    changed: 0, planValid: true, revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: plan.acquisitionIdentity,
    candidateIdentity: plan.candidateSetIdentity, comparisonIdentity: plan.comparisonIdentity,
    formalPrecondition: plan.preconditionIdentity, planIdentity: plan.planIdentity, mutationCeiling: E.COUNTS };
  const issued = Auth.issueAuthorizationCandidate(input); if (!issued.valid) throw Error(issued.reason);
  const program = nativeProgram({ binding: { databaseName: Schema.DATABASE_NAME, sourceId: E.SOURCE,
    invocationId: attemptIdentity, authorityMode: "E4f_startup_canary", plannedReadwriteTransactions: 1,
    identities: { schemaFingerprint: Schema.EXPECTED_FINGERPRINT, plan: plan.planIdentity }, exactMutationCeiling: ceiling },
    before, plan, expectedAfter, expiresAt: Date.now() + 5 * 60 * 1000 });
  const capability = Object.freeze(Object.create(null));
  executions.set(capability, { input, authorization: issued.authorization, run: async () => {
    let result;
    try { result = await wc.executeJavaScript(program, true); }
    catch (_) { let reached; try { reached = await wc.executeJavaScript("globalThis.__e3bExecution || null", true); } catch (_) {}
      result = { ...reached, status: "failed", reason: "commit_ambiguous" }; }
    const valid = result?.status === "verified" && result?.readback && Core.same(Core.sorted(result.readback), expectedAfter) &&
      await Shadow.integrity(result.readback);
    const verification = { valid: !!valid, expectedIdentity: await Canonical.sha256(expectedAfter),
      observedIdentity: result?.readback ? await Canonical.sha256(Core.sorted(result.readback)) : null };
    const { readback: _, ...compact } = result || {}; return { ...compact, verification };
  } });
  return { capability, row, planCounts: plan.counts, planningMs: performance.now() - planningStart,
    identities: { acquisition: plan.acquisitionIdentity, candidate: plan.candidateSetIdentity, comparison: plan.comparisonIdentity,
      plan: plan.planIdentity, precondition: plan.preconditionIdentity }, beforeCounts: Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f, before[f].length])) };
}
function build({ wc, safetyStore, runtimeStateStore, runtimeOptions = {} }) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  let started = false;
  return Object.freeze({ startup: async () => {
    if (started) return { status: "fail", reason: "startup_attempt_consumed" }; started = true;
    let loaded, runtime, acquired, prepared;
    const timings = {}, sourceResults = [];
    try {
      const start = performance.now(); loaded = safetyStore.load(); timings.safetyLoadMs = performance.now() - start;
      if (!loaded.available || loaded.record?.schemaVersion !== 2 || loaded.record.safety.persistedAuthorityVersion !== 3 ||
        loaded.record.safety.pendingFence || loaded.record.safety.globalSuspend.suspended || loaded.record.safety.sources.some(s => s.suspended))
        throw Error(loaded.reason || "safety_not_ready");
      const token = Safety.createStartupContext();
      runtime = Runtime.createRuntime({ ...runtimeOptions, webContents: wc,
        loadSafety: () => ({ status: "valid", safety: E.safetyInput(loaded.record.safety) }),
        onCanonicalAcquisition: s => sourceResults.push(s) });
      const integration = Integration.createRuntimeStateIntegration({ service: { check: request => runtime.checkStartup(request, token) },
        store: runtimeStateStore, targetEnvironment: "browser_runtime" });
      const acquisitionStart = performance.now(); acquired = await integration.startup(); timings.acquisitionMs = performance.now() - acquisitionStart;
      const own = acquired.sources?.find(s => s.sourceId === E.SOURCE);
      if (own?.planningDecision === "skip" && own.planningReason === "already_succeeded_today" && own.acquisitionStatus === "not_attempted")
        return { status: "hold", reason: "same_day_skip", acquisition: acquired, timings, diagnostics: runtime.diagnostics(), writerExecution: 0 };
      const source = sourceResults.find(s => s.sourceId === E.SOURCE);
      if (!source || source.acquisitionOutcome !== "complete" || own?.status !== "success") throw Error("fresh_startup_required");
      if (acquired.sources?.some(s => s.status !== "success")) throw Error("startup_acquisition_incomplete");
      const readStart = performance.now(), formal = await Reader.createReader(wc)(); timings.formalReadMs = performance.now() - readStart;
      if (formal.status !== "ok") throw Error(formal.reason);
      prepared = await prepare(source, formal.snapshot, loaded.record.safety, wc); timings.planningMs = prepared.planningMs;
      const execution = await safetyStore.execute(prepared.capability);
      return { status: execution.saved ? "pass" : "fail", reason: execution.reason || null, execution,
        acquisition: acquired, timings, fresh: { row: prepared.row, counts: prepared.planCounts, identities: prepared.identities,
          beforeCounts: prepared.beforeCounts }, diagnostics: runtime.diagnostics(), writerExecution: execution.result?.audit?.readwrite || 0 };
    } catch (e) { return { status: "fail", reason: /^[a-z_]+$/.test(e.message) ? e.message : "canary_failed", acquisition: acquired || null,
      diagnostics: runtime?.diagnostics() || null, timings, writerExecution: 0 }; }
  } });
}
function createProductionCanary(wc) {
  const store = Store.createProductionStore();
  let requests = 0, pending = 0;
  const controller = build({ wc, safetyStore: store, runtimeStateStore: genericStore(wc),
    runtimeOptions: { fetchImpl: async (url, options) => {
      requests++; pending++;
      try { return await require("electron").net.fetch(url, options); } finally { pending--; }
    } } });
  return Object.freeze({ ...controller, close: store.close, audit: () => ({ ...store.audit(), transportRequests: requests, pendingTransports: pending }) });
}
function createIsolatedCanary({ root, wc, runtimeStateStore, runtimeOptions }) {
  const store = Store.createIsolatedStore(root), controller = build({ wc, safetyStore: store, runtimeStateStore, runtimeOptions });
  return Object.freeze({ ...controller, close: store.close, audit: store.audit });
}
module.exports = Object.freeze({ createProductionCanary, createIsolatedCanary, consumeExecution, genericStore });
