"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Execution = require("./updateExecutionCoordinator.js");
const Builder = require("./calendarCandidateBuilder.js");
const Simulator = require("./calendarTransitionSimulator.js");

const MODE = "writer_disabled", ACTIVE_SOURCE_IDS = Registry.getAcquisitionEnabledSourceIds();
const SOURCE_NAMES = Object.freeze({
  "jp-boj-calendar": "日本銀行", "jp-stat-cpi": "総務省・消費者物価指数",
  "jp-stat-labor": "総務省・労働力調査",
  "jp-esri-machinery-orders-calendar": "内閣府・機械受注",
  "jp-esri-sna-calendar": "内閣府・国民経済計算",
  "us-fed-fomc-calendar": "米連邦準備制度", "us-bls-calendar": "米労働統計局",
  "us-bea-calendar": "米経済分析局", "us-census-calendar": "米国勢調査局",
  "jp-jpx-derivatives-calendar": "日本取引所・デリバティブ",
  "jp-jpx-market-holidays": "日本取引所・休場日",
  "us-nyse-market-holidays": "ニューヨーク証券取引所"
});
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze); return Object.freeze(value);
}
function requestedSources(sourceIds) {
  if (sourceIds === undefined) return [...ACTIVE_SOURCE_IDS];
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > ACTIVE_SOURCE_IDS.length ||
      sourceIds.some(sourceId => typeof sourceId !== "string" || !Registry.isAcquisitionEnabled(sourceId)))
    return null;
  const selected = new Set(sourceIds);
  return ACTIVE_SOURCE_IDS.filter(sourceId => selected.has(sourceId));
}
function reasonClass(planned, candidate, simulation) {
  if (planned.acquisitionStatus === "failed")
    return planned.acquisition?.reason || "acquisition_failed";
  if (!candidate || candidate.candidateStatus !== "available")
    return candidate?.reason || candidate?.parserStatus || "candidate_unavailable";
  if (!simulation || simulation.simulationStatus === "rejected")
    return simulation?.diagnostics?.[0] || "preview_unavailable";
  return null;
}

function createCalendarManualCheckService(configuration = {}) {
  const acquire = configuration.acquire, builder = configuration.builder || Builder,
    simulator = configuration.simulator || Simulator, executionFactory = configuration.executionFactory ||
      (options => Execution.createUpdateExecutionCoordinator(options)), now = configuration.now ||
      (() => new Date().toISOString());
  if (typeof acquire !== "function") throw new TypeError("acquire_required");
  // Main-side factory dependency only; never read from a check/renderer request.
  function capture(planned, a, candidate, success) {
    if (typeof configuration.onAcquisition !== "function") return;
    try { configuration.onAcquisition({ sourceId: planned.sourceId,
      acquisitionOutcome: success ? "complete" : "failed", candidateEnvelope: candidate || null,
      documentHealth: (a?.documents || []).map(d => ({ role: d.role,
        httpStatus: d.httpStatus, redirectCount: d.redirects?.length || 0,
        fetchOutcome: a.success ? "success" : "failure", parseOutcome: candidate?.parserStatus || "not_attempted" })),
      diagnostics: [a?.reason, candidate?.reason, ...(candidate?.parserDiagnostics || [])].filter(Boolean),
      failedRoles: [], coverage: null, absenceAuthority: "none" }); } catch (_) { /* Observer cannot change acquisition. */ }
  }
  let active = null, logicalRequestCount = 0, joinedRequestCount = 0;

  async function execute(sourceIds, options) {
    const requestedAt = now(), acquisitions = new Map(), coordinator = executionFactory({
      acquire: async request => { const envelope = await acquire(request);
        acquisitions.set(request.sourceId, envelope); return envelope; }
    }), execution = await coordinator.requestUpdate({ trigger: "manual", ...options, requestedAt, sourceIds }),
    sources = [];
    for (const planned of execution.sourceResults) {
      const base = { sourceId: planned.sourceId, displayName: SOURCE_NAMES[planned.sourceId] ||
        planned.sourceId || "不明なsource", status: "failed", reasonClass: null,
        acquisitionStatus: planned.acquisitionStatus, candidateStatus: "not_attempted",
        transitionStatus: "not_attempted", recordCount: 0, commitOutcome: MODE };
      const statuses = [...(planned.acquisition?.diagnostics || []),
        ...(planned.acquisition?.documents || [])].map(item => item.httpStatus)
        .filter(status => Number.isInteger(status) && status >= 100 && status <= 599);
      base.lastHttpStatus = statuses.find(status => status >= 400) ?? statuses.at(-1) ?? null;
      base.planningDecision = planned.planningDecision;
      base.planningReason = planned.planningReason;
      if (planned.acquisitionStatus === "not_attempted") {
        sources.push({ ...base, status: planned.planningDecision === "skip" ? "success" : "unavailable",
          reasonClass: planned.planningReason }); continue;
      }
      if (planned.acquisitionStatus !== "succeeded") {
        capture(planned, acquisitions.get(planned.sourceId), null, false);
        sources.push({ ...base, reasonClass: reasonClass(planned) }); continue;
      }
      const candidate = await builder.buildCalendarCandidate({ sourceId: planned.sourceId,
        acquisitionResult: acquisitions.get(planned.sourceId) });
      if (candidate.formalEligible !== true) {
        capture(planned, acquisitions.get(planned.sourceId), candidate, false);
        sources.push({ ...base, candidateStatus: candidate.candidateStatus,
          reasonClass: reasonClass(planned, candidate) }); continue;
      }
      const simulation = await simulator.simulateCalendarTransition({ sourceId: planned.sourceId,
        candidate, previousState: null, coveragePolicy: null }), success =
        simulation.simulationStatus !== "rejected" && simulation.commitOutcome === MODE;
      capture(planned, acquisitions.get(planned.sourceId), candidate, success);
      sources.push({ ...base, status: success ? "success" : "failed",
        candidateStatus: candidate.candidateStatus, transitionStatus: simulation.simulationStatus,
        recordCount: candidate.recordCount, reasonClass: success ? null :
          reasonClass(planned, candidate, simulation) });
    }
    const successfulSourceCount = sources.filter(source => source.status === "success").length,
      failedSourceCount = sources.length - successfulSourceCount, state = sources.length === 0 ?
        "unavailable" : failedSourceCount === 0 ? "success" : successfulSourceCount === 0 ?
          "failed" : "partial";
    const attempted = sources.filter(source => source.acquisitionStatus !== "not_attempted").length;
    const runtimePhase = attempted ? "checked" : sources.some(source => source.planningDecision === "cooldown")
      ? "cooldown" : sources.every(source => source.planningDecision === "skip") ? "skipped" : "blocked";
    const priorTime = Object.values(options.runtimeStates || {}).map(state => state?.lastSuccessAt)
      .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return freeze({ state, runtimePhase, mode: MODE, checkedAt: attempted ? now() : priorTime,
      restored: attempted === 0, requestedSourceCount: sources.length,
      successfulSourceCount, failedSourceCount, sources: clone(sources),
      failedSourceIds: sources.filter(source => source.status !== "success").map(source => source.sourceId),
      resources: clone(execution.resources), peakSourceConcurrency:
        execution.summary.peakSourceConcurrency });
  }

  function check({ sourceIds, trigger = "manual", runtimeStates, sessionStates } = {}) {
    const selected = requestedSources(sourceIds);
    if (!selected || !["manual", "startup"].includes(trigger)) return Promise.resolve(freeze({ state: "unavailable", mode: MODE,
      checkedAt: now(), requestedSourceCount: 0, successfulSourceCount: 0, failedSourceCount: 0,
      sources: [], failedSourceIds: [], reasonClass: "source_selection_invalid" }));
    logicalRequestCount += 1;
    if (active) { joinedRequestCount += 1; return active; }
    active = execute(selected, { trigger, runtimeStates, sessionStates }).finally(() => { active = null; });
    return active;
  }
  return Object.freeze({ check, diagnostics: () => freeze({ logicalRequestCount,
    joinedRequestCount, activeRequestCount: active ? 1 : 0, mode: MODE }) });
}

module.exports = Object.freeze({ MODE, ACTIVE_SOURCE_IDS, SOURCE_NAMES,
  createCalendarManualCheckService });
