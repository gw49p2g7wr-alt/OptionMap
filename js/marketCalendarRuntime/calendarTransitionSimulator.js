"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const HistoryContract = require("../marketCalendarHistory/historyContract.js");
const Planner = require("../marketCalendarHistory/transitionPlanner.js");

const SIMULATION_SCHEMA_VERSION = 1;
const POLICY_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
const emptySummary = () => ({ unchangedCount: 0, changedCount: 0, newCount: 0,
  notEvaluatedCount: 0, unobservedCount: 0, rejectedCount: 0 });
function rejected(sourceId, candidateIdentity, diagnostics, previousStateIdentity = null) {
  return freeze({ sourceId, simulationStatus: "rejected", simulationIdentity: null,
    previousStateIdentity, candidateIdentity: candidateIdentity || null,
    policyVersion: POLICY_VERSION, summary: { ...emptySummary(), rejectedCount: 1 },
    transitions: [], diagnostics: [...diagnostics], commitOutcome: "writer_disabled" });
}
function parserIdentity(source) { return { sourceId: source.sourceId, parserId: source.parserId,
  parserVersion: source.parserVersion }; }
async function candidateIdentity(candidate) {
  return Canonicalizer.sha256({ sourceId: candidate.sourceId,
    parserId: candidate.sourceIdentity?.parserId,
    parserVersion: candidate.sourceIdentity?.parserVersion,
    candidateSchemaVersion: candidate.sourceIdentity?.candidateSchemaVersion,
    revisionKeys: candidate.canonicalRecords.map(record => record.revisionKey).sort() });
}
function validateCandidate(sourceId, candidate, source) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || candidate.sourceId !== sourceId)
    return ["candidate_identity_invalid"];
  if (candidate.candidateStatus !== "available" || candidate.formalEligible !== true)
    errors.push("candidate_not_formal_eligible");
  if (!HASH.test(candidate.candidateIdentity || "")) errors.push("candidate_identity_invalid");
  if (candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
      candidate.parserDiagnostics?.length || candidate.canonicalDiagnostics?.length)
    errors.push("candidate_diagnostics_blocking");
  if (!Array.isArray(candidate.canonicalRecords) || candidate.canonicalRecords.length === 0 ||
      candidate.recordCount !== candidate.canonicalRecords.length)
    errors.push("candidate_canonical_set_invalid");
  const expectedParser = parserIdentity(source), identity = candidate.sourceIdentity;
  if (!identity || identity.sourceId !== expectedParser.sourceId ||
      identity.parserId !== expectedParser.parserId || identity.parserVersion !== expectedParser.parserVersion ||
      identity.candidateSchemaVersion !== 1 || !HASH.test(identity.semanticSetHash || ""))
    errors.push("candidate_source_contract_mismatch");
  const events = new Set(), revisions = new Set();
  for (const event of candidate.canonicalRecords || []) {
    if (typeof event?.eventKey !== "string" || !event.eventKey ||
        typeof event?.revisionKey !== "string" || !event.revisionKey ||
        !HASH.test(event?.canonicalContentHash || "") ||
        event.revisionKey !== `${event.eventKey}|sha256:${event.canonicalContentHash}` ||
        event.acquisitionEvidence?.sourceId !== sourceId) errors.push("candidate_canonical_identity_invalid");
    if (events.has(event?.eventKey)) errors.push("candidate_event_identity_ambiguous");
    if (revisions.has(event?.revisionKey)) errors.push("candidate_revision_identity_ambiguous");
    events.add(event?.eventKey); revisions.add(event?.revisionKey);
  }
  return [...new Set(errors)];
}
async function semanticPreviousIdentity(value) {
  return Canonicalizer.sha256({ sourceId: value.sourceId, schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion, parserIdentity: value.parserIdentity,
    active: value.entries.map(entry => ({ eventKey: entry.eventKey,
      activeRevisionKey: entry.activeRevisionKey })).sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
    revisions: value.revisions.filter(revision => revision.validTo === null).map(revision => ({
      eventKey: revision.eventKey, revisionKey: revision.revisionKey,
      canonicalContentHash: revision.canonicalContentHash })).sort((a, b) =>
      a.eventKey.localeCompare(b.eventKey) || a.revisionKey.localeCompare(b.revisionKey)) });
}
async function validatePrevious(sourceId, previousState, source) {
  if (previousState === null || previousState === undefined) {
    const value = { sourceId, schemaVersion: SIMULATION_SCHEMA_VERSION,
      contractVersion: HistoryContract.CONTRACT_VERSION, parserIdentity: parserIdentity(source),
      entries: [], revisions: [], runs: [], cursors: [] };
    return { valid: true, empty: true, value, identity: await semanticPreviousIdentity(value) };
  }
  const errors = [];
  if (!previousState || typeof previousState !== "object" || Array.isArray(previousState))
    return { valid: false, errors: ["previous_state_malformed"] };
  if (previousState.sourceId !== sourceId) errors.push("previous_source_mismatch");
  if (previousState.schemaVersion !== SIMULATION_SCHEMA_VERSION) errors.push("previous_schema_mismatch");
  if (previousState.contractVersion !== HistoryContract.CONTRACT_VERSION)
    errors.push("previous_contract_mismatch");
  const expectedParser = parserIdentity(source), priorParser = previousState.parserIdentity;
  if (!priorParser || priorParser.sourceId !== sourceId || priorParser.parserId !== expectedParser.parserId ||
      priorParser.parserVersion !== expectedParser.parserVersion)
    errors.push("parser_scope_change_suspected");
  for (const name of ["entries", "revisions", "runs", "cursors"])
    if (!Array.isArray(previousState[name])) errors.push(`previous_${name}_invalid`);
  if (errors.length) return { valid: false, errors: [...new Set(errors)] };
  const entryKeys = new Set(), revisionKeys = new Set(), activeByEvent = new Map();
  for (const revision of previousState.revisions) {
    if (!revision || typeof revision.eventKey !== "string" || typeof revision.revisionKey !== "string" ||
        !HASH.test(revision.canonicalContentHash || "") ||
        revision.revisionKey !== `${revision.eventKey}|sha256:${revision.canonicalContentHash}`)
      errors.push("previous_revision_integrity_invalid");
    if (revisionKeys.has(revision?.revisionKey)) errors.push("previous_revision_duplicate");
    if (!HistoryContract.validateRevisionShape(revision).valid)
      errors.push("previous_revision_shape_invalid");
    revisionKeys.add(revision?.revisionKey);
    if (revision?.validTo === null) activeByEvent.set(revision.eventKey,
      (activeByEvent.get(revision.eventKey) || 0) + 1);
  }
  for (const entry of previousState.entries) {
    if (!entry || typeof entry.eventKey !== "string" || !entry.eventKey ||
        entry.sourceId !== sourceId || typeof entry.activeRevisionKey !== "string")
      errors.push("previous_entry_integrity_invalid");
    if (!HistoryContract.timestamp(entry?.firstKnownAt) ||
        !HistoryContract.timestamp(entry?.lastObservedAt))
      errors.push("previous_entry_timestamp_invalid");
    if (entryKeys.has(entry?.eventKey)) errors.push("previous_event_identity_ambiguous");
    entryKeys.add(entry?.eventKey);
    const active = previousState.revisions.find(revision =>
      revision.revisionKey === entry?.activeRevisionKey && revision.eventKey === entry?.eventKey &&
      revision.validTo === null);
    if (!active) errors.push("previous_active_revision_missing");
    if ((activeByEvent.get(entry?.eventKey) || 0) !== 1) errors.push("previous_active_revision_ambiguous");
  }
  if (previousState.revisions.some(revision => revision.validTo === null && !entryKeys.has(revision.eventKey)))
    errors.push("previous_orphan_active_revision");
  if (previousState.cursors.length > 1 || previousState.cursors.some(cursor =>
      cursor?.sourceId !== sourceId || !HistoryContract.timestamp(cursor?.acceptedAt) ||
      typeof cursor?.runId !== "string" || !cursor.runId))
    errors.push("previous_cursor_ambiguous");
  if (previousState.runs.some(run => run?.sourceId !== sourceId ||
      !HistoryContract.validateAcceptedRun(run).valid)) errors.push("previous_run_integrity_invalid");
  if (errors.length) return { valid: false, errors: [...new Set(errors)] };
  const value = clone(previousState), identity = await semanticPreviousIdentity(value);
  if (previousState.previousStateIdentity && previousState.previousStateIdentity !== identity)
    return { valid: false, errors: ["previous_state_identity_mismatch"] };
  return { valid: true, empty: value.entries.length === 0, value, identity };
}
function coverageFor(sourceId, candidate, previous, coveragePolicy) {
  if (coveragePolicy === null || coveragePolicy === undefined)
    return { valid: true, plannerCoverage: null, identity: { policyVersion: POLICY_VERSION,
      sourceId, mode: "unknown" } };
  if (!coveragePolicy || typeof coveragePolicy !== "object" ||
      coveragePolicy.policyVersion !== POLICY_VERSION || coveragePolicy.sourceId !== sourceId ||
      coveragePolicy.mode !== "explicit_event_keys" || coveragePolicy.allowUnobserved !== true ||
      !Array.isArray(coveragePolicy.eventKeys) || coveragePolicy.parserId !== candidate.sourceIdentity.parserId ||
      coveragePolicy.parserVersion !== candidate.sourceIdentity.parserVersion)
    return { valid: false, errors: ["coverage_policy_invalid"] };
  const previousKeys = new Set(previous.entries.map(entry => entry.eventKey)), eventKeys =
    [...new Set(coveragePolicy.eventKeys)].sort();
  if (eventKeys.some(key => !previousKeys.has(key)))
    return { valid: false, errors: ["coverage_event_identity_unknown"] };
  return { valid: true, plannerCoverage: { confirmed: true, eventKeys }, identity: {
    policyVersion: POLICY_VERSION, sourceId, mode: "explicit_event_keys", allowUnobserved: true,
    parserId: coveragePolicy.parserId, parserVersion: coveragePolicy.parserVersion, eventKeys } };
}
function nextAcceptedAt(previous, candidate) {
  const cursorTime = previous.cursors[0]?.acceptedAt || "1970-01-01T00:00:00.000Z",
    fetched = candidate.canonicalRecords.map(event => event.acquisitionEvidence?.fetchedAt)
      .filter(HistoryContract.timestamp), maximum = [cursorTime, ...fetched].sort().at(-1),
    next = Math.max(Date.parse(maximum), Date.parse(cursorTime) + 1);
  return new Date(next).toISOString();
}

async function simulateCalendarTransition(input) {
  const sourceId = typeof input?.sourceId === "string" ? input.sourceId : null,
    source = Registry.getSource(sourceId);
  if (!source) return rejected(sourceId, input?.candidate?.candidateIdentity, ["source_unknown"]);
  const candidateErrors = validateCandidate(sourceId, input?.candidate, source);
  if (!candidateErrors.length && await candidateIdentity(input.candidate) !== input.candidate.candidateIdentity)
    candidateErrors.push("candidate_identity_mismatch");
  if (!candidateErrors.length && await Canonicalizer.sha256(input.candidate.canonicalRecords
      .map(record => record.revisionKey).sort()) !== input.candidate.sourceIdentity.semanticSetHash)
    candidateErrors.push("candidate_semantic_set_hash_mismatch");
  if (candidateErrors.length) return rejected(sourceId, input?.candidate?.candidateIdentity, candidateErrors);
  const previous = await validatePrevious(sourceId, input.previousState, source);
  if (!previous.valid) return rejected(sourceId, input.candidate.candidateIdentity,
    previous.errors, null);
  const coverage = coverageFor(sourceId, input.candidate, previous.value, input.coveragePolicy);
  if (!coverage.valid) return rejected(sourceId, input.candidate.candidateIdentity,
    coverage.errors, previous.identity);
  const simulationIdentity = await Canonicalizer.sha256({ schemaVersion: SIMULATION_SCHEMA_VERSION,
    sourceId, candidateIdentity: input.candidate.candidateIdentity,
    previousStateIdentity: previous.identity, coveragePolicy: coverage.identity });
  const acceptedAt = nextAcceptedAt(previous.value, input.candidate), runId =
    `simulation-${simulationIdentity}`, run = { sourceId, runId, acceptedAt,
      fetchedAt: [acceptedAt], status: "accepted",
      semanticSetHash: input.candidate.sourceIdentity.semanticSetHash };
  const planned = Planner.planTransition({ snapshot: previous.value, run,
    canonicalSet: input.candidate.canonicalRecords, coverage: coverage.plannerCoverage,
    parserChanged: false });
  if (!planned.ok || !planned.plan) return rejected(sourceId, input.candidate.candidateIdentity,
    [`planner:${planned.outcome}`, ...(planned.errors || [])], previous.identity);
  const appended = new Set(planned.plan.appendEntries.map(entry => entry.eventKey)), changed =
    new Set(planned.plan.appendRevisions.map(revision => revision.eventKey)), observations =
    new Map(planned.plan.appendObservations.map(observation => [observation.eventKey, observation]));
  const previousRevision = new Map(previous.value.entries.map(entry =>
    [entry.eventKey, entry.activeRevisionKey]));
  const transitions = input.candidate.canonicalRecords.map(event => ({ eventKey: event.eventKey,
    previousRevisionKey: previousRevision.get(event.eventKey) || null,
    candidateRevisionKey: event.revisionKey, status: appended.has(event.eventKey) ? "new" :
      changed.has(event.eventKey) ? "changed" : "unchanged" }));
  for (const entry of previous.value.entries) if (!observations.has(entry.eventKey) ||
      observations.get(entry.eventKey).state !== "observed") {
    const observation = observations.get(entry.eventKey);
    transitions.push({ eventKey: entry.eventKey, previousRevisionKey: entry.activeRevisionKey,
      candidateRevisionKey: null, status: observation?.state === "unobserved"
        ? "unobserved" : "not_evaluated" });
  }
  transitions.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  const summary = emptySummary();
  for (const transition of transitions) summary[`${transition.status.replace(/_([a-z])/g,
    (_, value) => value.toUpperCase())}Count`] += 1;
  const statuses = new Set(transitions.map(transition => transition.status));
  const simulationStatus = statuses.size === 1 ? [...statuses][0] : "mixed";
  return freeze({ sourceId, simulationStatus, simulationIdentity,
    previousStateIdentity: previous.identity, candidateIdentity: input.candidate.candidateIdentity,
    policyVersion: POLICY_VERSION, summary, transitions, diagnostics: [],
    commitOutcome: "writer_disabled" });
}

module.exports = Object.freeze({ SIMULATION_SCHEMA_VERSION, POLICY_VERSION,
  simulateCalendarTransition });
