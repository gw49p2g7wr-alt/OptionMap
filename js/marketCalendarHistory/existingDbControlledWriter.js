"use strict";

const Registry = require("../marketCalendar/sourceRegistry.js");
const Schema = require("./productionSchemaV1.js");
const Reader = require("./existingDbPreconditionReader.js");
const UpdatePlanner = require("./existingDbUpdatePlanner.js");
const TransitionPlanner = require("./transitionPlanner.js");
const Mapper = require("./storageRecordMapper.js");

const HASH = /^[0-9a-f]{64}$/, STORE_NAMES = Reader.STORE_NAMES;
const KNOWN_OPERATIONS = new Set(["append_source_run", "append_event_entry",
  "append_semantic_revision", "close_semantic_revision", "update_event_entry_active_revision",
  "update_event_entry_last_observed", "append_evidence", "append_observation",
  "update_source_cursor"]);
const FAILURE_POINTS = new Set(["after_close_revision", "after_append_revision",
  "after_semantic_revision", "after_event_entry", "after_evidence", "after_observation",
  "after_source_run", "after_source_cursor"]);
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
const normalized = value => Array.isArray(value) ? value.map(normalized) : value &&
  typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, normalized(value[key])])) : value;
const equal = (left, right) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
const frozen = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen); return Object.freeze(value); };
function result(sourceId, status, reason, extra = {}) {
  return frozen({ sourceId: sourceId || null, status, committed: false,
    transactionOutcome: "not_started", readBackStatus: "not_attempted", reason, ...extra });
}
function inputValid(input) {
  const { sourceId, plan, candidate, simulation } = input || {};
  if (!Registry.getSource(sourceId)) return "source_invalid";
  if (!plan || plan.sourceId !== sourceId || plan.planStatus !== "planned" ||
      plan.writeAllowed !== false || plan.plannerVersion !== UpdatePlanner.PLANNER_VERSION ||
      !HASH.test(plan.planIdentity || "") || !Array.isArray(plan.operations) ||
      plan.operations.some(value => !KNOWN_OPERATIONS.has(value?.type))) return "plan_invalid";
  const precondition = plan.precondition;
  if (!precondition || precondition.schemaVersion !== Schema.VERSION ||
      precondition.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      precondition.sourceId !== sourceId || !HASH.test(precondition.currentStateFingerprint || "") ||
      !Array.isArray(precondition.expectedActiveRevisionIdentities) ||
      !precondition.expectedRelevantCounts?.global || !precondition.expectedRelevantCounts?.source)
    return "precondition_invalid";
  if (!candidate || candidate.sourceId !== sourceId || !simulation ||
      simulation.sourceId !== sourceId || simulation.candidateIdentity !== candidate.candidateIdentity)
    return "bound_input_invalid";
  return null;
}
function previousFrom(state) {
  const source = Registry.getSource(state.sourceId);
  return { sourceId: state.sourceId, schemaVersion: 1, contractVersion: 1,
    parserIdentity: { sourceId: state.sourceId, parserId: source.parserId,
      parserVersion: source.parserVersion }, entries: clone(state.entries),
    revisions: clone(state.revisions), runs: clone(state.runs), cursors: clone(state.cursors) };
}
function acceptedAt(state, candidate) {
  const cursorTime = state.sourceCursor?.acceptedAt || "1970-01-01T00:00:00.000Z",
    fetched = candidate.canonicalRecords.map(event => event.acquisitionEvidence?.fetchedAt)
      .filter(value => typeof value === "string" && Number.isFinite(Date.parse(value))),
    maximum = [cursorTime, ...fetched].sort().at(-1), next = Math.max(Date.parse(maximum),
      Date.parse(cursorTime) + 1);
  return new Date(next).toISOString();
}
function materialize(state, candidate, simulation) {
  const time = acceptedAt(state, candidate), run = { sourceId: state.sourceId,
    runId: `simulation-${simulation.simulationIdentity}`, acceptedAt: time, fetchedAt: [time],
    status: "accepted", semanticSetHash: candidate.sourceIdentity.semanticSetHash },
    unobserved = simulation.transitions.filter(value => value.status === "unobserved")
      .map(value => value.eventKey), coverage = unobserved.length ?
      { confirmed: true, eventKeys: unobserved } : null;
  const planned = TransitionPlanner.planTransition({ snapshot: previousFrom(state), run,
    canonicalSet: candidate.canonicalRecords, coverage, parserChanged: false });
  if (!planned.ok || !planned.plan) throw new Error("storage_plan_invalid");
  return Mapper.mapPlan(planned.plan);
}
function keepAlive(transaction) {
  let active = true; const store = transaction.objectStore(STORE_NAMES[0]);
  const pump = () => { if (!active) return; const pending = store.count();
    pending.onsuccess = pump; pending.onerror = () => undefined; };
  pump(); return () => { active = false; };
}
async function openExisting(indexedDB) {
  const catalog = await indexedDB.databases(), descriptor = catalog.find(value =>
    value.name === Schema.DATABASE_NAME);
  if (!descriptor) throw new Error("database_absent");
  if (descriptor.version !== Schema.VERSION) throw new Error("schema_mismatch");
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(Schema.DATABASE_NAME); let upgraded = false;
    opening.onupgradeneeded = () => { upgraded = true; try { opening.transaction.abort(); } catch (_error) {} };
    opening.onsuccess = () => upgraded ? (opening.result.close(),
      reject(new Error("upgrade_forbidden"))) : resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error("open_failed"));
    opening.onblocked = () => reject(new Error("open_blocked"));
  });
}
async function verifyPlan(sourceId, current, candidate, simulation, expectedPlan) {
  if (UpdatePlanner.comparePrecondition(current, expectedPlan.precondition).status !== "current")
    return false;
  const regenerated = await UpdatePlanner.planExistingSourceUpdate({ sourceId,
    currentState: current, candidate, simulation });
  return regenerated.planStatus === "planned" && regenerated.planIdentity === expectedPlan.planIdentity &&
    equal(regenerated, expectedPlan);
}
async function applyMapped(transaction, mapped, checkpoint) {
  const stores = Object.fromEntries(STORE_NAMES.map(name => [name, transaction.objectStore(name)]));
  for (const value of mapped.closeRevisions) {
    const current = await request(stores.marketCalendarSemanticRevisions.get(value.revisionKey));
    if (!current || current.validTo !== value.expectedValidTo)
      throw new Error("close_revision_precondition_failed");
    await request(stores.marketCalendarSemanticRevisions.put({ ...current, validTo: value.validTo }));
  }
  await checkpoint("after_close_revision");
  for (const value of mapped.appendRevisions)
    await request(stores.marketCalendarSemanticRevisions.add(value));
  await checkpoint("after_append_revision");
  await checkpoint("after_semantic_revision");
  for (const value of mapped.appendEntries)
    await request(stores.marketCalendarEventEntries.add(value));
  for (const value of mapped.updateEntries) {
    const current = await request(stores.marketCalendarEventEntries.get(value.eventKey));
    if (!current || current.activeRevisionKey !== value.expectedActiveRevisionKey)
      throw new Error("entry_precondition_failed");
    const next = { ...current, ...value }; delete next.expectedActiveRevisionKey;
    await request(stores.marketCalendarEventEntries.put(next));
  }
  await checkpoint("after_event_entry");
  for (const value of mapped.appendEvidence)
    await request(stores.marketCalendarAcquisitionEvidence.add(value));
  await checkpoint("after_evidence");
  for (const value of mapped.appendObservations)
    await request(stores.marketCalendarEventObservations.add(value));
  await checkpoint("after_observation");
  for (const value of mapped.appendRuns)
    await request(stores.marketCalendarSourceRuns.add(value));
  await checkpoint("after_source_run");
  for (const value of mapped.updateCursors)
    await request(stores.marketCalendarSourceCursors.put(value));
  await checkpoint("after_source_cursor");
}
function expectedAfter(state, mapped) {
  const global = { ...state.relevantCounts.global }, source = { ...state.relevantCounts.source },
    additions = { marketCalendarEventEntries: mapped.appendEntries.length,
      marketCalendarSemanticRevisions: mapped.appendRevisions.length,
      marketCalendarAcquisitionEvidence: mapped.appendEvidence.length,
      marketCalendarEventObservations: mapped.appendObservations.length,
      marketCalendarSourceRuns: mapped.appendRuns.length,
      marketCalendarSourceCursors: state.sourceCursor ? 0 : mapped.updateCursors.length },
    fields = { marketCalendarEventEntries: "entries", marketCalendarSemanticRevisions: "revisions",
      marketCalendarAcquisitionEvidence: "evidence", marketCalendarEventObservations: "observations",
      marketCalendarSourceRuns: "runs", marketCalendarSourceCursors: "cursors" };
  for (const [store, count] of Object.entries(additions)) {
    global[store] += count; source[fields[store]] += count;
  }
  const active = new Map(state.activeRevisionIdentities.map(value => [value.eventKey, value.revisionKey]));
  for (const value of mapped.appendEntries) active.set(value.eventKey, value.activeRevisionKey);
  for (const value of mapped.updateEntries) active.set(value.eventKey, value.activeRevisionKey);
  return { cursor: mapped.updateCursors[0], counts: { global, source }, active: [...active]
    .map(([eventKey, revisionKey]) => ({ eventKey, revisionKey }))
    .sort((a, b) => a.eventKey.localeCompare(b.eventKey)) };
}

function createExistingDbControlledWriter(configuration = {}) {
  if (configuration.targetEnvironment !== "isolated_test" || !configuration.indexedDB)
    throw new Error("isolated_test_configuration_required");
  const indexedDB = configuration.indexedDB, enabled = configuration.enabled === true,
    beforeInsidePrecondition = configuration.beforeInsidePrecondition,
    failureInjectionPoint = configuration.failureInjectionPoint;
  if (failureInjectionPoint != null && !FAILURE_POINTS.has(failureInjectionPoint))
    throw new Error("failure_injection_point_invalid");
  const checkpoint = async point => {
    if (failureInjectionPoint === point) throw new Error(`injected_failure_${point}`);
  },
    metrics = { readwriteTransactionAttempts: 0, committedTransactions: 0,
      abortedTransactions: 0, readonlyReadBackTransactions: 0, openHandles: 0 };
  async function write(input = {}) {
    const sourceId = typeof input.sourceId === "string" ? input.sourceId : null,
      invalid = inputValid(input);
    if (!enabled) return result(sourceId, "disabled", "writer_disabled");
    if (invalid) return result(sourceId, "rejected", invalid);
    const preReader = Reader.createExistingDbPreconditionReader({ targetEnvironment: "isolated_test", indexedDB }),
      before = await preReader.read({ sourceId });
    if (!await verifyPlan(sourceId, before, input.candidate, input.simulation, input.plan))
      return result(sourceId, "rejected", "stale_precondition");
    let database, transaction, stopKeepAlive = () => {}, mapped, committed = false;
    try {
      database = await openExisting(indexedDB); metrics.openHandles += 1;
      transaction = database.transaction(STORE_NAMES, "readwrite");
      metrics.readwriteTransactionAttempts += 1;
      const completed = done(transaction); stopKeepAlive = keepAlive(transaction);
      try {
        if (typeof beforeInsidePrecondition === "function")
          await beforeInsidePrecondition({ transaction, sourceId });
        const inside = await Reader.assessExistingTransaction(database, transaction, sourceId);
        if (!await verifyPlan(sourceId, inside, input.candidate, input.simulation, input.plan))
          throw new Error("stale_precondition");
        mapped = materialize(inside.currentState, input.candidate, input.simulation);
        await applyMapped(transaction, mapped, checkpoint); stopKeepAlive(); await completed;
      } catch (error) {
        stopKeepAlive(); try { transaction.abort(); } catch (_error) {}
        try { await completed; } catch (_error) {}
        throw error;
      }
      committed = true; metrics.committedTransactions += 1;
      const expected = expectedAfter(before.currentState, mapped);
      database.close(); database = null; metrics.openHandles -= 1;
      metrics.readonlyReadBackTransactions += 1;
      const readBackReader = Reader.createExistingDbPreconditionReader({
        targetEnvironment: "isolated_test", indexedDB }), readBack = await readBackReader.read({ sourceId }),
        state = readBack.currentState;
      if (readBack.status !== "valid_existing" || !equal(state.sourceCursor, expected.cursor) ||
          !equal(state.relevantCounts, expected.counts) ||
          !equal(state.activeRevisionIdentities, expected.active))
        return result(sourceId, "committed_read_back_failed", "read_back_integrity_failed", {
          committed: true, transactionOutcome: "committed", readBackStatus: "failed",
          planIdentity: input.plan.planIdentity });
      return result(sourceId, "committed", null, { committed: true,
        transactionOutcome: "committed", readBackStatus: "passed",
        planIdentity: input.plan.planIdentity });
    } catch (error) {
      if (!committed && transaction) metrics.abortedTransactions += 1;
      return result(sourceId, "rolled_back", error.message || "write_failed", {
        transactionOutcome: transaction ? "aborted" : "not_started" });
    } finally {
      if (database) { database.close(); metrics.openHandles -= 1; }
    }
  }
  return Object.freeze({ write, diagnostics: () => frozen(clone(metrics)),
    contract: Object.freeze({ databaseName: Schema.DATABASE_NAME, schemaVersion: Schema.VERSION,
      stores: Object.freeze([...STORE_NAMES]), enabled }) });
}

module.exports = Object.freeze({ createExistingDbControlledWriter });
