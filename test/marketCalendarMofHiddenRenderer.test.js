"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), crypto = require("node:crypto");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js");
const F = require("./fixtures/marketCalendar/mofControlledFixture.js"), AF = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js"), C = require("../js/marketCalendarRuntime/mofControlledGrantController.js");
const W = require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js"), Native = require("../scripts/marketCalendarG15b4HiddenRendererNative.js");
const Lifecycle = require("./fixtures/nativeElectronFixtureLifecycle.js");
const hashFile = p => crypto.createHash("sha256").update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
let successful;
test("native forced-termination classification is explicit and platform-bound", () => {
  const forcedFaults = ["before_window"];
  assert.equal(Lifecycle.isIntentionalForcedTermination({ child: { status: null, signal: "SIGKILL", error: null },
    mode: "execute", fault: "before_window", forcedFaults, platform: "darwin" }), true);
  assert.equal(Lifecycle.isIntentionalForcedTermination({ child: { status: 1, signal: null, error: null },
    mode: "execute", fault: "before_window", forcedFaults, platform: "win32" }), true);
  for (const fixture of [
    { child: { status: 1, signal: null, error: null }, mode: "read", fault: "before_window", platform: "win32" },
    { child: { status: 1, signal: null, error: null }, mode: "execute", fault: "other", platform: "win32" },
    { child: { status: 2, signal: null, error: null }, mode: "execute", fault: "before_window", platform: "win32" },
    { child: { status: 1, signal: null, error: Error("spawn") }, mode: "execute", fault: "before_window", platform: "win32" }
  ]) assert.equal(Lifecycle.isIntentionalForcedTermination({ ...fixture, forcedFaults }), false);
  let inspections = 0;
  assert.deepEqual(Lifecycle.assertFixtureExited({ child: { status: 0, signal: null, error: null }, profile: "C:\\profile",
    platform: "win32", childProcess: { spawnSync() { inspections++; } } }), { method: "spawnSync_exit", exited: true });
  assert.equal(inspections, 0);
});
test("native Electron launch lock recovers stale ownership and fails closed on live contention", () => {
  const os = require("node:os"), path = require("node:path");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-native-lock-test-"));
  const lock = path.join(root, "optionmap-native-electron-launch.lock");
  try {
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "stale" }));
    assert.equal(Lifecycle.withNativeElectronLaunchLock(() => "launched", { lockRoot: root, timeoutMs: 100 }), "launched");
    assert.equal(fs.existsSync(lock), false);
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }));
    assert.throws(() => Lifecycle.withNativeElectronLaunchLock(() => "forbidden", { lockRoot: root, timeoutMs: 0 }),
      /native_electron_launch_lock_timeout/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("X1/X7/X9/X11 exact native renderer: local token, one real transaction, fresh process readback", async () => {
  successful = await Native.nativeCase(); const r = successful.executed.output;
  assert.equal(r.status, "PASS"); assert.equal(r.mainTokenAttempts, 0); assert.equal(r.audit.mainExecutionTokens, 0);
  assert.deepEqual(r.receipt.localToken, { minted: 1, writerCalls: 1, success: true });
  assert.deepEqual(r.receipt.transactions, { readwrite: 1, commit: 1, abort: 0 }); assert.deepEqual(r.receipt.counts, S.COUNTS);
  assert.equal(r.receipt.integrity, true); assert.equal(r.receipt.postIdentity, r.receipt.readbackIdentity);
  assert.notEqual(r.freshRenderer.prior.osProcessId, r.freshRenderer.next.osProcessId);
  assert.notEqual(r.freshRenderer.prior.webContentsId, r.freshRenderer.next.webContentsId);
  assert.deepEqual(r.phases.map(p => p.sequence), [9, 10, 11, 12, 13]);
  assert.equal(r.parity.database, "optionMapMarketCalendarHistory"); assert.equal(r.parity.version, 1);
  assert.equal(r.parity.realChromium, true); assert.equal(r.parity.url, W.URL); assert.equal(r.parity.origin, "file://");
  assert.equal(r.parity.profile, r.parity.defaultSessionStorage);
  assert.deepEqual(r.security, { nodeIntegration: false, contextIsolation: true, sandbox: true, mainWorldBridge: "undefined", mainWorldNode: "undefined" });
  assert.equal(r.audit.handlers, 0); assert.equal(r.audit.grants, 0); assert.equal(r.audit.windows, 0);
  assert.ok(r.audit.windowAudits.every(a => !a.windows && !a.listeners && !a.networkAttempts));
  assert.equal(r.guard.forbiddenAttempts, 0); assert.equal(r.guard.networkAttempts, 0);
});
test("X8 recreated, JSON-copied and other-module renderer token reject before DB", () => {
  assert.deepEqual(successful.executed.output.tokenChecks, { recreatedRejected: true, copiedRejected: true, otherModuleRejected: true, transactions: 0 });
});
test("X13/X14 durable permission, Machinery ceiling and BOJ unchanged", () => {
  const loaded = successful.reload.loaded;
  assert.equal(loaded.safety.persistedAuthorityVersion, 3); assert.equal(loaded.writeAllowed, false);
  assert.equal(loaded.safety.pendingFence, null); assert.equal(loaded.safety.globalSuspend.suspended, false);
  const P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
  assert.equal(P.PERMISSIONS.entries.find(r => r.sourceId === S.SOURCE).permission, "not_approved");
  assert.equal(P.PERMISSIONS.entries.find(r => r.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
  const snapshot = successful.reload.formal.snapshot;
  for (const field of Object.keys(snapshot)) assert.equal(snapshot[field].filter(r => r.sourceId !== S.SOURCE).length, 12);
});
const crashes = ["before_window", "before_load", "after_load", "after_challenge", "consume_before_started", "started_before_permit",
  "after_permit", "after_token", "during_tx", "commit_ambiguous", "commit_before_readback", "readback_before_completion"];
for (const fault of [...crashes, "permit_lost", "wrong_challenge", "wrong_sender", "wrong_frame", "reload", "navigation", "process_replacement",
  "network", "replay_challenge", "replay_consume", "second_tx"]) test(`crash/loss/replay fail closed: ${fault}`, async t => {
  const r = await Native.nativeCase(fault), loaded = r.reload.loaded;
  assert.ok(r.executed.code === 86 || r.executed.output.status === "FAIL"); assert.equal(r.reload.preflight.eligible, false);
  assert.equal(loaded.retryAllowed, false); assert.equal(loaded.controlledAttemptOwned, true);
  t.diagnostic(JSON.stringify({ fault, sequence: loaded.safety.sequence, pending: loaded.safety.pendingFence?.phase,
    crashSignal: r.executed.crashSignal, retryAllowed: loaded.retryAllowed }));
  const postCommit = ["commit_ambiguous", "commit_before_readback", "readback_before_completion", "second_tx"].includes(fault);
  const entries = r.reload.formal.snapshot.entries.filter(e => e.sourceId === S.SOURCE);
  assert.equal(entries.length, postCommit ? 16 : 0, fault);
  assert.equal(r.reload.guard.forbiddenAttempts, 0); assert.equal(r.cleanup.profileDeleted, true);
  if (r.executed.output) { const a = r.executed.output.audit; assert.equal(a.handlers, 0); assert.equal(a.grants, 0); assert.equal(a.windows, 0);
    assert.equal(r.executed.output.mainTokenAttempts, 0); assert.equal(a.mainExecutionTokens, 0);
    assert.ok(a.windowAudits.every(row => row.windows === 0 && row.listeners === 0));
    if (fault === "network") assert.ok(a.windowAudits.some(row => row.networkAttempts === 1));
    if (["reload", "navigation", "process_replacement"].includes(fault)) assert.ok(a.windowAudits.some(row => row.invalidated)); }
});
test("native material preparation never creates a main execution token and cannot accept copied capabilities", async () => {
  const p = await S.prepareNativeMaterial({ source: await F.source("pure-native"), snapshot: (await AF.fixture()).snapshot, attemptIdentity: A.hash("pure-native") });
  assert.equal(S.inspectNativeMaterial(p).plan.sourceId, S.SOURCE); assert.equal(S.take(p).execution, null);
  assert.throws(() => S.inspectNativeMaterial({}), /native_material_only_required/);
  await assert.rejects(S.prepareNativeMaterial({ source: { ...await F.source(), sourceId: "jp-boj-calendar" }, snapshot: F.empty(), attemptIdentity: A.hash("bad-source") }), /controlled/);
});
test("fixed native production entry rejects non-main context without touching a production path", async () => {
  assert.throws(() => C.createProductionController({}), /native_main_required/);
  await assert.rejects(W.createProductionWindow("arbitrary"), /native_main_required/);
});
test("writer core remains byte-identical", () => assert.equal(hashFile(require.resolve("../js/marketCalendarHistory/formalControlledWriterCore.js")),
  "7c2d0ca2a1779de0b9f65a48129adf6ce08647009d1b81de542306335f4eb0c5"));
test("fixed receipt rejects drift, missing and unknown fields", async () => {
  const material = await S.prepareNativeMaterial({ source: await F.source("hidden-native"), snapshot: (await AF.fixture()).snapshot, attemptIdentity: A.hash("hidden-native") });
  const data = S.inspectNativeMaterial(material), receipt = successful.executed.output.receipt;
  const invitation = { binding: { expectedFormalIdentity: A.hash(Core.sorted(data.expected)) } };
  C.validateReceipt(receipt, invitation, receipt.consumeIdentity, data);
  for (const change of [r => { r.sourceId = "jp-esri-machinery-orders-calendar"; }, r => { r.operation = "startup"; },
    r => { r.counts.eventEntryCreate++; }, r => { delete r.consumeIdentity; }, r => { r.arbitrary = true; },
    r => { r.localToken.minted = 2; }, r => { r.transactions.readwrite = 2; }, r => { r.audit.network = 1; },
    r => { r.snapshot.entries.pop(); }]) { const copy = structuredClone(receipt); change(copy);
    assert.throws(() => C.validateReceipt(copy, invitation, receipt.consumeIdentity, data), /native_receipt/); }
});
