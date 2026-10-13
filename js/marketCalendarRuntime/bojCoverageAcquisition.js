"use strict";

const Crypto = require("node:crypto");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Policy = require("./calendarNetworkPolicy.js");
const Acquisition = require("./calendarAcquisitionService.js");
const Builder = require("./calendarCandidateBuilder.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Parser = require("./bojCoverageParser.js");
const Encoding = require("../marketCalendarShadow/htmlEncoding.js");
const SOURCE_ID = "jp-boj-calendar", contract = Policy.BOJ_COVERAGE_V2;
const routeIdentity = Crypto.createHash("sha256").update(JSON.stringify({ sourceId: SOURCE_ID,
  documentContract: contract, maxRedirects: Policy.MAX_REDIRECTS, maxRetries: 0,
  credentials: "omit", requestTimeoutMs: Policy.REQUEST_TIMEOUT_MS, bodyTimeoutMs: Policy.BODY_TIMEOUT_MS })).digest("hex");
function adapter() {
  return Object.freeze({ sourceId: SOURCE_ID, async acquire({ fetcher, runId }) {
    const source = Registry.getSource(SOURCE_ID), fetches = [], parsed = [];
    for (const document of contract.documents) {
      const f = await fetcher(SOURCE_ID, document.url); fetches.push(f);
      if (f.status !== "success") return { fetches, records: [], diagnostics: [`fetch:${f.reason}`] };
      const context = { sourceId: SOURCE_ID, sourceUrl: f.finalUrl, fetchedAt: f.fetchedAt,
        parserId: source.parserId, parserVersion: source.parserVersion, rawContentHash: f.contentHash,
        requestId: f.requestId || null, runId, httpMetadata: { httpStatus: f.httpStatus,
          finalUrl: f.finalUrl, contentType: f.contentType, redirects: f.redirects } };
      if (document.kind === "xlsx") parsed.push(Parser.parseTankan(f.bytes, context));
      else {
        const decoded = Encoding.decodeHtml(f.bytes, f.contentType);
        if (!decoded.ok) return { fetches, records: [], diagnostics: [`encoding:${decoded.reason}`] };
        parsed.push(document.role === "primary" ? Parser.parseExisting(decoded.text, context)
          : Parser.parseSpeeches(decoded.text, context));
      }
    }
    const diagnostics = parsed.flatMap(p => p.diagnostics);
    if (diagnostics.length) return { fetches, records: [], diagnostics };
    try {
      const speeches = Parser.dedupeSpeeches(parsed[1].records), records =
        [...parsed[0].records, ...speeches.records, ...parsed[2].records];
      return { fetches, records, diagnostics: [], coverageAudit: { documentCount: 3,
        existingPolicyMeeting: parsed[0].records.length, speechesRemarks: speeches.records.length,
        tankan: parsed[2].records.length, deduped: speeches.deduped,
        excluded: parsed[1].excluded, malformed: 0, unknown: 0, absenceAuthority: "none" } };
    } catch (e) { return { fetches, records: [], diagnostics: [e.message] }; }
  } });
}
function create({ fetchImpl, now = () => new Date().toISOString() } = {}) {
  if (process.type === "renderer") throw Error("main_side_only");
  const transport = Acquisition.createCalendarAcquisitionService({ fetchImpl, now: () => new Date(now()),
    maxRetries: 0, documentContract: contract });
  const builder = Builder.createCalendarCandidateBuilder({ documentContract: contract,
    adapterMap: new Map([[SOURCE_ID, adapter()]]) });
  async function acquire(request) {
    if (request?.sourceId !== SOURCE_ID) return { success: false, reason: "source_mismatch", documents: [] };
    const raw = await transport.acquire(request);
    const candidate = await builder.buildCalendarCandidate({ sourceId: SOURCE_ID, acquisitionResult: raw });
    // No raw HTML/workbook crosses the normal-acquisition persistence/IPC boundary.
    const success = raw.success === true && candidate.candidateStatus === "available";
    return { ...raw, success, reason: success ? null : raw.reason || candidate.parserDiagnostics[0] || "boj_coverage_rejected",
      documents: (raw.documents || []).map(({ parserInput, ...health }) => health),
      candidate, bojCoverageVersion: 2, routeIdentity,
      coverageAudit: candidate.coverageAudit || null, acquisitionIdentity: success ?
        await Canonical.sha256({ candidateIdentity: candidate.candidateIdentity, fetchedAt: raw.fetchedAt,
          documents: raw.documents.map(d => ({ role: d.role, contentSha256: d.contentSha256 })) }) : null };
  }
  return Object.freeze({ acquire });
}
function builder(legacy = Builder) {
  return Object.freeze({ buildCalendarCandidate: input => input?.sourceId === SOURCE_ID &&
    input.acquisitionResult?.bojCoverageVersion === 2
    ? Promise.resolve(input.acquisitionResult.candidate) : legacy.buildCalendarCandidate(input) });
}
module.exports = Object.freeze({ SOURCE_ID, routeIdentity, create, builder });
