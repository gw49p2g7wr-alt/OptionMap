"use strict";

// Main-only safety adapter. No DB open, transaction, executor, network, runtime
// state, provisioning or migration. Receipts are observations of the main-owned
// controlled executor/read-only collector, not cryptographic commit signatures.
const A = require("./formalWriterAuthorityV2.js"), E = require("./writerSafetySourceSetEnvelope.js");
const P = require("./writerSafetySourceSetPermission.js"), L = require("./writerSafetyControlledLifecycle.js");
const Profile = require("./writerSafetyInitialProvisioning.js");
const Auth = require("./mofControlledAuthorization.js"), Semantic = require("./mofControlledSemanticPlan.js");
const SafetyIO = require("./mofControlledSafetyAtomicCore.js");
const Core = require("./formalControlledWriterCore.js"); // Pure sorting/store contracts ONLY.
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js"), Schema = require("./productionSchemaV1.js");
const Guard = require("../../scripts/marketCalendarG15b1FilesystemGuard.js");
const BaseGuard = require("../../scripts/marketCalendarG14bFilesystemGuard.js");
const OBSERVATION_KEYS = Object.freeze(["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity"]);
function mainOnly() { if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only"); }
function build(root, crashAt) {
  mainOnly(); const reader = Reader.createReader(root), attempts = new WeakMap();
  const audit = { authorizations: 0, writerExecution: 0, formalDBAccess: 0, migration: 0, touches: [] };
  let io = null, current = null, issued = false, closed = false;
  function scoped(action, state = current) {
    const policy = Guard.policyFor(root, state); audit.touches.push(...policy.selectionTouches);
    const result = Guard.scoped(policy, action); audit.touches.push(...result.touches); return result.value;
  }
  function load(...args) {
    if (args.length || closed) throw Error("controlled_adapter_unavailable");
    try { return scoped(() => reader.inspectControlledState(), null); }
    catch (e) { return A.freeze({ status: "corrupt", reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed",
      record: null, safety: null, writeAllowed: false, executionAllowed: false, retryAllowed: false }); }
  }
  function preflight(...args) {
    if (args.length || closed) throw Error("controlled_adapter_unavailable");
    const loaded = load();
    try {
      if (loaded.status !== "valid" || loaded.controlledAttemptOwned) throw Error(loaded.reason || "controlled_safety_unavailable");
      const r = loaded.record, s = loaded.safety;
      if (r.schemaVersion !== 3 || s.sourceSetVersion !== 2 || s.sourcePermissionVersion !== 2 || s.persistedAuthorityVersion !== 3 ||
        A.hash(s.sources.map(v => v.sourceId).sort()) !== A.hash(P.SOURCE_IDS) || r.controlledLifecycleAudit || s.pendingFence ||
        s.globalSuspend.suspended || s.sources.some(v => v.suspended) ||
        P.PERMISSIONS.entries.find(v => v.sourceId === Semantic.SOURCE).permission !== "not_approved")
        throw Error("controlled_safety_unavailable");
      L.assertCapacity(r);
      return A.freeze({ eligible: true, reason: null, phase: "idle", record: r, sequence: s.sequence, writes: 0,
        writeAllowed: false, executionAllowed: false, retryAllowed: false });
    } catch (e) { return A.freeze({ eligible: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "controlled_preflight_failed",
      record: loaded.record, writes: 0, writeAllowed: false, executionAllowed: false, retryAllowed: false }); }
  }
  function createControlledAuthorization(preparation, ...args) {
    if (args.length || issued || closed) throw Error("controlled_attempt_already_issued"); issued = true;
    const before = preflight(); if (!before.eligible) throw Error(before.reason);
    current = before.record;
    return scoped(() => {
      io = SafetyIO.createBoundStore(root, { crashAt }); current = io.begin(current);
      const token = Auth.createControlledAuthorization({ record: current, preparation,
        sourceId: Semantic.SOURCE, operation: Semantic.OPERATION });
      audit.authorizations++; io.point("after_authorization"); return token;
    });
  }
  function createPreparedFence(authorization, preparation, ...args) {
    if (args.length || !io || closed) throw Error("controlled_adapter_unavailable");
    return scoped(() => {
      io.checkOwned(); const context = Auth.consume(authorization, { record: current, preparation,
        sourceId: Semantic.SOURCE, operation: Semantic.OPERATION });
      current = io.createPreparedFence(context.binding);
      const token = Object.freeze({}); attempts.set(token, { ...context, phase: "prepared", readback: null }); return token;
    });
  }
  function get(token, phase) { const h = attempts.get(token);
    if (closed || !h || h.phase !== phase) throw Error("controlled_handle_invalid"); io.checkOwned(); return h; }
  function common(h) { return Object.fromEntries([...OBSERVATION_KEYS, "counts"].map(k => [k, h.binding[k]])); }
  function observation(h, receipt, extra) {
    if (!A.exact(receipt, [...OBSERVATION_KEYS, ...extra]) || OBSERVATION_KEYS.some(k => receipt[k] !== h.binding[k]))
      throw Error("controlled_observation_binding_invalid");
  }
  function markWriteStarted(token, ...args) {
    if (args.length) throw Error("controlled_adapter_unavailable");
    return scoped(() => { const h = get(token, "prepared"); h.phase = "unsafe_started";
      current = io.markWriteStarted(h.binding); h.phase = "formal_write_started";
      // Release the already-prepared one-use context only after the durable fence.
      // The adapter itself never calls executePrepared or opens an IndexedDB.
      return Object.freeze({ execution: h.execution, binding: h.binding }); });
  }
  function markCommitObserved(token, receipt, ...args) {
    if (args.length) throw Error("controlled_adapter_unavailable");
    return scoped(() => { const h = get(token, "formal_write_started"); h.phase = "unsafe_commit";
      observation(h, receipt, ["result", "metrics"]);
      const expected = Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f, f === "runs" || f === "cursors" ? 1 : 16]));
      if (!A.exact(receipt.result, ["committed", "counts"]) || receipt.result.committed !== true ||
        A.hash(receipt.result.counts) !== A.hash(expected) ||
        !A.exact(receipt.metrics, ["readwriteTransactions", "committedTransactions", "abortedTransactions"]) ||
        receipt.metrics.readwriteTransactions !== 1 || receipt.metrics.committedTransactions !== 1 || receipt.metrics.abortedTransactions !== 0)
        throw Error("controlled_commit_ambiguous_or_mismatch");
      const proof = { ...common(h), ...receipt.metrics };
      current = io.markCommitObserved(h.binding, proof); h.phase = "commit_observed"; return current; });
  }
  function markReadbackVerified(token, receipt, ...args) {
    if (args.length) throw Error("controlled_adapter_unavailable");
    return scoped(() => { const h = get(token, "commit_observed"); h.phase = "unsafe_readback";
      observation(h, receipt, ["freshReadonlyReopen", "snapshot"]);
      if (receipt.freshReadonlyReopen !== true) throw Error("controlled_fresh_readback_required");
      const snapshot = structuredClone(receipt.snapshot), identity = A.hash(Core.sorted(snapshot));
      if (identity !== h.binding.expectedFormalIdentity) throw Error("controlled_readback_mismatch");
      const cycle = Cycle.create(snapshot, Schema.EXPECTED_FINGERPRINT); Cycle.close(cycle);
      const before = Core.sorted(h.data.before), after = Core.sorted(snapshot);
      if (Core.STORE_ORDER.some(([f]) => A.hash(before[f].filter(r => r.sourceId !== Semantic.SOURCE)) !==
        A.hash(after[f].filter(r => r.sourceId !== Semantic.SOURCE)))) throw Error("controlled_cross_source_mutation");
      h.readback = { ...common(h), freshReadonlyReopen: true, integrity: true, otherSourcesUnchanged: true,
        expectedFormalIdentity: h.binding.expectedFormalIdentity, actualFormalIdentity: identity };
      current = io.markReadbackVerified(h.binding, h.readback); h.phase = "readback_verified"; return current; });
  }
  function completeAttempt(token, ...args) {
    if (args.length) throw Error("controlled_adapter_unavailable");
    return scoped(() => { const h = get(token, "readback_verified"); h.phase = "unsafe_completion";
      current = io.completeAttempt(h.binding, h.readback); h.phase = "completed";
      const reloaded = reader.load();
      if (reloaded.status !== "valid" || reloaded.record.checksum !== current.checksum || reloaded.safety.pendingFence)
        throw Error("controlled_completion_reload_failed"); return reloaded; });
  }
  function close() { if (io) scoped(() => io.close()); closed = true; }
  return Object.freeze({ load, preflight, createControlledAuthorization, createPreparedFence, markWriteStarted, markCommitObserved,
    markReadbackVerified, completeAttempt, close, audit: () => A.freeze({ ...audit, touches: structuredClone(audit.touches), reader: reader.audit(), safety: io?.audit() || null }) });
}
function createProductionAdapter(...args) {
  mainOnly(); if (args.length) throw Error("production_path_override_rejected");
  return build(Profile.resolveProductionProfile(), null);
}
function createIsolatedAdapter(options) {
  mainOnly();
  if (!A.exact(options, ["targetEnvironment", "fixtureRoot", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
    options.crashAt !== null && !SafetyIO.CRASH_POINTS.includes(options.crashAt)) throw Error("isolated_controlled_adapter_invalid");
  const p = BaseGuard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot: options.fixtureRoot });
  return build(p.profile, options.crashAt);
}
module.exports = Object.freeze({ createProductionAdapter, createIsolatedAdapter, CRASH_POINTS: SafetyIO.CRASH_POINTS });
