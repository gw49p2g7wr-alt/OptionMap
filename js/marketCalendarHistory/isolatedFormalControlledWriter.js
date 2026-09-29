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
const { STORE_ORDER, STORE_NAMES, FAILURE_POINTS, emptyCounts, copy, sorted, same, result,
  expectedWrites, linkageValid, applyToMemory, alreadyApplied, identityConflict,
  planScopeValid, prepareExecution, executePrepared } = require("./formalControlledWriterCore.js");
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
      const prepared = prepareExecution(plan, before), expectedAfter = applyToMemory(before, plan, updates);
      // The hook is isolated-fixture-only; all hashes and write material exist before the tx.
      if (beforeWriteTransaction) await beforeWriteTransaction({ indexedDB, databaseName });
      const outcome = await executePrepared(database, prepared, failureInjectionPoint, metrics);
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
