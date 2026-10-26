"use strict";

// Internal one-use authority for CAL-PB plans. No writer or storage capability
// is exposed by this module.
const { randomUUID } = require("node:crypto");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Contract = require("./calendarPartialBootstrapContract.js");
const Preparation = require("./calendarPartialSourcePreparation.js");
const Schema = require("./productionSchemaV1.js");
const WriterCore = require("./formalControlledWriterCore.js");

const AUTHORITY_VERSION = 1;
const AUTHORITY_IDENTITY = "calendar-partial-source-execution-authority-v1";
const GRANT_TTL_MS = 30_000;
const PLAN_KEYS = Object.freeze(["preparationVersion", "status", "sourceId", "reason",
  "operationType", "writeAllowed", "executionAuthorized", "preconditions", "mutations",
  "mutationCeiling", "mutationCounts", "receiptExpectation", "diagnostics", "planIdentity"]);
const EXECUTION_OPERATION = Object.freeze({
  ready_first_source: "create_schema_and_commit_first_source",
  ready_append_source: "append_missing_source",
  ready_new_revision: "append_source_revision"
});
const PLAN_OPERATION = Object.freeze({
  ready_first_source: "create_schema_and_commit_first_source",
  ready_append_source: "append_source_to_existing_schema",
  ready_new_revision: "commit_source_semantic_revision",
  no_semantic_change: "commit_source_observation",
  already_committed: "already_committed_noop"
});
const NOOP_STATUS = new Set(["no_semantic_change", "already_committed"]);
const grants = new WeakMap(), spent = new WeakSet();
const same = (left, right) => Canonicalizer.stable(left) === Canonicalizer.stable(right);
const frozen = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};
const exactKeys = (value, keys) => !!value && typeof value === "object" &&
  same(Object.keys(value).sort(), [...keys].sort());
const expectedCeiling = mutations => Object.fromEntries(Preparation.MUTATION_KEYS.map(key =>
  [key, mutations[key].length]));
const expectedCounts = mutations => ({ eventEntryCreate: mutations.appendEntries.length,
  eventEntryUpdate: mutations.updateEntries.length,
  semanticRevisionCreate: mutations.appendRevisions.length,
  semanticRevisionClose: mutations.closeRevisions.length,
  evidenceCreate: mutations.appendEvidence.length,
  observationCreate: mutations.appendObservations.length,
  sourceRunCreate: mutations.appendRuns.length,
  sourceCursorUpdate: mutations.updateCursors.length });
function scopeValid(plan) {
  if (!WriterCore.planScopeValid(plan)) return false;
  const sourceId = plan.sourceId, active = new Map(
    plan.preconditions.expectedSourceState.activeRevisionIdentities.map(value =>
      [value.eventKey, value.revisionKey]));
  if (plan.mutations.updateEntries.some(value => !active.has(value.eventKey)) ||
      plan.mutations.closeRevisions.some(value => ![...active.values()].includes(value.revisionKey)))
    return false;
  for (const field of ["appendEntries", "appendRevisions", "appendEvidence",
    "appendObservations", "appendRuns", "updateCursors"])
    if (plan.mutations[field].some(value => value.sourceId !== sourceId)) return false;
  return true;
}
async function validatePlan(plan) {
  if (!exactKeys(plan, PLAN_KEYS) || plan.preparationVersion !== Preparation.PREPARATION_VERSION ||
      !Contract.EXPECTED_SOURCE_IDS.includes(plan.sourceId) || plan.reason !== null ||
      plan.writeAllowed !== false || plan.executionAuthorized !== false ||
      !Object.hasOwn(PLAN_OPERATION, plan.status) || plan.operationType !== PLAN_OPERATION[plan.status])
    return frozen({ valid: false, reason: "invalid_plan", operation: null, noOp: false });
  if (!plan.preconditions || plan.preconditions.sourceId !== plan.sourceId ||
      plan.preconditions.expectedSchemaVersion !== Schema.VERSION ||
      plan.preconditions.expectedSchemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      plan.preconditions.authorityIdentity !== Preparation.AUTHORITY.identity ||
      plan.preconditions.authorityVersion !== Preparation.AUTHORITY.version)
    return frozen({ valid: false, reason: "authority_mismatch", operation: null, noOp: false });
  if (!plan.mutations || !same(Object.keys(plan.mutations).sort(),
    [...Preparation.MUTATION_KEYS].sort()) || Preparation.MUTATION_KEYS.some(key =>
      !Array.isArray(plan.mutations[key])))
    return frozen({ valid: false, reason: "invalid_plan", operation: null, noOp: false });
  if (!same(plan.mutationCeiling, expectedCeiling(plan.mutations)))
    return frozen({ valid: false, reason: "mutation_ceiling_mismatch", operation: null, noOp: false });
  if (!same(plan.mutationCounts, expectedCounts(plan.mutations)))
    return frozen({ valid: false, reason: "mutation_ceiling_mismatch", operation: null, noOp: false });
  if (!scopeValid(plan)) return frozen({ valid: false, reason: "source_scope_violation",
    operation: null, noOp: false });
  const { planIdentity, ...material } = plan;
  if (await Canonicalizer.sha256(material) !== planIdentity)
    return frozen({ valid: false, reason: "invalid_plan", operation: null, noOp: false });
  const noOp = NOOP_STATUS.has(plan.status), operation = EXECUTION_OPERATION[plan.status] || null;
  if (noOp && Preparation.MUTATION_KEYS.every(key => plan.mutations[key].length === 0) !==
      (plan.status === "already_committed"))
    return frozen({ valid: false, reason: "invalid_plan", operation: null, noOp: false });
  if (!noOp && (!operation || !plan.receiptExpectation ||
      plan.receiptExpectation.commitClaimed !== false ||
      plan.receiptExpectation.sourceId !== plan.sourceId ||
      plan.receiptExpectation.operationType !== plan.operationType ||
      !same(plan.receiptExpectation.expectedMutationCounts, plan.mutationCounts) ||
      plan.receiptExpectation.expectedSchemaVersion !== Schema.VERSION ||
      plan.receiptExpectation.expectedSchemaFingerprint !== Schema.EXPECTED_FINGERPRINT))
    return frozen({ valid: false, reason: "invalid_plan", operation: null, noOp: false });
  return frozen({ valid: true, reason: null, operation, noOp });
}
function assertMainOwned() {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document)
    throw new Error("main_side_only");
}
function createCalendarPartialExecutionAuthority({ clock = () => Date.now() } = {}) {
  assertMainOwned();
  if (typeof clock !== "function") throw new Error("execution_clock_invalid");
  async function issueGrant(plan) {
    const checked = await validatePlan(plan);
    if (!checked.valid) return frozen({ valid: false, reason: checked.reason,
      grant: null, binding: null });
    const issuedAt = clock(), expiresAt = issuedAt + GRANT_TTL_MS, nonce = randomUUID(),
      bindingBase = { authorityVersion: AUTHORITY_VERSION,
        authorityIdentity: AUTHORITY_IDENTITY, databaseName: Schema.DATABASE_NAME,
        schemaVersion: Schema.VERSION, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
        sourceSetIdentity: Contract.SOURCE_SET_ID, sourceId: plan.sourceId,
        operation: checked.operation, noOp: checked.noOp, planIdentity: plan.planIdentity,
        mutationCeiling: structuredClone(plan.mutationCeiling), issuedAt, expiresAt }, binding =
      frozen({ ...bindingBase, grantIdentity: await Canonicalizer.sha256({ bindingBase, nonce }) }),
      grant = Object.freeze({});
    grants.set(grant, { binding, plan, consumed: false });
    return frozen({ valid: true, reason: null, grant, binding });
  }
  async function consumeGrant(grant, plan) {
    if (spent.has(grant)) return frozen({ valid: false, reason: "grant_reused", binding: null });
    const record = grants.get(grant);
    if (!record) return frozen({ valid: false, reason: "invalid_grant", binding: null });
    grants.delete(grant); spent.add(grant); record.consumed = true;
    const checked = await validatePlan(plan);
    if (!checked.valid) return frozen({ valid: false, reason: checked.reason,
      binding: null });
    if (clock() > record.binding.expiresAt) return frozen({ valid: false,
      reason: "invalid_grant", binding: null });
    if (record.plan !== plan || record.binding.sourceId !== plan.sourceId ||
        record.binding.planIdentity !== plan.planIdentity ||
        record.binding.operation !== checked.operation || record.binding.noOp !== checked.noOp ||
        !same(record.binding.mutationCeiling, plan.mutationCeiling))
      return frozen({ valid: false, reason: "authority_mismatch", binding: null });
    return frozen({ valid: true, reason: null, binding: record.binding });
  }
  return Object.freeze({ issueGrant, consumeGrant });
}

module.exports = Object.freeze({ AUTHORITY_VERSION, AUTHORITY_IDENTITY, GRANT_TTL_MS,
  EXECUTION_OPERATION, PLAN_OPERATION, validatePlan, createCalendarPartialExecutionAuthority });
