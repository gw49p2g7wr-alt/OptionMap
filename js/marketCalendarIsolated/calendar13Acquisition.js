"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Adapter = require("../marketCalendarRuntime/calendarRouteAdapter.js");
const Routes = require("../marketCalendarRuntime/calendarRouteAuthority.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Automatic = require("../marketCalendarRuntime/automaticFormalShadow.js");
const Policy = require("../marketCalendarRuntime/updatePolicy.js").createIsolated13Policy();
const State = require("../marketCalendarRuntime/sourceUpdateState.js");
const Mof = require("./mofJgbVariableAdapter.js");
const ENABLEMENT = Mof.ENABLEMENT, SOURCE_IDS = Registry.getSourceSet(2).sourceIds;
const formalAbsent = { databaseStatus: "absent", sourceCursorStatus: "absent", lastAcceptedAt: null,
  schemaStatus: "compatible", securityStatus: "clear" };
function diagnostic(source) {
  const reason = source.reason || source.diagnostics?.[0] || "";
  if (/timeout/.test(reason)) return "timeout";
  if (/http_status/.test(reason)) return source.documentHealth.at(-1)?.httpStatus === 404 ? "http_404" : "network_failure";
  if (/network/.test(reason)) return "network_failure";
  if (/mime/.test(reason)) return "mime_mismatch";
  if (/parser|auction|month_heading/.test(reason)) return "parser_structure_change";
  return "security_violation";
}
function create({ enablement, fetchImpl, store, now = () => new Date().toISOString(), onRequest = () => {} } = {}) {
  if (enablement !== ENABLEMENT || typeof fetchImpl !== "function" || !store?.read || !store?.write)
    throw TypeError("isolated13_configuration_required");
  let active = 0, peak = 0;
  async function acquireOne(sourceId, assessmentDateJst, requestedAt) {
    const prior = await store.read(sourceId);
    if (!["ok", "absent"].includes(prior.status)) throw Error("isolated_state_unavailable");
    const decision = Policy.evaluateSourceUpdate({ sourceId, trigger: "startup", requestedAt,
      formalState: formalAbsent, runtimeState: prior.value, sessionState: { attemptCount: 0 } });
    const empty = { sourceId, acquisitionOutcome: "not_attempted", candidateStatus: "unavailable", canonicalRecords: [],
      candidateIdentity: null, documentHealth: [], failedRoles: [], absenceAuthority: "none" };
    if (!decision.eligible) return { ...empty, reason: decision.reason, requestCount: 0, elapsedMs: 0 };
    active++; peak = Math.max(peak, active);
    let requests = 0, result; const start = performance.now();
    const transport = (url, options) => { requests++; onRequest(sourceId, url); return fetchImpl(url, options); };
    try {
      if (sourceId === Mof.SOURCE_ID) {
        const adapter = Mof.create({ enablement, fetchImpl: transport });
        result = { ...await adapter.acquire({ sourceId, assessmentDateJst }), resourceAudit: adapter.diagnostics() };
      }
      else {
        const adapter = Adapter.createRouteAdapter({ fetchImpl: transport, assessmentDateJst,
          getAuthority: () => Routes.PRODUCTION_AUTHORITY });
        const envelope = await adapter.acquire({ sourceId, operation: Network.OPERATION });
        result = { ...Automatic.projectAcquisition(envelope), diagnostics: envelope.diagnostics,
          reason: envelope.diagnostics[0] || null, resourceAudit: adapter.diagnostics() };
      }
      const success = result.acquisitionOutcome === "complete" && result.candidateStatus === "available" && !result.failedRoles.length;
      const failureClass = success ? null : diagnostic(result), state = { sourceId, lastAttemptAt: requestedAt,
        lastSuccessAt: success ? requestedAt : prior.value?.lastSuccessAt || null, lastOutcome: success ? "success" : "failure",
        retryAfter: success ? null : State.retryAfterFor(failureClass, requestedAt),
        lastHttpStatus: result.documentHealth.at(-1)?.httpStatus ?? null, lastDiagnosticClass: failureClass, coordinatorVersion: 1 };
      if ((await store.write(sourceId, state)).status !== "ok") throw Error("isolated_state_persist_failed");
      return { ...result, requestCount: requests, elapsedMs: performance.now() - start, diagnosticClass: failureClass };
    } finally { active--; }
  }
  async function cycle() {
    const requestedAt = now(), date = new Date(Date.parse(requestedAt) + 540 * 60000).toISOString().slice(0, 10);
    const result = new Array(SOURCE_IDS.length); let next = 0; peak = 0;
    async function runner() { while (next < SOURCE_IDS.length) { const i = next++; result[i] = await acquireOne(SOURCE_IDS[i], date, requestedAt); } }
    await Promise.all(Array.from({ length: 3 }, runner));
    return { sourceResults: result, sourceConcurrency: peak, requestedAt, requests: result.reduce((n, s) => n + s.requestCount, 0),
      writerExecution: 0, productionAccess: 0, stateAudit: store.diagnostics() };
  }
  return Object.freeze({ cycle, acquireOne, diagnostics: () => ({ activeTasks: active, peakSourceConcurrency: peak }) });
}
module.exports = Object.freeze({ ENABLEMENT, SOURCE_IDS, create, diagnostic });
