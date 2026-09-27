(function (root, factory) {
  const node = typeof module === "object" && module.exports && !root?.document;
  const api = factory(node ? require("../marketCalendarRuntime/sourceUpdateState.js") : root.OptionMapCalendarSourceUpdateState,
    node ? require("../marketCalendar/sourceRegistry.js") : root.OptionMapMarketEventSourceRegistry);
  if (node) module.exports = api;
  if (root) root.OptionMapCalendarRuntimeStateStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (B1, Registry) {
"use strict";
const DATABASE_NAME = "optionMapMarketCalendarRuntimeState", VERSION = 1,
  STORE_NAME = "sourceUpdateStates", TIMEOUT_MS = 8000;
const sourceValid = id => Registry.getSource(id)?.formalEligible === true;
const valid = (state, id) => sourceValid(id) && state != null &&
  B1.validateCompatibleRuntimeState(state, id).valid;

// Explicit factory only; production composition exposes fixed operations, never a generic DB API.
function createRuntimeStateStore({ indexedDB, targetEnvironment, getRouteAuthority, reevaluationPolicy: Reevaluation } = {}) {
  if (!["isolated_test", "browser_runtime"].includes(targetEnvironment) || !indexedDB?.databases || !indexedDB?.open)
    throw new TypeError("isolated_test_configuration_required");
  // Trusted isolated composition injects the fixed policy; ordinary browser imports never load alternative routes.
  if ((getRouteAuthority !== undefined || Reevaluation !== undefined) && (targetEnvironment !== "isolated_test" ||
      typeof getRouteAuthority !== "function" || !Reevaluation ||
      !["evaluate", "reserveState", "reservationToken", "completeState"].every(k => typeof Reevaluation[k] === "function")))
    throw new TypeError("isolated_reevaluation_required");
  const counts = { databaseCreateAttempts: 0, successfulCreates: 0,
    readonlyTransactions: 0, readwriteTransactions: 0, successfulWrites: 0,
    failedWrites: 0, openHandles: 0, reservationAttempts: 0, successfulReservations: 0,
    duplicateRejects: 0, completionAttempts: 0, completionCommits: 0, completionRejects: 0 };
  async function open(create) {
    const catalog = await indexedDB.databases(), entry = catalog.find(x => x.name === DATABASE_NAME);
    if (!entry && !create) return null;
    if (entry && entry.version !== VERSION) throw new Error("schema_mismatch");
    return new Promise((resolve, reject) => {
      let settled = false, created = false;
      const request = indexedDB.open(DATABASE_NAME, VERSION);
      const finish = (error, db) => {
        if (settled) { if (db) db.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(new Error(error));
        else { counts.openHandles += 1; if (created) counts.successfulCreates += 1;
          db.onversionchange = () => db.close(); resolve(db); }
      };
      const timer = setTimeout(() => finish("open_timeout"), TIMEOUT_MS);
      request.onblocked = () => finish("open_blocked");
      request.onupgradeneeded = event => {
        if (settled || !create || event.oldVersion !== 0) {
          request.transaction.abort(); return;
        }
        counts.databaseCreateAttempts += 1; created = true;
        request.result.createObjectStore(STORE_NAME, { keyPath: "sourceId" });
      };
      request.onerror = () => finish("open_failed");
      request.onsuccess = () => finish(null, request.result);
    });
  }
  async function access(mode, work, mayCreate = mode === "readwrite") {
    let db;
    try {
      db = await open(mayCreate);
      if (!db) return { status: "absent", value: [] };
      if (db.version !== VERSION || db.objectStoreNames.length !== 1 ||
          !db.objectStoreNames.contains(STORE_NAME)) throw new Error("schema_mismatch");
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode), store = tx.objectStore(STORE_NAME);
        counts[mode === "readonly" ? "readonlyTransactions" : "readwriteTransactions"] += 1;
        let result, reason = "transaction_failed";
        const timer = setTimeout(() => { reason = "transaction_timeout"; tx.abort(); }, TIMEOUT_MS);
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onabort = () => { clearTimeout(timer); reject(new Error(reason)); };
        tx.onerror = () => {};
        try {
          if (store.keyPath !== "sourceId" || store.autoIncrement || store.indexNames.length)
            throw new Error("schema_mismatch");
          work(store, value => { result = value; }, why => { reason = why; tx.abort(); });
        } catch (error) { reason = error.message === "schema_mismatch" ? "schema_mismatch" :
          "transaction_failed"; tx.abort(); }
      });
      return { status: "ok", value };
    } catch (error) {
      return { status: "unavailable", reason: error.message === "schema_mismatch" ?
        "schema_mismatch" : "runtime_state_access_failed", value: null };
    } finally { if (db) { db.close(); counts.openHandles -= 1; } }
  }
  async function readAll() {
    const result = await access("readonly", (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => done(request.result);
    });
    if (result.status !== "ok") return { ...result, states: {}, invalidSources: [] };
    const value = [], invalidSources = [];
    for (const state of result.value) {
      if (valid(state, state?.sourceId)) value.push(state);
      else invalidSources.push({ sourceId: sourceValid(state?.sourceId) ? state.sourceId : null,
        reason: "runtime_state_invalid" });
    }
    value.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    return { status: "ok", value, states: Object.fromEntries(value.map(s => [s.sourceId, s])), invalidSources };
  }
  async function read(sourceId) {
    if (!sourceValid(sourceId)) return { status: "unavailable", reason: "source_invalid", value: null };
    const result = await readAll();
    if (result.invalidSources?.some(s => s.sourceId === sourceId))
      return { status: "unavailable", reason: "runtime_state_invalid", value: null };
    return { ...result, value: result.value?.find(state => state.sourceId === sourceId) || null };
  }
  async function write(sourceId, state) {
    // Existing manual persistence stays legacy-only; it cannot erase a v2 reservation/binding.
    if (!valid(state, sourceId) || !B1.validateRuntimeState(state, sourceId).valid) {
      counts.failedWrites += 1;
      return { status: "unavailable", reason: "runtime_state_invalid", value: null };
    }
    const snapshot = structuredClone(state);
    const result = await access("readwrite", (store, done, abort) => {
      const request = store.get(sourceId);
      request.onsuccess = () => {
        const previous = request.result;
        if (previous && (previous.runtimeStateContractVersion === 2 || !valid(previous, sourceId) ||
            Date.parse(previous.lastAttemptAt) > Date.parse(snapshot.lastAttemptAt))) {
          abort("stale_or_invalid_state"); return;
        }
        // Preserve an earlier success even when two callers prepared a failure concurrently.
        if (snapshot.lastOutcome === "failure" && previous?.lastSuccessAt &&
            (!snapshot.lastSuccessAt || Date.parse(previous.lastSuccessAt) > Date.parse(snapshot.lastSuccessAt)))
          snapshot.lastSuccessAt = previous.lastSuccessAt;
        if (!valid(snapshot, sourceId)) { abort("runtime_state_invalid"); return; }
        store.put(snapshot); done(snapshot);
      };
    });
    counts[result.status === "ok" ? "successfulWrites" : "failedWrites"] += 1;
    return result;
  }
  async function reserveReevaluation(input) {
    counts.reservationAttempts += 1;
    const denied = reason => ({ status: "unavailable", reason, networkEligible: false });
    if (!getRouteAuthority) return denied("reevaluation_disabled");
    if (!input || Object.keys(input).sort().join("|") !== "requestedAt|sourceId" || !sourceValid(input.sourceId))
      return denied("reevaluation_not_approved");
    const { sourceId, requestedAt } = input;
    const result = await access("readwrite", (store, done, abort) => {
      const request = store.get(sourceId);
      request.onsuccess = () => { try {
        const state = request.result, evaluation = Reevaluation.evaluate({ sourceId, state,
          authority: getRouteAuthority(), requestedAt });
        if (!evaluation.eligible) { done(denied(evaluation.reason)); return; }
        const next = Reevaluation.reserveState(state, evaluation, requestedAt);
        if (!valid(next, sourceId)) { done(denied("runtime_state_invalid")); return; }
        store.put(next); done({ status: "ok", networkEligible: true, state: next,
          token: Reevaluation.reservationToken(next) });
      } catch (_) { abort("reservation_write_failed"); } };
    }, false); // Existing DB only: never create/upgrade from a reservation.
    const output = result.status === "ok" ? result.value : denied("reservation_write_failed");
    if (output.networkEligible) { counts.successfulReservations++; counts.successfulWrites++; }
    else { counts.failedWrites++; if (["reevaluation_interrupted", "reevaluation_already_completed"].includes(output.reason))
      counts.duplicateRejects++; }
    return output;
  }
  async function completeReevaluation(input) {
    counts.completionAttempts++;
    const denied = reason => ({ status: "unavailable", reason, networkEligible: false });
    if (!getRouteAuthority) { counts.completionRejects++; return denied("reevaluation_disabled"); }
    if (!input || Object.keys(input).sort().join("|") !== "completedAt|result|token" || !sourceValid(input.token?.sourceId)) {
      counts.completionRejects++; return denied("stale_route_result");
    }
    // Detach caller input before any asynchronous DB work.
    let captured;
    try { captured = structuredClone(input); }
    catch (_) { counts.completionRejects++; return denied("runtime_state_invalid"); }
    const result = await access("readwrite", (store, done, abort) => {
      const request = store.get(captured.token.sourceId);
      request.onsuccess = () => { try {
        const checked = Reevaluation.completeState({ ...captured, state: request.result, authority: getRouteAuthority() });
        if (!checked.valid) { done(denied(checked.reason)); return; }
        store.put(checked.state); done({ status: "ok", state: checked.state, networkEligible: false });
      } catch (_) { abort("completion_write_failed"); } };
    }, false);
    const output = result.status === "ok" ? result.value : denied("completion_write_failed");
    if (output.status === "ok") { counts.completionCommits++; counts.successfulWrites++; }
    else { counts.completionRejects++; counts.failedWrites++; }
    return output;
  }
  return Object.freeze({ read, readAll, write, reserveReevaluation, completeReevaluation, diagnostics: () => ({ ...counts }) });
}
return Object.freeze({ DATABASE_NAME, VERSION, STORE_NAME, TIMEOUT_MS, createRuntimeStateStore });
});
