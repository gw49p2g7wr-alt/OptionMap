"use strict";

const Dates = require("../calendarDate/calendarDate.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Route = require("./estatRoute.js");
const ASSESSMENT_VERSION = 1; // Candidate-only operational assessment, never removal authority.
const monthNumber = value => { const match = typeof value === "string" && value.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null; };
const monthLabel = value => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, "0")}`;
async function assessCoverage({ sourceId, classifiedRows, parserStatus, assessmentDateJst } = {}) {
  const base = { sourceId: Route.ROUTES[sourceId] ? sourceId : null, assessmentVersion: ASSESSMENT_VERSION,
    sourceContractVersion: Route.SOURCE_CONTRACT_VERSION, assessmentDateJst,
    operationalRequiredFrom: assessmentDateJst,
    operationalRequiredThrough: Dates.isValid(assessmentDateJst) ? Dates.addDays(assessmentDateJst, 41) : null,
    absenceAuthority: "none", observedCoverageFrom: null, observedCoverageThrough: null,
    eligibleEventCount: 0, laneAssessments: [], assessmentBasis: "monthly_chain_bracketed" };
  const finish = async data => { const result = { ...base, ...data };
    return { ...result, coverageAssessmentIdentity: await Canonical.sha256(result) }; };
  if (!base.sourceId || !base.operationalRequiredThrough || parserStatus !== "success" || !Array.isArray(classifiedRows))
    return finish({ coverageState: "invalid", reasonCodes: ["coverage_input_invalid"] });
  const lanes = sourceId === "jp-stat-cpi" ? ["national", "tokyo"] : ["basic"];
  if (classifiedRows.some(row => !row || typeof row.eligible !== "boolean" || !lanes.includes(row.lane) ||
    !Dates.isValid(row.publicationDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.publicationTime) ||
    row.eligible && (row.kind !== "monthly" || monthNumber(row.targetMonth) === null)))
    return finish({ coverageState: "invalid", reasonCodes: ["row_identity_invalid"] });
  const eligible = classifiedRows.filter(row => row.eligible), identities = eligible.map(row => `${row.lane}|${row.targetMonth}`);
  if (new Set(identities).size !== identities.length)
    return finish({ coverageState: "invalid", reasonCodes: ["duplicate_identity"] });
  for (const lane of lanes) {
    const rows = eligible.filter(row => row.lane === lane).sort((a, b) => a.targetMonth.localeCompare(b.targetMonth));
    const dates = rows.map(row => row.publicationDate).sort(), assessment = { lane,
      observedCoverageFrom: dates[0] || null, observedCoverageThrough: dates.at(-1) || null,
      eligibleEventCount: rows.length, targetMonths: rows.map(row => row.targetMonth), missingTargetMonths: [],
      startBracketTargetMonth: null, endBracketTargetMonth: null, absenceAuthority: "none" };
    const complete = (coverageState, reason) => base.laneAssessments.push({ ...assessment, coverageState, reasonCodes: [reason] });
    if (!rows.length) { complete("partial", "eligible_monthly_rows_absent"); continue; }
    if (rows.some((row, i) => i && `${row.publicationDate}T${row.publicationTime}` <=
        `${rows[i - 1].publicationDate}T${rows[i - 1].publicationTime}`)) {
      complete("invalid", "publication_order_ambiguous"); continue; }
    const start = rows.findLast(row => row.publicationDate <= base.operationalRequiredFrom);
    const end = rows.find(row => row.publicationDate >= base.operationalRequiredThrough);
    assessment.startBracketTargetMonth = start?.targetMonth || null;
    assessment.endBracketTargetMonth = end?.targetMonth || null;
    if (!end) { complete("partial", "future_horizon_short"); continue; }
    if (!start) { complete("unknown", "start_boundary_unproven"); continue; }
    const months = new Set(assessment.targetMonths);
    for (let n = monthNumber(start.targetMonth); n <= monthNumber(end.targetMonth); n++)
      if (!months.has(monthLabel(n))) assessment.missingTargetMonths.push(monthLabel(n));
    complete(assessment.missingTargetMonths.length ? "partial" : "sufficient",
      assessment.missingTargetMonths.length ? "monthly_series_gap" : "monthly_chain_bracketed");
  }
  const dates = eligible.map(row => row.publicationDate).sort();
  const states = base.laneAssessments.map(lane => lane.coverageState);
  const coverageState = states.includes("invalid") ? "invalid" : states.includes("partial") ? "partial"
    : states.includes("unknown") ? "unknown" : "sufficient";
  return finish({ coverageState, reasonCodes: [...new Set(base.laneAssessments.flatMap(lane => lane.reasonCodes))].sort(),
    observedCoverageFrom: dates[0] || null, observedCoverageThrough: dates.at(-1) || null,
    eligibleEventCount: eligible.length });
}
module.exports = Object.freeze({ ASSESSMENT_VERSION, assessCoverage });
