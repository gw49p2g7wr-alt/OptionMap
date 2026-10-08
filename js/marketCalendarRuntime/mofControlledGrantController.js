"use strict";

// Main-owned one-attempt controller. No ordinary main/preload integration. The
// only transmitted authority decision is a sender/document-bound, consumed ACK;
// opaque main authorization and renderer execution tokens never cross contexts.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../marketCalendarHistory/mofControlledSemanticPlan.js");
const Adapter = require("../marketCalendarHistory/mofControlledSafetyProductionAdapter.js");
const Core = require("../marketCalendarHistory/formalControlledWriterCore.js"), Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const B = require("../marketCalendarHistory/bootstrapSchemaV1.js"), Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Executor = require("../marketCalendarHistory/firstProductionWriteExecutor.js"), Renderer = require("./mofHiddenRendererExecutor.js");
const Reader = require("./formalShadowElectronRead.js"), Cycle = require("./formalShadowCycle.js"), Windows = require("./mofHiddenRendererWindow.js");
const CHANNELS = Object.freeze(["optionmap:mof-controlled:challenge", "optionmap:mof-controlled:consume", "optionmap:mof-controlled:receipt"]);
const FAULTS = Object.freeze(["before_window", "before_load", "after_load", "after_challenge", "consume_before_started", "started_before_permit",
  "permit_lost", "after_permit", "after_token", "during_tx", "commit_ambiguous", "commit_before_readback", "readback_before_completion",
  "wrong_challenge", "wrong_sender", "wrong_frame", "reload", "navigation", "process_replacement", "network", "replay_challenge", "replay_consume", "second_tx"]);
const PACKET = ["attemptIdentity", "invitationIdentity", "nonce", "rendererChallenge", "materialIdentity"];
const RECEIPT = ["schemaVersion", "sourceId", "operation", "attemptIdentity", "consumeIdentity", "status", "reason", "localToken",
  "transactions", "counts", "preIdentity", "postIdentity", "readbackIdentity", "integrity", "snapshot", "audit"];
function mainOnly() { if (process.type !== "browser" || !process.versions.electron) throw Error("native_main_required"); }
function program(data, invitation, fault) {
  const source = fs.readFileSync(require.resolve("../marketCalendarHistory/formalControlledWriterCore.js"), "utf8");
  return `(async()=>{const Schema=${JSON.stringify({ DATABASE_NAME: Schema.DATABASE_NAME, STORES: Schema.STORES, EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT })};
    const stable=(${Canonical.stable.toString()}), module={exports:{}}, dependencies={"./productionSchemaV1.js":Schema,
      "./bootstrapSchemaV1.js":{STORE_ORDER:${JSON.stringify(Core.STORE_ORDER)}},"../marketCalendar/marketEventCanonicalizer.js":{stable}};
    ((module,require)=>{${source}\n})(module,key=>{if(!Object.hasOwn(dependencies,key))throw Error("native_core_dependency_rejected");return dependencies[key]});
    return (${Renderer.runRenderer.toString()})(${JSON.stringify(data)},${JSON.stringify(invitation)},module.exports,
      (${Executor.machineryCanaryExecutionSource}),Schema,(${B.inspect.toString()}),(${Schema.fingerprint.toString()}),
      stable,${JSON.stringify(S.COUNTS)},${JSON.stringify(fault)});})()`;
}
function validateReceipt(receipt, invitation, consumeIdentity, data) {
  if (!A.exact(receipt, RECEIPT) || receipt.schemaVersion !== 1 || receipt.sourceId !== S.SOURCE || receipt.operation !== S.OPERATION ||
    receipt.attemptIdentity !== data.attemptIdentity || receipt.consumeIdentity !== consumeIdentity || receipt.status !== "verified" || receipt.reason !== null ||
    !A.exact(receipt.localToken, ["minted", "writerCalls", "success"]) || receipt.localToken.minted !== 1 || receipt.localToken.writerCalls !== 1 || receipt.localToken.success !== true ||
    !A.exact(receipt.transactions, ["readwrite", "commit", "abort"]) || receipt.transactions.readwrite !== 1 || receipt.transactions.commit !== 1 || receipt.transactions.abort !== 0 ||
    A.hash(receipt.counts) !== A.hash(S.COUNTS) || receipt.preIdentity !== A.hash(Core.sorted(data.before)) ||
    receipt.postIdentity !== invitation.binding.expectedFormalIdentity || receipt.readbackIdentity !== receipt.postIdentity || receipt.integrity !== true ||
    !A.exact(receipt.audit, ["create", "upgrade", "deletes", "network", "handles", "readbackReopens"]) ||
    ["create", "upgrade", "deletes", "network", "handles"].some(k => receipt.audit[k] !== 0) || receipt.audit.readbackReopens !== 1)
    throw Error("native_receipt_invalid");
  const sorted = Core.sorted(receipt.snapshot);
  if (A.hash(sorted) !== receipt.postIdentity || A.hash(sorted) !== A.hash(Core.sorted(data.expected))) throw Error("native_receipt_snapshot_mismatch");
  const cycle = Cycle.create(sorted, Schema.EXPECTED_FINGERPRINT); Cycle.close(cycle);
}
function build({ preparation, adapter, createWindow, fault = null }) {
  mainOnly(); const data = S.inspectNativeMaterial(preparation); let window = null, collector = null, invitation = null, receipt = null;
  let attempt = null, started = false, phase = "idle", challengeIdentity = null, rendererChallenge = null, consumeIdentity = null, registeredFrame = null;
  let handlers = 0, registry = 0, invalid = false;
  // Electron overrides process.exit too. Only isolated fault selection can reach
  // this hard process crash; it cannot return and advance a durable phase.
  const phases = [], windowAudits = [], point = name => { if (fault === name) {
    process.kill(process.pid, "SIGKILL"); throw Error("isolated_crash_did_not_terminate");
  } };
  const observe = () => { const loaded = adapter.load(); if (loaded.status !== "valid") throw Error(loaded.reason);
    phases.push({ sequence: loaded.safety.sequence, generation: loaded.generation, checksum: loaded.record.checksum,
      phase: loaded.safety.pendingFence?.phase || "completed" }); return loaded; };
  function sender(event) { if (invalid || !window?.valid(event) || Windows.artifactIdentity() !== invitation.executorArtifactIdentity)
    throw Error("native_sender_document_invalid"); }
  function checkPacket(packet, keys) {
    if (!A.exact(packet, keys) || packet.attemptIdentity !== data.attemptIdentity || packet.invitationIdentity !== invitation.identity ||
      packet.nonce !== invitation.nonce || packet.materialIdentity !== invitation.materialIdentity || typeof packet.rendererChallenge !== "string" ||
      !/^[a-f0-9-]{36}$/.test(packet.rendererChallenge)) throw Error("native_challenge_invalid");
  }
  function freshPrepared() {
    const loaded = adapter.load();
    if (loaded.status !== "valid" || loaded.generation !== invitation.preparedGeneration || loaded.record.checksum !== invitation.preparedChecksum ||
      loaded.safety.sequence !== invitation.preparedSequence || loaded.safety.pendingFence?.phase !== "prepared" ||
      A.hash(loaded.safety.pendingFence.binding) !== A.hash(invitation.binding)) throw Error("native_safety_binding_stale");
    return loaded;
  }
  async function challenge(event, packet) {
    sender(event); if (phase !== "invited") throw Error("native_challenge_replayed");
    phase = "challenge_spent"; checkPacket(packet, PACKET); freshPrepared(); rendererChallenge = packet.rendererChallenge;
    challengeIdentity = A.hash({ invitation: invitation.identity, rendererChallenge, mainChallenge: randomUUID() });
    phase = "challenged"; return { challengeIdentity };
  }
  async function consume(event, packet) {
    sender(event); if (phase !== "challenged") throw Error("native_consume_replayed"); phase = "consume_locked";
    checkPacket(packet, [...PACKET, "challengeIdentity"]);
    if (packet.challengeIdentity !== challengeIdentity || packet.rendererChallenge !== rendererChallenge) throw Error("native_challenge_invalid");
    freshPrepared();
    point("consume_before_started"); const released = adapter.markWriteStarted(attempt);
    if (released.execution !== null || A.hash(released.binding) !== A.hash(invitation.binding)) throw Error("native_main_token_forbidden");
    const after = observe(); if (after.safety.sequence !== invitation.preparedSequence + 1 || after.safety.pendingFence?.phase !== "formal_write_started")
      throw Error("native_write_started_not_durable");
    phase = "spent"; consumeIdentity = A.hash({ invitation: invitation.identity, challengeIdentity, sequence: after.safety.sequence,
      generation: after.generation, checksum: after.record.checksum }); point("started_before_permit");
    if (fault === "permit_lost") throw Error("fixture_permit_response_lost");
    return { schemaVersion: 1, attemptIdentity: data.attemptIdentity, consumeIdentity, startedSequence: after.safety.sequence,
      startedGeneration: after.generation, startedChecksum: after.record.checksum };
  }
  async function submit(event, value) {
    sender(event); if (phase !== "spent" || receipt) throw Error("native_receipt_replayed"); phase = "receipt_spent";
    validateReceipt(value, invitation, consumeIdentity, data); receipt = A.freeze(structuredClone(value));
    adapter.markCommitObserved(attempt, { sourceId: S.SOURCE, operation: S.OPERATION, attemptIdentity: data.attemptIdentity,
      authorizationIdentity: invitation.binding.authorizationIdentity, planIdentity: data.planIdentity,
      result: { committed: true, counts: Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f, receipt.snapshot[f].length - data.before[f].length])) },
      metrics: { readwriteTransactions: receipt.transactions.readwrite, committedTransactions: receipt.transactions.commit, abortedTransactions: receipt.transactions.abort } });
    observe(); point("commit_before_readback"); phase = "commit_observed"; return { accepted: true };
  }
  async function cleanupWindow() {
    if (registeredFrame) { for (const channel of CHANNELS) {
      try { registeredFrame.ipc.removeHandler(channel); } catch (e) { if (!registeredFrame.detached) throw e; }
    } handlers = 0; registeredFrame = null; }
    if (window) { await window.close(); windowAudits.push(window.audit()); window = null; } registry = 0;
  }
  async function start(...args) {
    if (args.length || started) throw Error("native_attempt_replayed"); started = true;
    try {
      const before = adapter.preflight(); if (!before.eligible) throw Error(before.reason);
      const auth = adapter.createControlledAuthorization(preparation); attempt = adapter.createPreparedFence(auth, preparation);
      const prepared = observe(); point("before_window"); window = await createWindow(fault); point("after_load");
      const binding = prepared.safety.pendingFence.binding;
      const body = { schemaVersion: 1, nonce: randomUUID(), binding, preparedGeneration: prepared.generation,
        preparedChecksum: prepared.record.checksum, preparedSequence: prepared.safety.sequence,
        target: window.target, executorArtifactIdentity: window.artifactIdentity, materialIdentity: A.hash(data) };
      invitation = A.freeze({ ...body, identity: A.hash(body) }); registry = 1; phase = "invited";
      registeredFrame = window.wc.mainFrame;
      for (const [i, fn] of [challenge, consume, submit].entries()) { registeredFrame.ipc.handle(CHANNELS[i], fn); handlers++; }
      if (fault === "reload") { await new Promise(resolve => { window.wc.once("did-finish-load", resolve); window.wc.reload(); }); }
      if (fault === "navigation") { await window.wc.loadURL(Windows.URL + "#replacement"); }
      if (fault === "process_replacement") {
        await new Promise(resolve => { window.wc.once("render-process-gone", resolve); window.wc.forcefullyCrashRenderer(); });
        throw Error("fixture_process_invalidated");
      }
      if (fault === "wrong_frame") {
        if (window.valid({ sender: window.wc, senderFrame: null })) throw Error("fixture_wrong_frame_accepted");
        throw Error("fixture_wrong_frame_rejected");
      }
      if (fault === "network") {
        await window.run("fetch('https://example.invalid/')").catch(() => {}); throw Error("fixture_network_attempt");
      }
      if (fault === "wrong_sender") { const other = await createWindow(null);
        try { await other.run(program(data, invitation, null)); } finally { await other.close(); windowAudits.push(other.audit()); } throw Error("wrong_sender_not_rejected"); }
      await window.run(program(data, invitation, fault));
      if (phase !== "commit_observed" || !receipt) throw Error("native_receipt_missing");
      const priorTarget = window.target; await cleanupWindow();
      collector = await createWindow(null);
      if (collector.target.webContentsId === priorTarget.webContentsId || collector.target.osProcessId === priorTarget.osProcessId)
        throw Error("native_fresh_renderer_required");
      const collected = await Reader.createReader(collector.wc)();
      if (collected.status !== "ok" || collected.audit.readwrite !== 0 || collected.audit.writes !== 0 || collected.audit.handles !== 0 ||
        A.hash(Core.sorted(collected.snapshot)) !== invitation.binding.expectedFormalIdentity) throw Error("native_fresh_readback_failed");
      const cycle = Cycle.create(collected.snapshot, Schema.EXPECTED_FINGERPRINT); Cycle.close(cycle);
      adapter.markReadbackVerified(attempt, { sourceId: S.SOURCE, operation: S.OPERATION, attemptIdentity: data.attemptIdentity,
        authorizationIdentity: binding.authorizationIdentity, planIdentity: data.planIdentity, freshReadonlyReopen: true, snapshot: collected.snapshot });
      observe(); point("readback_before_completion"); const done = adapter.completeAttempt(attempt); observe(); phase = "completed";
      return { status: "PASS", receipt, phases, final: done, freshRenderer: { prior: priorTarget, next: collector.target, audit: collected.audit } };
    } catch (e) { phase = "stopped"; invalid = true; return { status: "FAIL", reason: e.message, receipt, phases, final: adapter.load() }; }
    finally { await cleanupWindow(); if (collector) { await collector.close(); windowAudits.push(collector.audit()); collector = null; } adapter.close(); }
  }
  return Object.freeze({ start, audit: () => ({ handlers, grants: registry, windows: window || collector ? 1 : 0, phase, started,
    mainExecutionTokens: 0, windowAudits: structuredClone(windowAudits), safety: adapter.audit() }) });
}
function createProductionController(preparation, ...args) {
  mainOnly(); if (args.length) throw Error("native_controller_arguments_rejected"); S.inspectNativeMaterial(preparation);
  return build({ preparation, adapter: Adapter.createProductionAdapter(), createWindow: () => Windows.createProductionWindow() });
}
function createIsolatedController({ targetEnvironment, fixtureRoot, preparation, fault = null }) {
  mainOnly(); if (targetEnvironment !== "isolated_test" || fault !== null && !FAULTS.includes(fault)) throw Error("isolated_controller_invalid");
  S.inspectNativeMaterial(preparation);
  return build({ preparation, adapter: Adapter.createIsolatedAdapter({ targetEnvironment, fixtureRoot, crashAt: null }), fault,
    createWindow: value => Windows.createIsolatedWindow({ targetEnvironment, fixtureRoot, crashAt: value === "before_load" ? value : null }) });
}
module.exports = Object.freeze({ CHANNELS, FAULTS, validateReceipt, createProductionController, createIsolatedController });
