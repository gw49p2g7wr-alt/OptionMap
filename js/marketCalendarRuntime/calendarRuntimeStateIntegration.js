(function (root, factory) {
  const node = typeof module === "object" && module.exports && !root?.document;
  const api = factory(node ? require("./sourceUpdateState.js") : root.OptionMapCalendarSourceUpdateState,
    node ? require("../marketCalendar/sourceRegistry.js") : root.OptionMapMarketEventSourceRegistry,
    node ? require("./calendarManualCheckService.js").SOURCE_NAMES : null);
  if (node) module.exports = api;
  if (root) root.OptionMapCalendarRuntimeStateIntegration = api;
})(typeof window !== "undefined" ? window : globalThis, function (B1, Registry, sourceNames) {
"use strict";
const SOURCE_NAMES = sourceNames || Object.fromEntries(Object.values(Registry.SOURCES)
  .map(source => [source.sourceId, source.authority]));
const diagnosticClass = source => {
  if (B1.classifyDiagnostic(source.reasonClass)) return source.reasonClass;
  return ({ request_timeout: "timeout", network_failed: "network_failure",
    mime_rejected: "mime_mismatch" })[source.reasonClass] ||
    (source.lastHttpStatus === 404 ? "http_404" : source.lastHttpStatus >= 500 ? "http_5xx" :
      source.candidateStatus === "rejected" ? "parser_structure_change" : "security_violation");
};

// The application composes only the fixed Runtime State capability and narrow check bridge.
function createRuntimeStateIntegration({ service, store, targetEnvironment } = {}) {
  if (!["isolated_test", "browser_runtime"].includes(targetEnvironment) || !service?.check || !store?.readAll || !store?.write)
    throw new TypeError("isolated_test_configuration_required");
  let active = null, startupPromise = null;
  const sessionStates = {};
  async function execute(input) {
    const diagnostics = [];
    let existing;
    try { existing = await store.readAll(); } catch (_) { existing = { status: "unavailable" }; }
    if (existing.invalidSources?.length) diagnostics.push("runtime_state_invalid");
    if (input?.trigger === "startup" && !["ok", "absent"].includes(existing.status))
      return { state: "unavailable", mode: "writer_disabled", sources: [], failedSourceIds: [],
        runtimeStateDiagnostics: ["runtime_state_restore_failed"] };
    const result = await service.check({ ...input,
      // An isolated invalid source is blocked by B1, not silently treated as never acquired.
      runtimeStates: Object.fromEntries([...(existing.value || []).map(x => [x.sourceId, x]),
        ...(existing.invalidSources || []).filter(x => x.sourceId).map(x => [x.sourceId, {}])]),
      sessionStates: input?.trigger === "startup" ? structuredClone(sessionStates) : {} });
    if (!["ok", "absent"].includes(existing.status))
      return { ...result, runtimeStateDiagnostics: ["runtime_state_persist_failed"] };
    for (const source of result.sources || []) {
      // Labor's controlled reservation/completion is owned by the main-side authority path.
      if (source.sourceId === "jp-stat-labor" && source.runtimeStateManaged === "main_labor") continue;
      if (source.sourceId === "jp-stat-cpi" && source.runtimeStateManaged === "main_cpi") continue;
      if (source.acquisitionStatus === "not_attempted") continue;
      sessionStates[source.sourceId] = { attemptCount: (sessionStates[source.sourceId]?.attemptCount || 0) + 1 };
      const previous = existing.value?.find(x => x.sourceId === source.sourceId), success =
        source.status === "success", failureClass = success ? null : diagnosticClass(source),
        at = result.checkedAt, candidate = { sourceId: source.sourceId, lastAttemptAt: at,
          lastSuccessAt: success ? at : previous?.lastSuccessAt || null,
          lastOutcome: success ? "success" : "failure", retryAfter: success ? null :
            B1.retryAfterFor(failureClass, at), lastHttpStatus: source.lastHttpStatus ?? null,
          lastDiagnosticClass: failureClass, coordinatorVersion: 1 };
      try {
        if ((await store.write(source.sourceId, candidate)).status !== "ok")
          diagnostics.push("runtime_state_persist_failed");
      } catch (_) { diagnostics.push("runtime_state_persist_failed"); }
    }
    return { ...result, runtimeStateDiagnostics: [...new Set(diagnostics)] };
  }
  function check(input) {
    if (active) return active;
    active = execute(input).finally(() => { active = null; }); return active;
  }
  function startup() {
    if (!startupPromise) startupPromise = check({ trigger: "startup" });
    return startupPromise;
  }
  async function restore() {
    let saved;
    try { saved = await store.readAll(); } catch (_) { saved = { status: "unavailable" }; }
    const base = { mode: "writer_disabled", restored: true, sources: [], failedSourceIds: [] };
    if (saved.status === "absent") return { ...base, state: "idle" };
    if (saved.status !== "ok") return { ...base, state: "unavailable",
      runtimeStateDiagnostics: ["runtime_state_restore_failed"] };
    const sources = saved.value.filter(x => x.lastOutcome !== "none").map(x => ({
      sourceId: x.sourceId, displayName: SOURCE_NAMES[x.sourceId],
      status: x.lastOutcome === "success" ? "success" : "failed",
      reasonClass: x.lastDiagnosticClass })).concat((saved.invalidSources || []).filter(x => x.sourceId)
        .map(x => ({ sourceId: x.sourceId, displayName: SOURCE_NAMES[x.sourceId], status: "failed",
          reasonClass: "runtime_state_invalid" }))), successfulSourceCount =
        sources.filter(x => x.status === "success").length, failedSourceIds =
        sources.filter(x => x.status !== "success").map(x => x.sourceId), total = Object.keys(Registry.SOURCES).length;
    return { ...base, sources, failedSourceIds, successfulSourceCount,
      requestedSourceCount: total, failedSourceCount: failedSourceIds.length,
      state: !sources.length ? "idle" : successfulSourceCount === total ? "success" :
        successfulSourceCount ? "partial" : "failed",
      checkedAt: saved.value.map(x => x.lastAttemptAt).filter(Boolean)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null };
  }
  return Object.freeze({ check, startup, restore });
}
return Object.freeze({ createRuntimeStateIntegration });
});
