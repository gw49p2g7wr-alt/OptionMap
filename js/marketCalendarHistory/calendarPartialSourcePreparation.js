"use strict";

// CAL-PB-B2 is a pure preparation boundary. It consumes caller-owned facts and
// returns data only; it never opens storage, acquires data, or grants authority.
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Eligibility = require("./calendarPartialBootstrapContract.js");
const Schema = require("./productionSchemaV1.js");
const Integrity = require("./historyIntegrity.js");
const Transition = require("./transitionPlanner.js");
const Mapper = require("./storageRecordMapper.js");
const PlanCanonicalizer = require("./planCanonicalizer.js");
const WriterCore = require("./formalControlledWriterCore.js");

const PREPARATION_VERSION = 1;
const AUTHORITY = Object.freeze({
  identity: "calendar-partial-source-preparation-v1",
  version: 1,
  sourceSetIdentity: Eligibility.SOURCE_SET_ID,
  schemaVersion: Schema.VERSION,
  schemaFingerprint: Schema.EXPECTED_FINGERPRINT
});
const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT_FIELDS = Object.freeze(["entries", "revisions", "evidence", "observations",
  "runs", "cursors"]);
const SNAPSHOT_KEYS = Object.freeze(["databaseStatus", "schemaVersion", "schemaFingerprint",
  "snapshotFingerprint", ...SNAPSHOT_FIELDS]);
const INPUT_KEYS = Object.freeze(["sourceId", "acquisition", "formalSnapshot", "acceptedAt",
  "generation", "authority"]);
const MUTATION_KEYS = PlanCanonicalizer.ARRAY_KEYS;
const FORBIDDEN_INPUT_KEYS = new Set(["mutations", "operations", "store", "stores", "storeName",
  "storeNames", "storeTargets", "transaction", "indexedDB", "runs", "cursors", "observations"]);
const clone = value => value == null ? value : structuredClone(value);
function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
const same = (left, right) => Canonicalizer.stable(left) === Canonicalizer.stable(right);
const exactKeys = (value, keys) => !!value && typeof value === "object" &&
  same(Object.keys(value).sort(), [...keys].sort());
const emptyMutations = () => Object.fromEntries(MUTATION_KEYS.map(key => [key, []]));
const operationCeiling = mutations => Object.fromEntries(MUTATION_KEYS.map(key =>
  [key, mutations[key].length]));
const mutationCounts = mutations => frozen({
  eventEntryCreate: mutations.appendEntries.length,
  eventEntryUpdate: mutations.updateEntries.length,
  semanticRevisionCreate: mutations.appendRevisions.length,
  semanticRevisionClose: mutations.closeRevisions.length,
  evidenceCreate: mutations.appendEvidence.length,
  observationCreate: mutations.appendObservations.length,
  sourceRunCreate: mutations.appendRuns.length,
  sourceCursorUpdate: mutations.updateCursors.length
});
function containsRawPayload(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) =>
    /^(rawBody|responseBody|rawHtml|rawXml|body|bytes|html|xml|blob|contentBytes)$/i.test(key) ||
    containsRawPayload(item, seen));
}
function inputControlViolation(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => FORBIDDEN_INPUT_KEYS.has(key) ||
    inputControlViolation(item, seen));
}
function foreignSourceIdentity(value, sourceId, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (key === "sourceId" && typeof item === "string" && item !== sourceId) return item;
    const nested = foreignSourceIdentity(item, sourceId, seen);
    if (nested) return nested;
  }
  return null;
}
function candidateRecords(acquisition) {
  return acquisition?.candidateEnvelope?.canonicalRecords || acquisition?.canonicalRecords || [];
}
function normalizedSnapshot(value) {
  return WriterCore.sorted(Object.fromEntries(SNAPSHOT_FIELDS.map(field =>
    [field, clone(value[field])])));
}
async function fingerprintFormalSnapshot(value) {
  const normalized = normalizedSnapshot(value);
  return Canonicalizer.sha256({ databaseStatus: value.databaseStatus,
    schemaVersion: value.schemaVersion, schemaFingerprint: value.schemaFingerprint,
    snapshot: normalized });
}
function linkageErrors(snapshot) {
  const errors = [], entries = new Map(snapshot.entries.map(value => [value.eventKey, value])),
    revisions = new Map(snapshot.revisions.map(value => [value.revisionKey, value])),
    runs = new Map(snapshot.runs.map(value => [value.runKey, value]));
  for (const revision of snapshot.revisions)
    if (entries.get(revision.eventKey)?.sourceId !== revision.sourceId)
      errors.push("revision_entry_linkage_invalid");
  for (const evidence of snapshot.evidence) {
    const revision = revisions.get(evidence.revisionKey), run = runs.get(
      `${evidence.sourceId}|${evidence.runId}`);
    if (!revision || revision.eventKey !== evidence.eventKey ||
        revision.sourceId !== evidence.sourceId || !run)
      errors.push("evidence_linkage_invalid");
  }
  for (const observation of snapshot.observations) {
    const entry = entries.get(observation.eventKey), run = runs.get(
      `${observation.sourceId}|${observation.runId}`);
    if (!entry || entry.sourceId !== observation.sourceId || !run)
      errors.push("observation_linkage_invalid");
  }
  for (const cursor of snapshot.cursors) {
    const own = snapshot.runs.filter(value => value.sourceId === cursor.sourceId)
      .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt) ||
        right.runId.localeCompare(left.runId));
    if (!own.length || own[0].runKey !== cursor.runKey ||
        own[0].acceptedAt !== cursor.acceptedAt) errors.push("cursor_run_linkage_invalid");
  }
  return [...new Set(errors)].sort();
}
async function rejected(sourceId, status, reason, diagnostics = {}) {
  const mutations = emptyMutations(), base = { preparationVersion: PREPARATION_VERSION,
    status, sourceId: sourceId || null, reason, operationType: null,
    writeAllowed: false, executionAuthorized: false, preconditions: null,
    mutations, mutationCeiling: operationCeiling(mutations),
    mutationCounts: mutationCounts(mutations), receiptExpectation: null,
    diagnostics: clone(diagnostics) };
  return frozen({ ...base, planIdentity: await Canonicalizer.sha256(base) });
}
async function validateSnapshot(formalSnapshot) {
  if (!exactKeys(formalSnapshot, SNAPSHOT_KEYS) ||
      !["absent", "present"].includes(formalSnapshot.databaseStatus) ||
      formalSnapshot.schemaVersion !== Schema.VERSION ||
      !SNAPSHOT_FIELDS.every(field => Array.isArray(formalSnapshot[field])))
    return { valid: false, status: "invalid_snapshot", reason: "formal_snapshot_shape_invalid" };
  if (formalSnapshot.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT)
    return { valid: false, status: "precondition_failed", reason: "schema_fingerprint_mismatch" };
  const snapshot = normalizedSnapshot(formalSnapshot), computed = await fingerprintFormalSnapshot(
    formalSnapshot);
  if (!HASH.test(formalSnapshot.snapshotFingerprint || "") ||
      formalSnapshot.snapshotFingerprint !== computed)
    return { valid: false, status: "precondition_failed", reason: "snapshot_fingerprint_mismatch" };
  if (formalSnapshot.databaseStatus === "absent") {
    if (SNAPSHOT_FIELDS.some(field => snapshot[field].length))
      return { valid: false, status: "invalid_snapshot", reason: "absent_database_not_empty" };
    return { valid: true, snapshot, snapshotFingerprint: computed, sourceIds: [] };
  }
  const semantic = await Integrity.audit(snapshot), storage = Integrity.auditStorageSnapshot(snapshot),
    linkage = linkageErrors(snapshot), sourceIds = [...new Set(SNAPSHOT_FIELDS.flatMap(field =>
      snapshot[field].map(value => value.sourceId)))], incompleteSources = sourceIds.filter(sourceId =>
      sourceState(snapshot, sourceId).status === "invalid");
  if (!semantic.valid || !storage.valid || linkage.length ||
      sourceIds.some(sourceId => !Registry.getSource(sourceId)) || incompleteSources.length)
    return { valid: false, status: "invalid_snapshot", reason: "formal_snapshot_integrity_invalid",
      errors: [...semantic.errors, ...storage.errors, ...linkage,
        ...incompleteSources.map(sourceId => `${sourceId}:source_state_incomplete`)] };
  return { valid: true, snapshot, snapshotFingerprint: computed, sourceIds };
}
function sourceState(snapshot, sourceId) {
  const own = Object.fromEntries(SNAPSHOT_FIELDS.map(field => [field,
    snapshot[field].filter(value => value.sourceId === sourceId)])), total =
    Object.values(own).reduce((sum, values) => sum + values.length, 0);
  if (!total) return { status: "absent", own };
  if (!own.entries.length || !own.runs.length || own.cursors.length !== 1)
    return { status: "invalid", own };
  return { status: "present", own };
}
function acceptedAtConsistent(acquisition, acceptedAt) {
  return [acquisition?.acceptedAt, acquisition?.candidateEnvelope?.acceptedAt]
    .filter(value => value !== undefined).every(value => value === acceptedAt);
}
function generationConsistent(acquisition, generation) {
  return [acquisition?.generationIdentity, acquisition?.candidateEnvelope?.generationIdentity]
    .filter(value => value !== undefined).every(value => value === generation);
}
function expectedSourceState(snapshot, sourceId) {
  const cursor = snapshot.cursors.find(value => value.sourceId === sourceId) || null,
    runs = snapshot.runs.filter(value => value.sourceId === sourceId).map(value => ({
      runKey: value.runKey, acceptedAt: value.acceptedAt,
      semanticSetHash: value.semanticSetHash })).sort((a, b) => a.runKey.localeCompare(b.runKey)),
    activeRevisionIdentities = snapshot.entries.filter(value => value.sourceId === sourceId)
      .map(value => ({ eventKey: value.eventKey, revisionKey: value.activeRevisionKey }))
      .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { cursor: clone(cursor), runs, activeRevisionIdentities };
}
function filterExistingEvidence(mutations, snapshot) {
  const existing = new Map(snapshot.evidence.map(value => [value.evidenceLinkKey, value])), kept = [];
  for (const value of mutations.appendEvidence) {
    const prior = existing.get(value.evidenceLinkKey);
    if (!prior) kept.push(value);
    else if (prior.revisionKey !== value.revisionKey ||
        prior.acquisitionEvidenceHash !== value.acquisitionEvidenceHash) return null;
  }
  return kept;
}
function identityCollision(mutations, snapshot) {
  const keys = { appendEntries: ["entries", "eventKey"],
    appendRevisions: ["revisions", "revisionKey"],
    appendObservations: ["observations", "observationKey"],
    appendRuns: ["runs", "runKey"] };
  for (const [field, [snapshotField, key]] of Object.entries(keys)) for (const value of mutations[field]) {
    const prior = snapshot[snapshotField].find(item => item[key] === value[key]);
    if (prior && !same(prior, value)) return `${snapshotField}_identity_collision`;
  }
  return WriterCore.identityConflict({ mutations }, snapshot);
}
async function prepareCalendarFormalSourceMutation(input = {}) {
  const sourceId = typeof input?.sourceId === "string" ? input.sourceId : null;
  if (!exactKeys(input, INPUT_KEYS)) return rejected(sourceId, "precondition_failed",
    "input_shape_invalid");
  const { acquisition, formalSnapshot, acceptedAt, generation, authority } = input;
  if (!Eligibility.EXPECTED_SOURCE_IDS.includes(sourceId))
    return rejected(sourceId, "precondition_failed", "source_unregistered");
  if (!same(authority, AUTHORITY)) return rejected(sourceId, "precondition_failed",
    "authority_mismatch");
  if (inputControlViolation(acquisition)) return rejected(sourceId, "precondition_failed",
    "mutation_input_forbidden");
  const foreignSourceId = foreignSourceIdentity(acquisition, sourceId);
  if (foreignSourceId) return rejected(sourceId, "precondition_failed",
    "source_scope_violation", { foreignSourceId });
  if (containsRawPayload(acquisition)) return rejected(sourceId, "precondition_failed",
    "raw_payload_forbidden");
  if (!HASH.test(generation || "") || !generationConsistent(acquisition, generation))
    return rejected(sourceId, "precondition_failed", "acquisition_generation_stale");
  if (!acceptedAtConsistent(acquisition, acceptedAt)) return rejected(sourceId,
    "precondition_failed", "accepted_at_inconsistent");

  const checkedSnapshot = await validateSnapshot(formalSnapshot);
  if (!checkedSnapshot.valid) return rejected(sourceId, checkedSnapshot.status,
    checkedSnapshot.reason, { errors: checkedSnapshot.errors || [] });
  const source = sourceState(checkedSnapshot.snapshot, sourceId);
  if (source.status === "invalid") return rejected(sourceId, "invalid_snapshot",
    "source_state_incomplete");
  const eligibility = await Eligibility.evaluateSourceEligibility({ sourceResult: acquisition,
    acceptedAt, generationIdentity: generation });
  if (!eligibility.eligible) return rejected(sourceId, "ineligible", eligibility.reason,
    { failedChecks: eligibility.failedChecks, classification: eligibility.classification });

  const records = candidateRecords(acquisition).slice().sort((left, right) =>
    left.eventKey.localeCompare(right.eventKey)), fetchedAt = [...new Set(records.map(value =>
    value.acquisitionEvidence?.fetchedAt))].sort(), runIdentity = await Canonicalizer.sha256({
    sourceId, acceptedAt, generation, semanticSetIdentity: eligibility.diagnostics.semanticSetIdentity,
    candidateIdentity: acquisition.candidateEnvelope?.candidateIdentity || acquisition.candidateIdentity,
    fetchedAt }), runId = `partial-source|sha256:${runIdentity}`, run = { sourceId, runId,
    acceptedAt, fetchedAt, status: "accepted",
    semanticSetHash: eligibility.diagnostics.semanticSetIdentity }, runKey = `${sourceId}|${runId}`,
    existingRun = checkedSnapshot.snapshot.runs.find(value => value.runKey === runKey);
  if (existingRun) {
    const expected = { ...run, runKey, contractVersion: 1 };
    if (!same(existingRun, expected)) return rejected(sourceId, "collision",
      "source_run_identity_collision");
    const mutations = emptyMutations(), base = { preparationVersion: PREPARATION_VERSION,
      status: "already_committed", sourceId, reason: null, operationType: "already_committed_noop",
      writeAllowed: false, executionAuthorized: false,
      preconditions: { expectedDatabaseStatus: formalSnapshot.databaseStatus,
        expectedSchemaVersion: Schema.VERSION, expectedSchemaFingerprint: Schema.EXPECTED_FINGERPRINT,
        sourceId, expectedSourceState: expectedSourceState(checkedSnapshot.snapshot, sourceId),
        formalSnapshotFingerprint: checkedSnapshot.snapshotFingerprint,
        acquisitionGenerationIdentity: generation,
        semanticSetIdentity: eligibility.diagnostics.semanticSetIdentity,
        authorityIdentity: AUTHORITY.identity, authorityVersion: AUTHORITY.version },
      mutations, mutationCeiling: operationCeiling(mutations), mutationCounts: mutationCounts(mutations),
      receiptExpectation: { commitClaimed: false, operationType: "already_committed_noop",
        sourceId, expectedMutationCounts: mutationCounts(mutations), existingRunKey: runKey },
      diagnostics: { sourceState: source.status, eligibility: "eligible" } };
    return frozen({ ...base, planIdentity: await Canonicalizer.sha256(base) });
  }

  const transition = Transition.planTransition({ snapshot: checkedSnapshot.snapshot, run,
    canonicalSet: records, coverage: acquisition.coverage || null, parserChanged: false });
  if (!transition.ok || !transition.plan) {
    const collision = transition.errors?.includes("cross_source_identity_collision");
    return rejected(sourceId, collision ? "collision" : "precondition_failed",
      collision ? "cross_source_event_key_collision" : `transition_${transition.outcome}`,
      { errors: transition.errors || [] });
  }
  const mapped = Mapper.mapPlan(transition.plan), mutations = Object.fromEntries(MUTATION_KEYS.map(key =>
    [key, clone(mapped[key])])), filteredEvidence = filterExistingEvidence(mutations,
      checkedSnapshot.snapshot);
  if (!filteredEvidence) return rejected(sourceId, "collision", "evidence_identity_collision");
  mutations.appendEvidence = filteredEvidence;
  const collision = identityCollision(mutations, checkedSnapshot.snapshot);
  if (collision) return rejected(sourceId, "collision", collision);
  const draft = { sourceId, mutations };
  if (!WriterCore.planScopeValid(draft) ||
      !WriterCore.linkageValid(draft, checkedSnapshot.snapshot))
    return rejected(sourceId, "precondition_failed", "mutation_source_scope_invalid");
  const updates = WriterCore.expectedWrites(draft, checkedSnapshot.snapshot);
  if (!updates) return rejected(sourceId, "precondition_failed", "mutation_precondition_invalid");
  const after = WriterCore.applyToMemory(checkedSnapshot.snapshot, draft, updates),
    semantic = await Integrity.audit(after), storage = Integrity.auditStorageSnapshot(after),
    afterLinkage = linkageErrors(after);
  if (!semantic.valid || !storage.valid || afterLinkage.length)
    return rejected(sourceId, "precondition_failed", "prepared_snapshot_integrity_invalid",
      { errors: [...semantic.errors, ...storage.errors, ...afterLinkage] });

  const counts = mutationCounts(mutations), operationType = formalSnapshot.databaseStatus === "absent"
    ? "create_schema_and_commit_first_source" : source.status === "absent"
      ? "append_source_to_existing_schema" : counts.semanticRevisionCreate ||
        counts.semanticRevisionClose ? "commit_source_semantic_revision" :
        "commit_source_observation", status = formalSnapshot.databaseStatus === "absent"
      ? "ready_first_source" : source.status === "absent" ? "ready_append_source" :
        counts.semanticRevisionCreate || counts.semanticRevisionClose ? "ready_new_revision" :
          "no_semantic_change", preconditions = {
    expectedDatabaseStatus: formalSnapshot.databaseStatus,
    expectedSchemaVersion: Schema.VERSION,
    expectedSchemaFingerprint: Schema.EXPECTED_FINGERPRINT,
    sourceId,
    expectedSourceState: expectedSourceState(checkedSnapshot.snapshot, sourceId),
    formalSnapshotFingerprint: checkedSnapshot.snapshotFingerprint,
    acquisitionGenerationIdentity: generation,
    semanticSetIdentity: eligibility.diagnostics.semanticSetIdentity,
    authorityIdentity: AUTHORITY.identity,
    authorityVersion: AUTHORITY.version
  }, afterDescriptor = { databaseStatus: "present", schemaVersion: Schema.VERSION,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, ...after }, afterFingerprint =
    await fingerprintFormalSnapshot(afterDescriptor), afterSource = expectedSourceState(after, sourceId),
    receiptExpectation = {
      commitClaimed: false,
      operationType,
      sourceId,
      expectedMutationCounts: counts,
      expectedRunIdentity: await Canonicalizer.sha256(mutations.appendRuns[0]),
      expectedCursorIdentity: await Canonicalizer.sha256(mutations.updateCursors[0]),
      expectedActiveRevisionIdentities: afterSource.activeRevisionIdentities,
      expectedSnapshotFingerprint: afterFingerprint,
      expectedSchemaVersion: Schema.VERSION,
      expectedSchemaFingerprint: Schema.EXPECTED_FINGERPRINT
    }, base = { preparationVersion: PREPARATION_VERSION, status, sourceId, reason: null,
      operationType, writeAllowed: false, executionAuthorized: false, preconditions,
      mutations, mutationCeiling: operationCeiling(mutations), mutationCounts: counts,
      receiptExpectation, diagnostics: { sourceState: source.status, eligibility: "eligible",
        recordCount: records.length, specialGuards: eligibility.diagnostics.specialGuards } };
  return frozen({ ...base, planIdentity: await Canonicalizer.sha256(base) });
}

module.exports = Object.freeze({ PREPARATION_VERSION, AUTHORITY, SNAPSHOT_FIELDS,
  MUTATION_KEYS, fingerprintFormalSnapshot, prepareCalendarFormalSourceMutation });
