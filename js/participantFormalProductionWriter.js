"use strict";

const Schema = require("./formalArchive/participantFormalArchiveSchema.js");
const ParticipantData = require("./participantData.js");

const WRITER_VERSION = "participants-formal-production-writer-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const clone = value => value == null ? value : structuredClone(value);
const requestValue = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
  transaction.onerror = () => undefined;
});

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function rejected(reason) {
  return freeze({ contractVersion: WRITER_VERSION, status: "rejected", reason,
    classification: null, revisionWriteCount: 0, transactionCount: 0, revision: null });
}

function createParticipantFormalProductionWriter(options = {}) {
  if (!exact(options, ["indexedDB", "IDBKeyRange", "databaseName"]) ||
      typeof options.indexedDB?.open !== "function" ||
      options.databaseName !== Schema.DATABASE_NAME)
    throw new TypeError("participants_formal_production_writer_options_invalid");
  let database = null, opening = null, queue = Promise.resolve();

  function openArchive() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = options.indexedDB.open(options.databaseName, Schema.DATABASE_VERSION);
      request.onupgradeneeded = event => {
        if (event.oldVersion !== 0) { request.transaction.abort(); return; }
        for (const [name, definition] of Object.entries(Schema.STORE_DEFINITIONS)) {
          const store = request.result.createObjectStore(name, { keyPath: definition.keyPath });
          for (const index of definition.indexes)
            store.createIndex(index.name, index.keyPath, { unique: index.unique });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => { database.close(); database = null; };
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
      request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
    }).finally(() => { opening = null; });
    return opening;
  }

  async function readRevision(db, revisionKey) {
    const transaction = db.transaction(Schema.REVISION_STORE, "readonly"),
      done = transactionDone(transaction), value = await requestValue(
        transaction.objectStore(Schema.REVISION_STORE).get(revisionKey));
    await done;
    return value || null;
  }

  async function commitNow(input) {
    if (!exact(input, ["completeSet", "sourceEvidence", "confirmedAt"]) ||
        !timestamp(input.confirmedAt) ||
        !(await ParticipantData.validateParticipantCache(input.completeSet)))
      return rejected("candidate_invalid");
    const entryKey = Schema.entryKeyFor(input.completeSet.sourceDate),
      revisionKey = `${entryKey}|${input.completeSet.versionKey}`,
      candidate = { revisionKey, entryKey, sourceDate: input.completeSet.sourceDate,
        versionKey: input.completeSet.versionKey, contentSignature: input.completeSet.signature,
        signatureAlgorithm: input.completeSet.signatureAlgorithm,
        signature: input.completeSet.signature, confirmedAt: input.confirmedAt, replacedAt: null,
        revisionState: "active", completeSet: clone(input.completeSet),
        sourceEvidence: clone(input.sourceEvidence) };
    if (!Schema.validateRevision(candidate)) return rejected("candidate_invalid");
    let db;
    try { db = await openArchive(); } catch (_error) { return rejected("archive_unavailable"); }
    try {
      const inspect = db.transaction([Schema.META_STORE, Schema.ENTRY_STORE], "readonly"),
        inspectDone = transactionDone(inspect), metadataRequest = requestValue(
          inspect.objectStore(Schema.META_STORE).get(Schema.META_KEY)), entryRequest = requestValue(
          inspect.objectStore(Schema.ENTRY_STORE).get(entryKey)),
        [metadata, entry] = await Promise.all([metadataRequest, entryRequest]);
      await inspectDone;
      const active = entry ? await readRevision(db, entry.activeRevisionKey) : null;
      if ((metadata && !Schema.validateMetadata(metadata)) ||
          (entry && !Schema.validateEntry(entry)) ||
          (entry && (!active || !Schema.validateRevision(active) ||
            active.revisionState !== "active"))) return rejected("archive_state_invalid");
      if (active?.versionKey === input.completeSet.versionKey)
        return freeze({ contractVersion: WRITER_VERSION, status: "accepted", reason: null,
          classification: "semantic_duplicate", revisionWriteCount: 0, transactionCount: 0,
          revision: clone(active) });
      const nextEntry = entry ? { ...clone(entry), activeRevisionKey: revisionKey,
        lastSeenAt: input.confirmedAt } : { entryKey, sourceDate: input.completeSet.sourceDate,
        activeRevisionKey: revisionKey, firstSeenAt: input.confirmedAt,
        lastSeenAt: input.confirmedAt };
      const nextMetadata = metadata ? { ...clone(metadata), updatedAt: input.confirmedAt,
        revisionCount: metadata.revisionCount + 1 } : { id: Schema.META_KEY,
        archiveSchemaVersion: Schema.ARCHIVE_SCHEMA_VERSION, dataset: Schema.DATASET,
        authorityClass: Schema.AUTHORITY_CLASS, retentionPolicy: Schema.RETENTION_POLICY,
        createdAt: input.confirmedAt, updatedAt: input.confirmedAt,
        integrityAlgorithm: "sha256", entryCount: 1, revisionCount: 1 };
      if (!entry && metadata) nextMetadata.entryCount += 1;
      if (!Schema.validateEntry(nextEntry) || !Schema.validateMetadata(nextMetadata))
        return rejected("candidate_invalid");
      const transaction = db.transaction([Schema.META_STORE, Schema.ENTRY_STORE,
        Schema.REVISION_STORE], "readwrite"), revisions = transaction.objectStore(
          Schema.REVISION_STORE);
      if (active) revisions.put({ ...clone(active), revisionState: "replaced",
        replacedAt: input.confirmedAt });
      revisions.add(candidate);
      transaction.objectStore(Schema.ENTRY_STORE).put(nextEntry);
      transaction.objectStore(Schema.META_STORE).put(nextMetadata);
      await transactionDone(transaction);
      const readback = await readRevision(db, revisionKey);
      if (!Schema.validateRevision(readback)) return rejected("revision_readback_invalid");
      return freeze({ contractVersion: WRITER_VERSION, status: "accepted", reason: null,
        classification: active ? "same_date_correction" : "new_revision",
        revisionWriteCount: 1, transactionCount: 1, revision: clone(readback) });
    } catch (_error) { return rejected("archive_write_failed"); }
  }

  function commit(input) {
    const operation = queue.then(() => commitNow(input), () => commitNow(input));
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function close() { database?.close(); database = null; }
  return freeze({ commit, close });
}

module.exports = freeze({ WRITER_VERSION, createParticipantFormalProductionWriter });
