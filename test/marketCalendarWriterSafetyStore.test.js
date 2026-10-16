"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"),
  path = require("node:path"), cp = require("node:child_process");
const Store = require("../js/marketCalendarHistory/writerSafetyStore.js"), Atomic = require("../js/marketCalendarHistory/writerSafetyAtomicFile.js"),
  Schema = require("../js/marketCalendarHistory/writerSafetyFileSchema.js"), A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"),
  Safety = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js"), Auth = require("../js/marketCalendarHistory/formalWriterAuthorizationV2.js"),
  H = require("../scripts/marketCalendarE4eSafetyStoreNative.js");
const ID = H.SOURCE;
async function fixture(fn, provision = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-")), store = H.create(root);
  try { if (provision) assert.equal((await store.provisionDisabled()).saved, true); return await fn(store, root); }
  finally { store.close(); assert.equal(store.audit().fileHandles, 0); assert.equal(store.audit().lockHandles, 0);
    fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
const statePath = root => path.join(root, Store.RELATIVE_STATE_PATH);
const record = root => Schema.parse(fs.readFileSync(statePath(root), "utf8"));
const count = s => s.sources.find(r => r.sourceId === ID).counters;
const transition = (s, reason = "network_failure", n = 1, outcome = "failure") => s.persistCounterUpdate({ expectedSequence: s.load().safety.sequence,
  signal: { ...H.signal(reason, n), outcome, reason: outcome === "failure" ? reason : null } });
const fence = (s, phase = "prepared") => s.persistPendingFence({ expectedSequence: s.load().safety.sequence,
  sourceId: ID, attemptIdentity: A.hash({ attempt: 1 }), cycleIdentity: A.hash({ cycle: 1 }), operation: "startup", phase });
function fresh(root, command = "read", crashAt = null, cycle = 1) {
  const r = H.child(command, root, crashAt, cycle); assert.equal(r.code, 0, r.stderr); assert.equal(r.signal, null);
  assert.notEqual(r.output.pid, process.pid); assert.equal(r.output.audit.fileHandles, 0); return r.output;
}
test("P1/P2 explicit disabled provisioning + native fsync/atomic replacement", () => fixture(async (s, root) => {
  assert.equal(s.load().available, true); assert.equal(s.load().safety.sequence, 0);
  assert.equal(A.PRODUCTION_POLICY.global.state, "disabled"); assert.equal(record(root).transitionAudit[0].reasonCode, "provision_disabled");
  assert.ok(s.audit().syncs >= 4);
  if (process.platform === "win32") assert.equal(s.audit().directorySyncs, 0);
  else assert.ok(s.audit().directorySyncs >= 5);
  assert.equal(s.audit().replaces, 2);
  assert.equal((await s.provisionDisabled()).saved, false);
}));
test("P3 missing file load never provisions; no directory/file mutation", () => fixture((s, root) => {
  assert.equal(s.load().reason, "safety_state_missing"); assert.equal(s.load().writeAllowed, false);
  assert.deepEqual(fs.readdirSync(root), []);
}, false));
for (const [name, edit] of [
  ["P4 malformed JSON", () => "{"], ["P5 incompatible envelope version", r => ({ ...r, schemaVersion: 2 })],
  ["P6 missing source", r => { r.safety.sources.pop(); return r; }],
  ["P6 duplicate source", r => { r.safety.sources[0] = r.safety.sources[1]; return r; }],
  ["P6 unknown source", r => { r.safety.sources[0].sourceId = "unknown"; return r; }],
  ["P22 checksum corruption", r => ({ ...r, checksum: "0".repeat(64) })],
  ["extra field", r => ({ ...r, active: true })], ["missing field", r => { delete r.transitionAudit; return r; }],
  ["invalid sequence", r => { r.safety.sequence = -1; return r; }]
]) test(`${name}: fail closed, never rewrite`, () => fixture((s, root) => {
  const value = edit(structuredClone(record(root))), text = typeof value === "string" ? value : JSON.stringify(value);
  fs.writeFileSync(statePath(root), text); const before = fs.readFileSync(statePath(root), "utf8");
  const result = s.load(); assert.equal(result.available, false); assert.equal(result.effectiveState, "suspended");
  assert.equal(fs.readFileSync(statePath(root), "utf8"), before);
}));
test("duplicate JSON keys rejected, including escaped/nested duplicates", () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}'])
    assert.throws(() => Schema.parse(text), /duplicate_key/);
  assert.deepEqual(Schema.parse('{"a":[1,true,null,{"b":"日本語"}]}'), { a: [1, true, null, { b: "日本語" }] });
});
test("P7 atomic replace: valid complete JSON and independent sequence checkpoint", () => fixture(async (s, root) => {
  const r = await transition(s); assert.equal(r.saved, true); assert.equal(r.durable, true); assert.equal(r.sequence, 1);
  assert.equal(Schema.validate(record(root)).valid, true); assert.equal(s.audit().replaces, 4);
  assert.equal(fs.existsSync(path.join(path.dirname(statePath(root)), Atomic.NAMES.intent)), false);
}));
test("P8 partial temp is never accepted as canonical state; never auto-deleted", () => fixture((s, root) => {
  const p = path.join(path.dirname(statePath(root)), Atomic.NAMES.temp); fs.writeFileSync(p, '{"partial":', { mode: 0o600 });
  assert.equal(s.load().safety.sequence, 0); assert.equal(fs.readFileSync(p, "utf8"), '{"partial":');
}));
for (const [label, point] of [["C1/P9 before temp", "before_temp_write"], ["C2 after temp before sync", "after_temp_write"],
  ["C3 after sync before replace", "after_sync"], ["C4/P10 after replace", "after_replace"], ["checkpoint crash", "after_checkpoint"]])
  test(`${label}: real child crash leaves restart blocked, no auto-repair`, () => fixture((s, root) => {
    s.close(); const before = record(root), crashed = H.child("failure", root, point);
    assert.equal(crashed.code, 86); assert.equal(crashed.output, null);
    const result = fresh(root); assert.equal(result.result.available, false); assert.equal(result.result.writeAllowed, false);
    assert.equal(record(root).safety.sequence, ["after_replace", "after_checkpoint"].includes(point) ? 1 : before.safety.sequence);
    assert.ok(fs.existsSync(path.join(path.dirname(statePath(root)), Atomic.NAMES.intent)));
    assert.ok(fs.existsSync(path.join(path.dirname(statePath(root)), Atomic.NAMES.lock)));
  }));
test("P11/P12 durable pending fence survives fresh process restart and blocks writer", () => fixture(async (s, root) => {
  assert.equal((await fence(s)).saved, true); s.close(); const r = fresh(root);
  assert.equal(r.result.reason, "interrupted_pending_fence"); assert.equal(r.result.safety.pendingFence.phase, "prepared");
  assert.equal(r.result.record.fenceDetails.operation, "startup"); assert.equal(r.result.record.fenceDetails.safetySequence, 1);
  assert.equal(Safety.evaluate({ sourceId: ID, safety: r.result.safety }).writeAllowed, false);
}));
test("C5 pending fence durable save then real child crash: fresh process cannot resume", () => fixture((s, root) => {
  s.close(); const crashed = H.child("fence_crash", root); assert.equal(crashed.code, 87);
  const r = fresh(root).result; assert.equal(r.available, false); assert.equal(r.writeAllowed, false);
  assert.equal(record(root).safety.pendingFence.phase, "prepared");
  assert.equal(record(root).fenceDetails.safetySequence, 1);
}));
for (const [label, command, reason] of [["C6/P27 commit ambiguous", "ambiguous", "commit_ambiguous"],
  ["C7/P28 read-back incomplete", "readback", "readback_incomplete"]]) test(`${label}: persistent global stop + fence`, () => fixture((s, root) => {
  s.close(); assert.equal(fresh(root, command).result.saved, true); const r = fresh(root).result;
  assert.equal(r.safety.globalSuspend.suspended, true); assert.equal(r.safety.globalSuspend.reason, reason);
  assert.equal(r.safety.pendingFence.phase, "prepared"); assert.equal(r.writeAllowed, false);
}));
test("P13 global suspend survives independent process restart", () => fixture(async (s, root) => {
  await transition(s, "orphan"); s.close(); const r = fresh(root).result;
  assert.equal(r.safety.globalSuspend.reason, "orphan"); assert.equal(r.safety.globalSuspend.suspended, true);
}));
test("P14 source suspend survives restart; success cannot resume", () => fixture(async (s, root) => {
  await transition(s, "unsupported_changed"); const before = s.load().safety;
  assert.equal((await transition(s, "network_failure", 2, "success")).unchanged, true);
  assert.deepEqual(s.load().safety, before); s.close(); assert.equal(fresh(root).result.safety.sources.find(r => r.sourceId === ID).suspended, true);
}));
test("P15/P16 counter + cycle survive restart; duplicate signal does not write/increment", () => fixture(async (s, root) => {
  await transition(s); s.close(); const next = H.create(root);
  try { assert.equal(count(next.load().safety).acquisition_failure.count, 1);
    const result = await transition(next); assert.equal(result.reason, "duplicate_signal"); assert.equal(next.audit().persists, 0);
    assert.equal(result.safety.sequence, 1); assert.equal(count(result.safety).acquisition_failure.cycleIdentity, H.signal("network_failure").cycleIdentity);
  } finally { next.close(); }
}));
test("P17 only successful matching category resets; P18 skipped cycles unchanged", () => fixture(async s => {
  await transition(s); await transition(s, "stale_precondition");
  for (const outcome of ["skip", "cooldown", "not_evaluated"]) {
    const before = s.load().safety; await transition(s, "network_failure", 2, outcome); assert.deepEqual(s.load().safety, before);
  }
  await transition(s, "network_failure", 2, "success"); assert.equal(count(s.load().safety).acquisition_failure.count, 0);
  assert.equal(count(s.load().safety).stale.count, 1);
}));
test("P19 third evaluated failure persists source suspend across three child processes", () => fixture((s, root) => {
  s.close(); for (let n = 1; n <= 3; n++) assert.equal(fresh(root, "failure", null, n).result.saved, true);
  const r = fresh(root).result.safety; assert.equal(count(r).acquisition_failure.count, 3);
  assert.equal(r.sources.find(s => s.sourceId === ID).suspended, true);
}));
test("P20/P21 monotonic sequence + stale expected sequence reject", () => fixture(async s => {
  await transition(s); const result = await s.persistCounterUpdate({ expectedSequence: 0, signal: H.signal("network_failure", 2) });
  assert.equal(result.reason, "safety_sequence_stale"); assert.equal(s.load().safety.sequence, 1);
  assert.equal((await transition(s, "network_failure", 2)).sequence, 2);
}));
test("state-only older replay detected in fresh process by independent checkpoint", () => fixture(async (s, root) => {
  const old = fs.readFileSync(statePath(root)); await transition(s); fs.writeFileSync(statePath(root), old); s.close();
  assert.equal(fresh(root).result.reason, "safety_sequence_replay_or_checkpoint_invalid");
}));
test("same-process high-water rejects replay of both file and checkpoint", () => fixture(async (s, root) => {
  const checkpointPath = path.join(path.dirname(statePath(root)), Atomic.NAMES.checkpoint);
  const old = fs.readFileSync(statePath(root)), oldCheckpoint = fs.readFileSync(checkpointPath);
  await transition(s); fs.writeFileSync(statePath(root), old); fs.writeFileSync(checkpointPath, oldCheckpoint);
  assert.equal(s.load().reason, "safety_sequence_replay_or_checkpoint_invalid");
}));
test("P23/P24 no authority elevation, arbitrary-object write or BOJ fence", () => fixture(async s => {
  for (const extra of [{ state: "active" }, { permission: "approved" }, { safety: s.load().safety }])
    assert.equal((await s.persistTransition({ expectedSequence: 0, signal: H.signal("network_failure"), ...extra })).saved, false);
  assert.equal(s.write, undefined); assert.equal(s.reset, undefined); assert.equal(s.resume, undefined);
  const r = await s.persistPendingFence({ expectedSequence: 0, sourceId: A.BOJ, attemptIdentity: A.hash({ a: 1 }),
    cycleIdentity: A.hash({ c: 1 }), operation: "startup", phase: "prepared" }); assert.equal(r.saved, false);
  assert.equal(s.load().writeAllowed, false); assert.equal(A.PRODUCTION_POLICY.permissions.entries.find(e => e.sourceId === A.BOJ).permission, "writer_ineligible");
}));
test("P25 persisted sequence update invalidates pre-existing v2 candidate binding", () => fixture(async s => {
  const policy = A.createIsolatedPolicy({ targetEnvironment: "isolated_test" }), cycleIdentity = A.hash({ c: 1 });
  const safety = Safety.createMemorySafety(policy), hash = A.hash({ id: 1 });
  const input = { policy, safety, sourceId: ID, operation: "startup", cycleIdentity,
    context: A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity: hash }),
    acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: hash, expectedRouteIdentity: hash,
    schemaFingerprint: policy.global.schemaFingerprint, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: hash, candidateIdentity: hash,
    comparisonIdentity: hash, formalPrecondition: hash, planIdentity: hash,
    mutationCeiling: { eventEntryCreate: 0, eventEntryUpdate: 4, semanticRevisionCreate: 0, semanticRevisionClose: 0,
      evidenceCreate: 4, observationCreate: 4, sourceRunCreate: 1, sourceCursorUpdate: 1 } };
  const authorization = Auth.issueAuthorizationCandidate(input); assert.equal(authorization.valid, true);
  assert.equal(Auth.validateAuthorizationCandidate(authorization.authorization, input).valid, true);
  await transition(s); const freshSafety = Safety.sealSafetyMaterial({ ...safety, sequence: s.load().safety.sequence });
  assert.equal(Auth.validateAuthorizationCandidate(authorization.authorization, { ...input, safety: freshSafety }).valid, false);
  assert.equal(Auth.validateAuthorizationCandidate(authorization.authorization, { ...input, safety: s.load().safety }).valid, false);
}));
test("P26 second owner + overlapping same-instance update fail closed", () => fixture(async (s, root) => {
  const other = H.create(root);
  try { assert.equal((await other.persistCounterUpdate({ expectedSequence: 0, signal: H.signal("network_failure") })).reason, "safety_ownership_conflict");
    assert.equal(other.load().available, false); const first = transition(s), second = await transition(s, "network_failure", 2);
    assert.equal(second.reason, "safety_update_concurrent"); assert.equal((await first).saved, true);
  } finally { other.close(); }
}));
test("P26 independent live child holds ownership; another process cannot persist", () => fixture(async (s, root) => {
  s.close(); const child = cp.fork(require.resolve("../scripts/marketCalendarE4eSafetyStoreNative.js"),
    ["worker", "hold", root, "none", "1"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
      const onMessage = m => { cleanup(); m.ready ? resolve() : reject(Error("not_ready")); };
      const onExit = () => { cleanup(); reject(Error("child_ended_before_ready")); };
      const onError = e => { cleanup(); reject(e); };
      child.once("message", onMessage); child.once("exit", onExit); child.once("error", onError);
    });
    const competing = H.child("failure", root, null, 2); assert.equal(competing.code, 1); // Cannot even load owned state as usable.
    assert.equal(H.child("read", root).output.result.available, false);
  } finally {
    if (child.connected) child.send("close"); const exit = await ended;
    child.removeAllListeners(); assert.equal(child.connected, false); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  }
}));
test("pending lifecycle is forward-only; never auto-cleared, manual not allowed", () => fixture(async s => {
  assert.equal((await fence(s)).saved, true); assert.equal((await fence(s)).saved, false);
  assert.equal((await fence(s, "transaction_started")).saved, true);
  assert.equal((await fence(s, "committed_unverified")).saved, true);
  assert.equal((await fence(s, "prepared")).saved, false); assert.equal(s.load().safety.pendingFence.phase, "committed_unverified");
}));
test("bounded append-only audit stops at capacity, never trims or resets history", () => fixture(async (s, root) => {
  for (let n = 1; n < Schema.MAX_AUDIT; n++) assert.equal((await transition(s, "network_failure", n, "success")).saved, true);
  const before = fs.readFileSync(statePath(root)); const result = await transition(s, "network_failure", Schema.MAX_AUDIT, "success");
  assert.equal(result.reason, "safety_audit_capacity_reached"); assert.deepEqual(fs.readFileSync(statePath(root)), before);
  assert.equal(record(root).transitionAudit.length, Schema.MAX_AUDIT);
}));
test("suspended source/global cannot begin a new pending attempt", async () => {
  for (const reason of ["orphan", "unsupported_changed"]) await fixture(async s => {
    await transition(s, reason); assert.equal((await fence(s)).reason, "writer_suspended");
    assert.equal(s.load().safety.pendingFence, null);
  });
});
test("schema/audit/fence fields exact; unauthorized permission input cannot be persisted", () => fixture((s, root) => {
  for (const mutate of [r => { r.transitionAudit[0].activatedSources = [ID]; }, r => { r.safety.sources[0].permission = "approved"; },
    r => { r.fenceDetails = {}; }, r => { r.transitionAudit[0].extra = 1; }]) {
    const r = structuredClone(record(root)); mutate(r); assert.equal(Schema.validate(Schema.seal(r)).valid, false);
  }
}));
test("file/directory permissions and symlink paths fail closed", () => fixture((s, root) => {
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(statePath(root)).mode & 0o077, 0); fs.chmodSync(statePath(root), 0o644);
    assert.equal(s.load().available, false); fs.chmodSync(statePath(root), 0o600);
  }
  assert.throws(() => Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: path.dirname(root), policy: A.PRODUCTION_POLICY, crashAt: null }), /path_invalid/);
}));
test("symlinked state and helper arbitrary path rejected without following target", () => fixture((s, root) => {
  const target = path.join(root, "unrelated.json"), original = fs.readFileSync(statePath(root));
  fs.writeFileSync(target, original, { mode: 0o600 }); fs.unlinkSync(statePath(root)); fs.symlinkSync(target, statePath(root));
  assert.equal(s.load().available, false); assert.deepEqual(fs.readFileSync(target), original);
  assert.throws(() => Atomic.create(path.join(root, "arbitrary-directory")), /path_invalid/);
}));
test("read failure (regular file replaced by directory) fails closed without repair", () => fixture((s, root) => {
  fs.unlinkSync(statePath(root)); fs.mkdirSync(statePath(root), { mode: 0o700 });
  assert.equal(s.load().reason, "safety_file_type_invalid"); assert.equal(fs.statSync(statePath(root)).isDirectory(), true);
}));
test("cycle-start single load reused for all 12 source decisions; no per-source IO", () => fixture(s => {
  const before = s.audit(), loaded = s.load();
  for (const sourceId of A.SOURCE_IDS) assert.equal(Safety.evaluate({ sourceId, safety: loaded.safety }).writeAllowed, false);
  assert.equal(s.audit().loads - before.loads, 1); assert.equal(s.audit().reads - before.reads, 3); // state/checkpoint/ownership
  assert.equal(s.audit().persists, before.persists);
}));
test("renderer/path/content isolation + no main/runtime/preload wiring", () => {
  const old = global.window; global.window = { document: {} };
  try { assert.throws(() => H.create(os.tmpdir()), /main_side_only/); } finally { if (old === undefined) delete global.window; else global.window = old; }
  const root = path.resolve(__dirname, "..");
  for (const file of ["main.js", "preload.js", "index.html", "js/marketCalendarRuntime/automaticFormalShadowRuntime.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /writerSafetyStore|writerSafetyAtomicFile|writerSafetyFileSchema/);
  for (const file of ["writerSafetyStore", "writerSafetyAtomicFile", "writerSafetyFileSchema"])
    assert.doesNotMatch(fs.readFileSync(path.join(root, "js/marketCalendarHistory", `${file}.js`), "utf8"),
      /require\(["'].*(?:electron|WriterExecutor|ControlledWriter|RuntimeState|productionHistoryWriter)/);
});
test("native fs + fresh main-like child restart acceptance/performance/cleanup", async () => {
  const report = await H.nativeAcceptance(); assert.equal(report.status, "PASS");
  assert.equal(report.freshProcesses, 5); assert.equal(report.tempRemaining, 0); console.log(JSON.stringify({ benchmark: "safety-native", ...report }));
});
