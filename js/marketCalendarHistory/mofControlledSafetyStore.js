"use strict";

// Isolated acceptance factory ONLY. No production resolver/provisioning/activation.
// Immutable generations + a durable attempt ownership latch make interruption
// fail closed, including an authorization-only crash before a pending fence exists.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("./formalWriterAuthorityV2.js");
const Auth = require("./mofControlledAuthorization.js"), Semantic = require("./mofControlledSemanticPlan.js");
const Atomic = require("./writerSafetyAtomicCore.js"), Core = require("./formalControlledWriterCore.js");
const SafetyIO = require("./mofControlledSafetyAtomicCore.js");
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js"), Schema = require("./productionSchemaV1.js");
const CRASH_POINTS = Object.freeze(["after_authorization", "after_prepared", "after_formal_write_started",
  "after_commit_observed", "after_readback_verified", "before_completion_persist", "after_completion_persist",
  ...Atomic.CRASH_POINTS.map(p => `completion_${p}`)]);
function createIsolatedStore({ userData, crashAt = null } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof userData !== "string" || !path.isAbsolute(userData) ||
    path.dirname(userData) !== fs.realpathSync(os.tmpdir()) || !path.basename(userData).startsWith("optionmap-writer-safety-") ||
    fs.realpathSync(userData) !== userData ||
    crashAt !== null && !CRASH_POINTS.includes(crashAt)) throw Error("isolated_store_path_invalid");
  const io = SafetyIO.createBoundStore(userData, { crashAt });
  const handles = new WeakMap(), audit = { authorizations: 0, readonlyTransactions: 0,
    readwriteTransactions: 0, committedTransactions: 0, abortedTransactions: 0, committedWrites: Core.emptyCounts() };
  let current = null, issued = false;
  function createControlledAuthorization(input) {
    if (issued) throw Error("controlled_attempt_already_issued"); issued = true;
    const loaded = Reader.createReader(userData).load();
    if (loaded.status !== "valid" || loaded.record.schemaVersion !== 3 || loaded.record.controlledLifecycleAudit ||
      loaded.record.safety.pendingFence) throw Error("controlled_safety_unavailable");
    current = io.begin(loaded.record);
    const authorization = Auth.createControlledAuthorization({ ...input, record: current });
    audit.authorizations++; io.point("after_authorization"); return authorization;
  }
  function createPendingFence(authorization, input) {
    io.checkOwned();
    const context = Auth.consume(authorization, { ...input, record: current });
    const token = Object.freeze({});
    current = io.createPreparedFence(context.binding);
    handles.set(token, { ...context, phase: "prepared", attempted: false, result: null, database: null, readback: null }); return token;
  }
  function get(token, phase) { const h = handles.get(token); if (!h || h.phase !== phase) throw Error("controlled_handle_invalid");
    io.checkOwned(); return h; }
  async function markWriteStarted(token, database) {
    const h = get(token, "prepared"); if (h.attempted) throw Error("controlled_second_write_forbidden");
    h.attempted = true; h.phase = "formal_write_started";
    current = io.markWriteStarted(h.binding); h.database = database;
    try { h.result = await Core.executePrepared(database, h.execution, null, audit); return h.result; }
    catch (e) { throw e; }
  }
  function common(h) { return Object.fromEntries(["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity", "counts"]
    .map(k => [k, h.binding[k]])); }
  function markCommitObserved(token) {
    const h = get(token, "formal_write_started");
    const expectedCounts = Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f,
      f === "runs" || f === "cursors" ? 1 : 16]));
    if (h.result?.committed !== true || A.hash(h.result.counts) !== A.hash(expectedCounts) ||
      audit.readwriteTransactions !== 1 || audit.committedTransactions !== 1 || audit.abortedTransactions !== 0)
      throw Error("controlled_commit_ambiguous_or_mismatch");
    const proof = { ...common(h), readwriteTransactions: audit.readwriteTransactions,
      committedTransactions: audit.committedTransactions, abortedTransactions: audit.abortedTransactions };
    current = io.markCommitObserved(h.binding, proof); h.phase = "commit_observed";
  }
  async function markReadbackVerified(token, openFreshReadonly) {
    const h = get(token, "commit_observed");
    h.phase = "readback_in_progress"; // A failed read-back never re-enters this attempt.
    if (typeof openFreshReadonly !== "function") throw Error("controlled_fresh_readback_required");
    h.database.close(); const database = await openFreshReadonly();
    if (!database || database === h.database) throw Error("controlled_fresh_readback_required");
    let snapshot;
    try {
      snapshot = await new Promise((resolve, reject) => {
        const tx = database.transaction(Core.STORE_NAMES, "readonly"), values = {}; audit.readonlyTransactions++;
        tx.onabort = () => reject(Error("controlled_readback_incomplete")); tx.onerror = () => undefined;
        tx.oncomplete = () => resolve(values);
        for (const [f, name] of Core.STORE_ORDER) { const r = tx.objectStore(name).getAll(); r.onsuccess = () => { values[f] = r.result; }; }
      });
    } finally { database.close(); }
    const identity = A.hash(Core.sorted(snapshot));
    if (identity !== h.binding.expectedFormalIdentity) throw Error("controlled_readback_mismatch");
    const cycle = Cycle.create(snapshot, Schema.EXPECTED_FINGERPRINT); Cycle.close(cycle);
    const afterSorted = Core.sorted(snapshot), beforeSorted = Core.sorted(h.data.before);
    if (Core.STORE_ORDER.some(([f]) => A.hash(afterSorted[f].filter(r => r.sourceId !== Semantic.SOURCE)) !==
      A.hash(beforeSorted[f].filter(r => r.sourceId !== Semantic.SOURCE)))) throw Error("controlled_cross_source_mutation");
    const proof = { ...common(h), freshReadonlyReopen: true, integrity: true, otherSourcesUnchanged: true,
      expectedFormalIdentity: h.binding.expectedFormalIdentity, actualFormalIdentity: identity };
    current = io.markReadbackVerified(h.binding, proof);
    h.phase = "readback_verified"; h.readback = proof;
  }
  function completeControlledAttempt(token) {
    const h = get(token, "readback_verified");
    current = io.completeAttempt(h.binding, h.readback); h.phase = "completed";
    close(); const reloaded = Reader.createReader(userData).load();
    if (reloaded.status !== "valid" || reloaded.record.checksum !== current.checksum || reloaded.safety.pendingFence)
      throw Error("controlled_completion_reload_failed"); return reloaded.record;
  }
  function close() { io.close(); }
  return Object.freeze({ createControlledAuthorization, createPendingFence, markWriteStarted, markCommitObserved,
    markReadbackVerified, completeControlledAttempt, close, audit: () => structuredClone({ ...audit, ...io.audit() }) });
}
module.exports = Object.freeze({ CRASH_POINTS, createIsolatedStore });
