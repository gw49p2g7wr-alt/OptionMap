"use strict";

const B1 = require("./sourceUpdateState.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const { SOURCE_NAMES } = require("./calendarManualCheckService.js");
const diagnosticClass = source => {
  if (B1.classifyDiagnostic(source.reasonClass)) return source.reasonClass;
  return ({ request_timeout: "timeout", network_failed: "network_failure",
    mime_rejected: "mime_mismatch" })[source.reasonClass] ||
    (source.lastHttpStatus === 404 ? "http_404" : source.lastHttpStatus >= 500 ? "http_5xx" :
      source.candidateStatus === "rejected" ? "parser_structure_change" : "security_violation");
};

// Optional isolated composition. main/preload never instantiate this adapter in D2a.
function createRuntimeStateIntegration({ service, store, targetEnvironment } = {}) {
  if (targetEnvironment !== "isolated_test" || !service?.check || !store?.readAll || !store?.write)
    throw new TypeError("isolated_test_configuration_required");
  let active = null;
  async function execute(input) {
    const result = await service.check(input), diagnostics = [];
    let existing;
    try { existing = await store.readAll(); } catch (_) { existing = { status: "unavailable" }; }
    if (!["ok", "absent"].includes(existing.status))
      return { ...result, runtimeStateDiagnostics: ["runtime_state_persist_failed"] };
    for (const source of result.sources || []) {
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
      reasonClass: x.lastDiagnosticClass })), successfulSourceCount =
        sources.filter(x => x.status === "success").length, failedSourceIds =
        sources.filter(x => x.status !== "success").map(x => x.sourceId), total = Object.keys(Registry.SOURCES).length;
    return { ...base, sources, failedSourceIds, successfulSourceCount,
      requestedSourceCount: total, failedSourceCount: failedSourceIds.length,
      state: !sources.length ? "idle" : successfulSourceCount === total ? "success" :
        successfulSourceCount ? "partial" : "failed",
      checkedAt: saved.value.map(x => x.lastAttemptAt).filter(Boolean)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null };
  }
  return Object.freeze({ check, restore });
}
module.exports = Object.freeze({ createRuntimeStateIntegration });
