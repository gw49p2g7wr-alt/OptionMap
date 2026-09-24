"use strict";

const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const FirstSource = require("./bootstrapFirstSourceWriter.js");
const Integrity = require("./historyIntegrity.js");

const STORE_NAMES = Object.freeze(Object.keys(Schema.STORES));
const capabilities = new WeakMap();
const clone = value => value == null ? value : structuredClone(value);
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
function createSessionCapability({ sessionIdentity, firstCommittedSourceId } = {}) {
  if (!/^[0-9a-f]{64}$/.test(sessionIdentity || "") ||
      typeof firstCommittedSourceId !== "string") throw new Error("bootstrap_session_invalid");
  const capability = Object.freeze({ sessionIdentity, firstCommittedSourceId });
  capabilities.set(capability, { committedSources: new Set([firstCommittedSourceId]) });
  return capability;
}
async function snapshot(transaction) {
  const result = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    result[field] = await request(transaction.objectStore(storeName).getAll());
  return result;
}
async function inspect(database) {
  const transaction = database.transaction(STORE_NAMES, "readonly"), completed = done(transaction),
    definition = BootstrapSchema.inspect(database, transaction), values = await snapshot(transaction);
  await completed;
  const fingerprint = await Schema.fingerprint(definition), semantic = await Integrity.audit(values),
    storage = Integrity.auditStorageSnapshot(values);
  if (database.version !== Schema.VERSION || fingerprint !== Schema.EXPECTED_FINGERPRINT)
    throw Object.assign(new Error("schema_mismatch"), { fatal: true });
  if (!semantic.valid || !storage.valid)
    throw Object.assign(new Error("database_integrity_invalid"), { fatal: true });
  return values;
}
async function openExisting(indexedDB) {
  const catalog = await indexedDB.databases(), descriptor = catalog.find(value =>
    value.name === Schema.DATABASE_NAME);
  if (!descriptor) throw Object.assign(new Error("bootstrap_database_absent"), { fatal: true });
  if (descriptor.version !== Schema.VERSION)
    throw Object.assign(new Error("schema_mismatch"), { fatal: true });
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME); let upgraded = false;
    opening.onupgradeneeded = () => { upgraded = true;
      try { opening.transaction.abort(); } catch (_error) {} };
    opening.onsuccess = () => upgraded ? (opening.result.close(),
      reject(Object.assign(new Error("upgrade_forbidden"), { fatal: true }))) :
      resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error("open_failed"));
    opening.onblocked = () => reject(new Error("open_blocked"));
  });
}

function createBootstrapAppendSourceWriter(configuration = {}) {
  if (configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB ||
      !capabilities.has(configuration.sessionCapability))
    throw new Error("controlled_bootstrap_session_required");
  const indexedDB = configuration.indexedDB, capability = configuration.sessionCapability,
    state = capabilities.get(capability), metrics = { sourceTransactionAttempts: 0,
      committedSourceTransactions: 0, rolledBackSourceTransactions: 0,
      readBackTransactions: 0, openHandles: 0 };
  async function append(input = {}) {
    const checked = await FirstSource.validateBootstrapInput(input);
    if (!checked.valid) return Object.freeze({ status: "rejected", sourceId: checked.sourceId,
      committed: false, transactionOutcome: "not_started", readBackStatus: "not_attempted",
      reason: checked.reason, fatal: false });
    if (input.bootstrapSessionIdentity !== capability.sessionIdentity)
      return Object.freeze({ status: "rejected", sourceId: checked.sourceId, committed: false,
        transactionOutcome: "not_started", readBackStatus: "not_attempted",
        reason: "bootstrap_session_mismatch", fatal: true });
    if (state.committedSources.has(checked.sourceId))
      return Object.freeze({ status: "duplicate_noop", sourceId: checked.sourceId,
        committed: false, transactionOutcome: "not_started", readBackStatus: "not_attempted",
        reason: "source_already_committed", fatal: false });
    metrics.sourceTransactionAttempts += 1;
    let database, transactionCommitted = false;
    try {
      database = await openExisting(indexedDB); metrics.openHandles += 1;
      const before = await inspect(database);
      if (before.entries.some(value => value.sourceId === checked.sourceId) ||
          before.runs.some(value => value.sourceId === checked.sourceId) ||
          before.cursors.some(value => value.sourceId === checked.sourceId))
        throw new Error("source_history_already_exists");
      const transaction = database.transaction(STORE_NAMES, "readwrite"), completed = done(transaction);
      try {
        for (const [field, storeName] of BootstrapSchema.STORE_ORDER) {
          const store = transaction.objectStore(storeName);
          for (const record of checked.snapshot[field]) store.add(record);
          if (input.injectFailureAfter === field)
            throw new Error(`injected_failure_after_${field}`);
        }
      } catch (error) {
        try { transaction.abort(); } catch (_error) {}
        try { await completed; } catch (_error) {}
        throw error;
      }
      await completed;
      transactionCommitted = true;
      state.committedSources.add(checked.sourceId);
      metrics.committedSourceTransactions += 1;
      database.close(); database = null; metrics.openHandles -= 1;
      metrics.readBackTransactions += 1;
      database = await openExisting(indexedDB); metrics.openHandles += 1;
      const after = await inspect(database), ownEntries = after.entries.filter(value =>
        value.sourceId === checked.sourceId), ownRuns = after.runs.filter(value =>
        value.sourceId === checked.sourceId), ownCursors = after.cursors.filter(value =>
        value.sourceId === checked.sourceId);
      if (ownEntries.length !== checked.snapshot.entries.length || ownRuns.length !== 1 ||
          ownCursors.length !== 1)
        throw Object.assign(new Error("source_read_back_failed"), { fatal: true });
      return Object.freeze({ status: "committed", sourceId: checked.sourceId, committed: true,
        transactionOutcome: "committed", readBackStatus: "passed", reason: null,
        fatal: false, planHash: checked.planHash });
    } catch (error) {
      if (transactionCommitted) return Object.freeze({ status: "committed_read_back_failed",
        sourceId: checked.sourceId, committed: true, transactionOutcome: "committed",
        readBackStatus: "failed", reason: error.message || "source_read_back_failed", fatal: true });
      metrics.rolledBackSourceTransactions += 1;
      return Object.freeze({ status: "rolled_back", sourceId: checked.sourceId,
        committed: false, transactionOutcome: "aborted", readBackStatus: "not_attempted",
        reason: error.message || "append_failed", fatal: error.fatal === true });
    } finally {
      if (database) { database.close(); metrics.openHandles -= 1; }
    }
  }
  async function validateDatabase() {
    let database;
    try {
      metrics.readBackTransactions += 1;
      database = await openExisting(indexedDB); metrics.openHandles += 1;
      await inspect(database);
      return Object.freeze({ valid: true, reason: null });
    } catch (error) {
      return Object.freeze({ valid: false, reason: error.message || "database_integrity_invalid" });
    } finally {
      if (database) { database.close(); metrics.openHandles -= 1; }
    }
  }
  return Object.freeze({ append, validateDatabase,
    diagnostics: () => Object.freeze(clone(metrics)) });
}

module.exports = Object.freeze({ createSessionCapability, createBootstrapAppendSourceWriter });
