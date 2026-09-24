"use strict";

const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Execution = require("../js/marketCalendarRuntime/updateExecutionCoordinator.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

async function main() {
  let networkRequestCount = 0, acquisitionCount = 0, active = 0, peak = 0;
  const service = Acquisition.createCalendarAcquisitionService({ maxRetries: 0,
    fetchImpl: async (...args) => { networkRequestCount += 1; return fetch(...args); } });
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async request => {
    acquisitionCount += 1; active += 1; peak = Math.max(peak, active);
    try { return await service.acquire(request); } finally { active -= 1; }
  } });
  const result = await coordinator.requestUpdate({ trigger: "bootstrap",
    requestedAt: new Date().toISOString() });
  const sources = result.sourceResults.map(item => ({ sourceId: item.sourceId,
    decision: item.planningDecision, acquisitionStatus: item.acquisitionStatus,
    joinedExistingFlight: item.joinedExistingFlight,
    reason: item.acquisition?.reason || null,
    documents: (item.acquisition?.documents || []).map(document => ({ role: document.role,
      httpStatus: document.httpStatus, mime: document.mime, byteCount: document.byteCount,
      redirectCount: document.redirects.length, contentSha256: document.contentSha256 })),
    diagnostics: item.acquisition?.diagnostics || [] }));
  const resources = { flights: Flights.getFlightDiagnostics(), pools: Pool.getTaskPoolDiagnostics() };
  process.stdout.write(`${JSON.stringify({ phase: "B2d", readOnly: true,
    productionProfileUsed: false, storage: { databaseOpen: 0, databaseCreate: 0,
      formalWrite: 0, indexedDbTransactions: 0, runtimeStateWrite: 0,
      localStorageWrite: 0, filesystemPersistence: 0, externalHistoryWrite: 0 },
    networkRequestCount, acquisitionCount, peakSourceConcurrency: peak,
    overallOutcome: result.overallOutcome, summary: result.summary, resources, sources }, null, 2)}\n`);
  process.exitCode = result.sourceResults.length === 12 && peak <= 3 &&
    resources.flights.activeFlightCount === 0 && resources.pools.activeTaskCount === 0 ? 0 : 2;
}

main().catch(error => {
  process.stderr.write(`B2d live acceptance failed: ${error?.code || "unexpected_error"}\n`);
  process.exitCode = 1;
});
