"use strict";

// Isolated schema-compatible proposal only. The production canonicalizer continues
// rejecting this unregistered source/type. No registry/taxonomy monkey-patching.
const Source = require("./mofJgbSource.js");
const Parser = require("./mofJgbParser.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Schedule = require("../marketCalendar/marketEventSchedule.js");
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
async function canonicalize(record) {
  const r = record, years = Number(r?.maturity?.slice(0, -1)), product = typeof r?.rawLabel === "string" ? Parser.classify(r.rawLabel) : null;
  if (!r || r.sourceId !== Source.SOURCE_ID || r.eventType !== Source.EVENT_TYPE ||
      !Parser.MATURITIES.includes(years) || r.maturity !== `${years}Y` || !product?.include || product.maturity !== years ||
      r.sourceTitle !== r.rawLabel || !Source.validDate(r.eventDate) ||
      r.instrumentClass !== Source.SOURCE.instrumentClass || r.time !== null || r.absenceAuthority !== "none" ||
      r.referencePeriod !== `auction-date:${r.eventDate}` || r.edition !== "normal-fixed-rate" || r.scope !== r.maturity ||
      r.authorityEventId !== null || r.sourceStatus !== "scheduled" || !Source.pageMonth(r.sourceUrl) ||
      r.evidenceUrl !== r.sourceUrl || r.sourcePageMonth !== Source.pageMonth(r.sourceUrl) ||
      !/^[0-9a-f]{64}$/.test(r.rawContentHash || "") || typeof r.fetchedAt !== "string" || !Number.isFinite(Date.parse(r.fetchedAt)) ||
      r.sourcePublishedAt !== null || r.sourceUpdatedAt !== null || r.parserId !== "mof-jgb-month-isolated" || r.parserVersion !== 1 ||
      r.sourceLocalSchedule?.kind !== "date_only" || r.sourceLocalSchedule?.startDate !== r.eventDate ||
      r.sourceLocalSchedule?.startTime !== null || r.sourceLocalSchedule?.endDate !== null ||
      r.sourceLocalSchedule?.endTime !== null || r.sourceLocalSchedule?.timeZone !== "Asia/Tokyo" ||
      r.sourceLocalSchedule?.precision !== "date_only") return { ok: false, reason: "isolated_candidate_invalid", event: null };
  const logical = { jurisdiction: "JP", authority: "MOF", eventType: Source.EVENT_TYPE,
    referencePeriod: r.referencePeriod, edition: r.edition, scope: r.scope, authorityEventId: null };
  const eventKey = [logical.jurisdiction, logical.authority, logical.eventType, logical.referencePeriod,
    logical.edition, logical.scope].join("|"); logical.eventKey = eventKey;
  const semantic = { schemaVersion: 1, logical, schedule: Schedule.canonicalize(r.sourceLocalSchedule),
    lifecycleStatus: "scheduled", title: { ja: `${years}年国債 入札`, en: `${years}-year JGB Auction` },
    change: { reason: null, supersedesRevisionKey: null } };
  const evidence = { sourceId: Source.SOURCE_ID, authority: "MOF", sourceUrl: r.sourceUrl,
    sourcePublishedAt: null, sourceUpdatedAt: null, fetchedAt: r.fetchedAt,
    rawContentHash: r.rawContentHash, parserId: r.parserId, parserVersion: r.parserVersion,
    requestId: null, runId: null, httpMetadata: null };
  const canonicalContentHash = await Canonical.sha256(semantic), acquisitionEvidenceHash = await Canonical.sha256(evidence);
  return { ok: true, reason: null, event: freeze({ ...semantic, source: evidence, acquisitionEvidence: evidence,
    eventKey, revisionKey: `${eventKey}|sha256:${canonicalContentHash}`,
    acquisitionEvidenceKey: `${Source.SOURCE_ID}|sha256:${acquisitionEvidenceHash}`,
    validFrom: null, validTo: null, canonicalContentHash, acquisitionEvidenceHash }) };
}
async function assess(acquired) {
  const diagnostics = { pagesDiscovered: acquired?.discovery?.months?.length || 0,
    pagesFetched: acquired?.documents?.filter(d => Source.pageMonth(d.requestedUrl) && d.outcome === "complete").length || 0,
    rowsExamined: 0, qualifyingRows: 0, excludedRows: {}, duplicateCount: 0, malformedCount: 0, unknownProductCount: 0 };
  const base = { sourceId: Source.SOURCE_ID, isolated: true, writeAllowed: false, productionActive: false,
    absenceAuthority: "none", coverage: "published_months_only", diagnostics };
  const failed = reason => ({ ...base, outcome: "failed", reason, canonicalRecords: [], records: [], candidateCount: 0 });
  if (acquired?.outcome !== "complete" || acquired.sourceId !== Source.SOURCE_ID || !Source.validDate(acquired.assessmentDateJst) ||
      !Array.isArray(acquired.documents) || !Array.isArray(acquired.discovery?.months) ||
      acquired.documents.length !== acquired.discovery.months.length + 1 || acquired.documents[0]?.requestedUrl !== Source.INDEX_URL ||
      acquired.documents.some(d => d.outcome !== "complete")) return failed(acquired?.reason || "acquisition_incomplete");
  const canonicalRecords = new Map(), records = [], documents = [];
  for (let i = 0; i < acquired.discovery.months.length; i++) {
    const d = acquired.documents[i + 1], discovered = acquired.discovery.months[i];
    if (d.requestedUrl !== discovered.url || Source.pageMonth(d.requestedUrl) !== discovered.month) return failed("discovery_document_mismatch");
    const parsed = Parser.parseMonth(d.html, { sourceUrl: d.requestedUrl, fetchedAt: acquired.fetchedAt, rawContentHash: d.rawContentHash });
    for (const key of ["rowsExamined", "qualifyingRows", "duplicateCount", "malformedCount", "unknownProductCount"]) diagnostics[key] += parsed.diagnostics[key];
    for (const [key, value] of Object.entries(parsed.diagnostics.excludedRows)) diagnostics.excludedRows[key] = (diagnostics.excludedRows[key] || 0) + value;
    documents.push({ month: discovered.month, diagnostics: parsed.diagnostics, outcome: parsed.ok ? "complete" : "failed" });
    if (!parsed.ok) return { ...failed(parsed.reason), documents };
    for (const r of parsed.records) {
      const c = await canonicalize(r);
      if (!c.ok) return failed(c.reason);
      const previous = canonicalRecords.get(c.event.eventKey);
      if (previous) {
        if (previous.canonicalContentHash !== c.event.canonicalContentHash) return failed("duplicate_semantic_conflict");
        diagnostics.duplicateCount++; continue;
      }
      canonicalRecords.set(c.event.eventKey, c.event); records.push(r);
    }
  }
  const events = [...canonicalRecords.values()].sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { ...base, outcome: "complete", reason: null, documents, records, canonicalRecords: events,
    candidateCount: events.length, futureCandidateCount: records.filter(r => r.eventDate >= acquired.assessmentDateJst).length,
    byMaturity: Object.fromEntries(Parser.MATURITIES.map(m => [`${m}Y`, records.filter(r => r.maturity === `${m}Y`).length])),
    candidateIdentity: await Canonical.sha256(events.map(e => e.revisionKey)) };
}
module.exports = Object.freeze({ canonicalize, assess });
