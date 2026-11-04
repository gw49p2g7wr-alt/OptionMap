"use strict";

const Canonical = require("./economicValueCanonical.js");
const { zonedInstant } = require("./blsCpiFormal.js");
const SourceEvidence = require("../sourceEvidence/sourceEvidenceContract.js");

const SOURCE_ID = "us-bea-pce-values";
const AUTHORITY = "BEA";
const PROGRAM = "PERSONAL_INCOME_AND_OUTLAYS";
const RELEASE_KEY_PREFIX = "US|BEA|PERSONAL_INCOME_AND_OUTLAYS|";
const PARSER_ID = "bea-pce-release-values";
const PARSER_VERSION = 1;
const MONTHS = Object.freeze({ January: "01", February: "02", March: "03", April: "04", May: "05",
  June: "06", July: "07", August: "08", September: "09", October: "10", November: "11", December: "12" });
const SERIES = Object.freeze([
  Object.freeze({ seriesDefinitionKey: "US|BEA|PCE_PRICE_INDEX|ALL_ITEMS|MOM|SA|PERCENT",
    officialLabel: "PCE price index", indicator: "US_PCE_PRICE_INDEX", measure: "month_over_month",
    scope: "US_national", unit: "percent", scale: "1", seasonalAdjustment: "seasonally_adjusted",
    periodBasis: "monthly", variant: "headline", methodologyIdentity: "BEA_NIPA_TABLE_2_8_7_LINE_1",
    indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BEA|PCE_PRICE_INDEX|ALL_ITEMS|YOY|SA|PERCENT",
    officialLabel: "PCE price index", indicator: "US_PCE_PRICE_INDEX", measure: "year_over_year",
    scope: "US_national", unit: "percent", scale: "1", seasonalAdjustment: "seasonally_adjusted",
    periodBasis: "year_over_year", variant: "headline", methodologyIdentity: "BEA_NIPA_TABLE_2_8_11_LINE_1",
    indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BEA|PCE_PRICE_INDEX|LESS_FOOD_ENERGY|MOM|SA|PERCENT",
    officialLabel: "PCE price index excluding food and energy", indicator: "US_PCE_PRICE_INDEX",
    measure: "month_over_month", scope: "US_national", unit: "percent", scale: "1",
    seasonalAdjustment: "seasonally_adjusted", periodBasis: "monthly", variant: "excluding_food_energy",
    methodologyIdentity: "BEA_NIPA_TABLE_2_8_7_LINE_6", indexBaseIdentity: null, decimalPlaces: 1 }),
  Object.freeze({ seriesDefinitionKey: "US|BEA|PCE_PRICE_INDEX|LESS_FOOD_ENERGY|YOY|SA|PERCENT",
    officialLabel: "PCE price index excluding food and energy", indicator: "US_PCE_PRICE_INDEX",
    measure: "year_over_year", scope: "US_national", unit: "percent", scale: "1",
    seasonalAdjustment: "seasonally_adjusted", periodBasis: "year_over_year", variant: "excluding_food_energy",
    methodologyIdentity: "BEA_NIPA_TABLE_2_8_11_LINE_6", indexBaseIdentity: null, decimalPlaces: 1 })
]);
const SERIES_COUNT = SERIES.length;
const DEFINITION_FIELDS = Object.freeze(["seriesDefinitionKey", "officialLabel", "indicator", "measure",
  "scope", "unit", "scale", "seasonalAdjustment", "periodBasis", "variant",
  "methodologyIdentity", "indexBaseIdentity", "decimalPlaces"]);
const decode = value => String(value || "").replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
  .replace(/&mdash;|&#8212;|&#x2014;/gi, "—").replace(/&#(\d+);/g,
    (_all, code) => String.fromCodePoint(Number(code)));
const text = html => decode(String(html || "")).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .normalize("NFKC").replace(/\s+/g, " ").trim();
const pad = value => String(value).padStart(2, "0");
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const decimal = value => /^-?(?:0|[1-9]\d{0,2})\.\d$/.test(value);
function previousMonth(referencePeriod) {
  const [year, month] = referencePeriod.split("-").map(Number), instant = new Date(Date.UTC(year, month - 2, 1));
  return `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}`;
}
function signed(value, direction) {
  if (!/^(?:0|[1-9]\d{0,2})\.\d$/.test(value)) throw new Error("bea_pce_numeric_invalid");
  if (/^increased$/i.test(direction)) return value;
  if (/^decreased$/i.test(direction)) return value === "0.0" ? value : `-${value}`;
  if (/^(?:was unchanged|was flat)$/i.test(direction) && value === "0.0") return value;
  throw new Error("bea_pce_direction_invalid");
}
function exactOne(body, pattern) {
  const matches = [...body.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
  if (matches.length !== 1) throw new Error("bea_pce_structure_change");
  return matches[0];
}
function releaseTable(html) {
  const matches = [...String(html || "").matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].filter(match =>
    text(match[0]).includes("Personal Income and Related Measures") &&
    text(match[0]).includes("Percent change from preceding month"));
  if (matches.length !== 1) throw new Error("bea_pce_structure_change");
  const rows = [...matches[0][0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(cell => text(cell[1])));
  return rows;
}
function requireReleaseLinks(html, releaseDate, referencePeriod) {
  const [releaseYear, releaseMonth] = releaseDate.split("-"), [referenceYear, referenceMonth] = referencePeriod.split("-"),
    code = `${referenceMonth}${referenceYear.slice(-2)}`,
    pdf = `/sites/default/files/${releaseYear}-${releaseMonth}/pi${code}.pdf`,
    comparisons = `/sites/default/files/${releaseYear}-${releaseMonth}/pi${code}-hist.xlsx`,
    archive = "https://apps.bea.gov/histdatacore/histChildLevels.html?HMI=7&oldDiv=National%20Accounts";
  const normalized = decode(html);
  if (!normalized.includes(`href="${pdf}"`) || !normalized.includes(`href="${comparisons}"`) ||
      !normalized.includes(`href="${archive}"`) ||
      exactOne(normalized, />Table 2\.8\.7\. Percent Change From Preceding Period in Prices for PCE by Major Type of Product</g).length === 0 ||
      exactOne(normalized, />Table 2\.8\.11\. Real PCE by Major Type of Product: Percent Change From Month One Year Ago</g).length === 0)
    throw new Error("bea_pce_vintage_links_invalid");
  return { releasePdfUrl: `https://www.bea.gov${pdf}`,
    historicalComparisonsUrl: `https://www.bea.gov${comparisons}`, dataArchiveUrl: archive,
    tableIdentities: ["BEA_NIPA_TABLE_2_8_7", "BEA_NIPA_TABLE_2_8_11"] };
}
function correctionPublishedAt(body, releaseDate) {
  if (!/\bCORRECTED\b/i.test(body)) return null;
  const match = body.match(/Corrected:\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\s+at\s+(\d{1,2}):(\d{2})\s+(a\.m\.|p\.m\.)\s*\(ET\)/i);
  if (!match) throw new Error("bea_pce_correction_time_unverifiable");
  const correctedDate = `${match[3]}-${MONTHS[match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()]}-${pad(match[2])}`;
  if (correctedDate !== releaseDate) throw new Error("bea_pce_correction_date_mismatch");
  let hour = Number(match[4]); const minute = Number(match[5]);
  if (hour < 1 || hour > 12 || minute > 59) throw new Error("bea_pce_correction_time_invalid");
  if (/p\.m\./i.test(match[6]) && hour !== 12) hour += 12;
  if (/a\.m\./i.test(match[6]) && hour === 12) hour = 0;
  return zonedInstant(releaseDate, hour, minute, "America/New_York");
}
function parseReleaseHtml(bytesOrText, context = {}) {
  let html;
  try { html = typeof bytesOrText === "string" ? bytesOrText :
    new TextDecoder("utf-8", { fatal: true }).decode(bytesOrText); }
  catch (_error) { throw new Error("bea_pce_encoding_invalid"); }
  const body = text(html), headingElement = exactOne(html,
    /<h1\b[^>]*>\s*Personal Income and Outlays, (January|February|March|April|May|June|July|August|September|October|November|December) (20\d{2})\s*<\/h1>/i),
    heading = headingElement,
    embargo = exactOne(body, /EMBARGOED UNTIL RELEASE AT 8:30 a\.m\. (EST|EDT), (?:Monday|Tuesday|Wednesday|Thursday|Friday), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (20\d{2})/i),
    releaseNumberMatch = exactOne(body, /BEA (\d{2})[–-](\d{2})/),
    referenceName = heading[1][0].toUpperCase() + heading[1].slice(1).toLowerCase(),
    releaseName = embargo[2][0].toUpperCase() + embargo[2].slice(1).toLowerCase(),
    referencePeriod = `${heading[2]}-${MONTHS[referenceName]}`,
    releaseDate = `${embargo[4]}-${MONTHS[releaseName]}-${pad(embargo[3])}`,
    releaseNumber = `BEA_${releaseNumberMatch[1]}-${releaseNumberMatch[2]}`;
  if (!MONTHS[referenceName] || !MONTHS[releaseName] || context.expectedReferencePeriod &&
      context.expectedReferencePeriod !== referencePeriod || context.expectedReleaseDate &&
      context.expectedReleaseDate !== releaseDate) throw new Error("bea_pce_release_identity_mismatch");
  const currentMonth = escape(referenceName), mom = exactOne(body, new RegExp(
      `From the preceding month, the PCE price index for ${currentMonth} (increased|decreased|was unchanged|was flat) (\\d{1,3}\\.\\d) percent\\s*\\. ` +
      `Excluding food and energy, the PCE price index (?:also )?(increased|decreased|was unchanged|was flat) (\\d{1,3}\\.\\d) percent\\s*\\.`, "i")),
    yoy = exactOne(body, new RegExp(
      `From the same month one year ago, the PCE price index for ${currentMonth} (increased|decreased|was unchanged|was flat) (\\d{1,3}\\.\\d) percent\\s*\\. ` +
      `Excluding food and energy, the PCE price index (?:also )?(increased|decreased|was unchanged|was flat) (\\d{1,3}\\.\\d) percent from one year ago\\s*\\.`, "i")),
    current = [signed(mom[2], mom[1]), signed(yoy[2], yoy[1]), signed(mom[4], mom[3]), signed(yoy[4], yoy[3])],
    rows = releaseTable(html), priorPeriod = previousMonth(referencePeriod), priorName = Object.keys(MONTHS)
      .find(name => MONTHS[name] === priorPeriod.slice(5)), headings = rows.filter(row =>
        row.length >= 3 && row[1] === priorName && row[2] === referenceName),
    headlineRows = rows.filter(row => row[0] === "PCE price index"),
    coreRows = rows.filter(row => row[0] === "PCE price index excluding food and energy");
  if (headings.length !== 1 || headlineRows.length !== 1 || coreRows.length !== 1 ||
      ![headlineRows[0][1], headlineRows[0][2], coreRows[0][1], coreRows[0][2]].every(decimal) ||
      headlineRows[0][2] !== current[0] || coreRows[0][2] !== current[2])
    throw new Error("bea_pce_structure_change");
  const values = [[SERIES[0], referencePeriod, current[0]], [SERIES[1], referencePeriod, current[1]],
    [SERIES[2], referencePeriod, current[2]], [SERIES[3], referencePeriod, current[3]],
    [SERIES[0], priorPeriod, headlineRows[0][1]], [SERIES[2], priorPeriod, coreRows[0][1]]]
    .map(([definition, period, decimalValue]) => ({ seriesDefinitionKey: definition.seriesDefinitionKey,
      referencePeriod: period, decimalValue, unit: definition.unit,
      seasonalAdjustment: definition.seasonalAdjustment, measure: definition.measure }));
  const correctedAt = correctionPublishedAt(body, releaseDate);
  return Canonical.freeze({ parserId: PARSER_ID, parserVersion: PARSER_VERSION, releaseDate,
    referencePeriod, releaseNumber, occurrenceType: correctedAt ? "correction" : "initial",
    publishedAt: correctedAt || zonedInstant(releaseDate, 8, 30, "America/New_York"), values,
    vintage: requireReleaseLinks(html, releaseDate, referencePeriod) });
}
function validateDefinition(value) {
  return Canonical.exact(value, DEFINITION_FIELDS) && SERIES.some(definition =>
    Canonical.stable(definition) === Canonical.stable(value));
}
function validateDefinitionSet(definitions) {
  return Array.isArray(definitions) && definitions.length === SERIES_COUNT && SERIES.every(definition =>
    definitions.some(value => Canonical.stable(value) === Canonical.stable(definition)));
}
function validateValue(value, definitions = SERIES) {
  if (!Canonical.exact(value, ["seriesDefinitionKey", "referencePeriod", "decimalValue", "unit",
    "seasonalAdjustment", "measure"]) || !Canonical.month(value.referencePeriod) || !decimal(value.decimalValue)) return false;
  const definition = definitions.find(item => item.seriesDefinitionKey === value.seriesDefinitionKey);
  return !!definition && validateDefinition(definition) && value.unit === definition.unit &&
    value.seasonalAdjustment === definition.seasonalAdjustment && value.measure === definition.measure;
}
function calendarLink(value, referencePeriod, occurrenceType) {
  if (value == null) return null;
  const expected = `US|US_BEA|US_PCE|${referencePeriod}|${occurrenceType}|national`;
  if (value !== expected) throw new Error("calendar_event_link_invalid");
  return value;
}
function createAcceptedCandidate({ acquisition, acceptedAt, calendarEventKey = null } = {}) {
  if (!Canonical.timestamp(acceptedAt) || !acquisition || acquisition.success !== true ||
      acquisition.sourceId !== SOURCE_ID || !Canonical.timestamp(acquisition.fetchedAt) ||
      !Canonical.hash(acquisition.document?.rawContentHash) || typeof acquisition.document?.sourceUrl !== "string")
    throw new Error("bea_pce_acquisition_invalid");
  const parsed = parseReleaseHtml(acquisition.document.parserInput, {
    expectedReleaseDate: acquisition.releaseDate, expectedReferencePeriod: acquisition.referencePeriod });
  const definitions = SERIES.map(Canonical.clone), current = parsed.values.filter(value =>
    value.referencePeriod === parsed.referencePeriod);
  if (!validateDefinitionSet(definitions) || parsed.values.some(value => !validateValue(value, definitions)) ||
      current.length !== SERIES_COUNT || new Set(current.map(value => value.seriesDefinitionKey)).size !== SERIES_COUNT ||
      new Set(parsed.values.map(value => `${value.seriesDefinitionKey}|${value.referencePeriod}`)).size !== parsed.values.length)
    throw new Error("bea_pce_value_contract_invalid");
  const occurrenceSuffix = parsed.occurrenceType === "correction" ?
      `${parsed.releaseNumber}|correction|sha256:${acquisition.document.rawContentHash}` : parsed.releaseNumber,
    releaseOccurrenceKey = `${RELEASE_KEY_PREFIX}${parsed.releaseDate}|${occurrenceSuffix}`,
    sourceDocumentKey = `${releaseOccurrenceKey}|release_specific_html|sha256:${acquisition.document.rawContentHash}`,
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
      sourceDocumentKey, calendarEventKey: calendarLink(calendarEventKey, parsed.referencePeriod,
        parsed.occurrenceType) },
    httpMetadata = { ...Canonical.clone(acquisition.document.httpMetadata), releaseNumber: parsed.releaseNumber,
      vintageAuthority: "bea_release_specific_news_archive", ...Canonical.clone(parsed.vintage) },
    document = { sourceDocumentKey, releaseOccurrenceKey, sourceId: SOURCE_ID, role: "official_release",
      sourceUrl: acquisition.document.sourceUrl, finalUrl: acquisition.document.finalUrl,
      fetchedAt: acquisition.fetchedAt, mime: acquisition.document.mime,
      byteCount: acquisition.document.byteCount, rawContentHash: acquisition.document.rawContentHash,
      parserId: PARSER_ID, parserVersion: PARSER_VERSION, httpMetadata },
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
    throw new Error("bea_pce_source_evidence_invalid");
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
  const prefix = `${escape(RELEASE_KEY_PREFIX)}${escape(releaseDate)}\\|BEA_\\d{2}-\\d{2}`;
  return new RegExp(`^${prefix}$`).test(value) ||
    new RegExp(`^${prefix}\\|correction\\|sha256:${rawContentHash}$`).test(value);
}

module.exports = Canonical.freeze({ SOURCE_ID, AUTHORITY, PROGRAM, RELEASE_KEY_PREFIX, PARSER_ID,
  PARSER_VERSION, SERIES, SERIES_COUNT, DEFINITION_FIELDS, parseReleaseHtml, validateDefinition,
  validateDefinitionSet, validateValue, createAcceptedCandidate, bindSourceEvidence,
  validateReleaseOccurrenceKey, previousMonth, correctionPublishedAt });
