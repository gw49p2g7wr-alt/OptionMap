"use strict";

// Internal transaction mechanics only. DB identity and authority belong to callers.
const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");

const STORE_ORDER = BootstrapSchema.STORE_ORDER;
const STORE_NAMES = Object.freeze(STORE_ORDER.map(([, name]) => name));
const STORE_FOR = Object.freeze(Object.fromEntries(STORE_ORDER));
const MUTATION_STORE = Object.freeze({ appendEntries: "entries", updateEntries: "entries",
  closeRevisions: "revisions", appendRevisions: "revisions", appendEvidence: "evidence",
  appendObservations: "observations", appendRuns: "runs", updateCursors: "cursors" });
const KEY_FOR = Object.freeze(Object.fromEntries(STORE_ORDER.map(([field, name]) =>
  [field, Schema.STORES[name].keyPath])));
const FAILURE_POINTS = Object.freeze(["after_event_entry", "after_semantic_revision",
  "after_evidence", "after_observation", "after_source_run", "before_cursor"]);
const snapshotFields = STORE_ORDER.map(([field]) => field);
const emptyCounts = () => Object.fromEntries(snapshotFields.map(field => [field, 0]));
const copy = value => structuredClone(value);
const sorted = snapshot => Object.fromEntries(STORE_ORDER.map(([field]) =>
  [field, [...snapshot[field]].sort((a, b) =>
    String(a[KEY_FOR[field]]).localeCompare(String(b[KEY_FOR[field]])))]));
const material = value => Canonicalizer.stable(value);
const same = (a, b) => material(a) === material(b);
const result = (plan, outcome, reason, extra = {}) => Object.freeze({
  saved: false, outcome, reason, sourceId: plan?.sourceId || null,
  planIdentity: plan?.planIdentity || null, committedMutationCounts: emptyCounts(),
  errorClass: null, ...extra });
function expectedWrites(plan, before) {
  const mutations = plan.mutations, entries = new Map(before.entries.map(v => [v.eventKey, v])),
    revisions = new Map(before.revisions.map(v => [v.revisionKey, v]));
  const updates = { entries: [], revisions: [] };
  for (const value of mutations.closeRevisions) {
    const prior = revisions.get(value.revisionKey);
    if (!prior || prior.sourceId !== plan.sourceId ||
        prior.validTo !== value.expectedValidTo) return null;
    updates.revisions.push({ ...prior, validTo: value.validTo });
  }
  for (const value of mutations.updateEntries) {
    const prior = entries.get(value.eventKey);
    if (!prior || prior.sourceId !== plan.sourceId ||
        prior.activeRevisionKey !== value.expectedActiveRevisionKey) return null;
    const next = { ...prior, ...value };
    delete next.expectedActiveRevisionKey;
    updates.entries.push(next);
  }
  return updates;
}
function linkageValid(plan, before) {
  const m = plan.mutations, entries = new Map(before.entries.map(v => [v.eventKey, v])),
    revisions = new Map(before.revisions.map(v => [v.revisionKey, v]));
  for (const value of m.appendEntries) entries.set(value.eventKey, value);
  for (const value of m.appendRevisions) revisions.set(value.revisionKey, value);
  if (m.appendRevisions.some(value => entries.get(value.eventKey)?.sourceId !== plan.sourceId))
    return false;
  if (m.appendEvidence.some(value => {
    const revision = revisions.get(value.revisionKey);
    return revision?.sourceId !== plan.sourceId || revision.eventKey !== value.eventKey;
  })) return false;
  return !m.appendObservations.some(value =>
    entries.get(value.eventKey)?.sourceId !== plan.sourceId);
}
function applyToMemory(before, plan, updates) {
  const after = copy(before), mutations = plan.mutations;
  for (const [field, values] of [["entries", updates.entries],
    ["revisions", updates.revisions], ["entries", mutations.appendEntries],
    ["revisions", mutations.appendRevisions], ["evidence", mutations.appendEvidence],
    ["observations", mutations.appendObservations], ["runs", mutations.appendRuns],
    ["cursors", mutations.updateCursors]]) {
    const key = KEY_FOR[field], index = new Map(after[field].map(value => [value[key], value]));
    for (const value of values) index.set(value[key], value);
    after[field] = [...index.values()];
  }
  return sorted(after);
}
function alreadyApplied(plan, current) {
  const m = plan.mutations, run = m.appendRuns[0], cursor = m.updateCursors[0];
  if (!same(current.runs.find(v => v.runKey === run.runKey), run) ||
      !same(current.cursors.find(v => v.sourceId === cursor.sourceId), cursor)) return false;
  const pairs = [["entries", m.appendEntries], ["revisions", m.appendRevisions],
    ["evidence", m.appendEvidence], ["observations", m.appendObservations]];
  for (const [field, values] of pairs) for (const value of values)
    if (!same(current[field].find(v => v[KEY_FOR[field]] === value[KEY_FOR[field]]), value))
      return false;
  for (const value of m.updateEntries) {
    const expected = { ...value };
    delete expected.expectedActiveRevisionKey;
    const actual = current.entries.find(v => v.eventKey === value.eventKey);
    if (!actual || Object.entries(expected).some(([key, item]) => !same(actual[key], item)))
      return false;
  }
  for (const value of m.closeRevisions) {
    const actual = current.revisions.find(v => v.revisionKey === value.revisionKey);
    if (!actual || actual.validTo !== value.validTo) return false;
  }
  return true;
}
function identityConflict(plan, current) {
  for (const [field, values] of [["evidence", plan.mutations.appendEvidence],
    ["observations", plan.mutations.appendObservations]]) {
    for (const value of values) {
      const prior = current[field].find(v => v[KEY_FOR[field]] === value[KEY_FOR[field]]);
      if (prior && !same(prior, value)) return `${field}_identity_conflict`;
    }
  }
  return null;
}
function planScopeValid(plan) {
  const m = plan.mutations;
  for (const field of ["appendEntries", "appendRevisions",
    "appendEvidence", "appendObservations", "appendRuns", "updateCursors"])
    if (m[field].some(value => value.sourceId !== plan.sourceId)) return false;
  if (m.updateEntries.some(value => value.sourceId != null &&
      value.sourceId !== plan.sourceId)) return false;
  const entries = new Map([...m.appendEntries, ...m.updateEntries]
    .map(value => [value.eventKey, value]));
  for (const value of m.appendRevisions)
    if (!entries.has(value.eventKey)) return false;
  const revisions = new Set(m.appendRevisions.map(value => value.revisionKey));
  for (const value of m.appendEvidence)
    if (revisions.has(value.revisionKey) &&
        !m.appendRevisions.some(revision => revision.revisionKey === value.revisionKey &&
          revision.eventKey === value.eventKey)) return false;
  return true;
}
const preparedExecutions = new WeakMap();
function prepareExecution(plan, before, ceiling = null) {
  if (!plan?.mutations || !same(Object.keys(plan.mutations).sort(), Object.keys(MUTATION_STORE).sort()) ||
      !planScopeValid(plan) || !linkageValid(plan, before)) throw new Error("mutation_precondition_invalid");
  const updates = expectedWrites(plan, before);
  if (!updates) throw new Error("mutation_precondition_invalid");
  const limits = ceiling || Object.fromEntries(Object.keys(MUTATION_STORE).map(key =>
    [key, plan.mutations[key].length]));
  if (!same(Object.keys(limits).sort(), Object.keys(MUTATION_STORE).sort()) ||
      Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0))
    throw new Error("mutation_ceiling_invalid");
  const token = Object.freeze({});
  preparedExecutions.set(token, { plan: copy(plan), updates: copy(updates),
    expectedMaterial: material(sorted(before)), ceiling: copy(limits) });
  return token;
}
function queueWrites(tx, plan, updates, failurePoint, attempted, ceiling) {
  const m = plan.mutations, operationCounts = {}, queue = (operation, field, mode, values) => {
    const store = tx.objectStore(STORE_FOR[field]);
    for (const value of values) {
      if (MUTATION_STORE[operation] !== field || !["add", "put"].includes(mode))
        throw new Error("unexpected_store_operation");
      if (value.sourceId !== plan.sourceId) throw new Error("mutation_source_mismatch");
      operationCounts[operation] = (operationCounts[operation] || 0) + 1;
      if (operationCounts[operation] > ceiling[operation]) throw new Error("mutation_ceiling_exceeded");
      store[mode](value); attempted[field] += 1;
    }
  }, checkpoint = point => {
    if (failurePoint === point) throw new Error(`injected_failure_${point}`);
  };
  queue("appendEntries", "entries", "add", m.appendEntries);
  queue("updateEntries", "entries", "put", updates.entries);
  checkpoint("after_event_entry");
  queue("closeRevisions", "revisions", "put", updates.revisions);
  queue("appendRevisions", "revisions", "add", m.appendRevisions);
  checkpoint("after_semantic_revision");
  queue("appendEvidence", "evidence", "add", m.appendEvidence);
  checkpoint("after_evidence");
  queue("appendObservations", "observations", "add", m.appendObservations);
  checkpoint("after_observation");
  queue("appendRuns", "runs", "add", m.appendRuns);
  checkpoint("after_source_run");
  checkpoint("before_cursor");
  queue("updateCursors", "cursors", "put", m.updateCursors);
}
function transact(database, plan, expectedMaterial, updates, failurePoint, metrics, ceiling) {
  return new Promise(resolve => {
    const tx = database.transaction(STORE_NAMES, "readwrite"), snapshot = {}, attempted = emptyCounts();
    metrics.readwriteTransactions += 1;
    let reason = null, finished = false;
    const settle = value => { if (!finished) { finished = true; resolve(value); } };
    tx.oncomplete = () => { metrics.committedTransactions += 1;
      for (const field of snapshotFields) metrics.committedWrites[field] += attempted[field];
      settle({ committed: true, counts: attempted }); };
    tx.onabort = () => { metrics.abortedTransactions += 1;
      settle({ committed: false, reason: reason || tx.error?.name || "transaction_aborted" }); };
    tx.onerror = () => undefined;
    let remaining = STORE_ORDER.length;
    for (const [field, name] of STORE_ORDER) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => {
        snapshot[field] = request.result;
        if (--remaining !== 0) return;
        try {
          if (material(sorted(snapshot)) !== expectedMaterial)
            throw new Error("stale_precondition_inside_transaction");
          queueWrites(tx, plan, updates, failurePoint, attempted, ceiling);
        } catch (error) { reason = error.message; try { tx.abort(); } catch (_error) {} }
      };
      request.onerror = () => { reason = "snapshot_read_failed"; };
    }
  });
}
function executePrepared(database, token, failurePoint, metrics) {
  const prepared = preparedExecutions.get(token);
  if (!prepared || failurePoint !== null && !FAILURE_POINTS.includes(failurePoint))
    return Promise.resolve({ committed: false, reason: "execution_context_invalid" });
  preparedExecutions.delete(token);
  return transact(database, prepared.plan, prepared.expectedMaterial, prepared.updates,
    failurePoint, metrics, prepared.ceiling);
}

module.exports = Object.freeze({ STORE_ORDER, STORE_NAMES, FAILURE_POINTS, emptyCounts, copy, sorted, material,
  same, result, expectedWrites, linkageValid, applyToMemory, alreadyApplied,
  identityConflict, planScopeValid, prepareExecution, executePrepared });
