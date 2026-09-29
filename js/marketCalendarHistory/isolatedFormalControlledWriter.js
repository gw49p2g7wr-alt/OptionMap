"use strict";

// E2b: deliberately unreachable from production. This module never creates a DB.
const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const Shadow = require("./formalShadowWritePlan.js");
const Authority = require("./formalWriterAuthority.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Integrity = require("./historyIntegrity.js");

const ISOLATED_FIXTURE_AUTHORITY = Object.freeze({ scope: "e2b_isolated_fixture_v1" });
const FIXTURE_NAME = /^optionMapMarketCalendarE2bFixture_[A-Za-z0-9_-]+$/;
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
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
function loadSnapshot(transaction) {
  return new Promise((resolve, reject) => {
    const snapshot = {}, requests = STORE_ORDER.map(([field, name]) => {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => {
        snapshot[field] = request.result;
        if (Object.keys(snapshot).length === STORE_ORDER.length) resolve(sorted(snapshot));
      };
      request.onerror = () => reject(request.error || new Error("read_failed"));
      return request;
    });
    void requests;
  });
}
async function openExisting(indexedDB, databaseName) {
  if (typeof indexedDB?.databases !== "function") throw new Error("catalog_unavailable");
  const catalog = await indexedDB.databases(), found = catalog.find(value => value.name === databaseName);
  if (!found) throw new Error("database_absent");
  if (found.version !== Schema.VERSION) throw new Error("schema_mismatch");
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(databaseName);
    opening.onupgradeneeded = () => { try { opening.transaction.abort(); } catch (_error) {};
      reject(new Error("upgrade_forbidden")); };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error("open_failed"));
    opening.onblocked = () => reject(new Error("open_blocked"));
  });
}
async function schemaValid(database, metrics) {
  if (database.version !== Schema.VERSION) return false;
  const tx = database.transaction(STORE_NAMES, "readonly"), finished = complete(tx);
  metrics.readonlyTransactions += 1;
  let inspected;
  try { inspected = BootstrapSchema.inspect(database, tx); }
  catch (_error) { try { await finished; } catch (_ignored) {} return false; }
  await finished;
  const fingerprint = await Schema.fingerprint({ ...inspected,
    databaseName: Schema.DATABASE_NAME });
  return fingerprint === Schema.EXPECTED_FINGERPRINT;
}
async function readSnapshot(database, metrics) {
  const tx = database.transaction(STORE_NAMES, "readonly"), finished = complete(tx);
  metrics.readonlyTransactions += 1;
  const snapshot = await loadSnapshot(tx);
  await finished;
  return snapshot;
}
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
function queueWrites(tx, plan, updates, failurePoint, attempted) {
  const m = plan.mutations, queue = (field, mode, values) => {
    const store = tx.objectStore(STORE_FOR[field]);
    for (const value of values) { store[mode](value); attempted[field] += 1; }
  }, checkpoint = point => {
    if (failurePoint === point) throw new Error(`injected_failure_${point}`);
  };
  queue("entries", "add", m.appendEntries);
  queue("entries", "put", updates.entries);
  checkpoint("after_event_entry");
  queue("revisions", "put", updates.revisions);
  queue("revisions", "add", m.appendRevisions);
  checkpoint("after_semantic_revision");
  queue("evidence", "add", m.appendEvidence);
  checkpoint("after_evidence");
  queue("observations", "add", m.appendObservations);
  checkpoint("after_observation");
  queue("runs", "add", m.appendRuns);
  checkpoint("after_source_run");
  checkpoint("before_cursor");
  queue("cursors", "put", m.updateCursors);
}
function transact(database, plan, expectedMaterial, updates, failurePoint, metrics) {
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
          queueWrites(tx, plan, updates, failurePoint, attempted);
        } catch (error) { reason = error.message; try { tx.abort(); } catch (_error) {} }
      };
      request.onerror = () => { reason = "snapshot_read_failed"; };
    }
  });
}
function createIsolatedFormalControlledWriter(configuration = {}) {
  const { indexedDB, databaseName, fixtureAuthority, failureInjectionPoint = null,
    beforeWriteTransaction = null } = configuration;
  if (fixtureAuthority !== ISOLATED_FIXTURE_AUTHORITY || !indexedDB ||
      typeof databaseName !== "string" || !FIXTURE_NAME.test(databaseName) ||
      databaseName === Schema.DATABASE_NAME)
    throw new Error("isolated_fixture_authority_required");
  if (failureInjectionPoint !== null && !FAILURE_POINTS.includes(failureInjectionPoint))
    throw new Error("failure_injection_point_invalid");
  const metrics = { opens: 0, readonlyTransactions: 0, readwriteTransactions: 0,
    committedTransactions: 0, abortedTransactions: 0, committedWrites: emptyCounts(),
    staleRejects: 0, failureInjectionAborts: 0, reopenCycles: 0, openHandles: 0 };
  async function write(plan) {
    if (!plan || plan.planStatus !== "planned" || plan.writeAllowed !== false ||
        plan.authorityIdentity !== Authority.SHADOW_AUTHORITY.identity ||
        plan.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
        Authority.selectWriterState(plan.sourceId, Authority.SHADOW_AUTHORITY).writeEligible !== true ||
        !(await Shadow.validateShadowPlan(plan)).valid || !planScopeValid(plan))
      return result(plan, "rejected", "plan_invalid");
    let database;
    try {
      database = await openExisting(indexedDB, databaseName);
      metrics.opens += 1; metrics.openHandles += 1;
      if (!await schemaValid(database, metrics)) return result(plan, "rejected", "schema_mismatch");
      const before = await readSnapshot(database, metrics), conflicting = identityConflict(plan, before);
      if (conflicting) return result(plan, "rejected", conflicting);
      if (alreadyApplied(plan, before)) return result(plan, "idempotent", "already_applied");
      const fingerprint = await Canonicalizer.sha256({ schemaFingerprint: plan.schemaFingerprint,
        formalSnapshot: before });
      if (fingerprint !== plan.preconditionIdentity) {
        metrics.staleRejects += 1;
        return result(plan, "rejected", "stale_precondition_before_transaction");
      }
      const updates = expectedWrites(plan, before);
      if (!updates || !linkageValid(plan, before))
        return result(plan, "rejected", "mutation_precondition_invalid");
      const expectedMaterial = material(before), expectedAfter = applyToMemory(before, plan, updates);
      // The hook is isolated-fixture-only; all hashes and write material exist before the tx.
      if (beforeWriteTransaction) await beforeWriteTransaction({ indexedDB, databaseName });
      const outcome = await transact(database, plan, expectedMaterial, updates,
        failureInjectionPoint, metrics);
      if (!outcome.committed) {
        if (outcome.reason === "stale_precondition_inside_transaction") metrics.staleRejects += 1;
        if (outcome.reason?.startsWith("injected_failure_")) metrics.failureInjectionAborts += 1;
        return result(plan, "rolled_back", outcome.reason,
          { errorClass: outcome.reason?.startsWith("injected_failure_") ? "injected_failure" :
            outcome.reason === "stale_precondition_inside_transaction" ? "stale_precondition" :
              "transaction_abort" });
      }
      const readBack = await readSnapshot(database, metrics), semantic = await Integrity.audit(readBack),
        storage = Integrity.auditStorageSnapshot(readBack);
      if (!same(readBack, expectedAfter) || !semantic.valid || !storage.valid)
        return result(plan, "committed_read_back_failed", "read_back_integrity_failed",
          { saved: true, committedMutationCounts: outcome.counts });
      return result(plan, "committed", null,
        { saved: true, committedMutationCounts: outcome.counts });
    } catch (error) {
      const allowed = new Set(["catalog_unavailable", "database_absent", "schema_mismatch",
        "upgrade_forbidden", "open_failed", "open_blocked"]);
      return result(plan, "rejected", allowed.has(error?.message) ? error.message : "writer_failed",
        { errorClass: ["AbortError", "InvalidStateError", "TransactionInactiveError"]
          .includes(error?.name) ? error.name : "Error" });
    }
    finally { if (database) { database.close(); metrics.openHandles -= 1; } }
  }
  return Object.freeze({ write, diagnostics: () => copy(metrics) });
}

module.exports = Object.freeze({ ISOLATED_FIXTURE_AUTHORITY, FAILURE_POINTS,
  createIsolatedFormalControlledWriter });
