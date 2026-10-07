"use strict";

// Disposable temp fixtures only. Importing this harness does not run it.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const Atomic = require("../js/marketCalendarHistory/writerSafetyAtomicCore.js");
const Adapter = require("../js/marketCalendarHistory/writerSafetyProductionMigration.js");
const Core = require("../js/marketCalendarHistory/writerSafetySourceSetAtomicCore.js");
const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const F = require("../test/fixtures/marketCalendar/safetySourceSetFixture.js");
function seed(root, record = F.historical()) {
  const io = Atomic.create(path.join(root, Atomic.DIRECTORY));
  try { io.acquire({ provision: true }); io.replace(record, File.seal({ schemaVersion: record.schemaVersion,
    sequence: record.safety.sequence, stateChecksum: record.checksum })); } finally { io.close(); }
  return record;
}
async function withSeed(action, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  try { return await action(root, seed(root, F.historical(options))); }
  finally { fs.rmSync(root, { recursive: true }); }
}
function child(command, root, crashAt = null) {
  const r = cp.spawnSync(process.execPath, [__filename, command, root, crashAt || "none"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error || r.signal) throw Error("adapter_child_failed");
  return { code: r.status, output: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}
async function worker(command, root, crashAt) {
  if (!["read", "migrate"].includes(command)) throw Error("adapter_command_invalid");
  if (command === "read") {
    const reader = Reader.createReader(root), loaded = reader.load();
    return { pid: process.pid, status: loaded.status, reason: loaded.reason, generation: loaded.generation,
      record: loaded.record, audit: reader.audit() };
  }
  const adapter = Adapter.createIsolatedAdapter({ targetEnvironment: "isolated_test", userData: root, crashAt });
  try {
    const record = Reader.createReader(root).load().record;
    const result = await adapter.migrateSourceSet(E.requestFor(record, F.GATE));
    adapter.close(); return { pid: process.pid, result, audit: adapter.audit() };
  } finally { adapter.close(); }
}
async function nativeAcceptance() {
  const success = await withSeed((root, old) => {
    const before = fs.readFileSync(path.join(root, Reader.RELATIVE_PATH));
    const m = child("migrate", root), r = child("read", root);
    assert.equal(m.code, 0); assert.equal(m.output.result.saved, true, m.output.result.reason);
    assert.equal(r.code, 0); assert.equal(r.output.status, "valid", r.output.reason);
    assert.deepEqual(r.output.record, E.migrateSourceSet(old, E.requestFor(old, F.GATE)));
    assert.deepEqual(fs.readFileSync(path.join(root, Reader.RELATIVE_PATH)), before);
    assert.notEqual(m.output.pid, r.output.pid); assert.equal(r.output.audit.writes, 0); assert.equal(r.output.audit.handles, 0);
    for (const a of m.output.audit.generations) { assert.equal(a.fileHandles, 0); assert.equal(a.lockHandles, 0); }
    assert.equal(m.output.audit.retained.fileHandles, 0); assert.equal(m.output.audit.retained.lockHandles, 0);
    return { beforeSequence: old.safety.sequence, afterSequence: r.output.record.safety.sequence, freshProcess: true,
      generation: r.output.generation, audit: m.output.audit, retainedPairUnchanged: true };
  }, { cycles: 5 });
  const crashes = [];
  for (const crashAt of Core.PROFILE_CRASH_POINTS) await withSeed((root, old) => {
    const m = child("migrate", root, crashAt); assert.equal(m.code, 86);
    const r = child("read", root); assert.equal(r.code, 0); assert.equal(r.output.status, "valid", r.output.reason);
    const next = E.migrateSourceSet(old, E.requestFor(old, F.GATE));
    assert.equal(r.output.record.checksum, crashAt === "after_publish" ? next.checksum : old.checksum);
    assert.equal(E.validate(r.output.record).valid, true); assert.equal(r.output.audit.writes, 0); assert.equal(r.output.audit.handles, 0);
    crashes.push({ crashAt, selected: r.output.generation, sequence: r.output.record.safety.sequence,
      valid: true, readerWrites: 0, autoRepair: 0 });
  });
  return { status: "PASS", success, crashes, freshProcesses: 2 + 2 * crashes.length,
    cleanup: { tempProfiles: 0, handles: 0, children: 0 }, writerExecution: 0, network: 0, formalAccess: 0 };
}
if (require.main === module) {
  const mode = process.argv[2];
  (mode ? worker(mode, process.argv[3], process.argv[4] === "none" ? null : process.argv[4]) : nativeAcceptance())
    .then(r => process.stdout.write(JSON.stringify(r) + "\n"), e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = Object.freeze({ seed, withSeed, child, worker, nativeAcceptance });
