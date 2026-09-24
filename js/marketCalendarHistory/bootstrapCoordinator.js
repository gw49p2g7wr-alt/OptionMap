"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Schema = require("./productionSchemaV1.js");
const FirstSource = require("./bootstrapFirstSourceWriter.js");
const AppendSource = require("./bootstrapAppendSourceWriter.js");

const activeOrder = Object.freeze(Object.keys(Registry.SOURCES));
const clone = value => value == null ? value : structuredClone(value);
function sourceResult(sourceId, status, reason, values = {}) {
  return { sourceId, decision: status === "committed" ? "commit" : "reject",
    status, committed: status === "committed", transactionOutcome: "not_started",
    readBackStatus: "not_attempted", reason, ...values };
}
async function sessionIdentity(inputs) {
  return Canonicalizer.sha256({ schemaVersion: Schema.VERSION,
    sources: inputs.map(value => ({ sourceId: value?.sourceId || null,
      candidateIdentity: value?.candidate?.candidateIdentity || null,
      simulationIdentity: value?.simulation?.simulationIdentity || null,
      planHash: value?.precondition?.planHash || null })) });
}

function createBootstrapCoordinator(configuration = {}) {
  if (configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB)
    throw new Error("isolated_test_configuration_required");
  const indexedDB = configuration.indexedDB, metrics = { bootstrapSessions: 0,
    databaseCreateAttempts: 0, successfulDatabaseCreates: 0, sourceTransactionAttempts: 0,
    committedSourceTransactions: 0, rolledBackSourceTransactions: 0,
    partialBootstrapRuns: 0, allFailureRuns: 0, readBackTransactions: 0, openHandles: 0 };
  async function bootstrap({ sources = [] } = {}) {
    metrics.bootstrapSessions += 1;
    const input = Array.isArray(sources) ? sources : [], positions = new Map(activeOrder.map(
      (sourceId, index) => [sourceId, index])), ordered = input.map((value, inputIndex) =>
      ({ value, inputIndex })).sort((left, right) => {
      const leftPosition = positions.has(left.value?.sourceId) ? positions.get(left.value.sourceId) : Infinity,
        rightPosition = positions.has(right.value?.sourceId) ? positions.get(right.value.sourceId) : Infinity;
      return leftPosition - rightPosition || String(left.value?.sourceId).localeCompare(
        String(right.value?.sourceId)) || left.inputIndex - right.inputIndex;
    }), identity = await sessionIdentity(ordered.map(item => item.value)), results = [],
      seenSources = new Set(), seenPlans = new Set(), firstWriter =
      FirstSource.createBootstrapFirstSourceWriter({ indexedDB, targetEnvironment: "isolated_test" });
    let firstCommittedSourceId = null, appendWriter = null, fatal = false;
    for (const item of ordered) {
      const value = item.value || {}, sourceId = typeof value.sourceId === "string" ? value.sourceId : null,
        planIdentity = value.precondition?.planHash || null;
      if (seenSources.has(sourceId)) {
        results.push(sourceResult(sourceId, "rejected", "duplicate_source_id")); continue;
      }
      if (planIdentity && seenPlans.has(planIdentity)) {
        results.push(sourceResult(sourceId, "rejected", "duplicate_plan_identity")); continue;
      }
      seenSources.add(sourceId); if (planIdentity) seenPlans.add(planIdentity);
      if (!firstCommittedSourceId) {
        const first = await firstWriter.bootstrap(value);
        if (!first.committed) {
          results.push(sourceResult(sourceId, first.status === "rolled_back" ? "failed" : "rejected",
            first.reason, { transactionOutcome: first.transactionOutcome,
              readBackStatus: first.readBackStatus }));
          continue;
        }
        firstCommittedSourceId = sourceId;
        const capability = AppendSource.createSessionCapability({ sessionIdentity: identity,
          firstCommittedSourceId });
        appendWriter = AppendSource.createBootstrapAppendSourceWriter({ indexedDB,
          targetEnvironment: "isolated_test", sessionCapability: capability });
        results.push(sourceResult(sourceId, "committed", null, { transactionOutcome:
          first.transactionOutcome, readBackStatus: first.readBackStatus }));
        continue;
      }
      const appended = await appendWriter.append({ ...value, bootstrapSessionIdentity: identity });
      results.push(sourceResult(sourceId, appended.committed ? "committed" :
        appended.status === "rejected" || appended.status === "duplicate_noop" ? "rejected" : "failed",
      appended.reason, { transactionOutcome: appended.transactionOutcome,
        readBackStatus: appended.readBackStatus }));
      if (appended.fatal) { fatal = true; break; }
    }
    if (appendWriter) {
      const finalValidation = await appendWriter.validateDatabase();
      if (!finalValidation.valid) fatal = true;
    }
    const firstMetrics = firstWriter.diagnostics(), appendMetrics = appendWriter?.diagnostics() || {
      sourceTransactionAttempts: 0, committedSourceTransactions: 0,
      rolledBackSourceTransactions: 0, readBackTransactions: 0, openHandles: 0 };
    metrics.databaseCreateAttempts += firstMetrics.databaseCreateAttempts;
    metrics.successfulDatabaseCreates += firstMetrics.successfulDatabaseCreates;
    metrics.sourceTransactionAttempts += firstMetrics.databaseCreateAttempts +
      appendMetrics.sourceTransactionAttempts;
    metrics.committedSourceTransactions += firstMetrics.successfulSourceCommits +
      appendMetrics.committedSourceTransactions;
    metrics.rolledBackSourceTransactions += firstMetrics.rolledBackTransactions +
      appendMetrics.rolledBackSourceTransactions;
    metrics.readBackTransactions += firstMetrics.readBackTransactions + appendMetrics.readBackTransactions;
    metrics.openHandles = firstMetrics.openHandles + appendMetrics.openHandles;
    const committedCount = results.filter(value => value.committed).length,
      rejectedCount = results.filter(value => value.status === "rejected").length,
      failedCount = results.filter(value => value.status === "failed").length,
      acceptedCount = committedCount + failedCount, overallOutcome = committedCount === input.length &&
      input.length > 0 ? "success" : committedCount === 0 ? "failed" : "partial";
    if (overallOutcome === "partial") metrics.partialBootstrapRuns += 1;
    if (overallOutcome === "failed") metrics.allFailureRuns += 1;
    return Object.freeze({ status: fatal ? "stopped_fail_closed" : "completed",
      bootstrapSessionIdentity: identity, dbCreated: firstMetrics.successfulDatabaseCreates === 1,
      firstCommittedSourceId, overallOutcome, sourceResults: clone(results), summary: {
        requestedCount: input.length, acceptedCount, committedCount, failedCount, rejectedCount },
      diagnostics: Object.freeze(clone(metrics)) });
  }
  return Object.freeze({ bootstrap, diagnostics: () => Object.freeze(clone(metrics)) });
}

module.exports = Object.freeze({ createBootstrapCoordinator });
