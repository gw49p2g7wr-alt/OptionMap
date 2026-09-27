"use strict";

// Acceptance-only composition. No production entry point, state store or writer.
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const ER = require("../js/marketCalendarIsolated/estatRoute.js");
const EP = require("../js/marketCalendarIsolated/estatParser.js");
const EC = require("../js/marketCalendarIsolated/estatCoverage.js");
const BR = require("../js/marketCalendarIsolated/blsFixedRoute.js");
const BA = require("../js/marketCalendarIsolated/blsFixedAssessment.js");
const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Builder = require("../js/marketCalendarRuntime/calendarCandidateBuilder.js");
const Dates = require("../js/calendarDate/calendarDate.js");
const SOURCE_IDS = Object.freeze(["jp-boj-calendar", "jp-stat-cpi", "jp-stat-labor",
  "jp-esri-machinery-orders-calendar", "jp-esri-sna-calendar", "us-fed-fomc-calendar",
  "us-bls-calendar", "us-bea-calendar", "us-census-calendar", "jp-jpx-derivatives-calendar",
  "jp-jpx-market-holidays", "us-nyse-market-holidays"]);
const routeKind = id => id === BR.SOURCE_ID ? "bls_fixed" : Object.hasOwn(ER.ROUTES, id) ? "estat" : "existing";
const safe = value => typeof value === "string" && /^[a-z0-9_:-]{1,120}$/.test(value) ? value : "diagnostic_redacted";
function aggregate(results, assessmentDateJst) {
  const ids = results.map(r => r.sourceId), duplicateSourceCount = ids.length - new Set(ids).size,
    unknownSourceCount = ids.filter(id => !SOURCE_IDS.includes(id)).length,
    missingSourceIds = SOURCE_IDS.filter(id => !ids.includes(id));
  const sourceIdentityValid = !duplicateSourceCount && !unknownSourceCount && !missingSourceIds.length;
  const sourceResults = [...results].sort((a, b) => SOURCE_IDS.indexOf(a.sourceId) - SOURCE_IDS.indexOf(b.sourceId));
  const records = sourceResults.flatMap(r => r.canonicalRecords), events = new Map(), revisions = new Set();
  let duplicateEventKey = 0, conflictingEventKey = 0, duplicateRevisionIdentity = 0;
  for (const r of records) {
    if (events.has(r.eventKey)) { duplicateEventKey++; if (events.get(r.eventKey) !== r.canonicalContentHash) conflictingEventKey++; }
    events.set(r.eventKey, r.canonicalContentHash);
    if (revisions.has(r.revisionKey)) duplicateRevisionIdentity++; revisions.add(r.revisionKey);
  }
  const completed = sourceResults.filter(r => r.candidateStatus === "available").length;
  return { assessmentDateJst, expectedSourceCount: 12, observedSourceCount: ids.length,
    duplicateSourceCount, unknownSourceCount, missingSourceIds, sourceIdentityValid,
    overallCompleteness: !sourceIdentityValid || duplicateEventKey || duplicateRevisionIdentity ? "invalid"
      : completed === 12 ? "complete" : records.length ? "partial" : "failed",
    totalCandidates: records.length, duplicateEventKey, conflictingEventKey, duplicateRevisionIdentity,
    writerEnabled: false, productionActive: false, absenceAuthority: "none", disappearance: "not_evaluated", sourceResults };
}
function createRunner({ fetchImpl, adapters } = {}) {
  // Injection is confined to this acceptance module; never renderer-configurable.
  const e = adapters?.estat || ER.createAcquirer({ fetchImpl }),
    b = adapters?.bls || BR.createAcquirer({ fetchImpl }),
    old = adapters?.existing || Acquisition.createCalendarAcquisitionService({ fetchImpl, maxRetries: 0 });
  const build = adapters?.buildExisting || Builder.buildCalendarCandidate;
  async function run({ assessmentDateJst } = {}) {
    if (!Dates.isValid(assessmentDateJst)) throw Error("assessment_date_invalid");
    const results = [];
    // Sequential source execution is deliberately bounded to one; each source failure is isolated.
    for (const sourceId of SOURCE_IDS) {
      if (!Registry.getSource(sourceId)) throw Error("registry_identity_mismatch");
      const route = routeKind(sourceId);
      const base = { sourceId, routeKind: route, acquisitionOutcome: "failed", parserOutcome: "not_attempted",
        candidateStatus: "unavailable", candidateCount: 0, blockingDiagnosticCount: 0, warningCount: 0,
        diagnostics: [], coverage: null, partial: false, failedRoles: [], canonicalRecords: [], documents: [],
        absenceAuthority: "none", disappearance: "not_evaluated" };
      try {
        const a = await (route === "estat" ? e.acquire({ sourceId }) : route === "bls_fixed" ? b.acquire({ sourceId })
          : old.acquire({ sourceId, operation: "source-document-set" }));
        const c = route === "estat" ? await EP.buildCandidate({ sourceId, acquisitionResult: a })
          : route === "bls_fixed" ? await BA.assess({ acquisitionResult: a, assessmentDateJst })
            : await build({ sourceId, acquisitionResult: a });
        const coverage = route === "estat" ? await EC.assessCoverage({ sourceId, assessmentDateJst,
          classifiedRows: c.classifiedRows, parserStatus: c.parserStatus }) : route === "bls_fixed"
            ? { coverageState: c.coverageState, roleCoverage: c.roleCoverage,
              operationalRequiredFrom: c.operationalRequiredFrom, operationalRequiredThrough: c.operationalRequiredThrough,
              absenceAuthority: "none" } : null;
        const documents = (a.documents || (a.document ? [a.document] : [])).map(d => ({
          role: d.role || "primary", httpStatus: d.httpStatus, mime: d.mime, byteCount: d.byteCount,
          redirectCount: d.redirects?.length || 0, encodingEvidence: d.encodingEvidence || d.encoding || null,
          warnings: (d.encodingWarnings || d.encoding?.warnings || []).map(safe),
          diagnostic: d.reason ? safe(d.reason) : null }));
        const diagnostics = [...(c.diagnostics || c.parserDiagnostics || []), ...(c.canonicalDiagnostics || []),
          ...(c.documents || []).flatMap(d => d.diagnostic ? [d.diagnostic] : []), ...(a.reason ? [a.reason] : [])].map(safe);
        const records = c.canonicalRecords || [], available = route === "bls_fixed" ? c.outcome === "complete" : c.formalEligible === true;
        results.push({ ...base, acquisitionOutcome: route === "bls_fixed" ? a.outcome : a.success ? "complete" : "failed",
          parserOutcome: route === "bls_fixed" ? c.outcome === "complete" ? "success" : c.outcome : c.parserStatus,
          candidateStatus: available ? "available" : records.length ? "partial" : "unavailable",
          candidateCount: records.length, canonicalRecords: records, documents, diagnostics,
          blockingDiagnosticCount: diagnostics.length,
          warningCount: documents.reduce((n, d) => n + d.warnings.length, 0),
          coverage, partial: route === "bls_fixed" && c.outcome === "partial", failedRoles: c.failedRoles || [] });
      } catch (_) { results.push({ ...base, diagnostics: ["source_execution_failed"], blockingDiagnosticCount: 1 }); }
    }
    return aggregate(results, assessmentDateJst);
  }
  return { run, resources: () => ({ estat: e.diagnostics?.() || null, bls: b.diagnostics?.() || null }) };
}
module.exports = Object.freeze({ SOURCE_IDS, routeKind, aggregate, createRunner });
