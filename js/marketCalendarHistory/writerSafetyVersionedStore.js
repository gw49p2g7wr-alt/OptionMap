"use strict";

// E4f-0 ONLY: no production factory, provision API, writer, network or runtime wiring.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("./formalWriterAuthorityV2.js"), Auth = require("./formalWriterAuthorizationV2.js");
const Legacy = require("./writerSafetyFileSchema.js"), Atomic = require("./writerSafetyAtomicFile.js");
const E = require("./writerSafetyVersionedEnvelope.js");
const same = (a, b) => A.hash(a) === A.hash(b);
const fail = reason => { throw Error(reason); };
function createIsolatedStore(options) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) fail("main_side_only");
  if (!A.exact(options, ["targetEnvironment", "userData", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
    options.crashAt !== null && !Atomic.CRASH_POINTS.includes(options.crashAt)) fail("isolated_envelope_store_invalid");
  const root = fs.realpathSync(options.userData);
  if (root !== options.userData || fs.lstatSync(root).isSymbolicLink() || path.dirname(root) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(root).startsWith("optionmap-writer-safety-")) fail("isolated_store_path_invalid");
  const io = Atomic.create(path.join(root, Atomic.DIRECTORY), { crashAt: options.crashAt });
  let closed = false, busy = false, highWater = -1;
  const tickets = new WeakMap(), receipts = new WeakMap(), audit = { loads: 0, persists: 0, writerExecution: 0 };
  function read() {
    if (closed) fail("safety_store_closed");
    const record = Legacy.parse(io.read("state", Legacy.MAX_BYTES)), checked = E.validateEnvelope(record);
    if (!checked.valid) fail(checked.reason);
    const c = Legacy.parse(io.read("checkpoint", 1024));
    if (!A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== record.schemaVersion ||
      c.sequence !== record.safety.sequence || c.sequence < highWater || c.stateChecksum !== record.checksum ||
      !same(c, Legacy.seal(c))) fail("safety_sequence_replay_or_checkpoint_invalid");
    highWater = c.sequence; return record;
  }
  function load() {
    audit.loads++;
    try {
      const record = read();
      if (io.lockVisibleToOther() || io.exists("intent")) fail("safety_io_interrupted_or_owned");
      return A.freeze({ available: true, kind: record.schemaVersion === 1 ? "legacy" : "versioned", record,
        reason: record.schemaVersion === 1 ? "explicit_migration_required" : record.safety.pendingFence ?
          "interrupted_pending_fence" : record.safety.globalSuspend.suspended ? record.safety.globalSuspend.reason : "isolated_contract_only",
        writerStopped: true, writeAllowed: false, executionAllowed: false });
    } catch (e) { return A.freeze({ available: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed",
      writerStopped: true, writeAllowed: false, executionAllowed: false, record: null }); }
  }
  function current(expectedSequence) {
    if (!A.integer(expectedSequence)) fail("safety_expected_sequence_invalid");
    io.acquire(); const record = read();
    if (record.safety.sequence !== expectedSequence) fail("safety_sequence_stale");
    return record;
  }
  function persist(record) {
    const checked = E.validateEnvelope(record); if (!checked.valid) fail(checked.reason);
    if (Buffer.byteLength(JSON.stringify(record)) > Legacy.MAX_BYTES) fail("safety_file_size_invalid");
    io.replace(record, Legacy.seal({ schemaVersion: record.schemaVersion, sequence: record.safety.sequence, stateChecksum: record.checksum }));
    const after = read(); if (after.checksum !== record.checksum) fail("safety_durable_readback_mismatch");
    audit.persists++;
    return { saved: true, durable: true, reason: null, record: after, sequence: after.safety.sequence,
      writeAllowed: false, executionAllowed: false };
  }
  async function exclusive(action) {
    if (closed || busy) return A.freeze({ saved: false, reason: closed ? "safety_store_closed" : "safety_update_concurrent", executionAllowed: false });
    busy = true;
    try { await Promise.resolve(); return A.freeze(action()); }
    catch (e) { return A.freeze({ saved: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_persist_failed",
      executionAllowed: false, writerStopped: true, globalSuspendCandidate: ["commit_ambiguous", "envelope_receipt_invalid"].includes(e.message) }); }
    finally { busy = false; }
  }
  function migrateLegacy(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "gateIdentity"])) fail("envelope_migration_input_invalid");
      const record = current(input.expectedSequence);
      if (record.schemaVersion !== 1) fail("explicit_legacy_required");
      return persist(E.migrate(record, input.gateIdentity));
    });
  }
  function transitionAuthority(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "expectedAuthorityVersion", "nextAuthorityVersion", "approvedSourceCeiling",
        "suspendedSourceSet", "reasonCode", "gateIdentity"]) || input.reasonCode !== "machinery_startup_canary_gate") fail("envelope_transition_input_invalid");
      const record = current(input.expectedSequence);
      return persist(E.append(record, { type: "authority_transition", expectedAuthorityVersion: input.expectedAuthorityVersion,
        nextAuthorityVersion: input.nextAuthorityVersion, approvedSourceCeiling: input.approvedSourceCeiling,
        suspendedSourceSet: input.suspendedSourceSet }, input.gateIdentity));
    });
  }
  function candidateInput(record, input) {
    if (record.schemaVersion !== 2 || !input || input.sourceId !== E.SOURCE || input.operation !== "startup" ||
      input.policy !== E.policyFor(record.safety.persistedAuthorityVersion) ||
      !same(input.safety, E.safetyInput(record.safety)) || !same(input.mutationCeiling, E.COUNTS)) fail("envelope_authorization_stale_or_invalid");
    return input;
  }
  function createPendingFence(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "authorization", "authorizationInput", "gateIdentity"])) fail("envelope_fence_input_invalid");
      const record = current(input.expectedSequence), fresh = candidateInput(record, input.authorizationInput);
      const consumed = Auth.consumeAuthorizationCandidate(input.authorization, fresh);
      if (!consumed.valid) fail("envelope_authorization_stale_or_invalid");
      const after = E.append(record, { type: "fence_created", binding: consumed.binding }, input.gateIdentity);
      const saved = persist(after), ticket = Object.freeze(Object.create(null));
      tickets.set(ticket, { fence: after.safety.pendingFence, consumed: false });
      return { ...saved, ticket, authorizationIdentity: consumed.binding.authorizationIdentity };
    });
  }
  function ticketFence(ticket, record) {
    const t = tickets.get(ticket), f = record.safety.pendingFence;
    if (!t || t.consumed || !f || ["attemptIdentity", "cycleIdentity", "sourceId", "authorityVersion", "sourcePermissionVersion",
      "safetySequence", "authorizationIdentity", "operation"].some(k => t.fence[k] !== f[k])) fail("envelope_ticket_invalid");
    return f;
  }
  // Explicit isolated receipt issuer. JSON/booleans supplied to transition APIs are not proof.
  // A future production adapter must derive receipts from actual writer/read-back results;
  // this fixture issuer must never be wired into production.
  function createIsolatedReceipt(input) {
    if (!A.exact(input, ["targetEnvironment", "ticket", "kind", "outcome", "mutationCounts", "freshReadonly", "integrityValid",
      "otherSourcesUnchanged", "expectedIdentity", "observedIdentity"]) || input.targetEnvironment !== "isolated_test" ||
      !["commit", "readback"].includes(input.kind) || !["committed", "ambiguous"].includes(input.outcome)) fail("isolated_receipt_invalid");
    const record = read(), f = ticketFence(input.ticket, record);
    if (f.phase !== (input.kind === "commit" ? "formal_write_started" : "commit_observed")) fail("isolated_receipt_phase_invalid");
    const proof = { kind: input.kind, sourceId: E.SOURCE, attemptIdentity: f.attemptIdentity,
      authorizationIdentity: f.authorizationIdentity, committed: input.outcome === "committed", mutationCounts: structuredClone(input.mutationCounts) };
    if (input.kind === "readback") Object.assign(proof, { freshReadonly: input.freshReadonly, integrityValid: input.integrityValid,
      otherSourcesUnchanged: input.otherSourcesUnchanged, expectedIdentity: input.expectedIdentity, observedIdentity: input.observedIdentity });
    const token = Object.freeze(Object.create(null)); receipts.set(token, { proof: A.freeze(proof), ticket: input.ticket }); return token;
  }
  function proofFor(receipt, ticket) {
    const r = receipts.get(receipt);
    if (!r || r.ticket !== ticket) fail("envelope_receipt_invalid");
    if (!r.proof.committed) fail("commit_ambiguous");
    return r.proof;
  }
  function advancePendingFence(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "ticket", "phase", "receipt", "gateIdentity"])) fail("envelope_fence_input_invalid");
      const record = current(input.expectedSequence), f = ticketFence(input.ticket, record);
      const proof = input.phase === "formal_write_started" && input.receipt === null ? null : proofFor(input.receipt, input.ticket);
      return persist(E.append(record, { type: "fence_advanced", attemptIdentity: f.attemptIdentity,
        authorizationIdentity: f.authorizationIdentity, phase: input.phase, proof }, input.gateIdentity));
    });
  }
  function completePendingFence(input) {
    return exclusive(() => {
      if (!A.exact(input, ["expectedSequence", "ticket", "receipt", "gateIdentity"])) fail("envelope_completion_input_invalid");
      const record = current(input.expectedSequence), f = ticketFence(input.ticket, record), proof = proofFor(input.receipt, input.ticket);
      const last = record.transitionAudit.at(-1);
      if (last.event.type !== "fence_advanced" || last.event.phase !== "readback_verified" || !same(last.event.proof, proof)) fail("envelope_completion_invalid");
      const result = persist(E.append(record, { type: "fence_completed", attemptIdentity: f.attemptIdentity,
        authorizationIdentity: f.authorizationIdentity, proof }, input.gateIdentity));
      tickets.get(input.ticket).consumed = true; return result;
    });
  }
  function close() { if (busy) fail("safety_update_in_progress"); io.close(); closed = true; }
  return Object.freeze({ load, migrateLegacy, transitionAuthority, createPendingFence, advancePendingFence, completePendingFence,
    createIsolatedReceipt, close, audit: () => Object.freeze({ ...audit, ...io.audit(), busy, closed }) });
}
module.exports = Object.freeze({ createIsolatedStore });
