"use strict";

const Canonical = require("./economicValueCanonical.js");

const SOURCE_ID = "us-bls-cpi-values";
const AUTHORITY = "BLS";
const PROGRAM = "CPI";
const PARSER_ID = "bls-cpi-release-values";
const PARSER_VERSION = 1;
const MONTHS = Object.freeze({ January: "01", February: "02", March: "03", April: "04",
  May: "05", June: "06", July: "07", August: "08", September: "09", October: "10",
  November: "11", December: "12" });
const SERIES = Object.freeze([
  Object.freeze({ seriesDefinitionKey: "US|BLS|CPI_U|ALL_ITEMS|MOM|SA|PERCENT",
    officialLabel: "All items", indicator: "US_CPI", measure: "month_over_month",
    scope: "US_city_average_all_urban_consumers", unit: "percent", scale: "1",
    seasonalAdjustment: "seasonally_adjusted", periodBasis: "monthly", variant: "headline",
    methodologyIdentity: "BLS_CPI_U", indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BLS|CPI_U|ALL_ITEMS|YOY|NSA|PERCENT",
    officialLabel: "All items", indicator: "US_CPI", measure: "year_over_year",
    scope: "US_city_average_all_urban_consumers", unit: "percent", scale: "1",
    seasonalAdjustment: "not_seasonally_adjusted", periodBasis: "year_over_year", variant: "headline",
    methodologyIdentity: "BLS_CPI_U", indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BLS|CPI_U|LESS_FOOD_ENERGY|MOM|SA|PERCENT",
    officialLabel: "All items less food and energy", indicator: "US_CPI", measure: "month_over_month",
    scope: "US_city_average_all_urban_consumers", unit: "percent", scale: "1",
    seasonalAdjustment: "seasonally_adjusted", periodBasis: "monthly", variant: "core_less_food_energy",
    methodologyIdentity: "BLS_CPI_U", indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BLS|CPI_U|LESS_FOOD_ENERGY|YOY|NSA|PERCENT",
    officialLabel: "All items less food and energy", indicator: "US_CPI", measure: "year_over_year",
    scope: "US_city_average_all_urban_consumers", unit: "percent", scale: "1",
    seasonalAdjustment: "not_seasonally_adjusted", periodBasis: "year_over_year", variant: "core_less_food_energy",
    methodologyIdentity: "BLS_CPI_U", indexBaseIdentity: null, decimalPlaces: 1 })
]);
const DEFINITION_FIELDS = Object.freeze(["seriesDefinitionKey", "officialLabel", "indicator", "measure",
  "scope", "unit", "scale", "seasonalAdjustment", "periodBasis", "variant",
  "methodologyIdentity", "indexBaseIdentity", "decimalPlaces"]);
const decode = value => String(value || "").replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&ndash;|&#8211;/gi, "–").replace(/&minus;|&#8722;/gi, "-")
  .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)));
const text = html => decode(String(html || "")).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ").trim();
const pad = value => String(value).padStart(2, "0");

function zonedInstant(date, hour, minute, timeZone) {
  const [year, month, day] = date.split("-").map(Number), desired = Date.UTC(year, month - 1, day, hour, minute);
  let instant = desired;
  const format = value => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value))
    .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  for (let count = 0; count < 3; count += 1) {
    const parts = format(instant), observed = Date.UTC(Number(parts.year), Number(parts.month) - 1,
      Number(parts.day), Number(parts.hour), Number(parts.minute));
    instant += desired - observed;
  }
  const check = format(instant);
  if (`${check.year}-${check.month}-${check.day}` !== date || Number(check.hour) !== hour ||
      Number(check.minute) !== minute) throw new Error("bls_release_timestamp_invalid");
  return new Date(instant).toISOString();
}

function releaseTable(html) {
  const matches = [...String(html || "").matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map(match => match[0]).filter(table => text(table).includes(
      "Table A. Percent changes in CPI for All Urban Consumers (CPI-U): U.S. city average"));
  if (matches.length !== 1) throw new Error("bls_cpi_structure_change");
  return matches[0];
}
function rowValues(table, officialLabel) {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(cell => text(cell[1])));
  const matching = rows.filter(cells => cells.length >= 3 && cells[0].replace(/\(\d+\)$/, "").trim() === officialLabel);
  if (matching.length !== 1) throw new Error("bls_cpi_structure_change");
  const monthOverMonth = matching[0].at(-2), yearOverYear = matching[0].at(-1);
  if (![monthOverMonth, yearOverYear].every(value => /^-?(?:0|[1-9]\d{0,2})\.\d$/.test(value)))
    throw new Error("bls_cpi_numeric_invalid");
  return Object.freeze({ monthOverMonth, yearOverYear });
}

function parseReleaseHtml(bytesOrText, context = {}) {
  let html;
  try { html = typeof bytesOrText === "string" ? bytesOrText :
    new TextDecoder("utf-8", { fatal: true }).decode(bytesOrText); }
  catch (_error) { throw new Error("bls_cpi_encoding_invalid"); }
  const body = text(html);
  if (!/Consumer Price Index (?:Summary|News Release)/.test(body) ||
      !body.includes("Consumer Price Index for All Urban Consumers"))
    throw new Error("bls_cpi_structure_change");
  const heading = body.match(/CONSUMER PRICE INDEX\s*[-–]\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);
  const embargo = body.match(/8:30\s*a\.m\.\s*\(ET\)\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday),\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})/i);
  if (!heading || !embargo) throw new Error("bls_cpi_structure_change");
  const headingMonth = heading[1][0].toUpperCase() + heading[1].slice(1).toLowerCase();
  const releaseMonth = embargo[1][0].toUpperCase() + embargo[1].slice(1).toLowerCase();
  if (!MONTHS[headingMonth] || !MONTHS[releaseMonth]) throw new Error("bls_cpi_structure_change");
  const referencePeriod = `${heading[2]}-${MONTHS[headingMonth]}`;
  const releaseDate = `${embargo[3]}-${MONTHS[releaseMonth]}-${pad(embargo[2])}`;
  if (context.expectedReleaseDate && context.expectedReleaseDate !== releaseDate)
    throw new Error("bls_cpi_release_date_mismatch");
  const table = releaseTable(html), headline = rowValues(table, "All items"),
    core = rowValues(table, "All items less food and energy"), values = [
      [SERIES[0], headline.monthOverMonth], [SERIES[1], headline.yearOverYear],
      [SERIES[2], core.monthOverMonth], [SERIES[3], core.yearOverYear]
    ].map(([definition, decimalValue]) => Object.freeze({ seriesDefinitionKey: definition.seriesDefinitionKey,
      referencePeriod, decimalValue, unit: definition.unit,
      seasonalAdjustment: definition.seasonalAdjustment, measure: definition.measure }));
  return Canonical.freeze({ parserId: PARSER_ID, parserVersion: PARSER_VERSION, releaseDate,
    referencePeriod, publishedAt: zonedInstant(releaseDate, 8, 30, "America/New_York"), values });
}

function validateDefinition(value) {
  return Canonical.exact(value, DEFINITION_FIELDS) && SERIES.some(definition =>
    Canonical.stable(definition) === Canonical.stable(value));
}
function validateValue(value, definitions = SERIES) {
  if (!Canonical.exact(value, ["seriesDefinitionKey", "referencePeriod", "decimalValue", "unit",
    "seasonalAdjustment", "measure"]) || !Canonical.month(value.referencePeriod) ||
    !Canonical.decimal(value.decimalValue)) return false;
  const definition = definitions.find(item => item.seriesDefinitionKey === value.seriesDefinitionKey);
  return !!definition && value.unit === definition.unit && value.seasonalAdjustment === definition.seasonalAdjustment &&
    value.measure === definition.measure;
}
function calendarLink(value, referencePeriod) {
  if (value == null) return null;
  const expected = `US|US_BLS|US_CPI|${referencePeriod}|initial|national`;
  if (value !== expected) throw new Error("calendar_event_link_invalid");
  return value;
}
function createAcceptedCandidate({ acquisition, acceptedAt, calendarEventKey = null } = {}) {
  if (!Canonical.timestamp(acceptedAt) || !acquisition || acquisition.success !== true ||
      acquisition.sourceId !== SOURCE_ID || !Canonical.timestamp(acquisition.fetchedAt) ||
      !Canonical.hash(acquisition.document?.rawContentHash) ||
      typeof acquisition.document?.sourceUrl !== "string") throw new Error("bls_cpi_acquisition_invalid");
  const parsed = parseReleaseHtml(acquisition.document.parserInput,
    { expectedReleaseDate: acquisition.releaseDate });
  if (parsed.parserId !== PARSER_ID || parsed.parserVersion !== PARSER_VERSION ||
      parsed.releaseDate !== acquisition.releaseDate || !Canonical.month(parsed.referencePeriod) ||
      !Canonical.timestamp(parsed.publishedAt) || !Array.isArray(parsed.values))
    throw new Error("bls_cpi_parser_contract_invalid");
  const definitions = SERIES.map(Canonical.clone);
  if (definitions.some(value => !validateDefinition(value)) || parsed.values.some(value => !validateValue(value, definitions)))
    throw new Error("bls_cpi_value_contract_invalid");
  const current = parsed.values.filter(value => value.referencePeriod === parsed.referencePeriod);
  if (current.length !== SERIES.length || new Set(current.map(value => value.seriesDefinitionKey)).size !== SERIES.length ||
      SERIES.some(definition => !current.some(value => value.seriesDefinitionKey === definition.seriesDefinitionKey)))
    throw new Error("bls_cpi_partial_value_set");
  const duplicate = new Set();
  for (const value of parsed.values) {
    const key = `${value.seriesDefinitionKey}|${value.referencePeriod}`;
    if (duplicate.has(key)) throw new Error("bls_cpi_duplicate_value");
    duplicate.add(key);
  }
  const releaseOccurrenceKey = `US|BLS|CPI|${parsed.releaseDate}`;
  const sourceDocumentKey = `${releaseOccurrenceKey}|sha256:${acquisition.document.rawContentHash}`;
  const runId = Canonical.sha256({ sourceId: SOURCE_ID, fetchedAt: acquisition.fetchedAt,
    sourceDocumentKey, parserId: PARSER_ID, parserVersion: PARSER_VERSION });
  const runKey = `${SOURCE_ID}|${runId}`;
  const values = parsed.values.map(value => {
    const valueKey = `${value.seriesDefinitionKey}|${value.referencePeriod}`,
      fact = { valueKey, seriesDefinitionKey: value.seriesDefinitionKey,
        referencePeriod: value.referencePeriod, decimalValue: value.decimalValue,
        unit: value.unit, seasonalAdjustment: value.seasonalAdjustment, measure: value.measure,
        officialStatus: "published" }, factHash = Canonical.sha256(fact);
    return { ...fact, factHash, revisionKey: `${valueKey}|sha256:${factHash}`,
      releaseOccurrenceKey };
  });
  const release = { releaseOccurrenceKey, authority: AUTHORITY, releaseProgram: PROGRAM,
    officialReleaseDate: parsed.releaseDate, referencePeriod: parsed.referencePeriod,
    publishedAt: parsed.publishedAt, fetchedAt: acquisition.fetchedAt, acceptedAt,
    sourceUrl: acquisition.document.sourceUrl, sourceDocumentKey,
    calendarEventKey: calendarLink(calendarEventKey, parsed.referencePeriod) };
  const document = { sourceDocumentKey, releaseOccurrenceKey, sourceId: SOURCE_ID,
    role: "official_release", sourceUrl: acquisition.document.sourceUrl,
    finalUrl: acquisition.document.finalUrl, fetchedAt: acquisition.fetchedAt,
    mime: acquisition.document.mime, byteCount: acquisition.document.byteCount,
    rawContentHash: acquisition.document.rawContentHash, parserId: PARSER_ID,
    parserVersion: PARSER_VERSION, httpMetadata: Canonical.clone(acquisition.document.httpMetadata) };
  const evidenceMaterial = { sourceId: SOURCE_ID, runId, releaseOccurrenceKey, sourceDocumentKey,
    fetchedAt: acquisition.fetchedAt, acceptedAt, sourcePublishedAt: parsed.publishedAt,
    sourceUrl: document.sourceUrl, parserId: PARSER_ID, parserVersion: PARSER_VERSION,
    rawContentHash: document.rawContentHash, httpMetadata: document.httpMetadata },
    acquisitionEvidenceHash = Canonical.sha256(evidenceMaterial);
  return Canonical.freeze({ sourceId: SOURCE_ID, runId, runKey, acceptedAt,
    definitions, release, document, values, evidenceMaterial, acquisitionEvidenceHash,
    candidateHash: Canonical.sha256({ release, values: values.map(value => value.revisionKey).sort(),
      sourceDocumentKey, acquisitionEvidenceHash }) });
}

module.exports = Canonical.freeze({ SOURCE_ID, AUTHORITY, PROGRAM, PARSER_ID, PARSER_VERSION,
  SERIES, DEFINITION_FIELDS, parseReleaseHtml, validateDefinition, validateValue, createAcceptedCandidate,
  zonedInstant });
