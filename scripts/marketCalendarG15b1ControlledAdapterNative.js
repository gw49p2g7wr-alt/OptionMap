"use strict";

// Dedicated temp mirror only. Receipt observations below are explicit fixtures,
// not a production Formal commit. The safety adapter never invokes a writer.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Adapter = require("../js/marketCalendarHistory/mofControlledSafetyProductionAdapter.js");
const Guard = require("./marketCalendarG14bFilesystemGuard.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const Generation = require("../js/marketCalendarHistory/writerSafetySourceSetAtomicCore.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const Seed = require("./marketCalendarG14b0SafetyAdapterNative.js");
const F = require("../test/fixtures/marketCalendar/mofControlledFixture.js");
const Safety = require("../test/fixtures/marketCalendar/safetySourceSetFixture.js");
const Semantic = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const L = require("../js/marketCalendarHistory/writerSafetyControlledLifecycle.js");
async function withSeed(action, historical = Safety.historical({ cycles: 5 })) {
  const fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g14bg-fixture-"));
  const policy = Guard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot });
  const root = policy.profile; fs.mkdirSync(root, { recursive: true, mode: 0o700 }); Seed.seed(root, historical);
  const generations = Generation.createGenerationStore(root);
  try {
    assert.equal((await generations.provisionHistoricalFixture(historical)).saved, true);
    const r = await generations.migrateSourceSet(E.requestFor(historical, Safety.GATE)); assert.equal(r.saved, true, r.reason);
    generations.close(); return await action(fixtureRoot, root, r.record, policy);
  } finally { generations.close(); fs.rmSync(fixtureRoot, { recursive: true }); assert.equal(fs.existsSync(fixtureRoot), false); }
}
const adapterFor = (fixtureRoot, crashAt = null) => Adapter.createIsolatedAdapter({ targetEnvironment: "isolated_test", fixtureRoot, crashAt });
async function preparation(label = "adapter-fixture", snapshot = F.empty()) {
  return Semantic.prepare({ source: await F.source(label), snapshot, attemptIdentity: A.hash(label) });
}
const observation = b => Object.fromEntries(["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity"].map(k => [k, b[k]]));
function commitReceipt(b) {
  return { ...observation(b), result: { committed: true,
    counts: Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f, ["runs", "cursors"].includes(f) ? 1 : 16])) },
  metrics: { readwriteTransactions: 1, committedTransactions: 1, abortedTransactions: 0 } };
}
function readbackReceipt(b, snapshot) { return { ...observation(b), freshReadonlyReopen: true, snapshot }; }
async function lifecycle(fixtureRoot, root, crashAt = null) {
  const adapter = adapterFor(fixtureRoot, crashAt), p = await preparation(), material = Semantic.inspect(p);
  const phases = [], observe = phase => {
    const fresh = Reader.createReader(root).inspectControlledState(); assert.equal(fresh.status, "valid", fresh.reason);
    assert.equal(E.validate(fresh.record).valid, true); assert.equal(fresh.writeAllowed, false); assert.equal(fresh.retryAllowed, false);
    phases.push({ phase, sequence: fresh.safety.sequence, pending: !!fresh.safety.pendingFence, owned: fresh.controlledAttemptOwned });
  };
  try {
    assert.equal(adapter.preflight().eligible, true);
    const authorization = adapter.createControlledAuthorization(p), attempt = adapter.createPreparedFence(authorization, p);
    observe("prepared"); const released = adapter.markWriteStarted(attempt); observe("formal_write_started");
    adapter.markCommitObserved(attempt, commitReceipt(released.binding)); observe("commit_observed");
    adapter.markReadbackVerified(attempt, readbackReceipt(released.binding, material.expected)); observe("readback_verified");
    const done = adapter.completeAttempt(attempt); observe("completed"); assert.equal(done.safety.sequence, 13);
    assert.equal(adapter.preflight().eligible, false); assert.throws(() => adapter.completeAttempt(attempt), /controlled_handle_invalid/);
    return { phases, audit: adapter.audit() };
  } finally { adapter.close(); }
}
function child(mode, fixtureRoot, crashAt = null) {
  const c = cp.spawnSync(process.execPath, [__filename, mode, fixtureRoot, crashAt || "none"], { encoding: "utf8", timeout: 20000, maxBuffer: 2e6 });
  if (c.error || c.signal) throw Error("controlled_adapter_child_failed");
  return { code: c.status, output: c.stdout.trim() ? JSON.parse(c.stdout) : null };
}
async function worker(mode, fixtureRoot, crashAt) {
  const policy = Guard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot });
  if (mode === "lifecycle") return lifecycle(fixtureRoot, policy.profile, crashAt);
  if (mode !== "read") throw Error("controlled_adapter_command_invalid");
  const adapter = adapterFor(fixtureRoot);
  try { const loaded = adapter.load(), preflight = adapter.preflight();
    return { loaded, preflight, audit: adapter.audit(), pid: process.pid }; }
  finally { adapter.close(); }
}
async function nativeAcceptance() {
  const success = await withSeed((fixtureRoot, root) => {
    const executed = child("lifecycle", fixtureRoot), fresh = child("read", fixtureRoot);
    assert.equal(executed.code, 0); assert.equal(fresh.code, 0);
    assert.equal(fresh.output.loaded.status, "valid", fresh.output.loaded.reason);
    assert.equal(fresh.output.loaded.safety.sequence, 13); assert.equal(fresh.output.preflight.eligible, false);
    assert.equal(executed.output.audit.writerExecution, 0); assert.equal(executed.output.audit.formalDBAccess, 0);
    return { phases: executed.output.phases, persists: executed.output.audit.safety.persists, freshReload: true };
  });
  const crashes = [];
  const points = L.PHASES.flatMap(p => [`before_${p}`, `before_publish_${p}`, `after_${p}`, `${p}:after_replace`]);
  for (const crashAt of points) await withSeed((fixtureRoot, root) => {
    const interrupted = child("lifecycle", fixtureRoot, crashAt); assert.equal(interrupted.code, 86, crashAt);
    const fresh = child("read", fixtureRoot); assert.equal(fresh.code, 0);
    const r = fresh.output; assert.equal(r.loaded.status, "valid", `${crashAt}: ${r.loaded.reason}`);
    assert.equal(E.validate(r.loaded.record).valid, true); assert.equal(r.preflight.eligible, false);
    assert.equal(r.loaded.retryAllowed, false); assert.equal(r.audit.reader.writes, 0);
    assert.equal(r.audit.writerExecution, 0); assert.equal(r.audit.formalDBAccess, 0);
    crashes.push({ crashAt, sequence: r.loaded.safety.sequence, phase: r.loaded.record.controlledLifecycleAudit?.at(-1)?.phase || "idle",
      valid: true, retryAllowed: false, readonlyWrites: 0 });
  });
  return { status: "PASS", success, crashes, freshProcesses: 2 + crashes.length * 2,
    receiptFixturesOnly: true, productionAccess: 0, writerExecution: 0, cleanup: { profiles: 0, handles: 0, children: 0 } };
}
if (require.main === module) {
  const mode = process.argv[2]; (mode ? worker(mode, process.argv[3], process.argv[4] === "none" ? null : process.argv[4]) : nativeAcceptance())
    .then(r => process.stdout.write(JSON.stringify(r) + "\n"), e => { console.error(e.stack); process.exitCode = 1; });
}
module.exports = Object.freeze({ withSeed, adapterFor, preparation, commitReceipt, readbackReceipt, lifecycle, nativeAcceptance });
