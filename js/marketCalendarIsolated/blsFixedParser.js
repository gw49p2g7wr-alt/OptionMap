"use strict";

const Route = require("./blsFixedRoute.js");
const Dates = require("../calendarDate/calendarDate.js");
const Legacy = require("../marketCalendarShadow/representativeParsers.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const canonicalizer = Canonical.createCanonicalizer(Route.shadowRegistry);
const months = "January February March April May June July August September October November December".split(" ");
const pad = n => String(n).padStart(2, "0");
const plain = s => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
function fail(reason) { return { parserStatus: "invalid", diagnostics: [reason], rows: [], records: [] }; }
function parse(role, html, context) {
  const route = Route.ROLES.find(r => r.role === role);
  if (!route || typeof html !== "string" || Buffer.byteLength(html) > Route.MAX_BYTES) return fail("input_invalid");
  try {
    const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
    const headings = [...clean.matchAll(/<(h[1-6]|title)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => plain(m[2]));
    if (!headings.includes(`Schedule of Releases for the ${route.title}`)) throw Error("release_identity_invalid");
    // Balance tables before choosing the leaf schedule; outer layout tables are not schedule tables.
    const stack = [], tables = [];
    for (const m of clean.matchAll(/<\/?table\b[^>]*>/gi)) {
      if (!m[0].startsWith("</")) stack.push(m.index);
      else { if (!stack.length) throw Error("structure_invalid");
        const start = stack.pop(); tables.push(clean.slice(start, m.index + m[0].length)); }
    }
    if (stack.length) throw Error("structure_invalid");
    const candidates = tables.filter(t => /Reference Month/.test(t) && /Release Date/.test(t) && /Release Time/.test(t));
    const leaves = candidates.filter(t => (t.match(/<table\b/gi) || []).length === 1);
    if (leaves.length !== 1) throw Error("schedule_table_ambiguous");
    const table = leaves[0];
    // Strict nesting within the schedule: no browser repair, scripts, nested tables, row/col spans.
    const tags = [], allowed = new Set(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "p", "span", "strong", "b", "a", "caption", "br"]);
    for (const m of table.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
      const tag = m[1].toLowerCase();
      if (!allowed.has(tag) || /\b(?:rowspan|colspan)\s*=/i.test(m[0])) throw Error("structure_invalid");
      if (tag === "br") continue;
      if (m[0].startsWith("</")) { if (tags.pop() !== tag) throw Error("structure_invalid"); }
      else tags.push(tag);
    }
    if (tags.length) throw Error("structure_invalid");
    const trs = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
    const rows = [], records = []; let header = false;
    for (const tr of trs) {
      const cells = [...tr[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => plain(m[2]));
      if (!header) { if (JSON.stringify(cells) !== JSON.stringify(["Reference Month", "Release Date", "Release Time"]))
        throw Error("headers_invalid"); header = true; continue; }
      if (cells.length !== 3) throw Error("row_invalid");
      const period = cells[0].match(/^([A-Za-z]+) (20\d{2})$/), date = cells[1].match(/^([A-Za-z]+)\.? (\d{1,2}), (20\d{2})$/),
        time = cells[2].match(/^(0?[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/);
      const pm = period && months.indexOf(period[1]), dm = date && months.findIndex(m => m === date[1] || m.slice(0, 3) === date[1]);
      if (!period || pm < 0 || !date || dm < 0 || !time) throw Error("row_invalid");
      const publicationDate = `${date[3]}-${pad(dm + 1)}-${pad(+date[2])}`;
      if (!Dates.isValid(publicationDate)) throw Error("row_invalid");
      const publicationTime = `${pad(+time[1] % 12 + (time[3] === "PM" ? 12 : 0))}:${time[2]}`;
      const referencePeriod = `${period[2]}-${pad(pm + 1)}`;
      if (rows.some(r => r.referencePeriod === referencePeriod)) throw Error("duplicate_identity");
      rows.push({ role, referencePeriod, publicationDate, publicationTime });
      const legacyHtml = `<h1>${months[dm]} ${date[3]}</h1><table><td id="d${pad(dm + 1)}${pad(+date[2])}"><p><strong>${route.title}</strong>${cells[0]} ${cells[2]}</p></td></table>`;
      const mapped = Legacy.parseBls(legacyHtml, context);
      if (mapped.diagnostics.length || mapped.records.length !== 1) throw Error("mapping_invalid");
      records.push(mapped.records[0]);
    }
    if (!rows.length) throw Error("rows_absent");
    rows.sort((a, b) => a.referencePeriod.localeCompare(b.referencePeriod));
    records.sort((a, b) => a.referencePeriod.localeCompare(b.referencePeriod));
    return { parserStatus: "success", diagnostics: [], rows, records,
      timezoneBasis: "inherited_bls_source_contract", timeZone: "America/New_York" };
  } catch (e) { return fail(new Set(["release_identity_invalid", "structure_invalid", "schedule_table_ambiguous",
    "headers_invalid", "row_invalid", "duplicate_identity", "mapping_invalid", "rows_absent"]).has(e.message) ? e.message : "structure_invalid"); }
}
async function buildDocument(role, document, fetchedAt) {
  const route = Route.ROLES.find(r => r.role === role), d = document;
  const bad = reason => ({ role, requestedUrl: route?.url || null, fetchOutcome: "failure",
    parseOutcome: "not_attempted", candidateCount: 0, canonicalRecords: [], rows: [], diagnostic: reason });
  if (!route || !d || d.role !== role || !Route.validateUrl(role, d.requestedUrl).valid) return bad("document_invalid");
  if (d.fetchOutcome !== "success") return bad("document_acquisition_failed");
  if (d.httpStatus !== 200 || d.mime !== "text/html" || !/^text\/html(?:\s*;|\s*$)/i.test(d.contentType || "") ||
      !Array.isArray(d.redirects) || d.redirects.length || !Number.isFinite(Date.parse(fetchedAt)) ||
      !(d.parserInput instanceof Uint8Array) || d.parserInput.length > Route.MAX_BYTES ||
      d.byteCount !== d.parserInput.length || Route.hash(d.parserInput) !== d.contentSha256) return bad("document_invalid");
  const decoded = Route.decode(d.parserInput, d.contentType,
    { sourceId: Route.SOURCE_ID, role, requestedUrl: d.requestedUrl });
  if (!decoded.ok) return bad(decoded.reason);
  const parsed = parse(role, decoded.text, { sourceId: Route.SOURCE_ID, sourceUrl: route.url,
    fetchedAt, parserId: Route.shadowRegistry.getSource(Route.SOURCE_ID).parserId,
    parserVersion: Route.PARSER_VERSION, rawContentHash: d.contentSha256 });
  if (parsed.parserStatus !== "success") return { ...bad(parsed.diagnostics[0]), fetchOutcome: "success", parseOutcome: "invalid" };
  const events = [];
  for (const record of parsed.records) { const c = await canonicalizer.canonicalize(record);
    if (!c.ok) return { ...bad("canonical_invalid"), fetchOutcome: "success", parseOutcome: "invalid" }; events.push(c.event); }
  events.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { role, requestedUrl: route.url, fetchOutcome: "success", parseOutcome: "success", diagnostic: null,
    candidateCount: events.length, canonicalRecords: events, rows: parsed.rows, canonicalDiagnostics: [],
    encodingEvidence: decoded.evidence, encodingWarnings: decoded.warnings, timezoneBasis: parsed.timezoneBasis };
}
module.exports = Object.freeze({ parse, buildDocument });
