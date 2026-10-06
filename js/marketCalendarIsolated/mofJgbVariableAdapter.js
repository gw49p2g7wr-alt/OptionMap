"use strict";

// Explicit isolated composition only. No production activation, state or writer.
const S = require("./mofJgbSource.js"), P = require("./mofJgbParser.js");
const C = require("../marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const ENABLEMENT = Object.freeze({ scope: "G1.3a_isolated13", productionActive: false });
const routeIdentity = S.hash(Buffer.from(C.stable(Registry.getSource(S.SOURCE_ID).route)));
function validateSet(a) {
  if (a?.outcome !== "complete" || a.sourceId !== S.SOURCE_ID || !S.validDate(a.assessmentDateJst) ||
      !Array.isArray(a.documents) || !Array.isArray(a.discovery?.months) || a.documents[0]?.requestedUrl !== S.INDEX_URL)
    return "acquisition_incomplete";
  const discovery = S.discoverMonths(a.documents[0].html, a.assessmentDateJst);
  if (!discovery.ok || discovery.duplicateCount) return discovery.reason || "duplicate_month_document";
  if (C.stable(discovery.months) !== C.stable(a.discovery.months) ||
      a.documents.length !== discovery.months.length + 1) return "document_set_mismatch";
  if (new Set(a.documents.map(d => d.requestedUrl)).size !== a.documents.length) return "duplicate_month_document";
  for (const [i, d] of a.documents.entries()) {
    const url = i ? discovery.months[i - 1].url : S.INDEX_URL;
    if (d.requestedUrl !== url || d.finalUrl !== url || d.outcome !== "complete" || d.httpStatus !== 200 ||
        !S.validateUrl(url).valid || !/^text\/html(?:\s*;|\s*$)/i.test(d.contentType || "") ||
        !Number.isInteger(d.byteCount) || d.byteCount < 1 || d.byteCount > S.MAX_BYTES || d.encoding !== "utf-8" ||
        !/^[a-f0-9]{64}$/.test(d.rawContentHash || "") || typeof d.html !== "string") return "document_contract_invalid";
  }
  return null;
}
async function buildCandidate(a) {
  const started = performance.now();
  const health = (a?.documents || []).map(d => ({ role: d.requestedUrl === S.INDEX_URL ? "index" :
    `month:${S.pageMonth(d.requestedUrl) || "invalid"}`, requestedUrl: d.requestedUrl, finalUrl: d.finalUrl || null,
    rawContentHash: d.rawContentHash || null, encodingEvidence: d.encodingEvidence || null,
    httpStatus: d.httpStatus, byteCount: d.byteCount, redirectCount: d.redirects.length,
    fetchOutcome: d.outcome === "complete" ? "success" : "failure", parseOutcome: "not_attempted" }));
  const base = { sourceId: S.SOURCE_ID, routeIdentity, acquisitionOutcome: "failed", candidateStatus: "unavailable",
    canonicalRecords: [], candidateIdentity: null, failedRoles: [], documentHealth: health,
    discovery: a?.discovery || null, absenceAuthority: "none", coverage: { coverageState: "published_months_only",
      absenceAuthority: "none" }, writeAllowed: false, permission: "unavailable_not_approved" };
  const fail = reason => ({ ...base, reason, failedRoles: health.filter(d => d.parseOutcome !== "success").map(d => d.role),
    parserCanonicalMs: performance.now() - started });
  const invalid = validateSet(a); if (invalid) return fail(a?.reason || invalid);
  const setIdentity = await C.sha256(health.map(d => ({ role: d.role, url: d.requestedUrl, hash: d.rawContentHash,
    encodingEvidence: d.encodingEvidence })));
  health[0].parseOutcome = "success";
  const records = [], seen = new Set();
  for (let i = 1; i < a.documents.length; i++) {
    const d = a.documents[i], parsed = P.parseMonth(d.html, { sourceUrl: d.requestedUrl,
      fetchedAt: a.fetchedAt, rawContentHash: d.rawContentHash });
    if (!parsed.ok || parsed.diagnostics.duplicateCount) return fail(parsed.reason || "duplicate_candidate");
    health[i].parseOutcome = "success";
    for (const r of parsed.records) {
      const result = await C.canonicalize({ ...C.toTypedJgbRecord(r),
        httpMetadata: { role: health[i].role, documentSetIdentity: setIdentity,
          encodingEvidence: d.encodingEvidence, httpStatus: d.httpStatus } });
      if (!result.ok || seen.has(result.event.eventKey)) return fail(result.reason || "duplicate_candidate");
      seen.add(result.event.eventKey); records.push(result.event);
    }
  }
  records.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { ...base, acquisitionOutcome: "complete", candidateStatus: "available", reason: null,
    canonicalRecords: records, candidateIdentity: await C.sha256({ setIdentity, revisions: records.map(r => r.revisionKey) }),
    documentSetIdentity: setIdentity, noEvent: records.length === 0, parserCanonicalMs: performance.now() - started };
}
function create({ enablement, fetchImpl } = {}) {
  if (enablement !== ENABLEMENT) throw TypeError("isolated_enablement_required");
  const transport = S.createAcquirer({ fetchImpl, rejectDuplicateDiscovery: true });
  return Object.freeze({ acquire: async request => buildCandidate(await transport.acquire(request)),
    diagnostics: transport.diagnostics });
}
module.exports = Object.freeze({ ENABLEMENT, SOURCE_ID: S.SOURCE_ID, routeIdentity, validateSet, buildCandidate, create });
