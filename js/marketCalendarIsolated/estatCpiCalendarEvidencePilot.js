"use strict";

const Core = require("./calendarSingleDocumentEvidencePilot.js");
const Estat = require("./estatRoute.js");
const Parser = require("./estatParser.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const SourceEvidenceSet = require("../marketCalendarHistory/estatCpiCalendarSourceEvidenceSet.js");

const SOURCE_ID = SourceEvidenceSet.SOURCE_ID, route = Estat.ROUTES[SOURCE_ID];
const pilot = Core.createSingleDocumentEvidencePilot({ sourceId: SOURCE_ID,
  sourceEvidenceSet: SourceEvidenceSet,
  pilotVersion: "optionmap-estat-cpi-calendar-evidence-pilot-v1",
  runIdPrefix: "estat-cpi-calendar-acquisition",
  diagnosticPrefix: "estat_cpi_calendar", allowedEncodings: ["utf-8"],
  routeAuthority: { source: Estat.shadowRegistry.getSource(SOURCE_ID), route,
    operation: Network.OPERATION, transportVersion: "estat-release-calendar-v2",
    validateUrl: value => Estat.validateUrl(SOURCE_ID, value),
    validateMime: value => Network.validateMime(route, value) } });

function normalizeAcquisition(result) {
  if (result?.success !== true) return result;
  const document = result.document, decoded = Estat.decode(document?.parserInput,
    document?.contentType);
  if (!decoded.ok) return { success: false, sourceId: SOURCE_ID, reason: decoded.reason };
  const redirects = Array.isArray(document?.redirects) ?
    document.redirects.map(hop => ({ status: hop.status, to: hop.to, accepted: true })) : null;
  return { ...result, operation: Network.OPERATION, activeAcquisition: result,
    documents: [{ role: "primary", originalOfficialUrl: route.url,
      finalUrl: document?.finalUrl, redirects, httpStatus: document?.httpStatus,
      mime: document?.mime, encoding: { encoding: "utf-8",
        evidence: decoded.evidence, warnings: decoded.warnings || [] },
      byteCount: document?.byteCount, contentSha256: document?.contentSha256,
      parserInputSha256: document?.contentSha256, parserInput: document?.parserInput }] };
}

function createPilotRuntime({ acquisition, vault, formal, builder = Parser } = {}) {
  if (!acquisition || typeof acquisition.acquire !== "function" || !builder ||
      typeof builder.buildCandidate !== "function")
    throw new TypeError("estat_cpi_calendar_evidence_runtime_input_invalid");
  const adaptedAcquisition = { acquire: async request => {
    if (request?.sourceId !== SOURCE_ID || request?.operation !== Network.OPERATION ||
        Object.keys(request).length !== 2) return { success: false, sourceId: SOURCE_ID,
      reason: "request_shape_invalid" };
    return normalizeAcquisition(await acquisition.acquire({ sourceId: SOURCE_ID }));
  } }, adaptedBuilder = { async buildCalendarCandidate({ sourceId, acquisitionResult }) {
    const built = await builder.buildCandidate({ sourceId,
      acquisitionResult: acquisitionResult?.activeAcquisition }), candidate = {
      ...built, structureGuardStatus: built?.parserStatus === "success" ? "passed" : "failed",
      canonicalizationStatus: built?.candidateStatus === "available" ? "success" : "not_attempted",
      parserDiagnostics: built?.diagnostics || [], canonicalDiagnostics: built?.canonicalDiagnostics || [] };
    if (candidate?.candidateStatus === "available" && (candidate.parserVersion !==
        Estat.PARSER_VERSION || candidate.sourceContractVersion !== Estat.SOURCE_CONTRACT_VERSION))
      return { ...candidate, candidateStatus: "rejected", formalEligible: false,
        canonicalRecords: [], parserStatus: "invalid", diagnostics: ["parser_generation_mismatch"] };
    return candidate;
  } };
  return pilot.createPilotRuntime({ acquisition: adaptedAcquisition, vault, formal,
    builder: adaptedBuilder });
}

module.exports = Object.freeze({ SOURCE_ID, CORE_VERSION: pilot.CORE_VERSION,
  PILOT_VERSION: pilot.PILOT_VERSION, TRANSPORT_VERSION: pilot.TRANSPORT_VERSION,
  DIAGNOSTICS: pilot.DIAGNOSTICS,
  createEstatCpiCalendarEvidencePolicy: pilot.createEvidencePolicy,
  normalizeAcquisition, acceptedAcquisition: pilot.acceptedAcquisition,
  createEvidenceInput: pilot.createEvidenceInput, sourceResultFor: pilot.sourceResultFor,
  createPilotRuntime });
