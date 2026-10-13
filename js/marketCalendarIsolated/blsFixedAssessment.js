"use strict";

const Route = require("./blsFixedRoute.js");
const Parser = require("./blsFixedParser.js");
const Dates = require("../calendarDate/calendarDate.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const ASSESSMENT_VERSION = 1;
const month = s => Number(s.slice(0, 4)) * 12 + Number(s.slice(5)) - 1;
function coverage(result, from, through) {
  const rows = result.rows, dates = rows.map(r => r.publicationDate).sort();
  const base = { role: result.role, absenceAuthority: "none", disappearance: "not_evaluated",
    earliestReferencePeriod: rows[0]?.referencePeriod || null,
    latestReferencePeriod: rows.at(-1)?.referencePeriod || null,
    earliestReleaseDate: dates[0] || null, latestReleaseDate: dates.at(-1) || null,
    windowEvents: rows.filter(r => r.publicationDate >= from && r.publicationDate <= through),
    futureEventCount: rows.filter(r => r.publicationDate >= from).length };
  if (result.parseOutcome !== "success") return { ...base, state: "partial", reason: "document_failed" };
  if (rows.some((r, i) => i && `${r.publicationDate}T${r.publicationTime}` <=
      `${rows[i - 1].publicationDate}T${rows[i - 1].publicationTime}`))
    return { ...base, state: "invalid", reason: "publication_order_ambiguous" };
  // Current fixed BLS pages retain only scheduled future releases.  The first
  // listed release is therefore the operational lower boundary when no past
  // row remains; a later row must still bracket the requested horizon.
  const start = rows.findLast(r => r.publicationDate <= from) || rows[0], end = rows.find(r => r.publicationDate >= through);
  if (!end) return { ...base, state: "partial", reason: "future_horizon_short" };
  const subset = rows.filter(r => r.referencePeriod >= start.referencePeriod && r.referencePeriod <= end.referencePeriod);
  if (subset.length !== month(end.referencePeriod) - month(start.referencePeriod) + 1)
    return { ...base, state: "partial", reason: "monthly_series_gap" };
  return { ...base, state: "sufficient", reason: "monthly_chain_bracketed_not_completeness" };
}
async function assess({ acquisitionResult, assessmentDateJst } = {}) {
  const a = acquisitionResult;
  const base = { sourceId: Route.SOURCE_ID, parserVersion: Route.PARSER_VERSION,
    sourceContractVersion: Route.SOURCE_CONTRACT_VERSION, assessmentVersion: ASSESSMENT_VERSION,
    assessmentDateJst, absenceAuthority: "none", disappearance: "not_evaluated",
    writerEnabled: false, productionActive: false };
  if (!Dates.isValid(assessmentDateJst) || a?.sourceId !== Route.SOURCE_ID || !Array.isArray(a.documents) ||
      a.documents.some(d => !Route.ROLES.some(r => r.role === d?.role)) ||
      new Set(a.documents.map(d => d.role)).size !== a.documents.length)
    return { ...base, outcome: "invalid", coverageState: "invalid", documents: [], canonicalRecords: [],
      candidateIdentity: null, reason: "assessment_input_invalid" };
  const through = Dates.addDays(assessmentDateJst, 41), documents = [];
  for (const role of Route.ROLES) documents.push(await Parser.buildDocument(role.role,
    a.documents.find(d => d.role === role.role), a.fetchedAt));
  const canonicalRecords = documents.flatMap(d => d.canonicalRecords).sort((x, y) => x.eventKey.localeCompare(y.eventKey));
  const success = documents.filter(d => d.parseOutcome === "success").length;
  const roleCoverage = documents.map(d => coverage(d, assessmentDateJst, through));
  const states = roleCoverage.map(c => c.state);
  const coverageState = states.includes("invalid") ? "invalid" : success < 4 || states.includes("partial") ? "partial"
    : states.includes("unknown") ? "unknown" : "sufficient";
  const candidateIdentity = await Canonical.sha256({ sourceId: Route.SOURCE_ID, parserVersion: Route.PARSER_VERSION,
    sourceContractVersion: Route.SOURCE_CONTRACT_VERSION, revisionKeys: canonicalRecords.map(e => e.revisionKey) });
  return { ...base, outcome: success === 4 ? "complete" : success ? "partial" : "failed",
    completeDocumentSet: success === 4, failedRoles: documents.filter(d => d.parseOutcome !== "success").map(d => d.role),
    candidateIdentity, canonicalRecords, candidateCount: canonicalRecords.length, documents,
    operationalRequiredFrom: assessmentDateJst, operationalRequiredThrough: through, roleCoverage, coverageState,
    coverageAssessmentIdentity: await Canonical.sha256({ assessmentDateJst, through, roleCoverage }) };
}
module.exports = Object.freeze({ ASSESSMENT_VERSION, assess });
