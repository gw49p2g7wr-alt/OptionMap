"use strict";

const Core = require("./calendarSingleDocumentEvidencePilot.js");
const Estat = require("./estatRoute.js");
const Parser = require("./estatParser.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");

const ADAPTER_VERSION = "optionmap-estat-calendar-evidence-adapter-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));

function createEstatCalendarEvidencePilot(configuration) {
  if (!exact(configuration, ["sourceId", "sourceEvidenceSet", "pilotVersion", "runIdPrefix",
    "diagnosticPrefix"]) || !Object.hasOwn(Estat.ROUTES, configuration.sourceId) ||
      configuration.sourceEvidenceSet?.SOURCE_ID !== configuration.sourceId)
    throw new TypeError("estat_calendar_evidence_policy_invalid");
  const { sourceId, sourceEvidenceSet, pilotVersion, runIdPrefix, diagnosticPrefix } = configuration,
    route = Estat.ROUTES[sourceId], pilot = Core.createSingleDocumentEvidencePilot({ sourceId,
      sourceEvidenceSet, pilotVersion, runIdPrefix, diagnosticPrefix, allowedEncodings: ["utf-8"],
      routeAuthority: { source: Estat.shadowRegistry.getSource(sourceId), route,
        operation: Network.OPERATION, transportVersion: "estat-release-calendar-v2",
        validateUrl: value => Estat.validateUrl(sourceId, value),
        validateMime: value => Network.validateMime(route, value) } });

  function normalizeAcquisition(result) {
    if (result?.success !== true) return result;
    if (result.sourceId !== sourceId) return { success: false, sourceId,
      reason: "source_identity_mismatch" };
    const document = result.document, decoded = Estat.decode(document?.parserInput,
      document?.contentType);
    if (!decoded.ok) return { success: false, sourceId, reason: decoded.reason };
    const redirects = Array.isArray(document?.redirects) ? document.redirects.map(hop => ({
      status: hop.status, to: hop.to, accepted: true })) : null;
    return { ...result, operation: Network.OPERATION, activeAcquisition: result,
      documents: [{ role: "primary", originalOfficialUrl: route.url,
        finalUrl: document?.finalUrl, redirects, httpStatus: document?.httpStatus,
        mime: document?.mime, encoding: { encoding: "utf-8", evidence: decoded.evidence,
          warnings: decoded.warnings || [] }, byteCount: document?.byteCount,
        contentSha256: document?.contentSha256, parserInputSha256: document?.contentSha256,
        parserInput: document?.parserInput }] };
  }

  function createPilotRuntime({ acquisition, vault, formal, builder = Parser } = {}) {
    if (!acquisition || typeof acquisition.acquire !== "function" || !builder ||
        typeof builder.buildCandidate !== "function")
      throw new TypeError("estat_calendar_evidence_runtime_input_invalid");
    const adaptedAcquisition = { acquire: async request => {
      if (request?.sourceId !== sourceId || request?.operation !== Network.OPERATION ||
          Object.keys(request).length !== 2) return { success: false, sourceId,
        reason: "request_shape_invalid" };
      return normalizeAcquisition(await acquisition.acquire({ sourceId }));
    } }, adaptedBuilder = { async buildCalendarCandidate({ sourceId: candidateSourceId,
      acquisitionResult }) {
      const built = await builder.buildCandidate({ sourceId: candidateSourceId,
        acquisitionResult: acquisitionResult?.activeAcquisition }), candidate = {
        ...built, structureGuardStatus: built?.parserStatus === "success" ? "passed" : "failed",
        canonicalizationStatus: built?.candidateStatus === "available" ? "success" : "not_attempted",
        parserDiagnostics: built?.diagnostics || [], canonicalDiagnostics:
          built?.canonicalDiagnostics || [] };
      if (candidate?.candidateStatus === "available" && (candidate.parserVersion !==
          Estat.PARSER_VERSION || candidate.sourceContractVersion !== Estat.SOURCE_CONTRACT_VERSION))
        return { ...candidate, candidateStatus: "rejected", formalEligible: false,
          canonicalRecords: [], parserStatus: "invalid", diagnostics: ["parser_generation_mismatch"] };
      return candidate;
    } };
    return pilot.createPilotRuntime({ acquisition: adaptedAcquisition, vault, formal,
      builder: adaptedBuilder });
  }

  return Object.freeze({ SOURCE_ID: sourceId, ADAPTER_VERSION, CORE_VERSION: pilot.CORE_VERSION,
    PILOT_VERSION: pilot.PILOT_VERSION, TRANSPORT_VERSION: pilot.TRANSPORT_VERSION,
    DIAGNOSTICS: pilot.DIAGNOSTICS, createEvidencePolicy: pilot.createEvidencePolicy,
    normalizeAcquisition, acceptedAcquisition: pilot.acceptedAcquisition,
    createEvidenceInput: pilot.createEvidenceInput, sourceResultFor: pilot.sourceResultFor,
    createPilotRuntime });
}

module.exports = Object.freeze({ ADAPTER_VERSION, createEstatCalendarEvidencePilot });
