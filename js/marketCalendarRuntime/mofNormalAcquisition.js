"use strict";

// Normal acquisition only: reuse accepted transport/parser, no writer/store imports.
const Source = require("../marketCalendarIsolated/mofJgbSource.js");
const Variable = require("../marketCalendarIsolated/mofJgbVariableAdapter.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("./calendarNetworkPolicy.js");
const Legacy = require("./calendarCandidateBuilder.js");
const Contracts = require("./normalAcquisitionContract.js");
function create({ acquisitionContract, fetchImpl, now = () => new Date().toISOString() } = {}) {
  if (acquisitionContract !== Contracts.NORMAL13) throw TypeError("normal_acquisition_contract_required");
  const transport = Source.createAcquirer({ fetchImpl, rejectDuplicateDiscovery: true });
  async function acquire(request) {
    if (!request || Object.keys(request).sort().join("|") !== "operation|sourceId" ||
        request.sourceId !== Source.SOURCE_ID || request.operation !== Network.OPERATION)
      return { success: false, reason: "request_shape_invalid", documents: [], diagnostics: [] };
    const requestedAt = now();
    const assessmentDateJst = new Date(Date.parse(requestedAt) + 540 * 60000).toISOString().slice(0, 10);
    const acquired = await transport.acquire({ sourceId: Source.SOURCE_ID, assessmentDateJst });
    const projected = await Variable.buildCandidate(acquired);
    const source = Registry.getSource(Source.SOURCE_ID), records = projected.canonicalRecords;
    const sourceIdentity = { sourceId: Source.SOURCE_ID, parserId: source.parserId,
      parserVersion: source.parserVersion, candidateSchemaVersion: 1,
      semanticSetHash: await Canonical.sha256(records.map(r => r.revisionKey).sort()) };
    const success = projected.acquisitionOutcome === "complete" && projected.candidateStatus === "available";
    const candidate = { sourceId: Source.SOURCE_ID, candidateStatus: projected.candidateStatus,
      formalEligible: success, candidateIdentity: success ? await Canonical.sha256({ sourceId: Source.SOURCE_ID,
        parserId: source.parserId, parserVersion: source.parserVersion, candidateSchemaVersion: 1,
        revisionKeys: records.map(r => r.revisionKey).sort() }) : null,
      recordCount: records.length, canonicalRecords: records, parserStatus: success ? "success" : "failed",
      canonicalizationStatus: success ? "success" : "not_attempted",
      parserDiagnostics: success ? [] : [projected.reason], canonicalDiagnostics: [], sourceIdentity };
    // Raw documents never leave this adapter or enter normal IPC/persistence.
    return { success, sourceId: Source.SOURCE_ID, operation: Network.OPERATION, requestedAt,
      fetchedAt: acquired.fetchedAt || requestedAt, reason: projected.reason, retryable: false,
      documents: projected.documentHealth.map(d => ({ ...d, mime: "text/html",
        redirects: Array.from({ length: d.redirectCount }, () => ({ accepted: true })) })),
      diagnostics: success ? [] : [{ reason: projected.reason,
        httpStatus: projected.documentHealth.find(d => d.httpStatus >= 400)?.httpStatus || null }],
      normalProjection: { ...projected, candidateEnvelope: candidate }, candidate };
  }
  return Object.freeze({ acquire, diagnostics: transport.diagnostics });
}
function builder(legacy = Legacy) {
  return Object.freeze({ buildCalendarCandidate: input => input?.sourceId === Source.SOURCE_ID
    ? Promise.resolve(input.acquisitionResult.candidate) : legacy.buildCalendarCandidate(input) });
}
module.exports = Object.freeze({ SOURCE_ID: Source.SOURCE_ID, routeIdentity: Variable.routeIdentity, create, builder });
