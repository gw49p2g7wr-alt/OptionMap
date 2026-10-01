"use strict";

// Dedicated Node main-like child; never launches OptionMap/Electron or production storage.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const Store = require("../js/marketCalendarHistory/writerSafetyStore.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Safety = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const SOURCE = require("../js/marketCalendarHistory/formalWriterAuthority.js").FIRST_WRITE_SOURCE_ID;
const COMMANDS = Object.freeze(["provision", "read", "failure", "global", "source", "fence", "fence_crash", "ambiguous", "readback", "hold"]);
function create(root, crashAt = null) {
  return Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt });
}
function signal(reason, n = 1) {
  return { sourceId: SOURCE, category: Safety.classifyFailure(reason).category, outcome: "failure", reason,
    cycleOrdinal: n, cycleIdentity: A.hash({ cycle: n }) };
}
async function worker(command, root, crashAt = null, cycle = 1) {
  if (!COMMANDS.includes(command) || !A.integer(cycle) || cycle < 1) throw Error("diagnostic_command_invalid");
  const store = create(root, crashAt), started = performance.now();
  let result;
  try {
    if (command === "provision") result = await store.provisionDisabled();
    else if (command === "read") result = store.load();
    else if (command === "hold") {
      result = await store.persistCounterUpdate({ expectedSequence: store.load().safety.sequence, signal: signal("network_failure", cycle) });
      if (process.send) process.send({ ready: true, result });
      await new Promise(resolve => process.once("message", resolve));
    } else if (["fence", "fence_crash", "ambiguous", "readback"].includes(command)) {
      result = await store.persistPendingFence({ expectedSequence: store.load().safety.sequence, sourceId: SOURCE,
        attemptIdentity: A.hash({ attempt: 1 }), cycleIdentity: A.hash({ cycle: 1 }), operation: "startup", phase: "prepared" });
      if (result.saved && command === "fence_crash") process.exit(87); // Abrupt exit: no finally/ownership release.
      if (result.saved && !["fence", "fence_crash"].includes(command)) result = await store.persistTransition({ expectedSequence: result.sequence,
        signal: signal(command === "ambiguous" ? "commit_ambiguous" : "readback_incomplete", cycle) });
    } else result = await store.persistTransition({ expectedSequence: store.load().safety.sequence,
      signal: signal(command === "global" ? "orphan" : command === "source" ? "unsupported_changed" : "network_failure", cycle) });
  } finally { store.close(); }
  return { pid: process.pid, result, elapsedMs: performance.now() - started, audit: store.audit() };
}
function child(command, root, crashAt = null, cycle = 1) {
  const start = performance.now();
  const result = cp.spawnSync(process.execPath, [__filename, "worker", command, root, crashAt || "none", String(cycle)],
    { encoding: "utf8", timeout: 15000 });
  if (result.error) throw result.error;
  return { code: result.status, signal: result.signal, elapsedMs: performance.now() - start,
    output: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr.trim() };
}
async function nativeAcceptance() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  let report;
  try {
    const p = child("provision", root); assert.equal(p.code, 0); assert.equal(p.output.result.saved, true);
    const f = child("failure", root); assert.equal(f.output.result.saved, true);
    const read = child("read", root); assert.equal(read.output.result.safety.sources.find(s => s.sourceId === SOURCE).counters.acquisition_failure.count, 1);
    const fence = child("fence", root); assert.equal(fence.output.result.saved, true);
    const restart = child("read", root); assert.equal(restart.output.result.reason, "interrupted_pending_fence");
    assert.equal(new Set([p, f, read, fence, restart].map(r => r.output.pid)).size, 5);
    for (const r of [p, f, read, fence, restart]) { assert.equal(r.output.audit.fileHandles, 0); assert.equal(r.output.audit.owned, false); }
    report = { status: "PASS", freshProcesses: 5, loadMs: read.output.audit.loadMs,
      persistMs: f.output.audit.persistMs, restartMs: restart.elapsedMs,
      fileSyncs: p.output.audit.syncs + f.output.audit.syncs + fence.output.audit.syncs,
      directorySyncs: p.output.audit.directorySyncs + f.output.audit.directorySyncs + fence.output.audit.directorySyncs,
      formalWrite: 0, productionUserDataAccess: 0, childProcesses: 0, fileHandles: 0, lockHandles: 0 };
  } finally { fs.rmSync(root, { recursive: true }); }
  return { ...report, tempRemaining: Number(fs.existsSync(root)) };
}
if (require.main === module) {
  const task = process.argv[2] === "worker" ? worker(process.argv[3], process.argv[4],
    process.argv[5] === "none" ? null : process.argv[5], Number(process.argv[6])) : nativeAcceptance();
  task.then(result => console.log(JSON.stringify(result)), () => { console.error("isolated_safety_diagnostic_failed"); process.exitCode = 1; });
}
module.exports = Object.freeze({ create, signal, child, nativeAcceptance, SOURCE });
