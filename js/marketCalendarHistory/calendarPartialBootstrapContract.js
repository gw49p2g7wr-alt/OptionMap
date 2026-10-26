"use strict";

// Pure CAL-PB-B1 contract only. This module cannot open storage, acquire data,
// grant writer authority, or execute the existing production bootstrap.
const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const AuthorityPolicy = require("../marketCalendar/authorityPolicy.js");
const Integrity = require("./historyIntegrity.js");
const Routes = require("../marketCalendarRuntime/calendarRouteAuthority.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Boj = require("../marketCalendarRuntime/bojCoverageAcquisition.js");
const Estat = require("../marketCalendarIsolated/estatRoute.js");
const Bls = require("../marketCalendarIsolated/blsFixedRoute.js");
const Mof = require("../marketCalendarIsolated/mofJgbVariableAdapter.js");
const MofSource = require("../marketCalendarIsolated/mofJgbSource.js");

const SOURCE_SET_ID = "calendar-source-set-v2";
const SOURCE_SET_VERSION = 2;
const HASH = /^[0-9a-f]{64}$/;
const EXPECTED_SOURCE_IDS = Object.freeze([...Registry.getSourceSet(SOURCE_SET_VERSION).sourceIds]);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const same = (left, right) => Canonicalizer.stable(left) === Canonicalizer.stable(right);
const exactGroup = roles => Object.freeze({ atomic: true, mode: "exact",
  requiredRoles: Object.freeze([...roles]), discoveredRolePrefix: null, minimumDiscoveredRoles: 0 });
const discoveredGroup = (roles, prefix, minimum) => Object.freeze({ atomic: true,
  mode: "index_plus_discovered", requiredRoles: Object.freeze([...roles]),
  discoveredRolePrefix: prefix, minimumDiscoveredRoles: minimum });

const GROUPS = Object.freeze({
  "jp-boj-calendar": exactGroup(["primary", "speeches", "tankan", "meeting_publications"]),
  "jp-stat-cpi": exactGroup(["primary"]),
  "jp-stat-labor": exactGroup(["primary"]),
  "jp-esri-machinery-orders-calendar": exactGroup(["primary"]),
  "jp-esri-sna-calendar": exactGroup(["primary"]),
  "us-fed-fomc-calendar": exactGroup(["primary"]),
  "us-bls-calendar": exactGroup(["cpi", "ppi", "employment_situation", "jolts"]),
  "us-bea-calendar": exactGroup(["scheduleAuthority", "releaseSemantics"]),
  "us-census-calendar": exactGroup(["primary"]),
  "jp-jpx-derivatives-calendar": exactGroup(["landing", "workbook"]),
  "jp-jpx-market-holidays": exactGroup(["primary"]),
  "us-nyse-market-holidays": exactGroup(["primary"]),
  "jp-mof-jgb-auction-calendar": discoveredGroup(["index"], "month:", 1)
});

const SPECIAL_GUARDS = Object.freeze({
  "jp-boj-calendar": Object.freeze(["boj_coverage_v3", "typed_boj_identity"]),
  "jp-stat-cpi": Object.freeze(["estat_route_generation_2"]),
  "jp-stat-labor": Object.freeze(["estat_route_generation_2"]),
  "us-fed-fomc-calendar": Object.freeze(["fomc_family_identity"]),
  "us-bls-calendar": Object.freeze(["fixed_four_page_set", "structure_change_fail_closed"]),
  "jp-jpx-derivatives-calendar": Object.freeze(["validated_workbook_discovery", "workbook_safety"]),
  "jp-jpx-market-holidays": Object.freeze(["trading_day_authority"]),
  "jp-mof-jgb-auction-calendar": Object.freeze(["validated_month_discovery", "typed_jgb_identity"])
});

const SOURCES = Object.freeze(Object.fromEntries(EXPECTED_SOURCE_IDS.map(sourceId => {
  const source = Registry.getSource(sourceId), group = GROUPS[sourceId];
  if (!source || !group || source.formalEligible !== true) throw new Error("partial_bootstrap_contract_invalid");
  return [sourceId, freeze({ sourceId, independent: true,
    crossSourceDependencies: [], formalEligible: true, sameSourceDocumentGroup: group,
    specialGuards: SPECIAL_GUARDS[sourceId] || Object.freeze([]) })];
})));

const SOURCE_SET = freeze({ identity: SOURCE_SET_ID, version: SOURCE_SET_VERSION,
  sourceIds: [...EXPECTED_SOURCE_IDS], sources: EXPECTED_SOURCE_IDS.map(sourceId => SOURCES[sourceId]) });

function expectedRouteIdentity(sourceId) {
  if (sourceId === Mof.SOURCE_ID) return Mof.routeIdentity;
  if (sourceId === Boj.SOURCE_ID) return Boj.shouldRouteIdentity;
  const selected = Routes.selectRoute({ sourceId, operation: Network.OPERATION },
    Routes.PRODUCTION_AUTHORITY);
  return selected.valid && selected.acquisitionAllowed ? selected.routeIdentity : null;
}

function evidenceUrlValid(sourceId, value) {
  if (typeof value !== "string") return false;
  if (sourceId === Mof.SOURCE_ID) return MofSource.validateUrl(value).valid;
  if (Object.hasOwn(Estat.ROUTES, sourceId)) return Estat.validateUrl(sourceId, value).valid;
  if (sourceId === Bls.SOURCE_ID) return Bls.ROLES.some(role => Bls.validateUrl(role.role, value).valid);
  const contract = sourceId === "jp-boj-calendar" ? Network.BOJ_COVERAGE_V3 : null,
    policy = Network.getPolicy(sourceId, contract);
  return !!policy?.documents?.some(document => Network.validateUrl(sourceId, document, value).valid);
}

function rolesComplete(sourceId, documentHealth) {
  const group = GROUPS[sourceId];
  if (!group || !Array.isArray(documentHealth)) return false;
  const roles = documentHealth.map(value => value?.role), unique = new Set(roles);
  if (roles.some(role => typeof role !== "string") || unique.size !== roles.length) return false;
  if (group.mode === "exact") return same([...unique].sort(), [...group.requiredRoles].sort());
  const discovered = roles.filter(role => role.startsWith(group.discoveredRolePrefix));
  return group.requiredRoles.every(role => unique.has(role)) &&
    discovered.length >= group.minimumDiscoveredRoles &&
    roles.every(role => group.requiredRoles.includes(role) ||
      /^month:20\d{2}-(?:0[1-9]|1[0-2])$/.test(role));
}

function candidateOf(sourceResult) {
  const candidate = sourceResult?.candidateEnvelope || sourceResult || {};
  return { candidate, records: candidate.canonicalRecords || sourceResult?.canonicalRecords || [],
    candidateStatus: candidate.candidateStatus || sourceResult?.candidateStatus || null,
    candidateIdentity: candidate.candidateIdentity || sourceResult?.candidateIdentity || null,
    formalEligible: candidate.formalEligible === true || sourceResult?.formalEligible === true,
    parserStatus: candidate.parserStatus || sourceResult?.parserStatus || null,
    canonicalizationStatus: candidate.canonicalizationStatus ||
      sourceResult?.canonicalizationStatus || null,
    parserDiagnostics: candidate.parserDiagnostics || sourceResult?.parserDiagnostics || [],
    canonicalDiagnostics: candidate.canonicalDiagnostics || sourceResult?.canonicalDiagnostics || [] };
}

function sourceFailure(sourceId, classification, reason, failedChecks, diagnostics = {}) {
  return freeze({ eligible: false, sourceId: sourceId || null, classification, reason,
    failedChecks: [...new Set(failedChecks)], diagnostics: clone(diagnostics) });
}

async function validateRecords(sourceId, records, acceptedAt) {
  const failed = [], eventKeys = new Set(), revisionKeys = new Set();
  let provenanceValid = true, fetchedAtValid = true, fetchedAtNotFuture = true,
    canonicalValid = true, revisionValid = true, evidenceValid = true, securityValid = true;
  for (const record of records) {
    const evidence = record?.acquisitionEvidence;
    if (!record || typeof record.eventKey !== "string" || !record.eventKey ||
        AuthorityPolicy.FORMAL_SOURCE_BY_EVENT_TYPE[record.logical?.eventType] !== sourceId ||
        record.logical?.authority !== Registry.getSource(sourceId)?.authority ||
        record.logical?.jurisdiction !== Registry.getSource(sourceId)?.jurisdiction ||
        !HASH.test(record.canonicalContentHash || "") ||
        await Canonicalizer.sha256(Integrity.semanticContent(record)) !== record.canonicalContentHash)
      canonicalValid = false;
    if (record?.revisionKey !== `${record?.eventKey}|sha256:${record?.canonicalContentHash}`)
      revisionValid = false;
    if (!evidence || evidence.sourceId !== sourceId ||
        evidence.authority !== Registry.getSource(sourceId)?.authority ||
        typeof evidence.sourceUrl !== "string" || !HASH.test(evidence.rawContentHash || "") ||
        typeof evidence.parserId !== "string" || !evidence.parserId ||
        !Number.isSafeInteger(evidence.parserVersion) || evidence.parserVersion < 1)
      provenanceValid = false;
    if (!evidenceUrlValid(sourceId, evidence?.sourceUrl)) securityValid = false;
    const fetched = Date.parse(evidence?.fetchedAt || "");
    if (!Number.isFinite(fetched)) fetchedAtValid = false;
    if (Number.isFinite(fetched) && fetched > Date.parse(acceptedAt)) fetchedAtNotFuture = false;
    if (!HASH.test(record?.acquisitionEvidenceHash || "") || evidence &&
        await Canonicalizer.sha256(evidence) !== record.acquisitionEvidenceHash ||
        record?.acquisitionEvidenceKey !== `${sourceId}|sha256:${record?.acquisitionEvidenceHash}`)
      evidenceValid = false;
    if (eventKeys.has(record?.eventKey)) failed.push("candidate_duplicate_event");
    if (revisionKeys.has(record?.revisionKey)) failed.push("candidate_duplicate_revision");
    eventKeys.add(record?.eventKey); revisionKeys.add(record?.revisionKey);
  }
  return { canonicalValid, revisionValid, evidenceValid, provenanceValid, securityValid,
    fetchedAtValid, fetchedAtNotFuture, duplicateCount: failed.length,
    duplicateReasons: [...new Set(failed)], semanticSetIdentity:
      await Canonicalizer.sha256([...revisionKeys].sort()) };
}

async function evaluateSourceEligibility({ sourceResult, acceptedAt, generationIdentity } = {}) {
  const sourceId = typeof sourceResult?.sourceId === "string" ? sourceResult.sourceId : null,
    failedChecks = [], reasons = {}, add = (check, reason) => {
      failedChecks.push(check); if (!Object.hasOwn(reasons, check)) reasons[check] = reason;
    }, source = Registry.getSource(sourceId), metadata = SOURCES[sourceId],
    acceptedTime = Date.parse(acceptedAt || "");
  if (!source || !metadata) return sourceFailure(sourceId, "invalid", "source_unregistered",
    ["source_registered"]);
  if (sourceResult.acquisitionOutcome === "not_attempted") return sourceFailure(sourceId,
    "not_attempted", "source_not_attempted", [], { sourceSetIdentity: SOURCE_SET_ID });
  if (source.formalEligible !== true || metadata.formalEligible !== true)
    add("formal_eligible", "source_not_formal_eligible");
  if (sourceResult.routeIdentity !== expectedRouteIdentity(sourceId))
    add("production_route_identity", "route_identity_mismatch");
  if (!HASH.test(generationIdentity || "") || sourceResult.generationIdentity !== generationIdentity)
    add("acquisition_generation_current", "acquisition_generation_stale");
  if (!Number.isFinite(acceptedTime)) add("acceptance_time_valid", "acceptance_time_invalid");

  const { candidate, records, candidateStatus, candidateIdentity, parserStatus,
    canonicalizationStatus, parserDiagnostics, canonicalDiagnostics } = candidateOf(sourceResult),
    documentHealth = sourceResult.documentHealth;
  if (sourceResult.acquisitionOutcome !== "complete") add("acquisition_complete",
    sourceResult.acquisitionOutcome === "partial" ? "source_partial" : "source_acquisition_failed");
  if (!rolesComplete(sourceId, documentHealth)) add("required_document_roles_complete",
    "document_set_incomplete");
  if (!Array.isArray(documentHealth) || documentHealth.some(document =>
    document?.fetchOutcome !== "success")) add("document_transport_success", "transport_failed");
  if (!Array.isArray(documentHealth) || documentHealth.some(document =>
    document?.parseOutcome !== "success") || parserStatus !== "success")
    add("parser_success", "parser_failed");
  const structurePassed = candidate.structureGuardStatus === undefined
    ? parserStatus === "success" && Array.isArray(parserDiagnostics) && parserDiagnostics.length === 0
    : candidate.structureGuardStatus === "passed";
  if (!structurePassed) add("structure_guard_pass", "parser_structure_change");
  if (candidateStatus !== "available") add("candidate_available", "candidate_unavailable");
  if (canonicalizationStatus !== "success" || !Array.isArray(canonicalDiagnostics) ||
      canonicalDiagnostics.length) add("canonicalization_success", "canonicalization_failed");
  if (!Array.isArray(records) || records.length === 0) add("non_empty_canonical_records",
    "canonical_records_empty");
  if (!Array.isArray(sourceResult.failedRoles) || sourceResult.failedRoles.length)
    add("failed_roles_zero", "source_roles_failed");
  if (!Number.isSafeInteger(sourceResult.ambiguityCount) || sourceResult.ambiguityCount !== 0)
    add("ambiguity_zero", "source_ambiguity");
  const candidateClaimsFormalSet = sourceResult.acquisitionOutcome === "complete" &&
    candidateStatus === "available";
  if (candidateClaimsFormalSet && !HASH.test(candidateIdentity || ""))
    add("candidate_identity_valid", "candidate_identity_invalid");

  const checked = candidateClaimsFormalSet && Array.isArray(records) && records.length && Number.isFinite(acceptedTime)
    ? await validateRecords(sourceId, records, acceptedAt) : { canonicalValid: false,
      revisionValid: false, evidenceValid: false, provenanceValid: false, securityValid: false,
      fetchedAtValid: false, fetchedAtNotFuture: false, duplicateCount: 0,
      duplicateReasons: [], semanticSetIdentity: null };
  if (candidateClaimsFormalSet && !checked.securityValid)
    add("https_security_valid", "security_contract_invalid");
  if (candidateClaimsFormalSet && (checked.duplicateCount !== 0 ||
      Number.isSafeInteger(sourceResult.duplicateCount) && sourceResult.duplicateCount !== 0))
    add("duplicates_zero", checked.duplicateReasons[0] || "candidate_duplicate");
  if (!Number.isSafeInteger(sourceResult.identityCollisionCount) ||
      sourceResult.identityCollisionCount !== 0) add("identity_collisions_zero",
    "identity_collision");
  if (candidateClaimsFormalSet && !checked.canonicalValid)
    add("canonical_identities_valid", "canonical_identity_invalid");
  if (candidateClaimsFormalSet && !checked.revisionValid)
    add("revision_keys_valid", "revision_key_invalid");
  if (candidateClaimsFormalSet && !checked.evidenceValid)
    add("evidence_hashes_valid", "evidence_hash_invalid");
  if (candidateClaimsFormalSet && !checked.provenanceValid)
    add("required_provenance_present", "provenance_invalid");
  if (candidateClaimsFormalSet && !checked.fetchedAtValid)
    add("fetched_at_valid", "fetched_at_invalid");
  if (candidateClaimsFormalSet && !checked.fetchedAtNotFuture)
    add("fetched_at_not_future", "fetched_at_future");
  if (candidateClaimsFormalSet && !HASH.test(checked.semanticSetIdentity || ""))
    add("semantic_set_identity_deterministic", "semantic_set_identity_invalid");

  if (!failedChecks.length) return freeze({ eligible: true, sourceId, classification: "eligible",
    reason: null, failedChecks: [], diagnostics: { sourceSetIdentity: SOURCE_SET_ID,
      expectedRouteIdentity: expectedRouteIdentity(sourceId), generationIdentity,
      semanticSetIdentity: checked.semanticSetIdentity,
      recordCount: records.length, requiredDocumentRoles: [...metadata.sameSourceDocumentGroup.requiredRoles],
      observedDocumentRoles: documentHealth.map(value => value.role).sort(),
      specialGuards: [...metadata.specialGuards] } });
  const invalidChecks = new Set(["source_registered", "formal_eligible", "production_route_identity",
    "acquisition_generation_current", "acceptance_time_valid", "ambiguity_zero", "duplicates_zero",
    "identity_collisions_zero", "candidate_identity_valid", "canonical_identities_valid",
    "revision_keys_valid", "evidence_hashes_valid", "required_provenance_present",
    "fetched_at_valid", "fetched_at_not_future", "semantic_set_identity_deterministic",
    "https_security_valid"]), classification = failedChecks.some(check => invalidChecks.has(check))
      ? "invalid" : "failed", reason = reasons[failedChecks[0]];
  return sourceFailure(sourceId, classification, reason, failedChecks, {
    sourceSetIdentity: SOURCE_SET_ID, expectedRouteIdentity: expectedRouteIdentity(sourceId),
    generationIdentity, semanticSetIdentity: checked.semanticSetIdentity,
    recordCount: Array.isArray(records) ? records.length : 0,
    requiredDocumentRoles: [...metadata.sameSourceDocumentGroup.requiredRoles],
    observedDocumentRoles: Array.isArray(documentHealth) ? documentHealth.map(value => value?.role).sort() : [] });
}

function collisionOwners(sourceResults) {
  const owners = new Map();
  for (const result of sourceResults) {
    const sourceId = result?.sourceId, records = candidateOf(result).records;
    if (!EXPECTED_SOURCE_IDS.includes(sourceId) || !Array.isArray(records)) continue;
    for (const record of records) {
      if (typeof record?.eventKey !== "string" || !record.eventKey) continue;
      const current = owners.get(record?.eventKey) || new Set();
      current.add(sourceId); owners.set(record?.eventKey, current);
    }
  }
  return new Map([...owners].filter(([, sourceIds]) => sourceIds.size > 1));
}

async function evaluateAcquisitionGeneration({ sourceResults, acceptedAt, generationIdentity } = {}) {
  const input = Array.isArray(sourceResults) ? sourceResults : [], bySource = new Map(),
    invalidInput = [], duplicateInputSourceIds = new Set();
  for (const result of input) {
    if (!result || typeof result.sourceId !== "string")
      invalidInput.push(result?.sourceId || null);
    else if (bySource.has(result.sourceId)) duplicateInputSourceIds.add(result.sourceId);
    else bySource.set(result.sourceId, result);
  }
  const results = [];
  for (const sourceId of EXPECTED_SOURCE_IDS) {
    const sourceResult = bySource.get(sourceId) || { sourceId, acquisitionOutcome: "not_attempted" };
    results.push(await evaluateSourceEligibility({ sourceResult, acceptedAt, generationIdentity }));
  }
  const collisions = collisionOwners(input);
  for (const [eventKey, sourceIds] of collisions) for (const sourceId of sourceIds) {
    const index = results.findIndex(value => value.sourceId === sourceId), previous = results[index];
    results[index] = sourceFailure(sourceId, "invalid", "cross_source_event_key_collision",
      [...previous.failedChecks, "cross_source_event_key_collision"], {
        ...clone(previous.diagnostics), collisionEventKey: eventKey,
        collisionSourceIds: [...sourceIds].sort() });
  }
  for (const sourceId of duplicateInputSourceIds) {
    const index = results.findIndex(value => value.sourceId === sourceId), previous = results[index];
    if (index >= 0) results[index] = sourceFailure(sourceId, "invalid", "duplicate_source_outcome",
      [...previous.failedChecks, "duplicate_source_outcome"], previous.diagnostics);
    else results.push(sourceFailure(sourceId, "invalid", "duplicate_source_outcome",
      ["duplicate_source_outcome"]));
  }
  for (const sourceId of invalidInput) if (sourceId && !EXPECTED_SOURCE_IDS.includes(sourceId))
    results.push(sourceFailure(sourceId, "invalid", "source_unregistered", ["source_registered"]));
  const select = classification => results.filter(value => value.classification === classification)
    .map(value => value.sourceId);
  const eligibleSources = select("eligible"), failedSources = select("failed"),
    notAttemptedSources = select("not_attempted"), invalidSources = select("invalid"),
    inputErrors = invalidInput.map(sourceId => sourceId ? "source_unregistered" : "source_result_invalid");
  return freeze({ sourceSetIdentity: SOURCE_SET_ID, sourceSetVersion: SOURCE_SET_VERSION,
    generationIdentity: generationIdentity || null, expectedSourceIds: [...EXPECTED_SOURCE_IDS],
    eligibleSources, failedSources, notAttemptedSources, invalidSources, inputErrors,
    fullCoverageCandidate: eligibleSources.length === EXPECTED_SOURCE_IDS.length &&
      invalidSources.length === 0 && inputErrors.length === 0,
    results: results.sort((left, right) => {
      const a = EXPECTED_SOURCE_IDS.indexOf(left.sourceId), b = EXPECTED_SOURCE_IDS.indexOf(right.sourceId);
      return (a < 0 ? Infinity : a) - (b < 0 ? Infinity : b) ||
        String(left.sourceId).localeCompare(String(right.sourceId));
    }) });
}

module.exports = Object.freeze({ SOURCE_SET_ID, SOURCE_SET_VERSION, EXPECTED_SOURCE_IDS,
  SOURCE_SET, SOURCES, expectedRouteIdentity, rolesComplete, evaluateSourceEligibility,
  evaluateAcquisitionGeneration });
