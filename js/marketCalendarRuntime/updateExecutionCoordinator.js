"use strict";

const planner = require("./updateCoordinator.js");
const flights = require("./sourceSingleFlight.js");
const pool = require("./boundedTaskPool.js");
const acquisitionApi = require("./calendarAcquisitionService.js");

const ACQUISITION_POLICY_IDENTITY = Object.freeze({ networkPolicyVersion: 1,
  operation: flights.OPERATION });

function deepFreeze(value) {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}
const clone = value => value === undefined ? undefined : structuredClone(value);

function sanitizeAcquisition(envelope) {
  if (!envelope || typeof envelope !== "object") return { success: false,
    reason: "acquisition_result_invalid", retryable: false, documents: [], diagnostics: [] };
  const diagnostics = Array.isArray(envelope.diagnostics) ? envelope.diagnostics.map(item => ({
    stage: typeof item?.stage === "string" ? item.stage : null,
    role: typeof item?.role === "string" ? item.role : null,
    reason: typeof item?.reason === "string" ? item.reason : "diagnostic_invalid",
    retryable: item?.retryable === true,
    httpStatus: Number.isInteger(item?.httpStatus) ? item.httpStatus : null,
    redirectCount: Number.isInteger(item?.redirectCount) ? item.redirectCount : 0
  })) : [];
  if (envelope.success !== true) return { success: false,
    reason: typeof envelope.reason === "string" ? envelope.reason : "acquisition_failed",
    retryable: envelope.retryable === true, documents: [], diagnostics };
  const documents = Array.isArray(envelope.documents) ? envelope.documents.map(document => ({
    role: document.role, originalOfficialUrl: document.originalOfficialUrl,
    finalUrl: document.finalUrl, redirects: Array.isArray(document.redirects)
      ? document.redirects.map(redirect => ({ status: redirect.status, from: redirect.from,
        to: redirect.to, accepted: redirect.accepted === true })) : [],
    httpStatus: document.httpStatus, mime: document.mime, encoding: clone(document.encoding),
    workbook: clone(document.workbook), byteCount: document.byteCount,
    contentSha256: document.contentSha256, parserInputSha256: document.parserInputSha256
  })) : [];
  return { success: true, reason: null, retryable: false, sourceId: envelope.sourceId,
    operation: envelope.operation, requestedAt: envelope.requestedAt,
    fetchedAt: envelope.fetchedAt, documents, diagnostics };
}

function baseSourceResult(planning) {
  return { sourceId: planning.sourceId, planningDecision: planning.decision,
    planningReason: planning.reason, classification: planning.classification,
    acquisitionStatus: "not_attempted", joinedExistingFlight: null,
    attemptCount: planning.attemptCount, retryAfter: planning.retryAfter,
    acquisition: null, parserStatus: "not_attempted", candidateStatus: "not_attempted",
    transitionStatus: "not_attempted", commitOutcome: "writer_disabled" };
}

function createUpdateExecutionCoordinator(configuration = {}) {
  const scopedPlanner = planner.createUpdateCoordinator(configuration.acquisitionContract);
  const service = configuration.service || acquisitionApi.createCalendarAcquisitionService(
    configuration.acquisitionOptions || {});
  const acquire = configuration.acquire || (request => service.acquire(request));
  const policyIdentity = configuration.acquisitionPolicyIdentity || ACQUISITION_POLICY_IDENTITY;

  async function requestUpdate(input) {
    const plan = scopedPlanner.planUpdate(input);
    const tasks = plan.acquisitionCandidates.map(candidate => ({ taskIdentity: candidate.sourceId,
      execute: () => flights.runSourceFlight({ sourceId: candidate.sourceId,
        operation: flights.OPERATION, acquisitionPolicyIdentity: policyIdentity,
        execute: async () => sanitizeAcquisition(await acquire({ sourceId: candidate.sourceId,
          operation: flights.OPERATION })) }) }));
    const execution = await pool.runBoundedTasks({ tasks, maxConcurrency: pool.MAX_CONCURRENCY });
    const executionBySource = new Map(execution.results.map(result => [result.taskIdentity, result]));
    let succeeded = 0, failed = 0;
    const sourceResults = plan.sourceResults.map(planning => {
      const result = baseSourceResult(planning);
      if (planning.classification !== "acquisition_candidate") return result;
      const taskResult = executionBySource.get(planning.sourceId);
      if (!taskResult || taskResult.status !== "fulfilled") {
        failed += 1; return { ...result, acquisitionStatus: "failed", acquisition: {
          success: false, reason: taskResult?.failure?.code || "execution_result_missing",
          retryable: false, documents: [], diagnostics: [] } };
      }
      const flight = taskResult.value, acquisition = sanitizeAcquisition(flight.executionOutcome);
      if (acquisition.success) succeeded += 1; else failed += 1;
      return { ...result, acquisitionStatus: acquisition.success ? "succeeded" : "failed",
        joinedExistingFlight: flight.joinedExistingFlight, acquisition };
    });
    const attempted = succeeded + failed;
    const overallOutcome = attempted === 0 ? "skipped" : failed === 0 ? "success"
      : succeeded === 0 ? "failed" : "partial";
    return deepFreeze({ trigger: plan.trigger, requestedAt: plan.requestedAt,
      policyVersion: plan.policyVersion, operation: flights.OPERATION, overallOutcome,
      sourceResults: clone(sourceResults), summary: { plannedSourceCount: plan.sourceResults.length,
        acquisitionCandidateCount: plan.acquisitionCandidates.length,
        successfulSourceCount: succeeded, failedSourceCount: failed,
        notAttemptedSourceCount: plan.sourceResults.length - attempted,
        peakSourceConcurrency: execution.diagnostics.peakActiveTaskCount },
      resources: { sourceFlights: flights.getFlightDiagnostics().activeFlightCount,
        activePools: pool.getTaskPoolDiagnostics().activePoolCount,
        activeTasks: pool.getTaskPoolDiagnostics().activeTaskCount,
        queuedTasks: pool.getTaskPoolDiagnostics().queuedTaskCount,
        unresolvedTasks: pool.getTaskPoolDiagnostics().unresolvedTaskCount } });
  }
  return Object.freeze({ requestUpdate });
}

const defaultCoordinator = createUpdateExecutionCoordinator();
module.exports = Object.freeze({ ACQUISITION_POLICY_IDENTITY, createUpdateExecutionCoordinator,
  requestUpdate: defaultCoordinator.requestUpdate });
