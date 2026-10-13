"use strict";

// Four explicit scheduled-publication families. No archive/detail crawling,
// meeting inference from URLs, business-day arithmetic, or cancellation authority.
const XLSX = require("xlsx"), Identity = require("../marketCalendar/marketEventIdentity.js"),
  Canonical = require("../marketCalendar/marketEventCanonicalizer.js"), Safety = require("./workbookSafety.js");
const pad = n => String(n).padStart(2, "0");
const text = s => String(s).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const compact = s => text(s).replace(/\s+/g, "");
const TYPES = Object.freeze(["BOJ_SUMMARY_OF_OPINIONS", "BOJ_OUTLOOK_REPORT", "BOJ_MPM_MINUTES", "JP_CGPI"]);
const titles = { BOJ_SUMMARY_OF_OPINIONS: "金融政策決定会合における主な意見", BOJ_OUTLOOK_REPORT: "経済・物価情勢の展望（基本的見解）",
  BOJ_MPM_MINUTES: "金融政策決定会合議事要旨", JP_CGPI: "企業物価指数" };
function record(c, type, identity, time, references = []) {
  const date = identity.publicationDate;
  if (!Identity.validateBojPublicationIdentity(type, identity)) throw Error("boj_publication_identity_invalid");
  return { ...c, sourcePublishedAt: null, sourceUpdatedAt: null, sourceStatus: "scheduled", absenceAuthority: "none",
    authorityEventId: null, eventType: type, sourceTitle: titles[type], titleJa: titles[type], bojPublicationIdentity: identity,
    sourceLocalSchedule: { kind: time ? "instant" : "date_only", precision: time ? "exact" : "date_only",
      startDate: date, startTime: time, endDate: null, endTime: null, timeZone: "Asia/Tokyo" },
    httpMetadata: { ...c.httpMetadata, scheduleReferences: [...new Set([c.sourceUrl, ...references])].sort() } };
}
function date(s, year) {
  const m = compact(s).replace(/\[PDF[^\]]+\]$/, "").match(/^(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日（[月火水木金土日]）$/);
  if (!m) throw Error("boj_publication_date_invalid");
  const d = `${m[1] || year}-${pad(m[2])}-${pad(m[3])}`;
  if (!Identity.validAuctionDate(d)) throw Error("boj_publication_date_invalid");
  return d;
}
function meeting(s, year) {
  const m = compact(s).replace(/\[PDF[^\]]+\]$/, "").match(/^(\d{1,2})月(\d{1,2})日（[月火水木金土日]）・(\d{1,2})日（[月火水木金土日]）$/);
  if (!m) throw Error("boj_publication_meeting_invalid");
  const start = `${year}-${pad(m[1])}-${pad(m[2])}`, end = `${year}-${pad(m[1])}-${pad(m[3])}`;
  if (!Identity.validAuctionDate(start) || !Identity.validAuctionDate(end) || end < start) throw Error("boj_publication_meeting_invalid");
  return { meetingStartDate: start, meetingEndDate: end };
}
function reference(cell, type) {
  const links = [...cell.matchAll(/href=["']([^"']+)["']/gi)];
  if (!links.length) return [];
  if (links.length !== 1) throw Error("boj_publication_reference_ambiguous");
  const u = new URL(links[0][1], "https://www.boj.or.jp");
  const patterns = { BOJ_SUMMARY_OF_OPINIONS: /^\/mopo\/mpmsche_minu\/opinion_20\d{2}\/opi\d{6}\.pdf$/,
    BOJ_OUTLOOK_REPORT: /^\/mopo\/outlook\/gor\d{4}b\.pdf$/, BOJ_MPM_MINUTES: /^\/mopo\/mpmsche_minu\/minu_20\d{2}\/g\d{6}\.pdf$/ };
  if (u.origin !== "https://www.boj.or.jp" || u.search || u.hash || u.username || u.password || !patterns[type].test(u.pathname))
    throw Error("boj_publication_reference_invalid");
  return [u.href];
}
function parseMeetings(html, context) {
  try {
    const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m => m[0])
      .filter(t => /^表20\d{2}年$/.test(compact(t.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || "")));
    if (!tables.length || tables.length > 2) throw Error("boj_publication_tables_invalid");
    const notes = [...html.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi)].map(m => m[1])
      .filter(s => [...s.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>/gi)].some(m => compact(m[1]) === "主な意見"));
    if (notes.length !== tables.length) throw Error("boj_publication_time_notes_missing");
    for (const note of notes) {
      const pairs = [...note.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)];
      for (const [label, expected] of [["主な意見", "：8時50分"], ["議事要旨", "：8時50分"],
        ["経済・物価情勢の展望（基本的見解）", "：会合終了後直ちに"]]) {
        const found = pairs.filter(p => compact(p[1]) === label);
        if (found.length !== 1 || compact(found[0][2]) !== expected) throw Error("boj_publication_time_note_changed");
      }
    }
    const years = new Set(), records = []; let unpublished = 0;
    for (const table of tables) {
      const year = Number(compact(table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)[1]).slice(1, 5));
      if (years.has(year)) throw Error("boj_publication_duplicate_year"); years.add(year);
      const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => compact(m[1]));
      if (headers.join("|") !== ["金融政策決定会合開催日および結果", "各資料の公表日", "総裁定例記者会見",
        "経済・物価情勢の展望（基本的見解）", "主な意見", "議事要旨"].join("|")) throw Error("boj_publication_headers_changed");
      const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
      if (!body) throw Error("boj_publication_body_missing");
      const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
      if (rows.length !== 8) throw Error("boj_publication_meeting_count_changed");
      const meetings = new Set();
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
        if (cells.length !== 5) throw Error("boj_publication_cells_changed");
        const related = meeting(cells[0], year), id = JSON.stringify(related);
        if (meetings.has(id)) throw Error("boj_publication_duplicate_meeting"); meetings.add(id);
        for (const [index, type, time] of [[1, TYPES[1], null], [2, TYPES[0], "08:50"], [3, TYPES[2], "08:50"]]) {
          const label = compact(cells[index]);
          if (label === "-" && index === 1) continue; // Official non-Outlook meeting.
          if (label === "未定") { unpublished++; continue; } // No inferred release date.
          const publicationDate = date(cells[index], year), rule = Identity.BOJ_PUBLICATIONS[type];
          records.push(record(context, type, { sourceId: "jp-boj-calendar", authority: "BOJ", family: rule[0],
            reportType: rule[1], ...related, publicationDate }, time, reference(cells[index], type)));
        }
      }
    }
    const sortedYears = [...years].sort();
    if (sortedYears.length === 2 && sortedYears[1] !== sortedYears[0] + 1) throw Error("boj_publication_year_gap");
    return { records, diagnostics: [], unpublished };
  } catch (e) { return { records: [], diagnostics: [e.message], unpublished: 0 }; }
}
function parseCgpi(bytes, context) {
  try {
    const safe = Safety.inspectWorkbook(bytes); if (!safe.valid) throw Error(safe.reason);
    const meta = XLSX.read(bytes, { type: "array", bookSheets: true, bookDeps: false, bookVBA: false });
    if (meta.SheetNames.join("|") !== "表紙|統計データ") throw Error("boj_cgpi_sheets_changed");
    const book = XLSX.read(bytes, { type: "array", sheets: ["統計データ"], sheetRows: 238,
      cellFormula: true, cellHTML: false, bookDeps: false, bookVBA: false }), sheet = book.Sheets["統計データ"];
    if (book.Workbook?.WBProps?.date1904) throw Error("boj_cgpi_date_system_invalid");
    const value = key => { const c = sheet[key]; if (!c || c.f !== undefined || c.l !== undefined) throw Error("boj_cgpi_cell_invalid"); return c.v; };
    if (value("A1") !== "統計データの公表・掲載予定" || value("B2") !== "統計名" || value("A237") !== "９．物価関連統計" ||
        value("B237") !== titles.JP_CGPI || value("B238") !== titles.JP_CGPI || value("D238") !== "(月次)" ||
        typeof value("D237") !== "number" || Math.abs(value("D237") * 1440 - 530) > 1e-7) throw Error("boj_cgpi_structure_changed");
    const records = []; let year = null, lastMonth = null, unpublished = 0;
    for (const col of "EFGHIJKLMNOP") {
      const h = String(value(col + "2")).replace(/\s+/g, "").match(/^(?:(20\d{2})年)?(\d{1,2})月$/);
      if (!h || !h[1] && year === null) throw Error("boj_cgpi_month_invalid");
      const month = Number(h[2]);
      if (h[1]) { const next = Number(h[1]); if (year !== null && next !== year + (month === 1 ? 1 : 0)) throw Error("boj_cgpi_year_invalid"); year = next; }
      else if (lastMonth === 12) throw Error("boj_cgpi_year_missing");
      if (month < 1 || month > 12 || lastMonth !== null && month !== lastMonth % 12 + 1) throw Error("boj_cgpi_month_sequence_invalid"); lastMonth = month;
      const serial = value(col + "238"), p = value(col + "237");
      if (serial === "―" && p === "―") { unpublished++; continue; }
      const period = String(p).match(/^\((\d{1,2})月分\)$/), d = typeof serial === "number" && XLSX.SSF.parse_date_code(serial);
      const expectedMonth = month === 1 ? 12 : month - 1;
      if (!period || Number(period[1]) !== expectedMonth || !Number.isInteger(serial) || !d || d.y !== year || d.m !== month)
        throw Error("boj_cgpi_date_period_invalid");
      records.push(record(context, "JP_CGPI", { sourceId: "jp-boj-calendar", authority: "BOJ", family: "CGPI",
        reportType: "monthly_release", publicationDate: `${d.y}-${pad(d.m)}-${pad(d.d)}`,
        referencePeriod: `${month === 1 ? year - 1 : year}-${pad(expectedMonth)}` }, "08:50"));
    }
    return { records, diagnostics: [], unpublished };
  } catch (e) { return { records: [], diagnostics: [e.message], unpublished: 0 }; }
}
function dedupe(records) {
  const found = new Map(); let deduped = 0;
  for (const r of records) {
    const key = Identity.eventKeyFor({ jurisdiction: "JP", authority: "BOJ", eventType: r.eventType, bojPublicationIdentity: r.bojPublicationIdentity });
    const prior = found.get(key);
    if (!prior) found.set(key, structuredClone(r));
    else {
      if (Canonical.stable(prior.sourceLocalSchedule) !== Canonical.stable(r.sourceLocalSchedule) || prior.sourceStatus !== r.sourceStatus)
        throw Error("boj_publication_schedule_conflict");
      prior.httpMetadata.scheduleReferences = [...new Set([...prior.httpMetadata.scheduleReferences, ...r.httpMetadata.scheduleReferences])].sort(); deduped++;
    }
  }
  return { records: [...found.values()], deduped };
}
module.exports = Object.freeze({ TYPES, parseMeetings, parseCgpi, dedupe });
