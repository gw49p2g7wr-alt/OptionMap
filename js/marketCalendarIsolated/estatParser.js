"use strict";

const Route = require("./estatRoute.js");
const Legacy = require("../marketCalendarShadow/representativeParsers.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Dates = require("../calendarDate/calendarDate.js");
const canonicalizer = Canonical.createCanonicalizer(Route.shadowRegistry);
const norm = value => String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
const decodeText = value => value.replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi,
  entity => { const named = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&apos;": "'" };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) throw Error("structure_invalid");
    return String.fromCodePoint(code); });
const xml = value => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
  '"': "&quot;", "'": "&apos;" })[char]);
const text = node => norm(node.children.map(child => typeof child === "string" ? decodeText(child) : text(child)).join(" "));
const cls = (node, name) => node.attrs?.class?.split(/\s+/).includes(name);
const descendants = (node, predicate) => node.children.flatMap(child => typeof child === "string" ? [] :
  [...(predicate(child) ? [child] : []), ...descendants(child, predicate)]);
function one(nodes, reason = "structure_invalid") { if (nodes.length !== 1) throw Error(reason); return nodes[0]; }

// Strict bounded fragment parser, not a general browser HTML repair engine. Broken nesting is rejected.
function tree(fragment) {
  const root = { tag: "root", children: [] }, stack = [root]; let end = 0, count = 0;
  const tokens = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
  for (const match of fragment.matchAll(tokens)) {
    if (match.index !== end || ++count > 100000) throw Error("structure_invalid");
    end += match[0].length; const token = match[0];
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) { stack.at(-1).children.push(token); continue; }
    const close = token.match(/^<\/([a-z][a-z0-9]*)\s*>$/i);
    if (close) { if (stack.length === 1 || stack.at(-1).tag !== close[1].toLowerCase())
      throw Error("structure_invalid"); stack.pop(); continue; }
    const open = token.match(/^<([a-z][a-z0-9]*)\b([\s\S]*?)\/?\s*>$/i);
    if (!open || /^(script|style|iframe|object)$/i.test(open[1])) throw Error("structure_invalid");
    const attrs = {}, attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const attr of open[2].matchAll(attrPattern)) {
      const key = attr[1].toLowerCase(); if (Object.hasOwn(attrs, key)) throw Error("structure_invalid");
      Object.defineProperty(attrs, key, { value: decodeText(attr[2] ?? attr[3] ?? attr[4]), enumerable: true });
    }
    const node = { tag: open[1].toLowerCase(), attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!/^(br|hr|img|input|meta|link|wbr)$/.test(node.tag) && !token.endsWith("/>")) stack.push(node);
    if (stack.length > 40) throw Error("structure_invalid");
  }
  if (end !== fragment.length || stack.length !== 1) throw Error("structure_invalid");
  return root;
}
function classification(sourceId, title) {
  const value = norm(title).replace(/\s/g, "");
  const match = sourceId === "jp-stat-cpi" ? value.match(/^(20\d{2})年(\d{1,2})月分$/) :
    value.match(/^基本集計\((20\d{2})年(\d{1,2})月分\)$/);
  if (match) {
    if (+match[2] < 1 || +match[2] > 12) throw Error("target_month_invalid");
    return { eligible: true, targetMonth: `${match[1]}-${match[2].padStart(2, "0")}`, kind: "monthly" };
  }
  // Benchmark/retrospective releases may name a whole range of monthly observations.
  if (/基準|遡及|接続指数/.test(value)) return { eligible: false, kind: "benchmark_or_retrospective" };
  if (/月分/.test(value) && (sourceId === "jp-stat-cpi" || /^基本集計/.test(value)))
    throw Error("target_month_invalid");
  return { eligible: false, kind: /詳細集計/.test(value) ? "detailed" : /年度平均/.test(value)
    ? "fiscal_year_average" : /年平均/.test(value) ? "calendar_year_average" : /月期|四半期/.test(value)
      ? "quarterly" : /基準|遡及|接続指数/.test(value) ? "benchmark_or_retrospective" : "other_publication" };
}
function parse(sourceId, html, context) {
  const bad = reason => ({ sourceId, parserStatus: "invalid", diagnostics: [reason], rows: [], records: [] });
  const route = Route.ROUTES[sourceId]; if (!route) return bad("source_invalid");
  if (typeof html !== "string" || Buffer.byteLength(html) > route.maxBytes) return bad("body_size_exceeded");
  try {
    const main = one([...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)])[1];
    if (!/政府統計名に関連する公表予定一覧/.test(main)) throw Error("statistics_identity_invalid");
    const meta = tree(one([...main.matchAll(/<dl\b[^>]*>[\s\S]*?<\/dl\s*>/gi)])[0]);
    const dl = one(descendants(meta, n => n.tag === "dl"));
    const fields = dl.children.filter(n => typeof n !== "string"), map = new Map();
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i]?.tag !== "dt" || fields[i + 1]?.tag !== "dd" || map.has(text(fields[i])))
        throw Error("statistics_identity_invalid");
      map.set(text(fields[i]), text(fields[i + 1]));
    }
    if (map.get("組織") !== "総務省" || map.get("政府統計名") !== route.statisticsName)
      throw Error("statistics_identity_invalid");
    const fragment = one([...main.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)])[0];
    const table = one(descendants(tree(fragment), n => n.tag === "table"));
    const rows = [], records = [];
    for (const child of table.children) {
      if (typeof child === "string" && !child.trim()) continue;
      if (child.tag !== "tbody") throw Error("scope_ambiguous");
      let group = null;
      for (const tr of child.children) {
        if (typeof tr === "string" && !tr.trim()) continue;
        if (tr.tag !== "tr") throw Error("scope_ambiguous");
        const cells = tr.children.filter(n => typeof n !== "string" || n.trim());
        if (cells.length !== 2 || cells.some(n => n.tag !== "td")) throw Error("scope_ambiguous");
        const container = one(cells[1].children.filter(n => typeof n !== "string" || n.trim()), "scope_ambiguous");
        if (!cls(container, "detail_list_table")) throw Error("scope_ambiguous");
        const blocks = container.children.filter(n => typeof n !== "string" || n.trim());
        const expected = blocks.length === 3 ? ["detail_list_header", "detail_list_title", "detail_list_flex"] :
          ["detail_list_title", "detail_list_flex"];
        if (blocks.length !== expected.length || blocks.some((n, i) => n.tag !== "div" || !cls(n, expected[i])))
          throw Error("scope_ambiguous");
        const headings = descendants(tr, n => cls(n, "detail_list_header"));
        if (headings.length > 1) throw Error("scope_ambiguous");
        if (headings.length) {
          group = text(headings[0]);
          if (sourceId === "jp-stat-cpi") {
            if (!["全国", "東京都区部(中旬速報値)"].includes(group)) throw Error("scope_ambiguous");
          } else if (!/^20\d{2}年(?:[1-9]|1[0-2])月分$/.test(group)) throw Error("scope_ambiguous");
        }
        if (!group || descendants(tr, n => ["section", "article", "table", "tbody", "tr"].includes(n.tag)).length)
          throw Error("scope_ambiguous");
        const titleNode = one(descendants(tr, n => cls(n, "detail_list_title")), "scope_ambiguous");
        const title = text(titleNode), kind = classification(sourceId, title);
        const publication = one(descendants(tr, n => n.tag === "ul").filter(ul =>
          ul.children.some(n => typeof n !== "string" && n.tag === "li" && text(n) === "公表日")),
        "publication_invalid");
        const items = publication.children.filter(n => typeof n !== "string");
        if (items.length !== 2 || items.some(n => n.tag !== "li") || text(items[0]) !== "公表日")
          throw Error("publication_invalid");
        const stamp = text(items[1]).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
        if (!stamp || !Dates.isValid(stamp[1]) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(stamp[2]))
          throw Error("publication_invalid");
        const row = { ...kind, lane: sourceId === "jp-stat-cpi" ? group === "全国" ? "national" : "tokyo" : "basic",
          publicationDate: stamp[1], publicationTime: stamp[2] };
        rows.push(row);
        if (!kind.eligible) continue;
        if (sourceId === "jp-stat-labor" && classification("jp-stat-cpi", group).targetMonth !== kind.targetMonth)
          throw Error("target_month_ambiguous");
        // Representation adapter only: reuse the existing, authoritative monthly semantic mapping.
        const [year, month, day] = stamp[1].split("-"), [hour, minute] = stamp[2].split(":");
        const legacyGroup = group === "東京都区部(中旬速報値)" ? "東京都区部（中旬速報値）" : group;
        const legacyTitle = sourceId === "jp-stat-cpi" ? title.replace(/\s/g, "") : title;
        const input = `<class_1 name="${xml(legacyGroup)}"><class_2 name="${xml(legacyTitle)}"><class_3>` +
          `<release_year>${year}</release_year><release_month>${month}</release_month><release_day>${day}</release_day>` +
          `<release_hour>${hour}</release_hour><release_minute>${minute}</release_minute></class_3></class_2></class_1>`;
        const mapped = sourceId === "jp-stat-cpi" ? Legacy.parseStatCpiXml(input, context) : Legacy.parseStatLaborXml(input, context);
        if (mapped.diagnostics.length || mapped.records.length !== 1) throw Error("semantic_mapping_invalid");
        records.push(mapped.records[0]);
      }
    }
    const keys = records.map(r => `${r.scope}|${r.referencePeriod}`);
    if (new Set(keys).size !== keys.length) throw Error("duplicate_identity");
    if (!rows.length) throw Error("structure_invalid");
    rows.sort((a, b) => Canonical.stable(a).localeCompare(Canonical.stable(b)));
    return { sourceId, parserStatus: "success", diagnostics: [], rows, records };
  } catch (error) {
    const allowed = new Set(["structure_invalid", "statistics_identity_invalid", "scope_ambiguous",
      "publication_invalid", "target_month_invalid", "target_month_ambiguous", "semantic_mapping_invalid", "duplicate_identity"]);
    return bad(allowed.has(error.message) ? error.message : "structure_invalid");
  }
}
async function buildCandidate({ sourceId, acquisitionResult } = {}) {
  const fail = reason => ({ sourceId, candidateStatus: "rejected", formalEligible: false,
    candidateIdentity: null, canonicalRecords: [], recordCount: 0, classifiedRows: [],
    diagnostics: [reason], writerEnabled: false, productionActive: false });
  const route = Route.ROUTES[sourceId], result = acquisitionResult, doc = result?.document;
  if (!route || !result?.success || result.sourceId !== sourceId || doc?.httpStatus !== 200 ||
      !Route.validateUrl(sourceId, doc.finalUrl).valid || !route.allowedMime.includes(doc.mime) ||
      String(doc.contentType).split(";", 1)[0].trim().toLowerCase() !== doc.mime ||
      !Number.isFinite(Date.parse(result.fetchedAt)) || !(doc.parserInput instanceof Uint8Array) ||
      doc.parserInput.length > route.maxBytes || doc.parserInput.length !== doc.byteCount ||
      Route.hash(doc.parserInput) !== doc.contentSha256 ||
      !Array.isArray(doc.redirects) || doc.redirects.length > 3 || doc.redirects.some(r =>
        !Route.validateUrl(sourceId, r.from).valid || !Route.validateUrl(sourceId, r.to).valid))
    return fail("acquisition_invalid");
  const decoded = Route.decode(doc.parserInput, doc.contentType);
  if (!decoded.ok) return fail(decoded.reason);
  const source = Route.shadowRegistry.getSource(sourceId);
  const parsed = parse(sourceId, decoded.text, { sourceId, sourceUrl: route.url, fetchedAt: result.fetchedAt,
    parserId: source.parserId, parserVersion: Route.PARSER_VERSION, rawContentHash: doc.contentSha256 });
  if (parsed.parserStatus !== "success") return { ...fail(parsed.diagnostics[0]), parserStatus: "invalid" };
  const events = [];
  for (const record of parsed.records) {
    const canonical = await canonicalizer.canonicalize(record);
    if (!canonical.ok) return fail("canonical_invalid");
    events.push(canonical.event);
  }
  events.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  const available = events.length > 0;
  return { sourceId, candidateStatus: available ? "available" : "unavailable", formalEligible: available,
    candidateIdentity: available ? await Canonical.sha256({ sourceId, parserVersion: Route.PARSER_VERSION,
      sourceContractVersion: Route.SOURCE_CONTRACT_VERSION, revisionKeys: events.map(e => e.revisionKey) }) : null,
    canonicalRecords: events, recordCount: events.length, classifiedRows: parsed.rows,
    parserStatus: "success", canonicalDiagnostics: [], diagnostics: available ? [] : ["eligible_monthly_rows_absent"],
    encodingEvidence: decoded.evidence, sourceContractVersion: Route.SOURCE_CONTRACT_VERSION,
    parserVersion: Route.PARSER_VERSION, writerEnabled: false, productionActive: false };
}
module.exports = Object.freeze({ parse, buildCandidate });
