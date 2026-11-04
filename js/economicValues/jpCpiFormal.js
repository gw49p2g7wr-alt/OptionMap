"use strict";

const Canonical = require("./economicValueCanonical.js");
const { zonedInstant } = require("./blsCpiFormal.js");
const Encoding = require("./jpCpiEncoding.js");
const SourceEvidence = require("../sourceEvidence/sourceEvidenceContract.js");

const SOURCE_ID = "jp-statistics-bureau-cpi-values";
const AUTHORITY = "JP_STATISTICS_BUREAU";
const PROGRAM = "CPI_NATIONAL";
const RELEASE_KEY_PREFIX = "JP|JP_STATISTICS_BUREAU|CPI_NATIONAL|";
const PARSER_ID = "jp-statistics-bureau-cpi-release-values";
const PARSER_VERSION = 1;
const SERIES_COUNT = 6;
const DEFINITION_FIELDS = Object.freeze(["seriesDefinitionKey", "officialLabel", "indicator", "measure",
  "scope", "unit", "scale", "seasonalAdjustment", "periodBasis", "variant",
  "methodologyIdentity", "indexBaseIdentity", "decimalPlaces"]);
const SERIES_ROLES = Object.freeze([
  Object.freeze({ code: "0001", label: "総合", role: "ALL_ITEMS" }),
  Object.freeze({ code: "0161", label: "生鮮食品を除く総合", role: "LESS_FRESH_FOOD" }),
  Object.freeze({ code: "0178", label: "生鮮食品及びエネルギーを除く総合", role: "LESS_FRESH_FOOD_ENERGY" })
]);
const GEOGRAPHIES = Object.freeze({ national: Object.freeze({ key: "NATIONAL", scope: "Japan_nationwide",
  heading: "全国" }), tokyo_wards: Object.freeze({ key: "TOKYO_WARDS", scope: "Tokyo_23_wards",
  heading: "東京都区部" }) });
const decode = value => String(value || "").replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)));
const text = html => decode(String(html || "")).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .normalize("NFKC").replace(/\s+/g, " ").trim();
const pad = value => String(value).padStart(2, "0");
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function dateFromJapanese(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    throw new Error("jp_cpi_date_invalid");
  return `${year}-${pad(month)}-${pad(day)}`;
}
function seriesForBaseYear(baseYear, geography = "national") {
  if (!/^20\d{2}$/.test(String(baseYear)) || Number(baseYear) % 5 !== 0 || !GEOGRAPHIES[geography])
    throw new Error("jp_cpi_series_identity_invalid");
  const place = GEOGRAPHIES[geography], base = `${baseYear}=100`;
  return Canonical.freeze(SERIES_ROLES.flatMap(role => [
    { seriesDefinitionKey: `JP|JP_STATISTICS_BUREAU|CPI|${place.key}|${role.code}|INDEX|NSA|${baseYear}`,
      officialLabel: role.label, indicator: "JP_CPI", measure: "index_level", scope: place.scope,
      unit: "index_points", scale: "1", seasonalAdjustment: "not_seasonally_adjusted",
      periodBasis: "monthly", variant: role.code, methodologyIdentity: `JP_CPI_${place.key}_${baseYear}_BASE`,
      indexBaseIdentity: base, decimalPlaces: 1 },
    { seriesDefinitionKey: `JP|JP_STATISTICS_BUREAU|CPI|${place.key}|${role.code}|YOY|NSA|${baseYear}`,
      officialLabel: role.label, indicator: "JP_CPI", measure: "year_over_year", scope: place.scope,
      unit: "percent", scale: "1", seasonalAdjustment: "not_seasonally_adjusted",
      periodBasis: "year_over_year", variant: role.code, methodologyIdentity: `JP_CPI_${place.key}_${baseYear}_BASE`,
      indexBaseIdentity: base, decimalPlaces: 1 }
  ]));
}
function definitionIdentity(value) {
  if (!Canonical.exact(value, DEFINITION_FIELDS)) return null;
  const base = String(value.indexBaseIdentity || "").match(/^(20\d{2})=100$/),
    geography = Object.keys(GEOGRAPHIES).find(key => GEOGRAPHIES[key].scope === value.scope);
  return base && geography ? { baseYear: base[1], geography } : null;
}
function validateDefinition(value) {
  const identity = definitionIdentity(value);
  if (!identity) return false;
  let expected;
  try { expected = seriesForBaseYear(identity.baseYear, identity.geography); } catch (_error) { return false; }
  return expected.some(definition => Canonical.stable(definition) === Canonical.stable(value));
}
function validateDefinitionSet(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== SERIES_COUNT) return false;
  const identities = definitions.map(definitionIdentity);
  if (identities.some(value => !value) || new Set(identities.map(value =>
    `${value.baseYear}|${value.geography}`)).size !== 1) return false;
  const expected = seriesForBaseYear(identities[0].baseYear, identities[0].geography);
  return expected.every(definition => definitions.some(value => Canonical.stable(value) === Canonical.stable(definition)));
}
function validateValue(value, definitions) {
  if (!Canonical.exact(value, ["seriesDefinitionKey", "referencePeriod", "decimalValue", "unit",
    "seasonalAdjustment", "measure"]) || !Canonical.month(value.referencePeriod) ||
    !/^-?(?:0|[1-9]\d{0,3})\.\d$/.test(value.decimalValue)) return false;
  const definition = definitions.find(item => item.seriesDefinitionKey === value.seriesDefinitionKey);
  return !!definition && validateDefinition(definition) && value.unit === definition.unit &&
    value.seasonalAdjustment === definition.seasonalAdjustment && value.measure === definition.measure;
}
function parseDirection(decimal, direction) {
  if (!/^(?:0|[1-9]\d{0,2})\.\d$/.test(decimal)) throw new Error("jp_cpi_numeric_invalid");
  if (direction === "低下") return decimal === "0.0" ? decimal : `-${decimal}`;
  if (direction === "上昇") return decimal;
  if (direction === "同水準" && decimal === "0.0") return decimal;
  throw new Error("jp_cpi_direction_invalid");
}
function correctionPublishedAt(body, releaseDate) {
  if (!body.includes("【訂正版】")) return null;
  const match = body.match(/訂正公表:\s*(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時(\d{2})分/);
  if (!match) throw new Error("jp_cpi_correction_time_unverifiable");
  const date = dateFromJapanese(Number(match[1]), Number(match[2]), Number(match[3])), hour = Number(match[4]),
    minute = Number(match[5]);
  if (date !== releaseDate) throw new Error("jp_cpi_correction_date_mismatch");
  if (hour > 23 || minute > 59) throw new Error("jp_cpi_correction_time_invalid");
  return zonedInstant(date, hour, minute, "Asia/Tokyo");
}
function parseReleaseHtml(bytesOrText, context = {}) {
  let html;
  try { html = Encoding.decode(bytesOrText); }
  catch (_error) { throw new Error("jp_cpi_encoding_invalid"); }
  const body = text(html), heading = body.match(/(20\d{2})年基準\s+消費者物価指数\s+全国\s+(20\d{2})年(?:\(令和\d+年\))?(\d{1,2})月分\s*\((20\d{2})年(\d{1,2})月(\d{1,2})日公表\)/);
  if (!heading)
    throw new Error("jp_cpi_structure_change");
  const baseYear = heading[1], referencePeriod = `${heading[2]}-${pad(heading[3])}`,
    releaseDate = dateFromJapanese(Number(heading[4]), Number(heading[5]), Number(heading[6]));
  if (!Canonical.month(referencePeriod) || context.expectedReleaseDate && context.expectedReleaseDate !== releaseDate)
    throw new Error("jp_cpi_release_date_mismatch");
  const definitions = seriesForBaseYear(baseYear, "national"), values = [];
  for (const [index, role] of SERIES_ROLES.entries()) {
    const labelMatches = [...body.matchAll(new RegExp(`\\(\\d+\\)\\s*${escape(role.label)}指数`, "g"))],
      pattern = new RegExp(`\\(${index + 1}\\)\\s*${escape(role.label)}指数\\s*は` +
      `${index === 0 ? `${baseYear}年を100として` : ""}\\s*(\\d{1,4}\\.\\d)\\s*` +
      `前年同月比は(\\d{1,3}\\.\\d)%の(上昇|低下|同水準)`, "g"), matches = [...body.matchAll(pattern)];
    if (labelMatches.length !== 1 || matches.length !== 1) throw new Error("jp_cpi_structure_change");
    const indexDefinition = definitions.find(value => value.variant === role.code && value.measure === "index_level"),
      yoyDefinition = definitions.find(value => value.variant === role.code && value.measure === "year_over_year");
    values.push({ seriesDefinitionKey: indexDefinition.seriesDefinitionKey, referencePeriod,
      decimalValue: matches[0][1], unit: indexDefinition.unit,
      seasonalAdjustment: indexDefinition.seasonalAdjustment, measure: indexDefinition.measure },
    { seriesDefinitionKey: yoyDefinition.seriesDefinitionKey, referencePeriod,
      decimalValue: parseDirection(matches[0][2], matches[0][3]), unit: yoyDefinition.unit,
      seasonalAdjustment: yoyDefinition.seasonalAdjustment, measure: yoyDefinition.measure });
  }
  const correctedAt = correctionPublishedAt(body, releaseDate);
  return Canonical.freeze({ parserId: PARSER_ID, parserVersion: PARSER_VERSION, releaseDate,
    referencePeriod, baseYear, geography: "national", occurrenceType: correctedAt ? "correction" : "initial",
    publishedAt: correctedAt || zonedInstant(releaseDate, 8, 30, "Asia/Tokyo"), values });
}
function calendarLink(value, referencePeriod, occurrenceType) {
  if (value == null) return null;
  const expected = `JP|JP_STATISTICS_BUREAU|JP_NATIONAL_CPI|${referencePeriod}|${occurrenceType}|national`;
  if (value !== expected) throw new Error("calendar_event_link_invalid");
  return value;
}
function createAcceptedCandidate({ acquisition, acceptedAt, calendarEventKey = null } = {}) {
  if (!Canonical.timestamp(acceptedAt) || !acquisition || acquisition.success !== true ||
      acquisition.sourceId !== SOURCE_ID || !Canonical.timestamp(acquisition.fetchedAt) ||
      !Canonical.hash(acquisition.document?.rawContentHash) || typeof acquisition.document?.sourceUrl !== "string")
    throw new Error("jp_cpi_acquisition_invalid");
  const parsed = parseReleaseHtml(acquisition.document.parserInput,
    { expectedReleaseDate: acquisition.releaseDate || null });
  const definitions = seriesForBaseYear(parsed.baseYear, parsed.geography);
  if (!validateDefinitionSet(definitions) || parsed.values.some(value => !validateValue(value, definitions)) ||
      parsed.values.length !== SERIES_COUNT || new Set(parsed.values.map(value => value.seriesDefinitionKey)).size !== SERIES_COUNT)
    throw new Error("jp_cpi_value_contract_invalid");
  const occurrenceSuffix = parsed.occurrenceType === "correction" ?
      `correction|sha256:${acquisition.document.rawContentHash}` : "initial",
    releaseOccurrenceKey = `${RELEASE_KEY_PREFIX}${parsed.releaseDate}|${occurrenceSuffix}`,
    sourceDocumentKey = `${releaseOccurrenceKey}|document|sha256:${acquisition.document.rawContentHash}`,
    runId = Canonical.sha256({ sourceId: SOURCE_ID, fetchedAt: acquisition.fetchedAt,
      sourceDocumentKey, parserId: PARSER_ID, parserVersion: PARSER_VERSION }), runKey = `${SOURCE_ID}|${runId}`,
    values = parsed.values.map(value => {
      const valueKey = `${value.seriesDefinitionKey}|${value.referencePeriod}`,
        fact = { valueKey, seriesDefinitionKey: value.seriesDefinitionKey, referencePeriod: value.referencePeriod,
          decimalValue: value.decimalValue, unit: value.unit, seasonalAdjustment: value.seasonalAdjustment,
          measure: value.measure, officialStatus: "published" }, factHash = Canonical.sha256(fact);
      return { ...fact, factHash, revisionKey: `${valueKey}|sha256:${factHash}`, releaseOccurrenceKey };
    }), release = { releaseOccurrenceKey, authority: AUTHORITY, releaseProgram: PROGRAM,
      occurrenceType: parsed.occurrenceType, officialReleaseDate: parsed.releaseDate,
      referencePeriod: parsed.referencePeriod, publishedAt: parsed.publishedAt,
      fetchedAt: acquisition.fetchedAt, acceptedAt, sourceUrl: acquisition.document.sourceUrl,
      sourceDocumentKey, calendarEventKey: calendarLink(calendarEventKey, parsed.referencePeriod, parsed.occurrenceType) },
    document = { sourceDocumentKey, releaseOccurrenceKey, sourceId: SOURCE_ID, role: "official_release",
      sourceUrl: acquisition.document.sourceUrl, finalUrl: acquisition.document.finalUrl,
      fetchedAt: acquisition.fetchedAt, mime: acquisition.document.mime,
      byteCount: acquisition.document.byteCount, rawContentHash: acquisition.document.rawContentHash,
      parserId: PARSER_ID, parserVersion: PARSER_VERSION,
      httpMetadata: Canonical.clone(acquisition.document.httpMetadata) },
    evidenceMaterial = { sourceId: SOURCE_ID, runId, releaseOccurrenceKey, sourceDocumentKey,
      fetchedAt: acquisition.fetchedAt, acceptedAt, sourcePublishedAt: parsed.publishedAt,
      sourceUrl: document.sourceUrl, parserId: PARSER_ID, parserVersion: PARSER_VERSION,
      rawContentHash: document.rawContentHash, httpMetadata: document.httpMetadata },
    acquisitionEvidenceHash = Canonical.sha256(evidenceMaterial);
  return Canonical.freeze({ sourceId: SOURCE_ID, runId, runKey, acceptedAt, definitions, release,
    document, values, evidenceMaterial, acquisitionEvidenceHash,
    candidateHash: Canonical.sha256({ release, values: values.map(value => value.revisionKey).sort(),
      sourceDocumentKey, acquisitionEvidenceHash }) });
}
function bindSourceEvidence(candidate, sourceEvidence) {
  if (!candidate || candidate.sourceId !== SOURCE_ID || !candidate.document ||
      Object.hasOwn(candidate.document, "sourceEvidence") ||
      !SourceEvidence.validateSourceEvidenceRef(sourceEvidence) || sourceEvidence.state !== "available" ||
      sourceEvidence.sourceFamily !== "economic_values" || sourceEvidence.sourceId !== SOURCE_ID ||
      sourceEvidence.contentSha256 !== candidate.document.rawContentHash)
    throw new Error("jp_cpi_source_evidence_invalid");
  const document = { ...Canonical.clone(candidate.document),
    sourceEvidence: Canonical.clone(sourceEvidence) }, evidenceMaterial = {
      ...Canonical.clone(candidate.evidenceMaterial), sourceEvidence: Canonical.clone(sourceEvidence) },
    acquisitionEvidenceHash = Canonical.sha256(evidenceMaterial), result = {
      ...Canonical.clone(candidate), document, evidenceMaterial, acquisitionEvidenceHash };
  result.candidateHash = Canonical.sha256({ release: result.release,
    values: result.values.map(value => value.revisionKey).sort(),
    sourceDocumentKey: result.document.sourceDocumentKey, acquisitionEvidenceHash });
  return Canonical.freeze(result);
}
function validateReleaseOccurrenceKey(value, releaseDate, rawContentHash) {
  return value === `${RELEASE_KEY_PREFIX}${releaseDate}|initial` ||
    value === `${RELEASE_KEY_PREFIX}${releaseDate}|correction|sha256:${rawContentHash}`;
}

module.exports = Canonical.freeze({ SOURCE_ID, AUTHORITY, PROGRAM, RELEASE_KEY_PREFIX, PARSER_ID,
  PARSER_VERSION, SERIES_COUNT, SERIES_ROLES, GEOGRAPHIES, DEFINITION_FIELDS, seriesForBaseYear,
  parseReleaseHtml, validateDefinition, validateDefinitionSet, validateValue, createAcceptedCandidate,
  bindSourceEvidence,
  validateReleaseOccurrenceKey, correctionPublishedAt });
