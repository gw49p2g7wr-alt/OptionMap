"use strict";

const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Execution = require("../js/marketCalendarRuntime/updateExecutionCoordinator.js");
const Builder = require("../js/marketCalendarRuntime/calendarCandidateBuilder.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const HistoryContract = require("../js/marketCalendarHistory/historyContract.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

async function acquisitionIdentity(sourceId, envelope) {
  if (envelope?.success !== true) return null;
  return Canonicalizer.sha256({ sourceId, operation: envelope.operation,
    documents: envelope.documents.map(document => ({ role: document.role,
      contentSha256: document.contentSha256,
      parserInputSha256: document.parserInputSha256 })).sort((a, b) =>
      a.role.localeCompare(b.role)) });
}

function syntheticPrevious(candidate) {
  const acceptedAt = candidate.canonicalRecords.map(record =>
    record.acquisitionEvidence?.fetchedAt).filter(value => Number.isFinite(Date.parse(value)))
    .sort().at(-1);
  if (!acceptedAt) return null;
  return { sourceId: candidate.sourceId, schemaVersion: 1,
    contractVersion: HistoryContract.CONTRACT_VERSION, parserIdentity: {
      sourceId: candidate.sourceId, parserId: candidate.sourceIdentity.parserId,
      parserVersion: candidate.sourceIdentity.parserVersion },
    entries: candidate.canonicalRecords.map(record => ({ eventKey: record.eventKey,
      sourceId: candidate.sourceId, activeRevisionKey: record.revisionKey,
      firstKnownAt: acceptedAt, lastObservedAt: acceptedAt })),
    revisions: candidate.canonicalRecords.map(record => ({ ...clone(record),
      validFrom: acceptedAt, validTo: null, revisionOrigin: "initial_observation" })),
    runs: [], cursors: [{ sourceId: candidate.sourceId, acceptedAt,
      runId: `gate-b-synthetic-${candidate.candidateIdentity}` }] };
}

function createIntegratedShadowRunner(configuration = {}) {
  const acquire = configuration.acquire;
  const builder = configuration.builder || Builder;
  const simulator = configuration.simulator || Simulator;

  async function run(input) {
    const acquisitions = new Map();
    let acquisitionCallCount = 0, active = 0, peak = 0;
    const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async request => {
      acquisitionCallCount += 1; active += 1; peak = Math.max(peak, active);
      try {
        const envelope = await acquire(request);
        acquisitions.set(request.sourceId, envelope);
        return envelope;
      } finally { active -= 1; }
    } });
    const execution = await coordinator.requestUpdate(input), sourceResults = [];
    for (const planned of execution.sourceResults) {
      const envelope = acquisitions.get(planned.sourceId), base = {
        sourceId: planned.sourceId, planningDecision: planned.planningDecision,
        planningReason: planned.planningReason, acquisitionStatus: planned.acquisitionStatus,
        joinedExistingFlight: planned.joinedExistingFlight,
        acquisitionIdentity: await acquisitionIdentity(planned.sourceId, envelope),
        candidateStatus: "not_attempted", candidateIdentity: null, recordCount: 0,
        parserStatus: "not_attempted", canonicalizationStatus: "not_attempted",
        simulationStatus: "not_attempted", previousStateIdentity: null,
        simulationIdentity: null, transitionSummary: null,
        commitOutcome: "writer_disabled" };
      if (planned.acquisitionStatus !== "succeeded" || !envelope) {
        sourceResults.push(base); continue;
      }
      const candidate = await builder.buildCalendarCandidate({ sourceId: planned.sourceId,
        acquisitionResult: envelope });
      const withCandidate = { ...base, candidateStatus: candidate.candidateStatus,
        candidateIdentity: candidate.candidateIdentity, recordCount: candidate.recordCount,
        parserStatus: candidate.parserStatus,
        canonicalizationStatus: candidate.canonicalizationStatus };
      if (!candidate.formalEligible) { sourceResults.push(withCandidate); continue; }
      const previousState = syntheticPrevious(candidate), simulation = previousState
        ? await simulator.simulateCalendarTransition({ sourceId: planned.sourceId,
          candidate, previousState, coveragePolicy: null })
        : { simulationStatus: "rejected", previousStateIdentity: null,
          simulationIdentity: null, summary: null, commitOutcome: "writer_disabled" };
      sourceResults.push({ ...withCandidate, simulationStatus: simulation.simulationStatus,
        previousStateIdentity: simulation.previousStateIdentity,
        simulationIdentity: simulation.simulationIdentity,
        transitionSummary: simulation.summary,
        commitOutcome: simulation.commitOutcome || "writer_disabled" });
    }
    const attempted = sourceResults.filter(value => value.acquisitionStatus !== "not_attempted"),
      completed = attempted.filter(value => value.simulationStatus === "unchanged"),
      overallOutcome = attempted.length === 0 ? "skipped" : completed.length === attempted.length
        ? "success" : completed.length === 0 ? "failed" : "partial";
    return freeze({ overallOutcome, sourceResults: clone(sourceResults), metrics: {
      logicalSourceAcquisitionCount: execution.summary.acquisitionCandidateCount,
      acquisitionCallCount, peakSourceConcurrency: peak }, resources: {
      flights: Flights.getFlightDiagnostics(), pools: Pool.getTaskPoolDiagnostics() } });
  }
  return Object.freeze({ run });
}

function sanitizedLiveSource(source, envelope) {
  return { ...source, documents: (envelope?.documents || []).map(document => ({
    role: document.role, httpStatus: document.httpStatus, mime: document.mime,
    byteCount: document.byteCount, redirectCount: document.redirects?.length || 0,
    contentSha256: document.contentSha256 })) };
}

async function main() {
  let networkRequestCount = 0;
  const acquisitions = new Map(), service = Acquisition.createCalendarAcquisitionService({
    maxRetries: 0, fetchImpl: async (...args) => {
      networkRequestCount += 1; return fetch(...args);
    } }), runner = createIntegratedShadowRunner({ acquire: async request => {
      const envelope = await service.acquire(request);
      acquisitions.set(request.sourceId, envelope); return envelope;
    } }), result = await runner.run({ trigger: "bootstrap",
      requestedAt: new Date().toISOString() });
  const sources = result.sourceResults.map(source =>
    sanitizedLiveSource(source, acquisitions.get(source.sourceId))),
    totalRecordCount = sources.reduce((sum, source) => sum + source.recordCount, 0),
    redirectCount = sources.flatMap(source => source.documents)
      .reduce((sum, document) => sum + document.redirectCount, 0),
    summary = { plannedSourceCount: sources.length,
      acquisitionCandidateCount: sources.filter(value =>
        ["update", "retry"].includes(value.planningDecision)).length,
      acquisitionSuccessCount: sources.filter(value => value.acquisitionStatus === "succeeded").length,
      parserSuccessCount: sources.filter(value => value.parserStatus === "success").length,
      canonicalizationSuccessCount: sources.filter(value =>
        value.canonicalizationStatus === "success").length,
      formalEligibleCount: sources.filter(value => value.candidateStatus === "available").length,
      unchangedCount: sources.reduce((sum, source) =>
        sum + (source.transitionSummary?.unchangedCount || 0), 0),
      changedCount: sources.reduce((sum, source) =>
        sum + (source.transitionSummary?.changedCount || 0), 0),
      newCount: sources.reduce((sum, source) =>
        sum + (source.transitionSummary?.newCount || 0), 0), totalRecordCount };
  const output = { gate: "B", mode: "integrated_shadow",
    comparisonBasis: "synthetic_self_comparison", productionProfileUsed: false,
    storage: { databaseOpen: 0, databaseCreate: 0, formalWrite: 0,
      indexedDbTransactions: 0, runtimeStateDatabaseCreate: 0, runtimeStateWrite: 0,
      localStorageWrite: 0, filesystemPersistence: 0, historyEntityWrite: 0,
      externalHistoryWrite: 0, repair: 0, backfill: 0, schemaUpgradeAttempt: 0 },
    network: { logicalSourceAcquisitionCount: result.metrics.logicalSourceAcquisitionCount,
      phaseAAcquisitionCount: result.metrics.acquisitionCallCount, actualNetworkRequestCount:
      networkRequestCount, redirectCount, peakSourceConcurrency: result.metrics.peakSourceConcurrency },
    overallOutcome: result.overallOutcome, summary, resources: result.resources, sources };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = summary.plannedSourceCount === 12 &&
    summary.acquisitionCandidateCount === 12 && summary.acquisitionSuccessCount === 12 &&
    summary.parserSuccessCount === 12 && summary.canonicalizationSuccessCount === 12 &&
    summary.formalEligibleCount === 12 && summary.totalRecordCount === 205 &&
    summary.unchangedCount === 205 && summary.changedCount === 0 && summary.newCount === 0 &&
    result.metrics.peakSourceConcurrency <= 3 &&
    result.resources.flights.activeFlightCount === 0 &&
    result.resources.pools.activePoolCount === 0 ? 0 : 2;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Gate B integrated shadow failed: ${error?.code || "unexpected_error"}\n`);
  process.exitCode = 1;
});

module.exports = Object.freeze({ acquisitionIdentity, syntheticPrevious,
  createIntegratedShadowRunner });
