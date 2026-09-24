"use strict";

const B1 = require("../marketCalendarRuntime/sourceUpdateState.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const DATABASE_NAME = "optionMapMarketCalendarRuntimeState", VERSION = 1,
  STORE_NAME = "sourceUpdateStates", TIMEOUT_MS = 8000;
const sourceValid = id => Registry.getSource(id)?.formalEligible === true;
const valid = (state, id) => sourceValid(id) && state != null &&
  B1.validateRuntimeState(state, id).valid;

// No default browser factory: D2a is an explicitly isolated capability only.
function createRuntimeStateStore({ indexedDB, targetEnvironment } = {}) {
  if (targetEnvironment !== "isolated_test" || !indexedDB?.databases || !indexedDB?.open)
    throw new TypeError("isolated_test_configuration_required");
  const counts = { databaseCreateAttempts: 0, successfulCreates: 0,
    readonlyTransactions: 0, readwriteTransactions: 0, successfulWrites: 0,
    failedWrites: 0, openHandles: 0 };
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
  async function access(mode, work) {
    let db;
    try {
      db = await open(mode === "readwrite");
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
    return access("readonly", (store, done, abort) => {
      const request = store.getAll();
      request.onsuccess = () => {
        if (request.result.some(state => !valid(state, state.sourceId))) {
          abort("invalid_persisted_state"); return;
        }
        done(request.result.sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
      };
    });
  }
  async function read(sourceId) {
    if (!sourceValid(sourceId)) return { status: "unavailable", reason: "source_invalid", value: null };
    const result = await readAll();
    return { ...result, value: result.value?.find(state => state.sourceId === sourceId) || null };
  }
  async function write(sourceId, state) {
    if (!valid(state, sourceId)) {
      counts.failedWrites += 1;
      return { status: "unavailable", reason: "runtime_state_invalid", value: null };
    }
    const snapshot = structuredClone(state);
    const result = await access("readwrite", (store, done, abort) => {
      const request = store.get(sourceId);
      request.onsuccess = () => {
        const previous = request.result;
        if (previous && (!valid(previous, sourceId) ||
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
  return Object.freeze({ read, readAll, write, diagnostics: () => ({ ...counts }) });
}
module.exports = Object.freeze({ DATABASE_NAME, VERSION, STORE_NAME, TIMEOUT_MS, createRuntimeStateStore });
