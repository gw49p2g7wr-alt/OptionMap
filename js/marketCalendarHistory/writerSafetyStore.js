"use strict";

// E4e-2b: isolated factory only. No production factory or runtime importer yet.
// Future main-side location is <app.getPath("userData")>/<RELATIVE_STATE_PATH>.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("./formalWriterAuthorityV2.js"), Safety = require("./formalWriterSafetyEvaluator.js");
const Schema = require("./writerSafetyFileSchema.js"), Atomic = require("./writerSafetyAtomicFile.js");
const DIRECTORY = Atomic.DIRECTORY, RELATIVE_STATE_PATH = `${DIRECTORY}/${Atomic.NAMES.state}`;
function createIsolatedStore(options) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (!A.exact(options, ["targetEnvironment", "userData", "policy", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
      !A.validatePolicy(options.policy).valid || options.policy.global.state !== "disabled" ||
      options.crashAt !== null && !Atomic.CRASH_POINTS.includes(options.crashAt)) throw Error("isolated_store_invalid");
  const tmp = fs.realpathSync(os.tmpdir()), root = fs.realpathSync(options.userData);
  if (path.dirname(root) !== tmp || !path.basename(root).startsWith("optionmap-writer-safety-") ||
      fs.lstatSync(options.userData).isSymbolicLink()) throw Error("isolated_store_path_invalid");
  const policy = options.policy, io = Atomic.create(path.join(root, DIRECTORY), { crashAt: options.crashAt });
  let busy = false, closed = false, highWater = -1;
  const metrics = { loads: 0, persists: 0, loadMs: 0, persistMs: 0 };
  const blocked = reason => A.freeze({ available: false, writerStopped: true, effectiveState: "suspended",
    writeAllowed: false, executionAllowed: false, reason, safety: null, record: null });
  function readRecord() {
    const record = Schema.parse(io.read("state", Schema.MAX_BYTES));
    const valid = Schema.validate(record, policy); if (!valid.valid) throw Error(valid.reason);
    const checkpoint = Schema.parse(io.read("checkpoint", 1024));
    if (!A.exact(checkpoint, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || checkpoint.schemaVersion !== 1 ||
        !A.integer(checkpoint.sequence) || checkpoint.sequence !== record.safety.sequence ||
        checkpoint.stateChecksum !== record.checksum || Schema.seal(checkpoint).checksum !== checkpoint.checksum ||
        checkpoint.sequence < highWater) throw Error("safety_sequence_replay_or_checkpoint_invalid");
    highWater = checkpoint.sequence; return record;
  }
  function load() {
    const start = performance.now(); metrics.loads++;
    try {
      if (closed) return blocked("safety_store_closed");
      const record = readRecord();
      if (io.lockVisibleToOther() || io.exists("intent")) return blocked("safety_io_interrupted_or_owned");
      const reason = record.safety.pendingFence ? "interrupted_pending_fence" : record.safety.globalSuspend.suspended ?
        record.safety.globalSuspend.reason : "writer_disabled";
      return A.freeze({ available: true, writerStopped: true,
        effectiveState: record.safety.pendingFence || record.safety.globalSuspend.suspended ? "suspended" : "disabled",
        writeAllowed: false, executionAllowed: false, reason, safety: record.safety, record });
    } catch (e) { return blocked(e.code === "ENOENT" ? "safety_state_missing" :
      e.message && /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed"); }
    finally { metrics.loadMs += performance.now() - start; }
  }
  async function exclusive(action) {
    if (closed || busy) return A.freeze({ saved: false, reason: closed ? "safety_store_closed" : "safety_update_concurrent", executionAllowed: false });
    busy = true; const start = performance.now();
    try { await Promise.resolve(); return action(); }
    catch (e) { return A.freeze({ saved: false, reason: e.message && /^[a-z_]+$/.test(e.message) ? e.message : "safety_persist_failed",
      executionAllowed: false }); }
    finally { busy = false; metrics.persistMs += performance.now() - start; }
  }
  function save(record) {
    const valid = Schema.validate(record, policy); if (!valid.valid) throw Error(valid.reason);
    const checkpoint = Schema.seal({ schemaVersion: 1, sequence: record.safety.sequence, stateChecksum: record.checksum });
    io.replace(record, checkpoint);
    const persisted = readRecord(); if (persisted.checksum !== record.checksum) throw Error("safety_durable_readback_mismatch");
    metrics.persists++;
    return A.freeze({ saved: true, reason: null, safety: persisted.safety, sequence: persisted.safety.sequence,
      durable: true, executionAllowed: false });
  }
  function provisionDisabled() {
    return exclusive(() => {
      io.acquire({ provision: true });
      if (["state", "checkpoint", "temp", "checkpointTemp"].some(io.exists)) throw Error("safety_provision_requires_empty_store");
      return save(Schema.build(null, Safety.createMemorySafety(policy), null, "provision_disabled", policy));
    });
  }
  function current(expectedSequence) {
    if (!A.integer(expectedSequence)) throw Error("safety_expected_sequence_invalid");
    io.acquire(); const record = readRecord();
    if (record.safety.sequence !== expectedSequence) throw Error("safety_sequence_stale");
    return record;
  }
  function persistTransition(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "signal"])) throw Error("safety_transition_input_invalid");
      const record = current(input.expectedSequence);
      const reduced = Safety.reduceSafetySignal({ policy, state: record.safety, signal: input.signal });
      if (!reduced.valid) throw Error(reduced.reason);
      if (reduced.state === record.safety) return A.freeze({ saved: false, unchanged: true, reason: reduced.reason,
        safety: record.safety, sequence: record.safety.sequence, executionAllowed: false });
      return save(Schema.build(record, reduced.state, record.fenceDetails, input.signal.reason || "evaluated_success", policy));
    });
  }
  function persistPendingFence(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "sourceId", "attemptIdentity", "cycleIdentity", "operation", "phase"]) ||
          input.operation !== "startup" || !A.isHash(input.attemptIdentity) || !A.isHash(input.cycleIdentity) ||
          !Schema.PHASES.includes(input.phase) || !policy.global.permittedSources.includes(input.sourceId) ||
          policy.permissions.entries.find(e => e.sourceId === input.sourceId)?.permission !== "approved") throw Error("safety_fence_input_invalid");
      const record = current(input.expectedSequence), old = record.safety.pendingFence;
      if (!old && (record.safety.globalSuspend.suspended || record.safety.sources.find(s => s.sourceId === input.sourceId).suspended))
        throw Error("writer_suspended");
      if (!old ? input.phase !== "prepared" : ["sourceId", "attemptIdentity", "cycleIdentity"].some(k => old[k] !== input[k]) ||
          Schema.PHASES.indexOf(input.phase) !== Schema.PHASES.indexOf(old.phase) + 1) throw Error("safety_fence_transition_invalid");
      const material = structuredClone(record.safety); material.sequence++;
      material.pendingFence = Object.fromEntries(["sourceId", "attemptIdentity", "cycleIdentity", "phase"].map(k => [k, input[k]]));
      const details = { ...material.pendingFence, authorityVersion: policy.global.authorityVersion,
        sourcePermissionVersion: policy.permissions.permissionVersion, safetySequence: material.sequence, operation: "startup" };
      return save(Schema.build(record, Safety.sealSafetyMaterial(material), details, `pending_${input.phase}`, policy));
    });
  }
  function close() { if (busy) throw Error("safety_update_in_progress"); io.close(); closed = true; }
  return Object.freeze({ load, provisionDisabled, persistTransition, persistCounterUpdate: persistTransition,
    persistPendingFence, close, audit: () => Object.freeze({ ...metrics, ...io.audit(), busy, closed }) });
}
module.exports = Object.freeze({ RELATIVE_STATE_PATH, createIsolatedStore });
