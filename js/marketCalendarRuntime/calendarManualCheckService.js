"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Execution = require("./updateExecutionCoordinator.js");
const Builder = require("./calendarCandidateBuilder.js");
const Simulator = require("./calendarTransitionSimulator.js");

const MODE = "writer_disabled", ACTIVE_SOURCE_IDS = Object.freeze(Object.keys(Registry.SOURCES));
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
      sourceIds.some(sourceId => typeof sourceId !== "string" || !Registry.SOURCES[sourceId]))
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
  let active = null, logicalRequestCount = 0, joinedRequestCount = 0;

  async function execute(sourceIds) {
    const requestedAt = now(), acquisitions = new Map(), coordinator = executionFactory({
      acquire: async request => { const envelope = await acquire(request);
        acquisitions.set(request.sourceId, envelope); return envelope; }
    }), execution = await coordinator.requestUpdate({ trigger: "manual", requestedAt, sourceIds }),
    sources = [];
    for (const planned of execution.sourceResults) {
      const base = { sourceId: planned.sourceId, displayName: SOURCE_NAMES[planned.sourceId] ||
        planned.sourceId || "不明なsource", status: "failed", reasonClass: null,
        acquisitionStatus: planned.acquisitionStatus, candidateStatus: "not_attempted",
        transitionStatus: "not_attempted", recordCount: 0, commitOutcome: MODE };
      if (planned.acquisitionStatus !== "succeeded") {
        sources.push({ ...base, reasonClass: reasonClass(planned) }); continue;
      }
      const candidate = await builder.buildCalendarCandidate({ sourceId: planned.sourceId,
        acquisitionResult: acquisitions.get(planned.sourceId) });
      if (candidate.formalEligible !== true) {
        sources.push({ ...base, candidateStatus: candidate.candidateStatus,
          reasonClass: reasonClass(planned, candidate) }); continue;
      }
      const simulation = await simulator.simulateCalendarTransition({ sourceId: planned.sourceId,
        candidate, previousState: null, coveragePolicy: null }), success =
        simulation.simulationStatus !== "rejected" && simulation.commitOutcome === MODE;
      sources.push({ ...base, status: success ? "success" : "failed",
        candidateStatus: candidate.candidateStatus, transitionStatus: simulation.simulationStatus,
        recordCount: candidate.recordCount, reasonClass: success ? null :
          reasonClass(planned, candidate, simulation) });
    }
    const successfulSourceCount = sources.filter(source => source.status === "success").length,
      failedSourceCount = sources.length - successfulSourceCount, state = sources.length === 0 ?
        "unavailable" : failedSourceCount === 0 ? "success" : successfulSourceCount === 0 ?
          "failed" : "partial";
    return freeze({ state, mode: MODE, checkedAt: now(), requestedSourceCount: sources.length,
      successfulSourceCount, failedSourceCount, sources: clone(sources),
      failedSourceIds: sources.filter(source => source.status !== "success").map(source => source.sourceId),
      resources: clone(execution.resources), peakSourceConcurrency:
        execution.summary.peakSourceConcurrency });
  }

  function check({ sourceIds } = {}) {
    const selected = requestedSources(sourceIds);
    if (!selected) return Promise.resolve(freeze({ state: "unavailable", mode: MODE,
      checkedAt: now(), requestedSourceCount: 0, successfulSourceCount: 0, failedSourceCount: 0,
      sources: [], failedSourceIds: [], reasonClass: "source_selection_invalid" }));
    logicalRequestCount += 1;
    if (active) { joinedRequestCount += 1; return active; }
    active = execute(selected).finally(() => { active = null; });
    return active;
  }
  return Object.freeze({ check, diagnostics: () => freeze({ logicalRequestCount,
    joinedRequestCount, activeRequestCount: active ? 1 : 0, mode: MODE }) });
}

module.exports = Object.freeze({ MODE, ACTIVE_SOURCE_IDS, SOURCE_NAMES,
  createCalendarManualCheckService });
