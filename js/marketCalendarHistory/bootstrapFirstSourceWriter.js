"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const Mapper = require("./storageRecordMapper.js");
const Integrity = require("./historyIntegrity.js");
const PlanCanonicalizer = require("./planCanonicalizer.js");

const STORE_NAMES = Object.freeze(Object.keys(Schema.STORES));
const clone = value => value == null ? value : structuredClone(value);
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
function emptyResult(sourceId, reason) {
  return { status: "bootstrap_not_started", sourceId: sourceId || null, dbCreated: false,
    committed: false, schemaVersion: Schema.VERSION, transactionOutcome: "not_started",
    readBackStatus: "not_attempted", reason };
}
function candidateSnapshot(mapped) {
  return { entries: mapped.appendEntries, revisions: mapped.appendRevisions,
    evidence: mapped.appendEvidence, observations: mapped.appendObservations,
    runs: mapped.appendRuns, cursors: mapped.updateCursors };
}
async function validate(input) {
  const sourceId = typeof input?.sourceId === "string" ? input.sourceId : null,
    candidate = input?.candidate, simulation = input?.simulation, plan = input?.plan,
    precondition = input?.precondition;
  if (!Registry.SOURCES[sourceId]) return { valid: false, sourceId, reason: "source_invalid" };
  if (input.expectedSchemaVersion !== Schema.VERSION)
    return { valid: false, sourceId, reason: "schema_version_mismatch" };
  if (!candidate || candidate.sourceId !== sourceId || candidate.formalEligible !== true ||
      candidate.candidateStatus !== "available")
    return { valid: false, sourceId, reason: "candidate_not_formal_eligible" };
  if (!Number.isInteger(candidate.recordCount) || candidate.recordCount < 1 ||
      !Array.isArray(candidate.canonicalRecords) ||
      candidate.canonicalRecords.length !== candidate.recordCount)
    return { valid: false, sourceId, reason: "accepted_record_count_invalid" };
  if (candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
      candidate.parserDiagnostics?.length || candidate.canonicalDiagnostics?.length)
    return { valid: false, sourceId, reason: "candidate_diagnostics_blocking" };
  if (!simulation || simulation.sourceId !== sourceId || simulation.candidateIdentity !==
      candidate.candidateIdentity || simulation.simulationStatus === "rejected" ||
      !simulation.simulationIdentity || simulation.commitOutcome !== "writer_disabled")
    return { valid: false, sourceId, reason: "transition_simulation_invalid" };
  if (!plan || plan.sourceId !== sourceId) return { valid: false, sourceId,
    reason: "transition_plan_invalid" };
  const planHash = await PlanCanonicalizer.planHash(plan);
  if (!precondition || precondition.schemaVersion !== Schema.VERSION ||
      precondition.sourceId !== sourceId || precondition.candidateIdentity !==
      candidate.candidateIdentity || precondition.simulationIdentity !==
      simulation.simulationIdentity || precondition.planHash !== planHash)
    return { valid: false, sourceId, reason: "bootstrap_precondition_invalid" };
  let mapped;
  try { mapped = Mapper.mapPlan(plan); }
  catch (_error) { return { valid: false, sourceId, reason: "transition_plan_invalid" }; }
  if (mapped.closeRevisions.length || mapped.updateEntries.length ||
      mapped.appendEntries.length !== candidate.recordCount ||
      mapped.appendRevisions.length !== candidate.recordCount ||
      mapped.appendEvidence.length !== candidate.recordCount ||
      mapped.appendObservations.length !== candidate.recordCount ||
      mapped.appendRuns.length !== 1 || mapped.updateCursors.length !== 1)
    return { valid: false, sourceId, reason: "first_source_plan_shape_invalid" };
  const snapshot = candidateSnapshot(mapped), semantic = await Integrity.audit(snapshot),
    storage = Integrity.auditStorageSnapshot(snapshot);
  if (!semantic.valid || !storage.valid || snapshot.entries.some(value => value.sourceId !== sourceId) ||
      snapshot.revisions.some(value => value.sourceId !== sourceId) ||
      snapshot.evidence.some(value => value.sourceId !== sourceId) ||
      snapshot.observations.some(value => value.sourceId !== sourceId) ||
      snapshot.runs.some(value => value.sourceId !== sourceId) ||
      snapshot.cursors.some(value => value.sourceId !== sourceId))
    return { valid: false, sourceId, reason: "first_source_plan_integrity_invalid" };
  return { valid: true, sourceId, planHash, snapshot: clone(snapshot) };
}
async function loadSnapshot(transaction) {
  const result = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    result[field] = await request(transaction.objectStore(storeName).getAll());
  return result;
}
async function readBack(indexedDB, sourceId, expected, metrics) {
  metrics.readBackTransactions += 1;
  const opening = indexedDB.open(Schema.DATABASE_NAME);
  let database;
  try {
    database = await request(opening); metrics.openHandles += 1;
    if (database.version !== Schema.VERSION) throw new Error("schema_version_mismatch");
    const transaction = database.transaction(STORE_NAMES, "readonly"), completed = done(transaction),
      inspected = BootstrapSchema.inspect(database, transaction), snapshot = await loadSnapshot(transaction);
    await completed;
    const fingerprint = await Schema.fingerprint(inspected);
    if (fingerprint !== Schema.EXPECTED_FINGERPRINT) throw new Error("schema_fingerprint_mismatch");
    const semantic = await Integrity.audit(snapshot),
      storage = Integrity.auditStorageSnapshot(snapshot);
    if (!semantic.valid || !storage.valid || snapshot.entries.length < 1 ||
        snapshot.entries.some(value => value.sourceId !== sourceId) ||
        snapshot.cursors.length !== 1 || snapshot.cursors[0].sourceId !== sourceId ||
        BootstrapSchema.STORE_ORDER.some(([field]) =>
          snapshot[field].length !== expected[field].length))
      throw new Error("read_back_integrity_failed");
    const runIds = new Set(snapshot.runs.map(value => value.runId));
    if (runIds.size !== 1 || snapshot.evidence.some(value => !runIds.has(value.runId)) ||
        snapshot.observations.some(value => !runIds.has(value.runId)) ||
        !runIds.has(snapshot.cursors[0].runId)) throw new Error("read_back_linkage_failed");
    return { valid: true, snapshot };
  } finally {
    if (database) { database.close(); metrics.openHandles -= 1; }
  }
}

function createBootstrapFirstSourceWriter(configuration = {}) {
  if (configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB)
    throw new Error("isolated_test_configuration_required");
  const indexedDB = configuration.indexedDB, metrics = { databaseCreateAttempts: 0,
    successfulDatabaseCreates: 0, abortedCreateAttempts: 0, successfulSourceCommits: 0,
    rolledBackTransactions: 0, readBackTransactions: 0, openHandles: 0 };
  async function bootstrap(input = {}) {
    const checked = await validate(input);
    if (!checked.valid) return Object.freeze(emptyResult(checked.sourceId, checked.reason));
    const catalog = await indexedDB.databases(), existing = catalog.find(value =>
      value.name === Schema.DATABASE_NAME);
    if (existing) return Object.freeze(emptyResult(checked.sourceId,
      existing.version === Schema.VERSION ? "db_already_exists" : "schema_mismatch_existing"));
    metrics.databaseCreateAttempts += 1;
    let upgradeStarted = false, creationCommitted = false, database = null, injectedReason = null;
    try {
      await new Promise((resolve, reject) => {
        const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
        opening.onupgradeneeded = () => {
          upgradeStarted = true; database = opening.result; metrics.openHandles += 1;
          try { BootstrapSchema.createAndPopulate(database, opening.transaction,
            checked.snapshot, input.injectFailureAfter || null); }
          catch (error) { injectedReason = error.message;
            try { opening.transaction.abort(); } catch (_error) {} }
        };
        opening.onsuccess = () => {
          database = opening.result;
          if (!upgradeStarted) { database.close(); database = null;
            reject(new Error("db_already_exists")); return; }
          resolve();
        };
        opening.onerror = () => reject(opening.error || new Error(injectedReason || "open_failed"));
        opening.onblocked = () => reject(new Error("open_blocked"));
      });
      if (database) { database.close(); database = null; metrics.openHandles -= 1; }
      creationCommitted = true;
      metrics.successfulDatabaseCreates += 1;
      metrics.successfulSourceCommits += 1;
      const verified = await readBack(indexedDB, checked.sourceId, checked.snapshot, metrics);
      return Object.freeze({ status: "committed", sourceId: checked.sourceId,
        dbCreated: true, committed: true, schemaVersion: Schema.VERSION,
        transactionOutcome: "committed", readBackStatus: verified.valid ? "passed" : "failed",
        reason: null, planHash: checked.planHash });
    } catch (error) {
      if (database) { database.close(); database = null; metrics.openHandles -= 1; }
      if (creationCommitted) return Object.freeze({ status: "committed_read_back_failed",
        sourceId: checked.sourceId, dbCreated: true, committed: true,
        schemaVersion: Schema.VERSION, transactionOutcome: "committed",
        readBackStatus: "failed", reason: error.message || "read_back_failed",
        planHash: checked.planHash });
      if (upgradeStarted) { metrics.abortedCreateAttempts += 1;
        metrics.rolledBackTransactions += 1; }
      return Object.freeze({ ...emptyResult(checked.sourceId,
        injectedReason || error.message || "bootstrap_failed"), status: "rolled_back",
      transactionOutcome: "aborted" });
    }
  }
  return Object.freeze({ bootstrap, diagnostics: () => Object.freeze(clone(metrics)) });
}

module.exports = Object.freeze({ createBootstrapFirstSourceWriter });
