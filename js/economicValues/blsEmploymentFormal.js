"use strict";

const Canonical = require("./economicValueCanonical.js");
const { zonedInstant } = require("./blsCpiFormal.js");

const SOURCE_ID = "us-bls-employment-situation-values";
const AUTHORITY = "BLS";
const PROGRAM = "EMPLOYMENT_SITUATION";
const RELEASE_KEY_PREFIX = "US|BLS|EMPLOYMENT_SITUATION|";
const PARSER_ID = "bls-employment-situation-release-values";
const PARSER_VERSION = 1;
const MONTHS = Object.freeze({ January: "01", February: "02", March: "03", April: "04",
  May: "05", June: "06", July: "07", August: "08", September: "09", October: "10",
  November: "11", December: "12" });
const SERIES = Object.freeze([
  Object.freeze({ seriesDefinitionKey: "US|BLS|CES|TOTAL_NONFARM|MONTHLY_CHANGE|SA|THOUSAND_PERSONS",
    officialLabel: "Total nonfarm payroll employment", indicator: "US_NONFARM_PAYROLLS",
    measure: "monthly_change", scope: "total_nonfarm_payroll_employment", unit: "thousand_persons",
    scale: "1000", seasonalAdjustment: "seasonally_adjusted", periodBasis: "monthly",
    variant: "total_nonfarm", methodologyIdentity: "BLS_CES", indexBaseIdentity: null, decimalPlaces: 0 }),
  Object.freeze({ seriesDefinitionKey: "US|BLS|CPS|CIVILIAN_UNEMPLOYMENT_RATE|LEVEL|SA|PERCENT",
    officialLabel: "Civilian unemployment rate", indicator: "US_UNEMPLOYMENT_RATE",
    measure: "rate", scope: "civilian_noninstitutional_population_age_16_plus", unit: "percent",
    scale: "1", seasonalAdjustment: "seasonally_adjusted", periodBasis: "monthly",
    variant: "official_u3", methodologyIdentity: "BLS_CPS", indexBaseIdentity: null, decimalPlaces: 1 })
]);
const DEFINITION_FIELDS = Object.freeze(["seriesDefinitionKey", "officialLabel", "indicator", "measure",
  "scope", "unit", "scale", "seasonalAdjustment", "periodBasis", "variant",
  "methodologyIdentity", "indexBaseIdentity", "decimalPlaces"]);
const decode = value => String(value || "").replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&ndash;|&#8211;/gi, "–").replace(/&minus;|&#8722;/gi, "-")
  .replace(/&#43;/g, "+").replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)));
const text = html => decode(String(html || "")).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ").trim();
const pad = value => String(value).padStart(2, "0");
const titleMonth = value => value[0].toUpperCase() + value.slice(1).toLowerCase();
function addMonths(period, delta) {
  const [year, month] = period.split("-").map(Number), date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}
function payrollDecimal(value) {
  if (!/^[+-]?(?:0|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) throw new Error("bls_employment_numeric_invalid");
  const persons = Number(value.replace(/,/g, ""));
  if (!Number.isSafeInteger(persons) || persons % 1000 !== 0) throw new Error("bls_employment_unit_invalid");
  return String(persons / 1000);
}
function paragraphs(html) {
  return [...String(html || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => text(match[1]));
}
function currentHeadline(items, referencePeriod) {
  const monthName = Object.keys(MONTHS).find(name => MONTHS[name] === referencePeriod.slice(5)),
    candidates = items.filter(value => value.includes("nonfarm payroll employment") &&
      value.includes("unemployment rate") && new RegExp(`\\b${monthName}\\b`, "i").test(value));
  if (candidates.length !== 1) throw new Error("bls_employment_structure_change");
  const value = candidates[0], compact = value.match(/Both nonfarm payroll employment\s*\(([+-]?[\d,]+)\)\s*and the unemployment rate\s*\((\d{1,2}\.\d) percent\)/i);
  if (compact) return { payroll: payrollDecimal(compact[1]), unemployment: compact[2] };
  const payroll = value.match(/Total nonfarm payroll employment\s+(increased|decreased|edged up|edged down)\s+by\s+([\d,]+)\s+in\s+([A-Za-z]+)/i),
    unemployment = value.match(/unemployment rate\s+(?:was unchanged|changed little|increased|decreased|rose|declined)?\s*(?:at|to)?\s*(\d{1,2}\.\d) percent/i);
  if (!payroll || !unemployment || titleMonth(payroll[3]) !== monthName)
    throw new Error("bls_employment_structure_change");
  const signed = /decreased|down/.test(payroll[1].toLowerCase()) ? `-${payroll[2]}` : payroll[2];
  return { payroll: payrollDecimal(signed), unemployment: unemployment[1] };
}
function revisedPayroll(items, referencePeriod) {
  const candidates = items.filter(value => /change in total nonfarm payroll employment for/i.test(value) &&
    /was revised/i.test(value));
  if (candidates.length > 1) throw new Error("bls_employment_structure_change");
  if (!candidates.length) return [];
  const numericToken = "[+-]?(?:0|[1-9]\\d{0,2}(?:,\\d{3})+)",
    matches = [...candidates[0].matchAll(new RegExp(
      `(?:The change in total nonfarm payroll employment for|the change for)\\s+` +
      `(January|February|March|April|May|June|July|August|September|October|November|December)\\s+` +
      `was revised\\s+(?:up|down)\\s+by\\s+[\\d,]+,\\s+from\\s+(${numericToken})\\s+to\\s+(${numericToken})`, "gi"))];
  if (!matches.length || matches.length > 2) throw new Error("bls_employment_structure_change");
  const expected = new Set([addMonths(referencePeriod, -2), addMonths(referencePeriod, -1)]), seen = new Set();
  return matches.map(match => {
    const monthName = titleMonth(match[1]), candidatesForMonth = [...expected].filter(period =>
      period.slice(5) === MONTHS[monthName]);
    if (candidatesForMonth.length !== 1 || seen.has(candidatesForMonth[0]))
      throw new Error("bls_employment_revision_period_invalid");
    seen.add(candidatesForMonth[0]);
    return Object.freeze({ referencePeriod: candidatesForMonth[0], previousDecimalValue: payrollDecimal(match[2]),
      decimalValue: payrollDecimal(match[3]) });
  }).sort((left, right) => left.referencePeriod.localeCompare(right.referencePeriod));
}
function correctionPublishedAt(body, releaseDate) {
  if (!/\bCORRECT(?:ED|ION)\b/i.test(body)) return null;
  const match = body.match(/Corrected:\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\s+at\s+(\d{1,2}):(\d{2})\s+(a\.m\.|p\.m\.)\s*\(ET\)/i);
  if (!match) throw new Error("bls_employment_correction_time_unverifiable");
  const correctedDate = `${match[3]}-${MONTHS[titleMonth(match[1])]}-${pad(match[2])}`;
  if (correctedDate !== releaseDate) throw new Error("bls_employment_correction_date_mismatch");
  let hour = Number(match[4]);
  if (hour < 1 || hour > 12 || Number(match[5]) > 59) throw new Error("bls_employment_correction_time_invalid");
  if (/p\.m\./i.test(match[6]) && hour !== 12) hour += 12;
  if (/a\.m\./i.test(match[6]) && hour === 12) hour = 0;
  return zonedInstant(releaseDate, hour, Number(match[5]), "America/New_York");
}
function parseReleaseHtml(bytesOrText, context = {}) {
  let html;
  try { html = typeof bytesOrText === "string" ? bytesOrText :
    new TextDecoder("utf-8", { fatal: true }).decode(bytesOrText); }
  catch (_error) { throw new Error("bls_employment_encoding_invalid"); }
  const body = text(html);
  if (!/Employment Situation (?:News Release|Summary)/i.test(body))
    throw new Error("bls_employment_structure_change");
  const heading = body.match(/THE EMPLOYMENT SITUATION\s*[-–—]\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i),
    embargo = body.match(/8:30\s*a\.m\.\s*\(ET\)\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday),\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})/i);
  if (!heading || !embargo) throw new Error("bls_employment_structure_change");
  const referenceMonth = titleMonth(heading[1]), releaseMonth = titleMonth(embargo[1]),
    referencePeriod = `${heading[2]}-${MONTHS[referenceMonth]}`,
    releaseDate = `${embargo[3]}-${MONTHS[releaseMonth]}-${pad(embargo[2])}`;
  if (context.expectedReleaseDate && context.expectedReleaseDate !== releaseDate)
    throw new Error("bls_employment_release_date_mismatch");
  const correctionAt = correctionPublishedAt(body, releaseDate), items = paragraphs(html),
    headline = currentHeadline(items, referencePeriod), revisions = revisedPayroll(items, referencePeriod), values = [
      { seriesDefinitionKey: SERIES[0].seriesDefinitionKey, referencePeriod,
        decimalValue: headline.payroll, unit: SERIES[0].unit,
        seasonalAdjustment: SERIES[0].seasonalAdjustment, measure: SERIES[0].measure },
      { seriesDefinitionKey: SERIES[1].seriesDefinitionKey, referencePeriod,
        decimalValue: headline.unemployment, unit: SERIES[1].unit,
        seasonalAdjustment: SERIES[1].seasonalAdjustment, measure: SERIES[1].measure },
      ...revisions.map(value => ({ seriesDefinitionKey: SERIES[0].seriesDefinitionKey,
        referencePeriod: value.referencePeriod, decimalValue: value.decimalValue, unit: SERIES[0].unit,
        seasonalAdjustment: SERIES[0].seasonalAdjustment, measure: SERIES[0].measure }))
    ];
  return Canonical.freeze({ parserId: PARSER_ID, parserVersion: PARSER_VERSION, releaseDate,
    referencePeriod, publishedAt: correctionAt || zonedInstant(releaseDate, 8, 30, "America/New_York"),
    occurrenceType: correctionAt ? "correction" : "initial",
    payrollRevisions: revisions, values });
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
    value.measure === definition.measure && (definition.decimalPlaces === 0 ? /^-?(?:0|[1-9]\d*)$/.test(value.decimalValue) :
      /^-?(?:0|[1-9]\d*)\.\d$/.test(value.decimalValue));
}
function calendarLink(value, referencePeriod) {
  if (value == null) return null;
  const expected = `US|US_BLS|US_EMPLOYMENT_SITUATION|${referencePeriod}|initial|national`;
  if (value !== expected) throw new Error("calendar_event_link_invalid");
  return value;
}
function createAcceptedCandidate({ acquisition, acceptedAt, calendarEventKey = null } = {}) {
  if (!Canonical.timestamp(acceptedAt) || !acquisition || acquisition.success !== true ||
      acquisition.sourceId !== SOURCE_ID || !Canonical.timestamp(acquisition.fetchedAt) ||
      !Canonical.hash(acquisition.document?.rawContentHash) || typeof acquisition.document?.sourceUrl !== "string")
    throw new Error("bls_employment_acquisition_invalid");
  const parsed = parseReleaseHtml(acquisition.document.parserInput, { expectedReleaseDate: acquisition.releaseDate });
  if (parsed.parserId !== PARSER_ID || parsed.parserVersion !== PARSER_VERSION ||
      parsed.releaseDate !== acquisition.releaseDate || !Canonical.month(parsed.referencePeriod) ||
      !Canonical.timestamp(parsed.publishedAt) || !Array.isArray(parsed.values))
    throw new Error("bls_employment_parser_contract_invalid");
  const definitions = SERIES.map(Canonical.clone);
  if (definitions.some(value => !validateDefinition(value)) || parsed.values.some(value => !validateValue(value, definitions)))
    throw new Error("bls_employment_value_contract_invalid");
  const current = parsed.values.filter(value => value.referencePeriod === parsed.referencePeriod);
  if (current.length !== SERIES.length || new Set(current.map(value => value.seriesDefinitionKey)).size !== SERIES.length ||
      SERIES.some(definition => !current.some(value => value.seriesDefinitionKey === definition.seriesDefinitionKey)) ||
      parsed.values.filter(value => value.referencePeriod !== parsed.referencePeriod).some(value =>
        value.seriesDefinitionKey !== SERIES[0].seriesDefinitionKey)) throw new Error("bls_employment_partial_value_set");
  if (new Set(parsed.values.map(value => `${value.seriesDefinitionKey}|${value.referencePeriod}`)).size !== parsed.values.length)
    throw new Error("bls_employment_duplicate_value");
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
      sourceDocumentKey, calendarEventKey: calendarLink(calendarEventKey, parsed.referencePeriod) },
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

function validateReleaseOccurrenceKey(value, releaseDate, rawContentHash) {
  return value === `${RELEASE_KEY_PREFIX}${releaseDate}|initial` ||
    value === `${RELEASE_KEY_PREFIX}${releaseDate}|correction|sha256:${rawContentHash}`;
}

module.exports = Canonical.freeze({ SOURCE_ID, AUTHORITY, PROGRAM, RELEASE_KEY_PREFIX, PARSER_ID,
  PARSER_VERSION, SERIES, DEFINITION_FIELDS, parseReleaseHtml, validateDefinition, validateValue,
  createAcceptedCandidate, validateReleaseOccurrenceKey, addMonths, payrollDecimal, correctionPublishedAt });
