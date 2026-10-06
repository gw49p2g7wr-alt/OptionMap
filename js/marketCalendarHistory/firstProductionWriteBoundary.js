"use strict";

// PREWRITE_ONLY remains non-executable. E3b has a separate main-side one-shot issuer.
const { randomUUID } = require("node:crypto");
const Schema = require("./productionSchemaV1.js");
const Authority = require("./formalWriterAuthority.js");
const Core = require("./formalControlledWriterCore.js");
const Shadow = require("./formalShadowWritePlan.js");
const Integrity = require("./historyIntegrity.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Compare = require("../marketCalendarRuntime/formalExactComparison.js");
const Gate = require("../marketCalendarRuntime/formalShadowReadOnlyGate.js");
const Routes = require("../marketCalendarRuntime/calendarRouteAuthority.js");
const NetworkPolicy = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const HISTORICAL_SOURCE_IDS = require("../marketCalendar/sourceRegistry.js").HISTORICAL_SOURCE_IDS;

// Private construction only: callers can select neither source nor authority mode.
function fixedBoundary(SOURCE_ID, AUTHORIZATION_MODE, RUN_PREFIX, EVENT_COUNT,
  EVIDENCE_ONLY_COUNT = 0, NEW_EVIDENCE_URL = null, NEW_COUNT = 0) {
const DATABASE_NAME = Schema.DATABASE_NAME;
const MODE = "PREWRITE_ONLY";
const EXPECTED_COUNTS = Object.freeze({ eventEntryCreate: NEW_COUNT, eventEntryUpdate: EVENT_COUNT - NEW_COUNT,
  semanticRevisionCreate: NEW_COUNT, semanticRevisionClose: 0, evidenceCreate: EVENT_COUNT,
  observationCreate: EVENT_COUNT, sourceRunCreate: 1, sourceCursorUpdate: 1 });
const MUTATION_CEILING = Object.freeze({ appendEntries: NEW_COUNT, updateEntries: EVENT_COUNT - NEW_COUNT,
  closeRevisions: 0, appendRevisions: NEW_COUNT, appendEvidence: EVENT_COUNT, appendObservations: EVENT_COUNT,
  appendRuns: 1, updateCursors: 1 });
const sessions = new WeakMap(), tickets = new WeakMap();
const authorizations = new WeakMap();
const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const rejected = reason => ({ status: "rejected", reason, firstLiveWriteEligible: false,
  mode: MODE, writeAllowed: false, coreWriteExecutions: 0 });
const exactKeys = (value, keys) => value && typeof value === "object" &&
  Core.same(Object.keys(value).sort(), [...keys].sort());
const counts = snapshot => Object.fromEntries(Core.STORE_ORDER.map(([field]) =>
  [field, snapshot[field].length]));
function evidenceTransitionAudit(before, plan, after = null) {
  if (!EVIDENCE_ONLY_COUNT) return null;
  const rows = plan.mutations.appendEvidence.filter(next => !NEW_COUNT ||
    before.entries.some(value => value.eventKey === next.eventKey)).map(next => {
    const entry = before.entries.find(value => value.eventKey === next.eventKey),
      revision = before.revisions.find(value => value.revisionKey === entry?.activeRevisionKey),
      old = before.evidence.filter(value => value.eventKey === next.eventKey &&
        value.revisionKey === entry?.activeRevisionKey);
    const distinct = !before.evidence.some(value => value.evidenceLinkKey === next.evidenceLinkKey);
    const sameRevision = next.revisionKey === entry?.activeRevisionKey && !!revision;
    const expectedUrl = NEW_COUNT ? require("../marketCalendarIsolated/blsFixedRoute.js").ROLES
      .find(role => role.eventType === revision?.logical?.eventType)?.url : NEW_EVIDENCE_URL;
    const provenanceChanged = next.acquisitionEvidence?.sourceUrl === expectedUrl &&
      old.length > 0 && old.every(value => value.acquisitionEvidence?.sourceUrl &&
        value.acquisitionEvidence.sourceUrl !== expectedUrl);
    const oldPreserved = !after || old.every(value => Core.same(value,
      after.evidence.find(observed => observed.evidenceLinkKey === value.evidenceLinkKey)));
    const revisionPreserved = !after || Core.same(revision,
      after.revisions.find(value => value.revisionKey === next.revisionKey)) &&
      after.entries.find(value => value.eventKey === next.eventKey)?.activeRevisionKey === next.revisionKey;
    const newLinked = !after || Core.same(next,
      after.evidence.find(value => value.evidenceLinkKey === next.evidenceLinkKey));
    return { eventKey: next.eventKey, revisionKey: next.revisionKey,
      ...(SOURCE_ID === "jp-stat-cpi" ? { lane: revision?.logical?.scope,
        eventType: revision?.logical?.eventType, edition: revision?.logical?.edition } : {}),
      semanticHash: revision?.canonicalContentHash || null,
      oldEvidenceKeys: old.map(value => value.evidenceLinkKey).sort(),
      oldUrls: [...new Set(old.map(value => value.acquisitionEvidence?.sourceUrl))].sort(),
      newEvidenceKey: next.evidenceLinkKey, newUrl: next.acquisitionEvidence?.sourceUrl || null,
      distinct, sameRevision, provenanceChanged, oldPreserved, revisionPreserved, newLinked };
  }).sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { valid: rows.length === EVIDENCE_ONLY_COUNT &&
    new Set(rows.map(value => value.eventKey)).size === EVIDENCE_ONLY_COUNT &&
    rows.every(value => value.distinct && value.sameRevision && value.provenanceChanged &&
      value.oldPreserved && value.revisionPreserved && value.newLinked),
    eventCount: rows.length, rows };
}
function newLinkageAudit(before, plan, after = null) {
  if (!NEW_COUNT) return null;
  const m = plan.mutations, roles = require("../marketCalendarIsolated/blsFixedRoute.js").ROLES;
  const rows = m.appendEntries.map(entry => {
    const revisions = m.appendRevisions.filter(value => value.eventKey === entry.eventKey),
      evidence = m.appendEvidence.filter(value => value.eventKey === entry.eventKey),
      observations = m.appendObservations.filter(value => value.eventKey === entry.eventKey),
      revision = revisions[0], role = roles.find(value => value.eventType === revision?.logical?.eventType);
    const valid = !before.entries.some(value => value.eventKey === entry.eventKey) &&
      !before.revisions.some(value => value.revisionKey === entry.activeRevisionKey) &&
      revisions.length === 1 && revision.validTo === null && revision.revisionOrigin === "initial_observation" &&
      entry.activeRevisionKey === revision.revisionKey && evidence.length === 1 && observations.length === 1 &&
      evidence[0].revisionKey === revision.revisionKey && observations[0].state === "observed" &&
      observations[0].sourceId === SOURCE_ID && observations[0].runId === evidence[0].runId &&
      observations[0].acceptedAt === evidence[0].acceptedAt &&
      role && evidence[0].acquisitionEvidence?.sourceUrl === role.url &&
      (!after || [entry, revision, evidence[0], observations[0]].every((value, i) => {
        const field = ["entries", "revisions", "evidence", "observations"][i],
          key = ["eventKey", "revisionKey", "evidenceLinkKey", "observationKey"][i];
        return Core.same(value, after[field].find(item => item[key] === value[key]));
      }));
    return { eventKey: entry.eventKey, revisionKey: entry.activeRevisionKey,
      evidenceKey: evidence[0]?.evidenceLinkKey, observationKey: observations[0]?.observationKey,
      role: role?.role, valid: !!valid };
  }).sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { valid: rows.length === NEW_COUNT && new Set(rows.map(x => x.eventKey)).size === NEW_COUNT &&
    new Set(rows.map(x => x.revisionKey)).size === NEW_COUNT && rows.every(x => x.valid),
    eventCount: rows.length, rows };
}
async function safetySnapshot(snapshot) {
  const semantic = await Integrity.audit(snapshot), storage = Integrity.auditStorageSnapshot(snapshot),
    entries = new Map(snapshot.entries.map(value => [value.eventKey, value])),
    revisions = new Map(snapshot.revisions.map(value => [value.revisionKey, value]));
  const audit = { activeCount: snapshot.entries.length,
    duplicateActiveEventKey: snapshot.entries.length - entries.size,
    multipleActiveRevision: snapshot.entries.filter(value => snapshot.revisions.filter(revision =>
      revision.eventKey === value.eventKey && revision.validTo === null).length !== 1).length,
    orphanRevision: snapshot.revisions.filter(value => !entries.has(value.eventKey)).length,
    orphanEvidence: snapshot.evidence.filter(value => !revisions.has(value.revisionKey)).length,
    orphanObservation: snapshot.observations.filter(value => !entries.has(value.eventKey)).length };
  return { valid: semantic.valid && storage.valid && Object.entries(audit).every(([key, value]) =>
    key === "activeCount" || value === 0), ...audit };
}
async function validateFirstWritePlan(plan, before) {
  if (plan?.sourceId !== SOURCE_ID) return { valid: false, reason: "first_source_required" };
  if (plan.mutations && Object.keys(plan.mutations).some(key => /delete|remove/i.test(key)))
    return { valid: false, reason: "delete_forbidden" };
  if ((!NEW_COUNT && plan.mutations?.appendRevisions?.length) || plan.mutations?.closeRevisions?.length)
    return { valid: false, reason: "revision_mutation_forbidden" };
  if (!(await Shadow.validateShadowPlan(plan)).valid || !Core.planScopeValid(plan))
    return { valid: false, reason: "plan_invalid" };
  if (!Core.same(plan.counts, EXPECTED_COUNTS) || Object.keys(MUTATION_CEILING).some(key =>
    plan.mutations[key].length !== MUTATION_CEILING[key]))
    return { valid: false, reason: "mutation_expectation_mismatch" };
  const updates = Core.expectedWrites(plan, before);
  if (!updates || !Core.linkageValid(plan, before) || updates.entries.some(value =>
    value.activeRevisionKey !== before.entries.find(prior => prior.eventKey === value.eventKey)?.activeRevisionKey))
    return { valid: false, reason: "semantic_linkage_changed" };
  if (updates.entries.some(value => {
    const prior = before.entries.find(record => record.eventKey === value.eventKey);
    return !Core.same(value, { ...prior, lastObservedAt: value.lastObservedAt }) ||
      value.lastObservedAt !== plan.mutations.appendRuns[0]?.acceptedAt;
  })) return { valid: false, reason: "unexpected_entry_field_mutation" };
  if (NEW_COUNT && !newLinkageAudit(before, plan).valid)
    return { valid: false, reason: "new_event_linkage_invalid" };
  if (Core.identityConflict(plan, before) || plan.mutations.appendEvidence.some(value =>
    before.evidence.some(prior => prior.evidenceLinkKey === value.evidenceLinkKey)) ||
    plan.mutations.appendObservations.some(value => before.observations.some(prior =>
      prior.observationKey === value.observationKey)) || plan.mutations.appendRuns.some(value =>
      before.runs.some(prior => prior.runKey === value.runKey)))
    return { valid: false, reason: "existing_identity_overwrite_forbidden" };
  return { valid: true, reason: null };
}
function beginPrewrite() {
  if (typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const session = Object.freeze({});
  sessions.set(session, { phase: "created", startedAt: Date.now(), nonce: randomUUID() });
  return session;
}
async function captureFormalRead(session, snapshot, schemaFingerprint) {
  const state = sessions.get(session);
  if (!state || state.phase !== "created") return rejected("fresh_session_required");
  state.phase = "reading";
  if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT) return rejected("schema_fingerprint_mismatch");
  const before = Core.sorted(Core.copy(snapshot)), audit = await safetySnapshot(before);
  if (!audit.valid) return rejected("formal_ambiguity");
  state.before = before;
  state.preconditionIdentity = await Gate.formalPreconditionIdentity(before, schemaFingerprint);
  state.phase = "read";
  return { status: "captured", preconditionIdentity: state.preconditionIdentity, audit };
}
async function completePrewrite(session, input) {
  const preparationStartedAt = Date.now();
  const state = sessions.get(session);
  if (!state || state.phase !== "read") return rejected("fresh_session_required");
  state.phase = "consumed";
  if (!exactKeys(input, ["sourceResults", "endingFormalSnapshot", "completedAt"]))
    return rejected("prewrite_input_invalid");
  const { sourceResults, endingFormalSnapshot, completedAt } = Core.copy(input);
  if (!Array.isArray(sourceResults) || sourceResults.length !== HISTORICAL_SOURCE_IDS.length ||
      !Number.isFinite(Date.parse(completedAt)) || Date.parse(completedAt) < state.startedAt ||
      Date.parse(completedAt) > Date.now()) return rejected("fresh_acquisition_required");
  // CPI inherits its existing two-lane production contract, never total-count-only eligibility.
  let laneAudit = null, documentAudit = null;
  if (NEW_COUNT) {
    const source = sourceResults.find(value => value.sourceId === SOURCE_ID),
      roles = require("../marketCalendarIsolated/blsFixedRoute.js").ROLES;
    if (!Array.isArray(source?.documentHealth) || !Array.isArray(source?.coverage?.roleCoverage))
      return rejected("bls_document_contract_invalid");
    documentAudit = roles.map(role => {
      const health = source.documentHealth.filter(value => value.role === role.role),
        coverage = source.coverage.roleCoverage.filter(value => value.role === role.role);
      return { role: role.role, valid: health.length === 1 && health[0].httpStatus === 200 &&
        health[0].fetchOutcome === "success" && health[0].parseOutcome === "success" &&
        health[0].redirectCount === 0 && coverage.length === 1 &&
        coverage[0].state === "sufficient" && coverage[0].absenceAuthority === "none" };
    });
    if (source.acquisitionOutcome !== "complete" || source.absenceAuthority !== "none" ||
        source.coverage.coverageState !== "sufficient" || source.coverage.absenceAuthority !== "none" ||
        source.documentHealth.length !== 4 || source.coverage.roleCoverage.length !== 4 ||
        !documentAudit.every(value => value.valid))
      return { ...rejected("bls_document_contract_invalid"), documentAudit };
  }
  if (SOURCE_ID === "jp-stat-cpi") {
    const source = sourceResults.find(value => value.sourceId === SOURCE_ID), coverage = source?.coverage;
    if (!Array.isArray(source?.canonicalRecords) || !Array.isArray(coverage?.laneAssessments))
      return rejected("cpi_lane_contract_invalid");
    const lanes = [["national", "JP_NATIONAL_CPI", "initial"], ["tokyo", "JP_TOKYO_CPI", "preliminary"]];
    laneAudit = lanes.map(([lane, eventType, edition]) => {
      const records = (source?.canonicalRecords || []).filter(record => record.logical?.scope === lane),
        assessments = (coverage?.laneAssessments || []).filter(value => value.lane === lane);
      return { lane, candidateCount: records.length, coverageState: assessments[0]?.coverageState ?? null,
        valid: records.length === 15 && records.every(record => record.logical.eventType === eventType &&
          record.logical.edition === edition) && assessments.length === 1 &&
          assessments[0].coverageState === "sufficient" && assessments[0].absenceAuthority === "none" &&
          assessments[0].eligibleEventCount === records.length };
    });
    if (source?.acquisitionOutcome !== "complete" || source.absenceAuthority !== "none" ||
        coverage?.coverageState !== "sufficient" || coverage.absenceAuthority !== "none" ||
        coverage.laneAssessments?.length !== 2 || !laneAudit.every(value => value.valid))
      return { ...rejected("cpi_lane_contract_invalid"), laneAudit };
  }
  const routeAudit = [];
  for (const source of sourceResults) {
    const selected = Routes.selectRoute({ sourceId: source.sourceId, operation: NetworkPolicy.OPERATION },
      Routes.PRODUCTION_AUTHORITY);
    const present = identity => typeof identity === "string" && identity.trim().length > 0;
    const selectorValid = selected.valid === true && selected.reason === null &&
      selected.acquisitionAllowed === true && present(selected.routeIdentity);
    const acquisitionIdentityPresent = present(source.routeIdentity);
    const match = selectorValid && acquisitionIdentityPresent && source.routeIdentity === selected.routeIdentity;
    routeAudit.push({ sourceId: source.sourceId, operation: NetworkPolicy.OPERATION,
      selectorValid, selectorRouteIdentity: selected.routeIdentity ?? null,
      acquisitionRouteIdentity: source.routeIdentity ?? null, match });
    if (!selectorValid) return { ...rejected("route_selector_invalid"), routeAudit };
    if (!acquisitionIdentityPresent) return { ...rejected("route_identity_missing"), routeAudit };
    if (!match) return { ...rejected("route_identity_mismatch"), routeAudit };
    if (!Array.isArray(source.canonicalRecords) || !source.canonicalRecords.length ||
        source.canonicalRecords.some(record => {
          const evidence = record.acquisitionEvidence, fetched = Date.parse(evidence?.fetchedAt);
          return evidence?.sourceId !== source.sourceId || !Number.isFinite(fetched) ||
            fetched < state.startedAt || fetched > Date.parse(completedAt);
        })) return rejected("fresh_acquisition_required");
  }
  const endingIdentity = await Gate.formalPreconditionIdentity(endingFormalSnapshot,
    Schema.EXPECTED_FINGERPRINT);
  const shadowReport = await Gate.buildReadOnlyShadowReport({ formalSnapshot: state.before,
    sourceResults, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, completedAt,
    startingPreconditionIdentity: state.preconditionIdentity, endingPreconditionIdentity: endingIdentity });
  const globalEligible = shadowReport.status === "evaluated" &&
    shadowReport.sourceSuccessCount === HISTORICAL_SOURCE_IDS.length && shadowReport.comparison.totals.changed === 0 &&
    Object.values(shadowReport.identityAudit).every(value => value === 0) &&
    shadowReport.sourceRows.every(value => value.sourceId === Authority.BOJ_SOURCE_ID ||
      value.planStatus === "planned");
  if (!globalEligible || SOURCE_ID === Authority.FIRST_WRITE_SOURCE_ID && !shadowReport.firstLiveWriteEligible)
    return { ...rejected(shadowReport.reason || "fresh_gate_not_ready"), shadowReport };
  const first = shadowReport.sourceRows.find(value => value.sourceId === SOURCE_ID);
  if (first.candidate !== EVENT_COUNT || first.formalActive !== EVENT_COUNT - NEW_COUNT || first.unchanged !== EVENT_COUNT - NEW_COUNT ||
      first.changed !== 0 || first.new !== NEW_COUNT || first.evidenceOnly !== EVIDENCE_ONLY_COUNT || first.notEvaluated !== 0)
    return rejected("first_source_expectation_mismatch");
  const sourceResult = sourceResults.find(value => value.sourceId === SOURCE_ID),
    comparison = await Compare.compare({ sourceResults, formalSnapshot: state.before }),
    run = { sourceId: SOURCE_ID, runId: `${RUN_PREFIX}-${state.nonce}`, acceptedAt: completedAt,
      fetchedAt: [...new Set(sourceResult.canonicalRecords.map(value => value.acquisitionEvidence.fetchedAt))].sort(),
      status: "accepted", semanticSetHash: await Canonical.sha256(sourceResult.canonicalRecords.map(value =>
        value.revisionKey).sort()) },
    plan = await Shadow.buildSourceShadowPlan({ sourceId: SOURCE_ID, sourceResult, comparison,
      formalSnapshot: state.before, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, run }),
    validation = await validateFirstWritePlan(plan, state.before);
  if (!validation.valid) return rejected(validation.reason);
  const provenanceAudit = evidenceTransitionAudit(state.before, plan);
  if (provenanceAudit && !provenanceAudit.valid) return rejected("evidence_transition_invalid");
  const corePreparation = Core.prepareExecution(plan, state.before, MUTATION_CEILING),
    expectedAfter = Core.applyToMemory(state.before, plan, Core.expectedWrites(plan, state.before)),
    beforeSafety = await safetySnapshot(state.before), afterSafety = await safetySnapshot(expectedAfter);
  if (!afterSafety.valid || !Core.same({ ...beforeSafety, activeCount: beforeSafety.activeCount + NEW_COUNT }, afterSafety)) return rejected("expected_global_integrity_changed");
  for (const [field] of Core.STORE_ORDER) if (!Core.same(
    state.before[field].filter(value => value.sourceId !== SOURCE_ID),
    expectedAfter[field].filter(value => value.sourceId !== SOURCE_ID)))
    return rejected("other_source_mutation");
  const binding = { databaseName: DATABASE_NAME, sourceId: SOURCE_ID, invocationId: state.nonce,
    planIdentity: plan.planIdentity, preconditionIdentity: plan.preconditionIdentity },
    ticket = Object.freeze({});
  const identities = { schemaFingerprint: plan.schemaFingerprint, precondition: plan.preconditionIdentity,
    activeFormal: plan.activeFormalIdentity, candidateSet: plan.candidateSetIdentity,
    acquisition: plan.acquisitionIdentity, comparison: plan.comparisonIdentity, plan: plan.planIdentity };
  tickets.set(ticket, { binding: Core.copy(binding), plan, corePreparation, identities,
    createdAt: Date.now(), authorizationIssued: false,
    before: Core.copy(state.before), expectedAfter: Core.copy(expectedAfter) });
  return { status: "prewrite_eligible", reason: null, mode: MODE, writeAllowed: false,
    firstLiveWriteEligible: true, writerAuthorityState: Authority.selectWriterState(SOURCE_ID).state,
    coreWriteExecutions: 0, ticket, binding, sourceId: SOURCE_ID, expectedMutationCounts: plan.counts,
    identities: Core.copy(identities), ...(provenanceAudit ? { provenanceAudit } : {}),
    ...(laneAudit ? { laneAudit } : {}),
    ...(documentAudit ? { documentAudit, linkageAudit: newLinkageAudit(state.before, plan) } : {}),
    ...(NEW_COUNT ? { resourceAudit: { preparationMs: Date.now() - preparationStartedAt,
      preconditionBytes: Buffer.byteLength(Core.material(Core.sorted(state.before))),
      transactionMaterialBytes: Buffer.byteLength(Core.material(plan.mutations)),
      operationCount: EVENT_COUNT * 3 + NEW_COUNT + 2,
      authorizationTtlMs: AUTHORIZATION_TTL_MS } } : {}),
    expectation: { beforeIdentity: await Canonical.sha256(Core.sorted(state.before)),
      afterIdentity: await Canonical.sha256(expectedAfter), beforeCounts: counts(state.before),
      afterCounts: counts(expectedAfter), beforeSafety, afterSafety,
      entries: expectedAfter.entries.filter(value => value.sourceId === SOURCE_ID),
      newEvidenceKeys: plan.mutations.appendEvidence.map(value => value.evidenceLinkKey),
      newObservationKeys: plan.mutations.appendObservations.map(value => value.observationKey),
      newRunKey: plan.mutations.appendRuns[0].runKey,
      cursorBefore: state.before.cursors.find(value => value.sourceId === SOURCE_ID) || null,
      cursorAfter: plan.mutations.updateCursors[0], otherSourceMutation: 0 },
    comparison: shadowReport.comparison, sourceRows: shadowReport.sourceRows,
    identityAudit: shadowReport.identityAudit, sourceSuccessCount: shadowReport.sourceSuccessCount,
    routeAudit };
}
function validateFreshBinding(ticket, binding) {
  const state = tickets.get(ticket);
  return state && Core.same(state.binding, binding) ? { valid: true, reason: null } :
    { valid: false, reason: "fresh_authorization_binding_mismatch" };
}
async function verifyReadback(ticket, snapshot) {
  const state = tickets.get(ticket);
  if (!state) return { valid: false, reason: "fresh_session_required" };
  const audit = await safetySnapshot(snapshot);
  const provenanceAudit = evidenceTransitionAudit(state.before, state.plan, snapshot),
    linkageAudit = newLinkageAudit(state.before, state.plan, snapshot);
  return { valid: audit.valid && Core.same(Core.sorted(snapshot), state.expectedAfter) &&
    (!provenanceAudit || provenanceAudit.valid) && (!linkageAudit || linkageAudit.valid),
    audit, ...(provenanceAudit ? { provenanceAudit } : {}), ...(linkageAudit ? { linkageAudit } : {}),
    expectedIdentity: await Canonical.sha256(state.expectedAfter),
    observedIdentity: await Canonical.sha256(Core.sorted(snapshot)) };
}
function requestProductionWrite(input = {}) {
  if (!exactKeys(input, ["ticket", "binding"])) return rejected("production_input_invalid");
  if (input.binding?.databaseName !== DATABASE_NAME) return rejected("fixed_database_required");
  if (input.binding?.sourceId !== SOURCE_ID) return rejected("first_source_required");
  if (!validateFreshBinding(input.ticket, input.binding).valid) return rejected("fresh_authorization_binding_mismatch");
  if (Authority.selectWriterState(SOURCE_ID).state !== "active") return rejected("writer_authority_disabled");
  // E3b must add a separately approved one-shot issuer; no active execution path exists in E3a.
  return rejected("e3b_explicit_authorization_required");
}
function authorizeFirstProductionWrite(input = {}) {
  if (typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (!exactKeys(input, ["ticket", "binding"]) || !validateFreshBinding(input.ticket, input.binding).valid)
    throw Error("fresh_authorization_binding_mismatch");
  const state = tickets.get(input.ticket);
  if (state.authorizationIssued) throw Error("authorization_already_issued");
  if (Date.now() - state.createdAt > AUTHORIZATION_TTL_MS) throw Error("authorization_expired");
  if (Authority.selectWriterState(SOURCE_ID).state !== "disabled") throw Error("disabled_authority_required");
  if (Object.values(state.identities).some(value => !/^[a-f0-9]{64}$/.test(value)))
    throw Error("fresh_identity_missing");
  state.authorizationIssued = true;
  const binding = Object.freeze({ ...Core.copy(state.binding), version: 1,
    identities: Core.copy(state.identities), exactMutationCeiling: Core.copy(MUTATION_CEILING),
    plannedReadwriteTransactions: 1, authorityMode: AUTHORIZATION_MODE });
  const authorization = Object.freeze({});
  authorizations.set(authorization, { ticket: input.ticket, binding: Core.copy(binding),
    expiresAt: state.createdAt + AUTHORIZATION_TTL_MS, consumed: false });
  return { authorization, binding };
}
// This internal handoff is used only by the explicit E3b harness executor, never IPC/startup.
function consumeFirstProductionAuthorization(authorization, binding) {
  if (typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const auth = authorizations.get(authorization);
  if (!auth || auth.consumed) throw Error("authorization_invalid_or_reused");
  auth.consumed = true; // A failed attempt also exhausts the authorization; no retry.
  if (!Core.same(auth.binding, binding)) throw Error("fresh_authorization_binding_mismatch");
  if (Date.now() > auth.expiresAt) throw Error("authorization_expired");
  if (Authority.selectWriterState(SOURCE_ID).state !== "disabled") throw Error("disabled_authority_required");
  const state = tickets.get(auth.ticket);
  return { ticket: auth.ticket, expiresAt: auth.expiresAt, binding: Core.copy(auth.binding),
    plan: Core.copy(state.plan), before: Core.copy(state.before), expectedAfter: Core.copy(state.expectedAfter) };
}
return Object.freeze({ SOURCE_ID, DATABASE_NAME, MODE, EXPECTED_COUNTS, MUTATION_CEILING, HISTORICAL_SOURCE_IDS,
  beginPrewrite, captureFormalRead, completePrewrite, validateFirstWritePlan,
  validateFreshBinding, requestProductionWrite, verifyReadback,
  authorizeFirstProductionWrite, consumeFirstProductionAuthorization });
}
const first = fixedBoundary(Authority.FIRST_WRITE_SOURCE_ID, "E3b_explicit_one_shot", "e3a-prewrite", 4);
const sna = fixedBoundary("jp-esri-sna-calendar", "E4a_sna_explicit_one_shot", "e4a-sna", 4);
const bea = fixedBoundary("us-bea-calendar", "E4b1_bea_explicit_one_shot", "e4b1-bea", 8);
const census = fixedBoundary("us-census-calendar", "E4b2_census_explicit_one_shot", "e4b2-census", 13);
const fomc = fixedBoundary("us-fed-fomc-calendar", "E4b3_fomc_explicit_one_shot", "e4b3-fomc", 24);
const jpxDerivatives = fixedBoundary("jp-jpx-derivatives-calendar", "E4b4_jpx_derivatives_explicit_one_shot", "e4b4-jpx-derivatives", 24);
const nyse = fixedBoundary("us-nyse-market-holidays", "E4b5_nyse_explicit_one_shot", "e4b5-nyse", 34);
const jpxHolidays = fixedBoundary("jp-jpx-market-holidays", "E4b6_jpx_holidays_explicit_one_shot", "e4b6-jpx-holidays", 41);
const laborEvidence = fixedBoundary("jp-stat-labor", "E4c_labor_explicit_one_shot", "e4c-labor", 15, 15,
  require("../marketCalendarIsolated/estatRoute.js").ROUTES["jp-stat-labor"].url);
const cpiEvidence = fixedBoundary("jp-stat-cpi", "E4c_cpi_explicit_one_shot", "e4c-cpi", 30, 30,
  require("../marketCalendarIsolated/estatRoute.js").ROUTES["jp-stat-cpi"].url);
const blsNew = fixedBoundary("us-bls-calendar", "E4d_bls_explicit_one_shot", "e4d-bls", 52, 5, null, 47);
module.exports = Object.freeze({ ...first, sna, bea, census, fomc, jpxDerivatives, nyse, jpxHolidays, laborEvidence, cpiEvidence, blsNew });
