"use strict";

// Future main-side boundary. Not wired to main.js, IPC, startup, manual UI or any writer.
const Authority = require("./calendarRouteAuthority.js");
const Legacy = require("./calendarAcquisitionService.js");
const Builder = require("./calendarCandidateBuilder.js");
const ER = require("../marketCalendarIsolated/estatRoute.js");
const EP = require("../marketCalendarIsolated/estatParser.js");
const EC = require("../marketCalendarIsolated/estatCoverage.js");
const BR = require("../marketCalendarIsolated/blsFixedRoute.js");
const BA = require("../marketCalendarIsolated/blsFixedAssessment.js");
const Dates = require("../calendarDate/calendarDate.js");
const safe = v => typeof v === "string" && /^[a-z0-9_:-]{1,120}$/.test(v) ? v : "diagnostic_redacted";
function freeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function createRouteAdapter({ fetchImpl, getAuthority = () => Authority.DEFAULT_AUTHORITY, assessmentDateJst,
  legacyAcquire } = {}) {
  if (typeof fetchImpl !== "function" || typeof getAuthority !== "function" || !Dates.isValid(assessmentDateJst) ||
      legacyAcquire !== undefined && typeof legacyAcquire !== "function") throw TypeError("route_adapter_configuration_invalid");
  // Explicit injected transport; construction/import performs no acquisition.
  const estat = ER.createAcquirer({ fetchImpl }), bls = BR.createAcquirer({ fetchImpl });
  const legacy = legacyAcquire || Legacy.createCalendarAcquisitionService({ fetchImpl }).acquire;
  async function acquire(request) {
    let selection;
    try { selection = Authority.selectRoute(request, getAuthority()); }
    catch (_) { selection = { valid: false, acquisitionAllowed: false, reason: "authority_invalid" }; }
    // Selection is a detached immutable snapshot taken before the first await.
    const base = { sourceId: selection.sourceId || null, routeIdentity: selection.routeIdentity || null,
      routeKind: selection.routeKind || null, sourceContractVersion: selection.sourceContractVersion || null,
      routeContractVersion: selection.routeContractVersion || null, activationVersion: selection.activationVersion || null,
      authorityIdentity: selection.authorityIdentity || null, acquisitionOutcome: "not_attempted",
      candidateEnvelope: null, documentHealth: [], coverage: null, diagnostics: [], failedRoles: [],
      absenceAuthority: "none", disappearance: "not_evaluated", writerEnabled: false, commitOutcome: "writer_disabled" };
    if (!selection.valid || !selection.acquisitionAllowed) return freeze({ ...base,
      diagnostics: [selection.reason], acquisitionOutcome: selection.valid ? "suspended" : "rejected" });
    try {
      const sourceId = selection.sourceId, kind = selection.routeKind;
      const a = kind === "legacy" ? await legacy({ sourceId, operation: selection.operation })
        : kind === "estat_release_calendar" ? await estat.acquire({ sourceId }) : await bls.acquire({ sourceId });
      const c = kind === "legacy" ? await Builder.buildCalendarCandidate({ sourceId, acquisitionResult: a })
        : kind === "estat_release_calendar" ? await EP.buildCandidate({ sourceId, acquisitionResult: a })
          : await BA.assess({ acquisitionResult: a, assessmentDateJst });
      const isBls = kind === "bls_fixed_schedule_pages", records = c.canonicalRecords || [];
      const coverage = kind === "estat_release_calendar" ? await EC.assessCoverage({ sourceId, assessmentDateJst,
        classifiedRows: c.classifiedRows, parserStatus: c.parserStatus }) : isBls ? {
          coverageState: c.coverageState, roleCoverage: c.roleCoverage,
          operationalRequiredFrom: c.operationalRequiredFrom, operationalRequiredThrough: c.operationalRequiredThrough,
          absenceAuthority: "none" } : null;
      const diagnostics = [...(a.reason ? [a.reason] : []), ...(c.diagnostics || c.parserDiagnostics || []),
        ...(c.canonicalDiagnostics || [])].map(safe);
      const candidateStatus = isBls ? c.outcome === "complete" ? "available" : records.length ? "partial" : "unavailable" : c.candidateStatus;
      const documentHealth = (a.documents || (a.document ? [a.document] : [])).map(d => {
        const parsed = c.documents?.find(p => p.role === d.role);
        return { role: d.role || "primary", httpStatus: d.httpStatus ?? null, mime: d.mime || null,
          byteCount: d.byteCount ?? null, redirectCount: d.redirects?.length || 0,
          fetchOutcome: d.fetchOutcome || (a.success ? "success" : "failure"),
          parseOutcome: parsed?.parseOutcome || c.parserStatus || "not_attempted",
          candidateCount: parsed?.candidateCount ?? null,
          encodingEvidence: d.encodingEvidence || d.encoding || null,
          diagnostics: [d.reason, parsed?.diagnostic].filter(Boolean).map(safe) };
      });
      return freeze({ ...base, acquisitionOutcome: isBls ? a.outcome : a.success ? "complete" : "failed",
        candidateEnvelope: { sourceId, candidateStatus, formalEligible: isBls ? c.outcome === "complete" : c.formalEligible === true,
          candidateIdentity: c.candidateIdentity || null, recordCount: records.length,
          canonicalRecords: records, parserStatus: isBls ? c.outcome === "complete" ? "success" : c.outcome : c.parserStatus || "not_attempted",
          canonicalDiagnostics: (c.canonicalDiagnostics || []).map(safe) },
        documentHealth, coverage, diagnostics, failedRoles: c.failedRoles || [] });
    } catch (_) { return freeze({ ...base, acquisitionOutcome: "failed", diagnostics: ["route_execution_failed"] }); }
  }
  return Object.freeze({ acquire, diagnostics: () => ({ estat: estat.diagnostics(), bls: bls.diagnostics() }) });
}
module.exports = Object.freeze({ createRouteAdapter });
