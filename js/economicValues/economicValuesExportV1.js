"use strict";

const Canonical = require("./economicValueCanonical.js");
const Store = require("./economicValueFormalStore.js");
const Cpi = require("./blsCpiFormal.js");
const Sources = require("./economicValueSourceRegistry.js");

const SCHEMA_VERSION = "optionmap-economic-values-export-v1";
const TOP_LEVEL_KEYS = Object.freeze(["schemaVersion", "exportMeta", "selection", "seriesDefinitions",
  "releaseOccurrences", "officialValues", "sourceStatus"]);
function safeEvidence(value) {
  return { evidenceKey: value.evidenceKey, revisionKey: value.revisionKey,
    sourceDocumentKey: value.sourceDocumentKey, sourceId: value.sourceId,
    runId: value.runId, releaseOccurrenceKey: value.releaseOccurrenceKey,
    sourceUrl: value.sourceUrl, sourcePublishedAt: value.sourcePublishedAt,
    fetchedAt: value.fetchedAt, acceptedAt: value.acceptedAt,
    parserId: value.parserId, parserVersion: value.parserVersion,
    rawContentHash: value.rawContentHash, acquisitionEvidenceHash: value.acquisitionEvidenceHash,
    httpMetadata: Canonical.clone(value.httpMetadata) };
}
function create({ appVersion, generatedAt, selection = { mode: "current" }, snapshotResult } = {}) {
  if (typeof appVersion !== "string" || !appVersion.trim() || !Canonical.timestamp(generatedAt) ||
      !snapshotResult || !["available", "absent"].includes(snapshotResult.status) ||
      !selection || !["current", "as_known_at"].includes(selection.mode) ||
      selection.mode === "as_known_at" && !Canonical.timestamp(selection.asKnownAt))
    throw new Error("economic_export_input_invalid");
  const snapshot = snapshotResult.snapshot || Store.emptySnapshot(), at = selection.mode === "current" ? null :
    selection.asKnownAt, official = snapshotResult.status === "available" ?
      (at ? Store.selectAt(snapshot, at) : snapshot.revisions.filter(value => value.validTo === null)) : [],
    releases = snapshot.releases.filter(value => !at || value.acceptedAt <= at),
    evidence = snapshot.evidence.filter(value => (!at || value.acceptedAt <= at) &&
      official.some(revision => revision.revisionKey === value.revisionKey)),
    sourceStatuses = Sources.CONTRACTS.map(contract => {
      const seriesKeys = new Set(Sources.definitionsForSource(snapshot.definitions,
        contract.SOURCE_ID).map(value => value.seriesDefinitionKey)),
        count = official.filter(value => seriesKeys.has(value.seriesDefinitionKey)).length;
      return { sourceId: contract.SOURCE_ID, readiness: count ? "formal_reference" : "unavailable",
        reason: snapshotResult.status === "absent" ? "database_absent" : count ? null : "value_absent",
        officialValueCount: count };
    });
  return Canonical.freeze({ schemaVersion: SCHEMA_VERSION,
    exportMeta: { appVersion, generatedAt, timeZone: "Asia/Tokyo", readOnly: true,
      artifactType: "economic_values_formal_export", schemaVersion: SCHEMA_VERSION },
    selection: at ? { mode: "as_known_at", asKnownAt: at } : { mode: "current" },
    seriesDefinitions: Canonical.clone(snapshot.definitions),
    releaseOccurrences: Canonical.clone(releases),
    officialValues: official.map(revision => ({ revision: Canonical.clone(revision),
      provenance: evidence.filter(value => value.revisionKey === revision.revisionKey).map(safeEvidence),
      revisionHistory: snapshot.revisions.filter(value => value.valueKey === revision.valueKey &&
        (!at || value.validFrom <= at)).sort((left, right) => left.validFrom.localeCompare(right.validFrom))
        .map(history => ({ revision: Canonical.clone(history), provenance: snapshot.evidence.filter(value =>
          value.revisionKey === history.revisionKey && (!at || value.acceptedAt <= at)).map(safeEvidence) })) })),
    sourceStatus: { sourceId: Cpi.SOURCE_ID,
      readiness: snapshotResult.status === "available" && official.length ? "formal_reference" : "unavailable",
      reason: snapshotResult.status === "absent" ? "database_absent" : official.length ? null : "value_absent",
      forecastValues: "unsupported", sources: sourceStatuses } });
}
function validate(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...TOP_LEVEL_KEYS].sort()))
    errors.push("top_level_invalid");
  if (value?.schemaVersion !== SCHEMA_VERSION || value?.exportMeta?.schemaVersion !== SCHEMA_VERSION ||
      value?.exportMeta?.readOnly !== true || value?.exportMeta?.artifactType !== "economic_values_formal_export")
    errors.push("meta_invalid");
  if (!Array.isArray(value?.seriesDefinitions) || !Array.isArray(value?.releaseOccurrences) ||
      !Array.isArray(value?.officialValues)) errors.push("content_invalid");
  if (!value?.sourceStatus || value.sourceStatus.sourceId !== Cpi.SOURCE_ID ||
      value.sourceStatus.forecastValues !== "unsupported" || !Array.isArray(value.sourceStatus.sources) ||
      value.sourceStatus.sources.length !== Sources.CONTRACTS.length) errors.push("source_status_invalid");
  const serialized = Canonical.stable(value || {});
  if (/parserInput|rawHtml|rawBody|consensus|surprise/.test(serialized)) errors.push("forbidden_export_material");
  return Canonical.freeze({ valid: errors.length === 0, errors });
}
function serialize(value, spacing = 2) {
  const result = validate(value); if (!result.valid) throw new Error(`economic_export_invalid:${result.errors.join(",")}`);
  return JSON.stringify(value, null, spacing);
}

module.exports = Canonical.freeze({ SCHEMA_VERSION, TOP_LEVEL_KEYS, create, validate, serialize });
