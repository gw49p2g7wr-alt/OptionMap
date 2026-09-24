"use strict";

const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const Integrity = require("./historyIntegrity.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");

const STORE_NAMES = Object.freeze(Object.keys(Schema.STORES));
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("readonly_request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("readonly_transaction_aborted"));
  transaction.onerror = () => undefined;
});
const clone = value => value == null ? value : structuredClone(value);
function frozen(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen); return Object.freeze(value);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value &&
  typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, canonical(value[key])])) : value;
async function snapshot(transaction) {
  const values = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    values[field] = await request(transaction.objectStore(storeName).getAll());
  return values;
}
function linkageErrors(values) {
  const errors = [], entries = new Map(values.entries.map(value => [value.eventKey, value])),
    revisions = new Map(values.revisions.map(value => [value.revisionKey, value])),
    runs = new Map(values.runs.map(value => [value.runKey, value]));
  for (const revision of values.revisions) {
    if (revision.sourceId !== entries.get(revision.eventKey)?.sourceId)
      errors.push("revision_entry_linkage_invalid");
  }
  for (const evidence of values.evidence) {
    const revision = revisions.get(evidence.revisionKey), run =
      runs.get(`${evidence.sourceId}|${evidence.runId}`);
    if (!revision || revision.eventKey !== evidence.eventKey ||
        revision.sourceId !== evidence.sourceId || !run)
      errors.push("evidence_linkage_invalid");
  }
  for (const observation of values.observations) {
    const entry = entries.get(observation.eventKey), run =
      runs.get(`${observation.sourceId}|${observation.runId}`);
    if (!entry || entry.sourceId !== observation.sourceId || !run)
      errors.push("observation_linkage_invalid");
  }
  for (const cursor of values.cursors) {
    const run = runs.get(cursor.runKey);
    if (!run || run.sourceId !== cursor.sourceId || run.runId !== cursor.runId ||
        run.acceptedAt !== cursor.acceptedAt) errors.push("cursor_run_linkage_invalid");
  }
  return [...new Set(errors)].sort();
}
function sourceValues(values, sourceId) {
  const keys = { entries: "eventKey", revisions: "revisionKey", evidence: "evidenceLinkKey",
    observations: "observationKey", runs: "runKey", cursors: "sourceId" };
  const own = field => values[field].filter(value => value.sourceId === sourceId)
    .sort((a, b) => String(a[keys[field]]).localeCompare(String(b[keys[field]])));
  return { entries: own("entries"), revisions: own("revisions"), evidence: own("evidence"),
    observations: own("observations"), runs: own("runs"), cursors: own("cursors") };
}

function createExistingDbPreconditionReader(configuration = {}) {
  if (configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB)
    throw new Error("isolated_test_configuration_required");
  const indexedDB = configuration.indexedDB, metrics = { catalogReads: 0, databaseOpens: 0,
    readonlyTransactions: 0, readwriteTransactions: 0, upgradeAttempts: 0, openHandles: 0 };
  async function read({ sourceId } = {}) {
    if (typeof sourceId !== "string" || !sourceId)
      return frozen({ status: "integrity_invalid", reason: "source_identity_invalid",
        sourceId: sourceId || null, currentState: null });
    metrics.catalogReads += 1;
    const catalog = await indexedDB.databases(), descriptor = catalog.find(value =>
      value.name === Schema.DATABASE_NAME);
    if (!descriptor) return frozen({ status: "absent", reason: "database_absent",
      sourceId, currentState: null });
    if (descriptor.version !== Schema.VERSION) return frozen({ status: "schema_mismatch",
      reason: "schema_version_mismatch", sourceId, currentState: null });
    let database;
    try {
      database = await new Promise((resolve, reject) => {
        const opening = indexedDB.open(Schema.DATABASE_NAME); let upgraded = false;
        opening.onupgradeneeded = () => { upgraded = true; metrics.upgradeAttempts += 1;
          try { opening.transaction.abort(); } catch (_error) {} };
        opening.onsuccess = () => upgraded ? (opening.result.close(),
          reject(new Error("upgrade_forbidden"))) : resolve(opening.result);
        opening.onerror = () => reject(opening.error || new Error("readonly_open_failed"));
        opening.onblocked = () => reject(new Error("readonly_open_blocked"));
      });
      metrics.databaseOpens += 1; metrics.openHandles += 1;
      const transaction = database.transaction(STORE_NAMES, "readonly");
      metrics.readonlyTransactions += 1;
      const completed = done(transaction), inspected = BootstrapSchema.inspect(database, transaction),
        values = await snapshot(transaction); await completed;
      const schemaFingerprint = await Schema.fingerprint(inspected);
      if (database.version !== Schema.VERSION || schemaFingerprint !== Schema.EXPECTED_FINGERPRINT)
        return frozen({ status: "schema_mismatch", reason: "schema_fingerprint_mismatch",
          sourceId, currentState: null });
      const semantic = await Integrity.audit(values), storage = Integrity.auditStorageSnapshot(values),
        linkage = linkageErrors(values);
      if (!semantic.valid || !storage.valid || linkage.length)
        return frozen({ status: "integrity_invalid", reason: "database_integrity_invalid",
          sourceId, errors: [...semantic.errors, ...storage.errors, ...linkage], currentState: null });
      const own = sourceValues(values, sourceId), cursor = own.cursors[0] || null;
      if (own.cursors.length > 1) return frozen({ status: "integrity_invalid",
        reason: "source_cursor_ambiguous", sourceId, currentState: null });
      const latestRun = own.runs.slice().sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) ||
        b.runId.localeCompare(a.runId))[0] || null;
      if ((cursor && (!latestRun || cursor.runId !== latestRun.runId ||
          cursor.acceptedAt !== latestRun.acceptedAt)) || (!cursor && (own.entries.length || own.runs.length)))
        return frozen({ status: "integrity_invalid", reason: "source_cursor_mismatch",
          sourceId, currentState: null });
      const activeRevisionIdentities = own.entries.map(entry => ({ eventKey: entry.eventKey,
        revisionKey: entry.activeRevisionKey })).sort((a, b) => a.eventKey.localeCompare(b.eventKey));
      const counts = Object.fromEntries(BootstrapSchema.STORE_ORDER.map(([field, storeName]) =>
        [storeName, values[field].length])), sourceCounts = Object.fromEntries(
        Object.keys(own).map(field => [field, own[field].length]));
      const identityInput = { schemaVersion: Schema.VERSION, schemaFingerprint, sourceId,
        sourceCursor: cursor, latestSourceRun: latestRun, activeRevisionIdentities,
        relevantCounts: { global: counts, source: sourceCounts }, sourceSnapshot: own };
      const currentStateFingerprint = await Canonicalizer.sha256(canonical(identityInput));
      const currentState = { ...identityInput, currentStateFingerprint, ...clone(own) };
      return frozen({ status: cursor ? "valid_existing" : "source_state_missing", reason: null,
        sourceId, currentState });
    } catch (error) {
      return frozen({ status: error?.message === "upgrade_forbidden" ? "schema_mismatch" :
        "integrity_invalid", reason: error?.message || "readonly_inspection_failed",
      sourceId, currentState: null });
    } finally {
      if (database) { database.close(); metrics.openHandles -= 1; }
    }
  }
  return Object.freeze({ read, diagnostics: () => frozen(clone(metrics)) });
}

module.exports = Object.freeze({ createExistingDbPreconditionReader });
