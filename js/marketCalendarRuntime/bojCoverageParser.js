"use strict";

const XLSX = require("xlsx");
const Legacy = require("../marketCalendarShadow/representativeParsers.js");
const Identity = require("../marketCalendar/marketEventIdentity.js");
const Safety = require("./workbookSafety.js");
const pad = n => String(n).padStart(2, "0");
const text = s => String(s).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const base = c => ({ ...c, sourcePublishedAt: null, sourceUpdatedAt: null,
  sourceStatus: "scheduled", absenceAuthority: "none", authorityEventId: null });
const schedule = (date, time = null) => ({ kind: time ? "instant" : "date_only", startDate: date,
  startTime: time, endDate: null, endTime: null, timeZone: "Asia/Tokyo", precision: time ? "exact" : "date_only" });
function dateOf(s) {
  const m = text(s).match(/^(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) throw Error("boj_speech_date_invalid");
  const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time = m[4] ? `${pad(m[4])}:${m[5]}` : null;
  if (!Identity.validAuctionDate(date) || time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw Error("boj_speech_date_invalid");
  return { date, time };
}
function speakerOf(s) {
  const m = text(s).match(/^([一-龯ぁ-んァ-ヶ]{1,30}?)(副総裁|総裁|審議委員)(?:（[^）]+代読）)?$/);
  return m && { speakerId: m[1], speakerRole: ({ 総裁: "governor", 副総裁: "deputy_governor",
    審議委員: "policy_board_member" })[m[2]] };
}
function officialComponent(title, href) {
  let publication = null;
  if (href) {
    const u = new URL(href, "https://www.boj.or.jp");
    const m = u.pathname.match(/^\/about\/press\/koen_20\d{2}\/(ko\d{6}[a-z])\.htm$/);
    if (u.origin !== "https://www.boj.or.jp" || u.search || u.hash || u.username || u.password || !m)
      throw Error("boj_speech_reference_invalid");
    publication = m[1];
  }
  // Extract the named official venue/event, not the complete speech title.
  const future = title.match(/^(.+?)における(?:開会)?(?:挨拶|講演)$/),
    published = title.match(/（([^（）]+)）$/);
  const venue = (future?.[1] || published?.[1]?.replace(/における(?:開会)?挨拶の邦訳$/, ""))
    ?.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (venue && !/[|<>]/.test(venue) && venue.length <= 190) return `venue:${venue}`;
  if (publication) return `publication:${publication}`;
  throw Error("boj_speech_official_identity_missing");
}
function parseSpeeches(html, context) {
  const records = [], diagnostics = [], excluded = []; let tables = 0;
  try {
    for (const [caption, headers] of [
      ["表 最新の講演・挨拶等", ["開催日", "講演者等", "タイトル等"]],
      ["表 今後の講演・挨拶等の予定", ["日程", "講演者等", "講演内容等"]]
    ]) {
      const matches = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
        .filter(m => text(m[0].match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || "") === caption);
      if (matches.length !== 1) throw Error("boj_speech_table_structure_changed");
      tables++;
      const table = matches[0][0], names = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => text(m[1]));
      if (names.join("|") !== headers.join("|")) throw Error("boj_speech_headers_changed");
      const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
      if (!body) throw Error("boj_speech_body_missing");
      const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
      if (rows.length > 100) throw Error("boj_speech_row_limit");
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
        if (cells.length !== 3) throw Error("boj_speech_row_structure_changed");
        const speaker = speakerOf(cells[1]), title = text(cells[2]);
        if (!speaker && /総裁|審議委員/.test(text(cells[1]))) throw Error("boj_speech_speaker_invalid");
        if (!speaker || /国会|研究|記者会見/.test(title)) { excluded.push("out_of_scope"); continue; }
        if (!/挨拶|講演/.test(title)) throw Error("boj_speech_kind_unknown");
        const { date, time } = dateOf(cells[0]), href = cells[2].match(/href=["']([^"']+)["']/i)?.[1];
        const speechIdentity = { sourceId: "jp-boj-calendar", family: "speech_remarks", ...speaker,
          eventDate: date, officialEventComponent: officialComponent(title, href) };
        const officialSpeechReference = href ? new URL(href, "https://www.boj.or.jp").href : null;
        records.push({ ...base(context), eventType: "BOJ_SPEECH", sourceTitle: title,
          titleJa: `${text(cells[1])} ${title}`, speechIdentity, sourceLocalSchedule: schedule(date, time),
          officialSpeechReference, httpMetadata: { ...context.httpMetadata, speechPublicationUrl: officialSpeechReference } });
      }
    }
  } catch (e) { diagnostics.push(e.message); }
  return { records: diagnostics.length ? [] : records, diagnostics, tables, excluded: excluded.length };
}
function dedupeSpeeches(records) {
  const found = new Map(); let deduped = 0;
  for (const record of records) {
    const key = Identity.eventKeyFor({ jurisdiction: "JP", authority: "BOJ", eventType: "BOJ_SPEECH",
      speechIdentity: record.speechIdentity }), previous = found.get(key);
    if (previous) {
      if (previous.officialSpeechReference && record.officialSpeechReference &&
          previous.officialSpeechReference !== record.officialSpeechReference)
        throw Error("boj_speech_publication_conflict");
      if (JSON.stringify(previous.sourceLocalSchedule) !== JSON.stringify(record.sourceLocalSchedule))
        throw Error("boj_speech_schedule_conflict");
      deduped++;
    } else found.set(key, record);
  }
  return { records: [...found.values()], deduped };
}
const TANKAN_LABEL = "短観（全国企業短期経済観測調査）／概要及び要旨";
function parseTankan(bytes, context) {
  try {
    const safe = Safety.inspectWorkbook(bytes);
    if (!safe.valid) throw Error(safe.reason);
    const meta = XLSX.read(bytes, { type: "array", bookSheets: true, bookDeps: false, bookVBA: false });
    if (meta.SheetNames.join("|") !== "表紙|統計データ") throw Error("boj_tankan_sheet_structure_changed");
    // Fixed bounded sheet/range: only read the header and explicit Tankan summary rows.
    const book = XLSX.read(bytes, { type: "array", sheets: ["統計データ"], sheetRows: 231,
      cellFormula: true, cellHTML: false, bookDeps: false, bookVBA: false }), sheet = book.Sheets["統計データ"];
    if (book.Workbook?.WBProps?.date1904) throw Error("boj_tankan_date_system_invalid");
    const value = address => {
      const cell = sheet[address];
      if (!cell || cell.f !== undefined || cell.l !== undefined) throw Error("boj_tankan_required_cell_invalid");
      return cell.v;
    };
    if (value("A1") !== "統計データの公表・掲載予定" || value("B2") !== "統計名" ||
        value("A229") !== "８．短観" || value("B230") !== TANKAN_LABEL || value("B231") !== TANKAN_LABEL ||
        value("D231") !== "(四半期)") throw Error("boj_tankan_required_structure_changed");
    if (typeof value("D230") !== "number") throw Error("boj_tankan_release_time_invalid");
    const minutes = value("D230") * 1440;
    if (Math.abs(minutes - 530) > 1e-7) throw Error("boj_tankan_release_time_changed");
    let year = null, lastMonth = null; const records = [];
    for (const column of "EFGHIJKLMNOP") {
      const header = String(value(`${column}2`)).replace(/\s+/g, ""), m = header.match(/^(?:(20\d{2})年)?(\d{1,2})月$/);
      if (!m || m[1] === undefined && year === null) throw Error("boj_tankan_month_header_invalid");
      const month = Number(m[2]);
      if (m[1]) {
        const nextYear = Number(m[1]);
        if (year !== null && nextYear !== year + (month === 1 ? 1 : 0)) throw Error("boj_tankan_year_sequence_invalid");
        year = nextYear;
      } else if (lastMonth === 12) throw Error("boj_tankan_year_header_missing");
      if (month < 1 || month > 12 || lastMonth !== null && month !== lastMonth % 12 + 1)
        throw Error("boj_tankan_month_sequence_invalid");
      lastMonth = month;
      const serial = value(`${column}231`), period = value(`${column}230`);
      if (serial === "―" && period === "―") continue;
      const p = String(period).match(/^\((3|6|9|12)月調査\)$/), d = typeof serial === "number" && XLSX.SSF.parse_date_code(serial);
      if (!p || !d || !Number.isInteger(serial) || d.y !== year || d.m !== month ||
          !Identity.validAuctionDate(`${d.y}-${pad(d.m)}-${pad(d.d)}`)) throw Error("boj_tankan_release_date_invalid");
      const periodMonth = Number(p[1]), periodYear = periodMonth > month ? year - 1 : year;
      records.push({ ...base(context), eventType: "JP_TANKAN", sourceTitle: TANKAN_LABEL,
        titleJa: "短観（概要及び要旨）", titleEn: "Tankan (Summary)", referencePeriod: `${periodYear}-${pad(periodMonth)}`,
        edition: "initial", scope: "national", sourceLocalSchedule: schedule(`${d.y}-${pad(d.m)}-${pad(d.d)}`, "08:50") });
    }
    if (records.length !== 4) throw Error("boj_tankan_quarter_count_invalid");
    return { records, diagnostics: [] };
  } catch (e) { return { records: [], diagnostics: [e.message] }; }
}
module.exports = Object.freeze({ parseExisting: Legacy.parseBoj, parseSpeeches, dedupeSpeeches, parseTankan });
