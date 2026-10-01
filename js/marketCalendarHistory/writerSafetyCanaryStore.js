"use strict";

// Fixed production boundary. There is no provisioning, repair or arbitrary state setter.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("./formalWriterAuthorityV2.js"), Auth = require("./formalWriterAuthorizationV2.js");
const E = require("./writerSafetyVersionedEnvelope.js"), Legacy = require("./writerSafetyFileSchema.js");
const Atomic = require("./writerSafetyAtomicCore.js"), Profile = require("./writerSafetyInitialProvisioning.js");
const GATE = A.hash({ phase: "E4f-1R", head: "e765852dcc927d14be32fb3eed4e40ec2bbc6182",
  source: E.SOURCE, operation: "startup", authorityVersion: 3, mutationCounts: E.COUNTS });
const same = (a, b) => A.hash(a) === A.hash(b);
function build(root) {
  const io = Atomic.create(path.join(root, Atomic.DIRECTORY));
  let closed = false, busy = false, highWater = -1, attempted = false, reachedExecution = null;
  const states = [];
  function read() {
    if (closed) throw Error("safety_store_closed");
    const record = Legacy.parse(io.read("state", Legacy.MAX_BYTES)), check = E.validateEnvelope(record);
    if (!check.valid) throw Error(check.reason);
    const c = Legacy.parse(io.read("checkpoint", 1024));
    if (!A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== record.schemaVersion ||
        c.sequence !== record.safety.sequence || c.sequence < highWater || c.stateChecksum !== record.checksum || !same(c, Legacy.seal(c)))
      throw Error("safety_sequence_invalid");
    if (io.lockVisibleToOther() || io.exists("intent")) throw Error("safety_io_interrupted_or_owned");
    highWater = c.sequence; return record;
  }
  function load() {
    const start = performance.now();
    try { const record = read(); return { available: true, record,
      contentHash: require("node:crypto").createHash("sha256").update(io.read("state", Legacy.MAX_BYTES)).digest("hex"),
      latencyMs: performance.now() - start, writeAllowed: false }; }
    catch (e) { return { available: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed", writeAllowed: false }; }
  }
  function healthy(record) {
    if (record.safety.pendingFence || record.safety.globalSuspend.suspended || record.safety.sources.some(s => s.suspended))
      throw Error("safety_not_ready");
  }
  function current(sequence) {
    if (!A.integer(sequence)) throw Error("safety_sequence_invalid");
    io.acquire(); const record = read();
    if (record.safety.sequence !== sequence) throw Error("safety_sequence_stale"); return record;
  }
  function persist(record, stage) {
    const start = performance.now();
    if (!E.validateEnvelope(record).valid || Buffer.byteLength(JSON.stringify(record)) > Legacy.MAX_BYTES) throw Error("envelope_invalid");
    io.replace(record, Legacy.seal({ schemaVersion: record.schemaVersion, sequence: record.safety.sequence, stateChecksum: record.checksum }));
    const after = read(); if (after.checksum !== record.checksum) throw Error("safety_durable_readback_mismatch");
    states.push({ stage, sequence: after.safety.sequence, authorityVersion: after.safety.persistedAuthorityVersion,
      contentHash: require("node:crypto").createHash("sha256").update(io.read("state", Legacy.MAX_BYTES)).digest("hex"),
      checksum: after.checksum, persistMs: performance.now() - start, pending: after.safety.pendingFence?.phase || null });
    return after;
  }
  async function exclusive(action) {
    if (closed || busy) return { saved: false, reason: closed ? "safety_store_closed" : "safety_update_concurrent" };
    busy = true;
    try { return await action(); }
    catch (e) { return { saved: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "canary_failed",
      writerStopped: true, pendingPreserved: true, result: reachedExecution }; }
    finally { busy = false; }
  }
  function migrate(expectedSequence) { return exclusive(() => {
    const record = current(expectedSequence); healthy(record);
    if (record.schemaVersion !== 1 || record.safety.persistedAuthorityVersion !== 2) throw Error("valid_legacy_required");
    const after = persist(E.migrate(record, GATE), "migration");
    return { saved: true, record: after, writeAllowed: false };
  }); }
  function transition(expectedSequence) { return exclusive(() => {
    const record = current(expectedSequence); healthy(record);
    if (record.schemaVersion !== 2 || record.safety.persistedAuthorityVersion !== 2) throw Error("previous_authority_invalid");
    const after = persist(E.append(record, { type: "authority_transition", expectedAuthorityVersion: 2,
      nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE], suspendedSourceSet: [] }, GATE), "authority_transition");
    return { saved: true, record: after, writeAllowed: false };
  }); }
  // The callback is NOT a production API: execution is a private opaque capability
  // issued by the fixed startup adapter and consumed below, never caller JSON.
  function execute(capability) { return exclusive(async () => {
    if (attempted) throw Error("canary_attempt_consumed"); attempted = true;
    const Canary = require("../marketCalendarRuntime/machineryStartupCanary.js");
    const execution = Canary.consumeExecution(capability);
    if (!execution) throw Error("trusted_startup_required");
    let record = current(execution.input.safety.sequence); healthy(record);
    if (record.schemaVersion !== 2 || record.safety.persistedAuthorityVersion !== 3 ||
      !same(E.safetyInput(record.safety), execution.input.safety)) throw Error("authorization_stale");
    const auth = Auth.consumeAuthorizationCandidate(execution.authorization, execution.input);
    if (!auth.valid) throw Error("authorization_stale");
    record = persist(E.append(record, { type: "fence_created", binding: auth.binding }, GATE), "pending_prepared");
    const f = record.safety.pendingFence;
    const advance = (phase, proof) => {
      record = persist(E.append(record, { type: "fence_advanced", attemptIdentity: f.attemptIdentity,
        authorizationIdentity: f.authorizationIdentity, phase, proof }, GATE), phase);
    };
    advance("formal_write_started", null);
    const result = await execution.run(); reachedExecution = result; // Actual fixed native core + fresh close/reopen read-back.
    const counts = { entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 };
    if (result.committed !== true || result.audit?.readwrite !== 1 || result.audit?.committed !== 1 || result.audit?.aborted !== 0 ||
      !same(result.audit.committedWrites, counts)) throw Error(result.reason || "commit_ambiguous");
    const commit = { kind: "commit", sourceId: E.SOURCE, attemptIdentity: f.attemptIdentity,
      authorizationIdentity: f.authorizationIdentity, committed: true, mutationCounts: E.COUNTS };
    advance("commit_observed", commit);
    if (result.status !== "verified" || result.verification?.valid !== true || result.audit?.readbackReopens !== 1 ||
      result.verification.expectedIdentity !== result.verification.observedIdentity) throw Error("readback_incomplete");
    const proof = { ...commit, kind: "readback", freshReadonly: true, integrityValid: true,
      otherSourcesUnchanged: true, expectedIdentity: result.verification.expectedIdentity, observedIdentity: result.verification.observedIdentity };
    advance("readback_verified", proof);
    record = persist(E.append(record, { type: "fence_completed", attemptIdentity: f.attemptIdentity,
      authorizationIdentity: f.authorizationIdentity, proof }, GATE), "completion");
    return { saved: true, result, finalSequence: record.safety.sequence, pendingCleared: record.safety.pendingFence === null };
  }); }
  function close() { if (busy) throw Error("safety_update_in_progress"); io.close(); closed = true; }
  return Object.freeze({ load, migrate, transition, execute, close, audit: () => ({ ...io.audit(), states: structuredClone(states), attempted, busy, closed }) });
}
function createProductionStore() { return build(Profile.resolveProductionProfile()); }
function createIsolatedStore(root) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (root !== fs.realpathSync(root) || path.dirname(root) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(root).startsWith("optionmap-writer-safety-")) throw Error("isolated_profile_invalid");
  return build(root);
}
module.exports = Object.freeze({ GATE, createProductionStore, createIsolatedStore });
