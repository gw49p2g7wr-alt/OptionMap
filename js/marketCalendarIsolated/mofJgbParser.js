"use strict";

const Source = require("./mofJgbSource.js");
const MATURITIES = Object.freeze([2, 5, 10, 20, 30, 40]);
const compact = value => Source.text(value).normalize("NFKC").replace(/\s+/g, "");
function classify(rawLabel) {
  const label = compact(rawLabel);
  const excluded = [
    ["climate_transition", /^\d+年クライメート・トランジション利付国債(?:\(第\d+回\))?$/],
    ["inflation_linked", /^\d+年物価連動国債(?:\(第\d+回\))?$/],
    ["treasury_bill", /^国庫短期証券(?:\([^()]+\))?(?:\(第\d+回\))?$/],
    ["liquidity_enhancement", /^流動性供給入札(?:\([^()]+\))?$/],
    ["buyback", /^買入消却(?:\([^()]+\))?$/],
    ["special_account_borrowing", /^特別会計借入金(?:\([^()]+\))?$/]
  ].find(([, pattern]) => pattern.test(label));
  if (excluded) return { include: false, reason: excluded[0] };
  const normal = label.match(/^(\d+)年利付国債(?:\(第(\d+)回\))?$/);
  if (!normal || !MATURITIES.includes(Number(normal[1]))) return { include: false, reason: "unknown_product" };
  return { include: true, maturity: Number(normal[1]), issueNumber: normal[2] || null };
}
function diagnostics() { return { rowsExamined: 0, qualifyingRows: 0, excludedRows: {}, duplicateCount: 0,
  malformedCount: 0, unknownProductCount: 0 }; }
function parseMonth(html, context) {
  const d = diagnostics(), records = [], month = Source.pageMonth(context?.sourceUrl);
  const fail = reason => ({ ok: false, reason, records: [], diagnostics: d, absenceAuthority: "none" });
  if (typeof html !== "string" || !month) return fail("month_input_invalid");
  html = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, "");
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i), label = compact(heading?.[1] || "");
  const h = label.match(/^入札カレンダー[:：](?:令和(\d+)年|((?:20)\d{2})年)(\d{1,2})月$/);
  if (!h || Number(h[1] ? Number(h[1]) + 2018 : h[2]) !== Number(month.slice(0, 4)) ||
      Number(h[3]) !== Number(month.slice(5))) return fail("month_heading_mismatch");
  const sections = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  const selected = sections.filter(s => compact(s[1]) === "(1)国債及び国庫短期証券");
  if (selected.length !== 1) return fail("auction_section_invalid");
  const begin = selected[0].index + selected[0][0].length, end = sections.find(s => s.index >= begin)?.index || html.length;
  const tables = [...html.slice(begin, end).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length !== 1 || /<table\b/i.test(tables[0][1])) return fail("auction_table_invalid");
  const table = tables[0][1], thead = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i),
    tbody = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  const headers = thead && [...thead[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(x => compact(x[1]));
  if (!tbody || headers?.join("|") !== "入札予定日|入札対象国債等|発行予定額等|入札発行について|価格競争入札等|第II非価格競争入札")
    return fail("auction_header_invalid");
  const rows = [...tbody[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if ((tbody[1].match(/<tr\b/gi) || []).length !== rows.length || (tbody[1].match(/<td\b/gi) || []).length !== rows.length * 6)
    return fail("auction_row_structure_invalid");
  const keys = new Set();
  for (const row of rows) {
    d.rowsExamined++;
    const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length !== 6 || cells.some(c => /\b(?:rowspan|colspan)\s*=/i.test(c[1]))) { d.malformedCount++; continue; }
    const dateLabel = compact(cells[0][2]), dm = dateLabel.match(/^(\d{1,2})月(\d{1,2})日(?:\([月火水木金土日]\))?$/),
      date = dm && `${month.slice(0, 4)}-${String(dm[1]).padStart(2, "0")}-${String(dm[2]).padStart(2, "0")}`;
    if (!Source.validDate(date) || date.slice(0, 7) !== month) { d.malformedCount++; continue; }
    const rawLabel = Source.text(cells[1][2]), type = classify(rawLabel);
    if (!type.include) {
      d.excludedRows[type.reason] = (d.excludedRows[type.reason] || 0) + 1;
      if (type.reason === "unknown_product") d.unknownProductCount++;
      continue;
    }
    d.qualifyingRows++;
    const key = `${date}|${type.maturity}`;
    if (keys.has(key)) { d.duplicateCount++; continue; } keys.add(key);
    records.push({ sourceId: Source.SOURCE_ID, eventType: Source.EVENT_TYPE,
      titleJa: `${type.maturity}年国債 入札`, titleEn: `${type.maturity}-year JGB Auction`, sourceTitle: rawLabel,
      eventDate: date, time: null, maturity: `${type.maturity}Y`, instrumentClass: Source.SOURCE.instrumentClass,
      sourcePageMonth: month, rawLabel, issueNumber: type.issueNumber,
      evidenceUrl: context.sourceUrl, sourceUrl: context.sourceUrl,
      sourcePublishedAt: null, sourceUpdatedAt: null, fetchedAt: context.fetchedAt,
      rawContentHash: context.rawContentHash, parserId: "mof-jgb-month-isolated", parserVersion: 1,
      // Explicit auction-date identity proposal, NOT a statistical reference month.
      referencePeriod: `auction-date:${date}`, edition: "normal-fixed-rate", scope: `${type.maturity}Y`,
      authorityEventId: null, sourceStatus: "scheduled", absenceAuthority: "none",
      sourceLocalSchedule: { kind: "date_only", startDate: date, startTime: null, endDate: null,
        endTime: null, timeZone: "Asia/Tokyo", precision: "date_only" } });
  }
  if (d.malformedCount || d.unknownProductCount) return fail(d.malformedCount ? "auction_row_malformed" : "auction_product_unknown");
  return { ok: true, reason: null, records: records.sort((a, b) => a.eventDate.localeCompare(b.eventDate) ||
    Number(a.maturity.slice(0, -1)) - Number(b.maturity.slice(0, -1))), diagnostics: d, absenceAuthority: "none" };
}
module.exports = Object.freeze({ MATURITIES, classify, parseMonth });
