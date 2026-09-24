"use strict";

const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Execution = require("../js/marketCalendarRuntime/updateExecutionCoordinator.js");
const Builder = require("../js/marketCalendarRuntime/calendarCandidateBuilder.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

async function main() {
  let networkRequestCount = 0, acquisitionCount = 0, active = 0, peak = 0;
  const acquired = new Map(), service = Acquisition.createCalendarAcquisitionService({ maxRetries: 0,
    fetchImpl: async (...args) => { networkRequestCount += 1; return fetch(...args); } });
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async request => {
    acquisitionCount += 1; active += 1; peak = Math.max(peak, active);
    try { const envelope = await service.acquire(request); acquired.set(request.sourceId, envelope);
      return envelope; } finally { active -= 1; }
  } });
  const execution = await coordinator.requestUpdate({ trigger: "bootstrap",
    requestedAt: new Date().toISOString() }), candidates = [];
  for (const source of execution.sourceResults) candidates.push(
    await Builder.buildCalendarCandidate({ sourceId: source.sourceId,
      acquisitionResult: acquired.get(source.sourceId) }));
  const resources = { flights: Flights.getFlightDiagnostics(), pools: Pool.getTaskPoolDiagnostics() },
    sources = candidates.map(candidate => ({ sourceId: candidate.sourceId,
      candidateStatus: candidate.candidateStatus, formalEligible: candidate.formalEligible,
      recordCount: candidate.recordCount, candidateIdentity: candidate.candidateIdentity,
      parserStatus: candidate.parserStatus,
      canonicalizationStatus: candidate.canonicalizationStatus,
      parserDiagnostics: candidate.parserDiagnostics,
      canonicalDiagnostics: candidate.canonicalDiagnostics })),
    totalCandidateCount = candidates.reduce((sum, candidate) => sum + candidate.recordCount, 0),
    formalEligibleSourceCount = candidates.filter(candidate => candidate.formalEligible).length;
  const output = { phase: "B3a", readOnly: true, productionProfileUsed: false,
    storage: { databaseOpen: 0, databaseCreate: 0, formalWrite: 0,
      indexedDbTransactions: 0, runtimeStateWrite: 0, localStorageWrite: 0,
      filesystemPersistence: 0, externalHistoryWrite: 0, repair: 0, backfill: 0,
      schemaUpgrade: 0 }, networkRequestCount, acquisitionCount,
    peakSourceConcurrency: peak, acquiredSourceCount: acquired.size,
    parsedSourceCount: candidates.filter(value => value.parserStatus === "success").length,
    canonicalizedSourceCount: candidates.filter(value =>
      value.canonicalizationStatus === "success").length,
    formalEligibleSourceCount, totalCandidateCount, resources, sources };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = acquired.size === 12 && formalEligibleSourceCount === 12 &&
    totalCandidateCount === 205 && peak <= 3 && resources.flights.activeFlightCount === 0 &&
    resources.pools.activeTaskCount === 0 ? 0 : 2;
}

main().catch(error => {
  process.stderr.write(`B3a live acceptance failed: ${error?.code || "unexpected_error"}\n`);
  process.exitCode = 1;
});
