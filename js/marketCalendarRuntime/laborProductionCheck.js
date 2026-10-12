"use strict";
const Authority = require("./calendarRouteAuthority.js");
const Adapter = require("./calendarRouteAdapter.js");
const Policy = require("./routeReevaluationPolicy.js");
const Continuation = require("./activeRouteContinuation.js");
const Flights = require("./sourceSingleFlight.js");
const Manual = require("./calendarManualCheckService.js");
const Contracts = require("./normalAcquisitionContract.js");
const ID = "jp-stat-labor", EXCLUDED = ["jp-stat-cpi", "us-bls-calendar"];
function createLaborProductionCheck({ store, legacyService, fetchImpl, now = () => new Date().toISOString(),
  getAuthority = () => Authority.PRODUCTION_AUTHORITY, adapterFactory = Adapter.createRouteAdapter,
  onAcquisition, acquisitionContract } = {}) {
  const activeSourceIds = Contracts.resolve(acquisitionContract);
  if (!store?.read || !store?.reserveReevaluation || !store?.completeReevaluation || !legacyService?.check ||
      typeof fetchImpl !== "function") throw TypeError("labor_configuration_invalid");
  let active = null;
  let startupAttempts = 0;
  const audit = [];
  const record = entry => { audit.push(entry); if (audit.length > 12) audit.shift(); };
  const base = { sourceId: ID, displayName: Manual.SOURCE_NAMES[ID], status: "unavailable",
    acquisitionStatus: "not_attempted", candidateStatus: "not_attempted", transitionStatus: "not_attempted",
    recordCount: 0, commitOutcome: "writer_disabled", runtimeStateManaged: "main_labor", lastHttpStatus: null };
  async function labor(trigger) {
    const old = await store.read();
    record({ phase: "read", record: old.value || null, status: old.status });
    if (old.status !== "ok" || !old.value) return { ...base, reasonClass: "runtime_state_invalid" };
    const authority = getAuthority();
    const plan = Continuation.plan({ sourceId: ID, state: old.value, authority, trigger,
      requestedAt: now(), attemptCount: startupAttempts });
    const { decision, selected } = plan;
    record({ phase: "decision", decision, acquisitionMode: plan.mode, routeIdentity: selected.routeIdentity });
    if (decision.decision === "skip") return { ...base, status: "success", planningDecision: "skip",
      acquisitionMode: "skip", reasonClass: decision.reason, lastCheckedAt: old.value.lastSuccessAt };
    if (!plan.acquire) return { ...base, planningDecision: decision.decision,
      acquisitionMode: plan.mode, reasonClass: decision.reason };
    const flight = await Flights.runSourceFlight({ sourceId: ID, operation: Flights.OPERATION,
      acquisitionPolicyIdentity: { routeIdentity: selected.routeIdentity, activationVersion: selected.activationVersion },
      execute: async () => {
        const normal = plan.mode === "normal_active_route";
        const reserved = normal ? { state: old.value } :
          await store.reserveReevaluation({ sourceId: ID, requestedAt: now() });
        if (!normal) record({ phase: "reservation", result: reserved });
        if (!normal && !reserved.networkEligible) return { ...base, acquisitionMode: plan.mode,
          planningDecision: decision.decision, reasonClass: reserved.reason };
        const current = Authority.selectRoute({ sourceId: ID, operation: Flights.OPERATION }, getAuthority());
        if (!current.valid || !current.acquisitionAllowed || !Policy.sameBinding(Policy.binding(current), reserved.state.routeBinding))
          return { ...base, reasonClass: "stale_route_result" };
        const at = now(), dateJst = new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10);
        if (trigger === "startup") startupAttempts++;
        const transport = [];
        const adapter = adapterFactory({ fetchImpl: async (url, options) => {
          const response = await fetchImpl(url, options);
          transport.push({ httpStatus: response.status, contentType: response.headers.get("content-type"),
            redirect: response.status >= 300 && response.status < 400 });
          return response;
        }, getAuthority: () => authority, assessmentDateJst: dateJst });
        let result;
        try { result = await adapter.acquire({ sourceId: ID, operation: Flights.OPERATION }); }
        catch (_) { result = { acquisitionOutcome: "failed", diagnostics: ["network_failure"] }; }
        const candidate = result.candidateEnvelope, http = result.documentHealth?.[0]?.httpStatus ?? transport.at(-1)?.httpStatus ?? null;
        const success = result.acquisitionOutcome === "complete" && candidate?.formalEligible === true &&
          candidate.recordCount > 0 && candidate.parserStatus === "success" &&
          candidate.canonicalDiagnostics.length === 0 && result.coverage?.coverageState === "sufficient";
        const diagnostic = success ? null : http === 404 ? "http_404" : http >= 500 ? "http_5xx" :
          result.diagnostics?.includes("request_timeout") ? "timeout" :
          result.diagnostics?.some(x => /mime/.test(x)) ? "mime_mismatch" :
          result.diagnostics?.some(x => /security|redirect|url|credential|path|byte|encoding|utf8/.test(x)) ? "security_violation" :
          result.acquisitionOutcome !== "complete" ? "network_failure" : "parser_structure_change";
        const completion = { completedAt: now(), result: { lastAttemptAt: at,
          lastOutcome: success ? "success" : "failure", lastHttpStatus: http, lastDiagnosticClass: diagnostic } };
        const completed = normal ? await store.completeActiveAcquisition({ ...completion, sourceId: ID,
          expectedState: old.value }) : await store.completeReevaluation({ ...completion, token: reserved.token });
        try { onAcquisition?.({ ...result, sourceId: ID, acquisitionOutcome:
          success && completed.status === "ok" ? "complete" : result.acquisitionOutcome === "partial" ? "partial" : "failed" }); }
        catch (_) { /* Shadow capture cannot affect completion or the public result. */ }
        record({ phase: "acquisition", transport, acquisitionOutcome: result.acquisitionOutcome,
          documentHealth: result.documentHealth, coverage: result.coverage, absenceAuthority: result.absenceAuthority,
          candidate: candidate ? { parserStatus: candidate.parserStatus, recordCount: candidate.recordCount,
            formalEligible: candidate.formalEligible, canonicalDiagnostics: candidate.canonicalDiagnostics } : null,
          resources: adapter.diagnostics?.() || null });
        record({ phase: normal ? "normal_completion" : "completion", result: completed });
        return { ...base, status: success && completed.status === "ok" ? "success" : "failed",
          acquisitionStatus: success ? "succeeded" : "failed", candidateStatus: candidate?.candidateStatus || "unavailable",
          recordCount: candidate?.recordCount || 0, lastHttpStatus: http, acquisitionMode: plan.mode,
          planningDecision: normal ? decision.decision : "approved_reevaluation",
          reasonClass: completed.status !== "ok" ? completed.reason : diagnostic };
      } });
    return flight.executionOutcome || { ...base, reasonClass: "flight_failed" };
  }
  async function execute(request) {
    const ids = request.sourceIds || activeSourceIds;
    const selected = Authority.selectRoute({ sourceId: ID, operation: Flights.OPERATION }, getAuthority());
    if (selected.valid && selected.routeKind === "legacy") return legacyService.check(request);
    const legacyIds = ids.filter(id => id !== ID && !EXCLUDED.includes(id));
    const legacy = legacyIds.length ? await legacyService.check({ ...request, sourceIds: legacyIds }) : { sources: [] };
    const l = ids.includes(ID) ? await labor(request.trigger || "manual") : null;
    const sources = ids.map(id => id === ID ? l : EXCLUDED.includes(id) ? {
      sourceId: id, displayName: Manual.SOURCE_NAMES[id], status: "unavailable", acquisitionStatus: "not_attempted",
      reasonClass: "controlled_activation_out_of_scope", commitOutcome: "writer_disabled"
    } : legacy.sources.find(s => s.sourceId === id)).filter(Boolean);
    const successfulSourceCount = sources.filter(s => s.status === "success").length;
    const checkedAt = sources.some(s => s.acquisitionStatus !== "not_attempted") ? now() :
      [legacy.checkedAt, l?.lastCheckedAt].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return { ...legacy, mode: "writer_disabled", sources, checkedAt, laborAudit: structuredClone(audit),
      requestedSourceCount: sources.length, successfulSourceCount, failedSourceCount: sources.length - successfulSourceCount,
      failedSourceIds: sources.filter(s => s.status !== "success").map(s => s.sourceId),
      state: successfulSourceCount === sources.length ? "success" : successfulSourceCount ? "partial" : "failed" };
  }
  function check(request = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).some(k => !["sourceIds", "trigger", "runtimeStates", "sessionStates"].includes(k)) ||
        request.trigger !== undefined && !["startup", "manual"].includes(request.trigger) ||
        request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) || !request.sourceIds.length ||
          request.sourceIds.some(id => !activeSourceIds.includes(id))))
      return Promise.resolve({ state: "unavailable", sources: [], reasonClass: "invalid_argument", mode: "writer_disabled" });
    if (active) return active;
    active = execute(structuredClone(request)).finally(() => { active = null; }); return active;
  }
  return Object.freeze({ check, diagnostics: () => structuredClone(audit) });
}
module.exports = Object.freeze({ ID, EXCLUDED, createLaborProductionCheck });
