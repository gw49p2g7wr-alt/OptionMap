"use strict";

// CAL-PB-B3 executor core. CAL-PB-B4 reuses the fixed authorized renderer
// operation, but callers still cannot select a database, schema, store, path,
// URL, parser, or production execution authority.
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Schema = require("./productionSchemaV1.js");
const BootstrapSchema = require("./bootstrapSchemaV1.js");
const Integrity = require("./historyIntegrity.js");
const Preparation = require("./calendarPartialSourcePreparation.js");
const Authority = require("./calendarPartialSourceExecutionAuthority.js");
const WriterCore = require("./formalControlledWriterCore.js");

const STORE_NAMES = Object.freeze(Object.keys(Schema.STORES));
const clone = value => value == null ? value : structuredClone(value);
const same = (left, right) => Canonicalizer.stable(left) === Canonicalizer.stable(right);
const frozen = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
const emptyStoreCounts = () => Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
  [field, 0]));
const emptyMutationCounts = () => ({ eventEntryCreate: 0, eventEntryUpdate: 0,
  semanticRevisionCreate: 0, semanticRevisionClose: 0, evidenceCreate: 0,
  observationCreate: 0, sourceRunCreate: 0, sourceCursorUpdate: 0 });
const storeCountsFor = counts => ({ entries: counts.eventEntryCreate + counts.eventEntryUpdate,
  revisions: counts.semanticRevisionCreate + counts.semanticRevisionClose,
  evidence: counts.evidenceCreate, observations: counts.observationCreate,
  runs: counts.sourceRunCreate, cursors: counts.sourceCursorUpdate });
function result(status, reason, extra = {}) {
  return frozen({ status, reason, committed: false, operation: null, sourceId: null,
    durableReceipt: null, mutationCounts: emptyMutationCounts(), ...extra });
}
async function snapshot(transaction) {
  const values = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    values[field] = await request(transaction.objectStore(storeName).getAll());
  return WriterCore.sorted(values);
}
async function openExisting(indexedDB) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME); let upgraded = false;
    opening.onupgradeneeded = () => { upgraded = true;
      try { opening.transaction.abort(); } catch (_error) {} };
    opening.onsuccess = () => upgraded ? (opening.result.close(),
      reject(new Error("database_state_mismatch"))) : resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error("database_open_failed"));
    opening.onblocked = () => reject(new Error("database_open_blocked"));
  });
}
async function readFresh(indexedDB, metrics) {
  metrics.catalogReads += 1;
  const catalog = await indexedDB.databases(), descriptor = catalog.find(value =>
    value.name === Schema.DATABASE_NAME);
  if (!descriptor) return { status: "absent", snapshot: null, fingerprint: null };
  if (descriptor.version !== Schema.VERSION) return { status: "schema_mismatch",
    snapshot: null, fingerprint: null };
  let database;
  try {
    database = await openExisting(indexedDB); metrics.openHandles += 1;
    const transaction = database.transaction(STORE_NAMES, "readonly"), completed = done(transaction),
      definition = BootstrapSchema.inspect(database, transaction), values = await snapshot(transaction);
    metrics.readonlyTransactions += 1;
    await completed;
    const schemaFingerprint = await Schema.fingerprint(definition);
    if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT)
      return { status: "schema_mismatch", snapshot: null, fingerprint: null };
    const formalSnapshot = { databaseStatus: "present", schemaVersion: Schema.VERSION,
      schemaFingerprint, snapshotFingerprint: null, ...values };
    formalSnapshot.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(formalSnapshot);
    return { status: "present", snapshot: values,
      fingerprint: formalSnapshot.snapshotFingerprint, formalSnapshot };
  } finally {
    if (database) { database.close(); metrics.openHandles -= 1; }
  }
}
function expectedSourceState(snapshotValue, sourceId) {
  const cursor = snapshotValue.cursors.find(value => value.sourceId === sourceId) || null,
    runs = snapshotValue.runs.filter(value => value.sourceId === sourceId).map(value => ({
      runKey: value.runKey, acceptedAt: value.acceptedAt,
      semanticSetHash: value.semanticSetHash })).sort((a, b) => a.runKey.localeCompare(b.runKey)),
    activeRevisionIdentities = snapshotValue.entries.filter(value => value.sourceId === sourceId)
      .map(value => ({ eventKey: value.eventKey, revisionKey: value.activeRevisionKey }))
      .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  return { cursor: clone(cursor), runs, activeRevisionIdentities };
}
function planRuntimePreconditionsValid(plan) {
  const run = plan.mutations.appendRuns[0], cursor = plan.mutations.updateCursors[0];
  return /^[0-9a-f]{64}$/.test(plan.preconditions.acquisitionGenerationIdentity || "") &&
    /^[0-9a-f]{64}$/.test(plan.preconditions.semanticSetIdentity || "") && run && cursor &&
    run.sourceId === plan.sourceId && cursor.sourceId === plan.sourceId &&
    run.semanticSetHash === plan.preconditions.semanticSetIdentity &&
    cursor.runKey === run.runKey && cursor.runId === run.runId;
}
function beforeMatches(plan, fresh) {
  if (fresh.status !== plan.preconditions.expectedDatabaseStatus ||
      fresh.status === "present" && fresh.fingerprint !==
        plan.preconditions.formalSnapshotFingerprint) return false;
  if (fresh.status === "absent") return plan.preconditions.expectedSourceState.cursor === null &&
    plan.preconditions.expectedSourceState.runs.length === 0 &&
    plan.preconditions.expectedSourceState.activeRevisionIdentities.length === 0;
  return same(expectedSourceState(fresh.snapshot, plan.sourceId),
    plan.preconditions.expectedSourceState);
}
async function verifyReceipt(plan, operation, fresh, committedCounts, readbackMutator = null) {
  if (fresh.status !== "present") return { valid: false, reason: "readback_mismatch" };
  const snapshotValue = readbackMutator ? readbackMutator(clone(fresh.snapshot)) : fresh.snapshot,
    semantic = await Integrity.audit(snapshotValue), storage = Integrity.auditStorageSnapshot(snapshotValue);
  if (!semantic.valid || !storage.valid) return { valid: false, reason: "readback_mismatch" };
  const descriptor = { databaseStatus: "present", schemaVersion: Schema.VERSION,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, ...snapshotValue }, fingerprint =
    await Preparation.fingerprintFormalSnapshot(descriptor), expectation = plan.receiptExpectation,
    run = snapshotValue.runs.find(value => value.runKey === plan.mutations.appendRuns[0].runKey),
    cursor = snapshotValue.cursors.find(value => value.sourceId === plan.sourceId),
    active = expectedSourceState(snapshotValue, plan.sourceId).activeRevisionIdentities,
    runIdentity = run ? await Canonicalizer.sha256(run) : null,
    cursorIdentity = cursor ? await Canonicalizer.sha256(cursor) : null;
  if (expectation.sourceId !== plan.sourceId || expectation.operationType !== plan.operationType ||
      !same(expectation.expectedMutationCounts, committedCounts) ||
      expectation.expectedRunIdentity !== runIdentity ||
      expectation.expectedCursorIdentity !== cursorIdentity ||
      !same(expectation.expectedActiveRevisionIdentities, active) ||
      expectation.expectedSchemaVersion !== Schema.VERSION ||
      expectation.expectedSchemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      expectation.expectedSnapshotFingerprint !== fingerprint)
    return { valid: false, reason: "readback_mismatch" };
  return { valid: true, receipt: frozen({ verified: true, sourceId: plan.sourceId,
    operation, planIdentity: plan.planIdentity, mutationCounts: clone(committedCounts),
    storeMutationCounts: storeCountsFor(committedCounts),
    runIdentity, cursorIdentity, activeRevisionIdentities: active,
    schemaVersion: Schema.VERSION, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
    snapshotFingerprint: fingerprint }) };
}
async function createFirstSource(indexedDB, plan, metrics, failurePoint = null) {
  const candidate = { entries: plan.mutations.appendEntries,
    revisions: plan.mutations.appendRevisions, evidence: plan.mutations.appendEvidence,
    observations: plan.mutations.appendObservations, runs: plan.mutations.appendRuns,
    cursors: plan.mutations.updateCursors };
  if (plan.mutations.updateEntries.length || plan.mutations.closeRevisions.length)
    return { committed: false, reason: "invalid_plan" };
  metrics.readwriteTransactions += 1;
  let database = null, upgradeStarted = false, injectedReason = null;
  try {
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
      opening.onupgradeneeded = () => {
        upgradeStarted = true; database = opening.result; metrics.openHandles += 1;
        try { BootstrapSchema.createAndPopulate(database, opening.transaction, candidate,
          failurePoint); }
        catch (error) { injectedReason = error.message;
          try { opening.transaction.abort(); } catch (_error) {} }
      };
      opening.onsuccess = () => upgradeStarted ? resolve() :
        reject(new Error("database_state_mismatch"));
      opening.onerror = () => reject(opening.error || new Error(injectedReason ||
        "transaction_aborted"));
      opening.onblocked = () => reject(new Error("database_open_blocked"));
    });
    metrics.committedTransactions += 1;
    return { committed: true, reason: null, storeCounts: storeCountsFor(plan.mutationCounts) };
  } catch (error) {
    metrics.abortedTransactions += 1;
    return { committed: false, reason: injectedReason || error.message || "transaction_aborted" };
  } finally {
    if (database) { database.close(); metrics.openHandles -= 1; }
  }
}
async function mutateExisting(indexedDB, plan, before, metrics, failurePoint = null) {
  let token;
  try { token = WriterCore.prepareExecution(plan, before, plan.mutationCeiling); }
  catch (error) { return { committed: false, reason: error.message || "invalid_plan" }; }
  let database;
  try {
    database = await openExisting(indexedDB); metrics.openHandles += 1;
    metrics.readwriteTransactions += 1;
    const outcome = await WriterCore.executePrepared(database, token, failurePoint, metrics);
    return outcome.committed ? { committed: true, reason: null,
      storeCounts: outcome.counts } : { committed: false,
      reason: outcome.reason || "transaction_aborted" };
  } finally {
    if (database) { database.close(); metrics.openHandles -= 1; }
  }
}

// Serialized only into a main-created, fixed hidden renderer. Main consumes the
// one-use grant before invoking this function; the renderer receives no grant,
// authority object, path, database name, or source-selection capability.
async function executeAuthorizedMutationInRenderer(plan, operation, Core, schema,
  storeOrder, stable, databaseApi) {
  const digest = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(text)))].map(value =>
      value.toString(16).padStart(2, "0")).join(""), hash = value => digest(stable(value)),
    request = value =>
    new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result);
      value.onerror = () => reject(value.error || Error("request_failed"));
    }), complete = transaction => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || Error("transaction_aborted"));
      transaction.onerror = () => undefined;
    }), storeNames = storeOrder.map(([, name]) => name), fields = storeOrder.map(([field]) => field),
    metrics = { catalogReads: 0, readonlyTransactions: 0, readwriteTransactions: 0,
      committedTransactions: 0, abortedTransactions: 0, openHandles: 0 },
    storeCounts = counts => ({ entries: counts.eventEntryCreate + counts.eventEntryUpdate,
      revisions: counts.semanticRevisionCreate + counts.semanticRevisionClose,
      evidence: counts.evidenceCreate, observations: counts.observationCreate,
      runs: counts.sourceRunCreate, cursors: counts.sourceCursorUpdate }),
    openExisting = () => new Promise((resolve, reject) => {
      const opening = databaseApi.open(schema.DATABASE_NAME); let upgraded = false;
      opening.onupgradeneeded = () => { upgraded = true;
        try { opening.transaction.abort(); } catch (_) {} };
      opening.onsuccess = () => upgraded ? (opening.result.close(),
        reject(Error("database_state_mismatch"))) : resolve(opening.result);
      opening.onerror = () => reject(opening.error || Error("database_open_failed"));
      opening.onblocked = () => reject(Error("database_open_blocked"));
    }), inspect = (database, transaction) => {
      const stores = {};
      for (const [name, expected] of Object.entries(schema.STORES)) {
        const store = transaction.objectStore(name), indexes = expected.indexes.map(([indexName]) => {
          const index = store.index(indexName);
          return [index.name, Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
            index.unique];
        });
        stores[name] = { keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
          indexes };
      }
      return { databaseName: database.name, version: database.version, stores };
    }, readFresh = async () => {
      metrics.catalogReads++;
      const catalog = await databaseApi.databases(), descriptor = catalog.find(value =>
        value.name === schema.DATABASE_NAME);
      if (!descriptor) return { status: "absent", snapshot: null, fingerprint: null };
      if (descriptor.version !== schema.VERSION) return { status: "schema_mismatch",
        snapshot: null, fingerprint: null };
      let database;
      try {
        database = await openExisting(); metrics.openHandles++;
        const transaction = database.transaction(storeNames, "readonly"), finished = complete(transaction),
          definition = inspect(database, transaction), snapshot = {};
        metrics.readonlyTransactions++;
        for (const [field, name] of storeOrder)
          snapshot[field] = await request(transaction.objectStore(name).getAll());
        await finished;
        if (await digest(JSON.stringify(definition)) !== schema.EXPECTED_FINGERPRINT)
          return { status: "schema_mismatch", snapshot: null, fingerprint: null };
        const sorted = Core.sorted(snapshot), fingerprint = await hash({ databaseStatus: "present",
          schemaVersion: schema.VERSION, schemaFingerprint: schema.EXPECTED_FINGERPRINT,
          snapshot: sorted });
        return { status: "present", snapshot: sorted, fingerprint };
      } finally { if (database) { database.close(); metrics.openHandles--; } }
    }, fail = (status, reason, extra = {}) => ({ status, reason, committed: false,
      operation, sourceId: plan?.sourceId || null, snapshot: null, storeCounts: null,
      metrics: { ...metrics }, ...extra });
  if (!plan || !["create_schema_and_commit_first_source", "append_missing_source"].includes(operation))
    return fail("rejected", "operation_not_enabled");
  const fresh = await readFresh();
  if (fresh.status === "schema_mismatch") return fail("rejected", "schema_mismatch");
  if (fresh.status === "present" && Core.alreadyApplied(plan, fresh.snapshot))
    return fail("already_committed", null, { snapshot: fresh.snapshot });
  if (fresh.status !== plan.preconditions.expectedDatabaseStatus ||
      fresh.status === "present" && fresh.fingerprint !== plan.preconditions.formalSnapshotFingerprint)
    return fail("precondition_failed", "precondition_failed");
  let outcome;
  if (operation === "create_schema_and_commit_first_source") {
    if (fresh.status !== "absent" || plan.mutations.updateEntries.length ||
        plan.mutations.closeRevisions.length) return fail("rejected", "database_state_mismatch");
    metrics.readwriteTransactions++;
    let database = null, upgraded = false, reason = null;
    try {
      await new Promise((resolve, reject) => {
        const opening = databaseApi.open(schema.DATABASE_NAME, schema.VERSION);
        opening.onupgradeneeded = () => {
          upgraded = true; database = opening.result; metrics.openHandles++;
          try {
            for (const [name, specification] of Object.entries(schema.STORES)) {
              const store = database.createObjectStore(name, { keyPath: specification.keyPath });
              for (const [indexName, keyPath, unique] of specification.indexes)
                store.createIndex(indexName, keyPath, { unique });
            }
            const candidate = { entries: plan.mutations.appendEntries,
              revisions: plan.mutations.appendRevisions, evidence: plan.mutations.appendEvidence,
              observations: plan.mutations.appendObservations, runs: plan.mutations.appendRuns,
              cursors: plan.mutations.updateCursors };
            for (const [field, name] of storeOrder) for (const value of candidate[field])
              opening.transaction.objectStore(name).add(value);
          } catch (error) { reason = error.message;
            try { opening.transaction.abort(); } catch (_) {} }
        };
        opening.onsuccess = () => upgraded ? resolve() : reject(Error("database_state_mismatch"));
        opening.onerror = () => reject(opening.error || Error(reason || "transaction_aborted"));
        opening.onblocked = () => reject(Error("database_open_blocked"));
      });
      metrics.committedTransactions++;
      outcome = { committed: true, storeCounts: storeCounts(plan.mutationCounts) };
    } catch (error) { metrics.abortedTransactions++;
      outcome = { committed: false, reason: reason || error.message || "transaction_aborted" };
    } finally { if (database) { database.close(); metrics.openHandles--; } }
  } else if (fresh.status === "present") {
    let database;
    const coreMetrics = { readwriteTransactions: 0, committedTransactions: 0,
      abortedTransactions: 0, committedWrites: Object.fromEntries(fields.map(field => [field, 0])) };
    try {
      const token = Core.prepareExecution(plan, fresh.snapshot, plan.mutationCeiling);
      database = await openExisting(); metrics.openHandles++;
      outcome = await Core.executePrepared(database, token, null, coreMetrics);
    } catch (error) { outcome = { committed: false, reason: error.message || "transaction_aborted" }; }
    finally { if (database) { database.close(); metrics.openHandles--; } }
    metrics.readwriteTransactions += coreMetrics.readwriteTransactions;
    metrics.committedTransactions += coreMetrics.committedTransactions;
    metrics.abortedTransactions += coreMetrics.abortedTransactions;
    if (outcome.committed) outcome.storeCounts = outcome.counts;
  } else outcome = { committed: false, reason: "database_state_mismatch" };
  if (!outcome.committed) return fail("transaction_aborted",
    outcome.reason === "database_state_mismatch" ? "database_state_mismatch" : "transaction_aborted");
  const readback = await readFresh();
  if (readback.status !== "present") return fail("readback_mismatch", "readback_mismatch",
    { committed: true });
  return { status: "committed", reason: null, committed: true, operation,
    sourceId: plan.sourceId, snapshot: readback.snapshot,
    storeCounts: outcome.storeCounts, metrics: { ...metrics } };
}

async function finalizeAuthorizedRendererExecution(plan, operation, value) {
  if (!value || value.sourceId !== plan?.sourceId || value.operation !== operation ||
      !["committed", "already_committed", "precondition_failed", "transaction_aborted",
        "readback_mismatch", "rejected"].includes(value.status))
    return result("rejected", "renderer_receipt_invalid", { sourceId: plan?.sourceId || null,
      operation });
  if (!["committed", "already_committed"].includes(value.status)) return result(value.status,
    value.reason || value.status, { committed: value.committed === true,
      sourceId: plan.sourceId, operation });
  const committedCounts = plan.mutationCounts, verified = await verifyReceipt(plan, operation,
    { status: "present", snapshot: value.snapshot }, committedCounts);
  if (!verified.valid || value.status === "committed" &&
      (!same(value.storeCounts, storeCountsFor(committedCounts)) ||
       value.metrics?.readwriteTransactions !== 1 || value.metrics?.committedTransactions !== 1 ||
       value.metrics?.abortedTransactions !== 0 || value.metrics?.openHandles !== 0))
    return result("readback_mismatch", "readback_mismatch", { committed: value.committed === true,
      sourceId: plan.sourceId, operation });
  return result(value.status, null, { committed: value.status === "committed",
    sourceId: plan.sourceId, operation, durableReceipt: verified.receipt,
    mutationCounts: value.status === "committed" ? clone(committedCounts) : emptyMutationCounts() });
}
function createCalendarPartialSourceAtomicExecutor(configuration = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document)
    throw new Error("main_side_only");
  const configurationKeys = Object.keys(configuration).sort(), allowedConfigurationKeys =
    ["executionAuthority", "indexedDB", "targetEnvironment", "testHooks"];
  if (configurationKeys.some(key => !allowedConfigurationKeys.includes(key)) ||
      configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB ||
      !configuration.executionAuthority ||
      typeof configuration.executionAuthority.consumeGrant !== "function")
    throw new Error("controlled_isolated_executor_required");
  const indexedDB = configuration.indexedDB, executionAuthority = configuration.executionAuthority,
    hooks = configuration.testHooks || {}, hookKeys = Object.keys(hooks), allowedHookKeys =
      ["firstSourceFailureAfter", "existingFailurePoint", "readbackMutator"], metrics =
    { catalogReads: 0, readonlyTransactions: 0,
      readwriteTransactions: 0, committedTransactions: 0, abortedTransactions: 0,
      openHandles: 0, activeExecutions: 0, maxConcurrentExecutions: 0 },
    rawCoreMetrics = { readwriteTransactions: 0, committedTransactions: 0,
      abortedTransactions: 0, committedWrites: emptyStoreCounts() };
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) ||
      hookKeys.some(key => !allowedHookKeys.includes(key)) ||
      hooks.firstSourceFailureAfter != null &&
        !BootstrapSchema.FAILURE_POINTS.includes(hooks.firstSourceFailureAfter) ||
      hooks.existingFailurePoint != null &&
        !WriterCore.FAILURE_POINTS.includes(hooks.existingFailurePoint) ||
      hooks.readbackMutator != null && typeof hooks.readbackMutator !== "function")
    throw new Error("controlled_isolated_executor_required");
  let serial = Promise.resolve();
  async function perform(input = {}) {
    if (!input || !same(Object.keys(input).sort(), ["grant", "plan"]))
      return result("rejected", "invalid_plan");
    const { plan, grant } = input;
    const planCheck = await Authority.validatePlan(plan);
    if (!planCheck.valid) return result("rejected", planCheck.reason,
      { sourceId: plan?.sourceId || null });
    const authorized = await executionAuthority.consumeGrant(grant, plan);
    if (!authorized.valid) return result("rejected", authorized.reason,
      { sourceId: plan.sourceId });
    if (authorized.binding.noOp) return result(plan.status, null, { sourceId: plan.sourceId,
      operation: null });
    if (!planRuntimePreconditionsValid(plan)) return result("rejected", "precondition_failed",
      { sourceId: plan.sourceId, operation: authorized.binding.operation });

    const fresh = await readFresh(indexedDB, metrics);
    if (fresh.status === "schema_mismatch") return result("rejected", "schema_mismatch",
      { sourceId: plan.sourceId, operation: authorized.binding.operation });
    if (fresh.status === "present" && fresh.fingerprint ===
        plan.receiptExpectation.expectedSnapshotFingerprint) {
      const verified = await verifyReceipt(plan, authorized.binding.operation, fresh,
        plan.mutationCounts);
      if (verified.valid) return result("already_committed", null, { sourceId: plan.sourceId,
        operation: authorized.binding.operation, durableReceipt: verified.receipt });
    }
    if (fresh.status === "present" && WriterCore.alreadyApplied(plan, fresh.snapshot))
      return result("already_committed", null, { sourceId: plan.sourceId,
        operation: authorized.binding.operation });
    if (!beforeMatches(plan, fresh)) return result("precondition_failed", "precondition_failed",
      { sourceId: plan.sourceId, operation: authorized.binding.operation });

    let outcome;
    if (authorized.binding.operation === "create_schema_and_commit_first_source")
      outcome = await createFirstSource(indexedDB, plan, metrics,
        hooks.firstSourceFailureAfter || null);
    else if (fresh.status === "present") {
      outcome = await mutateExisting(indexedDB, plan, fresh.snapshot, rawCoreMetrics,
        hooks.existingFailurePoint || null);
      metrics.readwriteTransactions += rawCoreMetrics.readwriteTransactions;
      metrics.committedTransactions += rawCoreMetrics.committedTransactions;
      metrics.abortedTransactions += rawCoreMetrics.abortedTransactions;
      rawCoreMetrics.readwriteTransactions = 0; rawCoreMetrics.committedTransactions = 0;
      rawCoreMetrics.abortedTransactions = 0;
    } else outcome = { committed: false, reason: "database_state_mismatch" };
    if (!outcome.committed) return result("transaction_aborted",
      outcome.reason === "database_state_mismatch" ? "database_state_mismatch" :
        "transaction_aborted", { sourceId: plan.sourceId,
        operation: authorized.binding.operation });

    if (!same(outcome.storeCounts, storeCountsFor(plan.mutationCounts)))
      return result("readback_mismatch", "readback_mismatch", { committed: true,
        sourceId: plan.sourceId, operation: authorized.binding.operation,
        mutationCounts: clone(plan.mutationCounts) });

    const readback = await readFresh(indexedDB, metrics), committedCounts = plan.mutationCounts,
      verified = await verifyReceipt(plan, authorized.binding.operation, readback,
        committedCounts, hooks.readbackMutator || null);
    if (!verified.valid) return result("readback_mismatch", "readback_mismatch", {
      committed: true, sourceId: plan.sourceId, operation: authorized.binding.operation,
      mutationCounts: clone(committedCounts) });
    return result("committed", null, { committed: true, sourceId: plan.sourceId,
      operation: authorized.binding.operation, durableReceipt: verified.receipt,
      mutationCounts: clone(committedCounts) });
  }
  function executeCalendarFormalSourceMutation(input) {
    const task = serial.then(async () => {
      metrics.activeExecutions += 1;
      metrics.maxConcurrentExecutions = Math.max(metrics.maxConcurrentExecutions,
        metrics.activeExecutions);
      try { return await perform(input); }
      finally { metrics.activeExecutions -= 1; }
    });
    serial = task.catch(() => undefined);
    return task;
  }
  return Object.freeze({ executeCalendarFormalSourceMutation,
    diagnostics: () => frozen(clone(metrics)) });
}

module.exports = Object.freeze({ STORE_NAMES, createCalendarPartialSourceAtomicExecutor,
  executeAuthorizedMutationInRenderer, finalizeAuthorizedRendererExecution });
