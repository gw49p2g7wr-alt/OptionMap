"use strict";

// Native Node child processes + disposable dedicated temp profiles only.
// No Electron/package launch, network, runtime acquisition, DB or production IO.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
const Store = require("../js/marketCalendarHistory/writerSafetySourceSetStore.js");
const Fixture = require("../test/fixtures/marketCalendar/safetySourceSetFixture.js");
function child(command, root, crashAt = null) {
  const started = performance.now();
  const c = cp.spawnSync(process.execPath, [__filename, command, root, crashAt || "none"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  if (c.error || c.signal) throw Error("isolated_migration_child_failed");
  return { code: c.status, elapsedMs: performance.now() - started, output: c.stdout.trim() ? JSON.parse(c.stdout) : null };
}
function artifacts(root) {
  const rows = [];
  function visit(dir) { for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name); if (d.isDirectory()) visit(p);
    else if (["migration.lock", "ownership.lock", "update.intent", "safety.tmp", "sequence.tmp", "selection.tmp"].includes(d.name))
      rows.push(path.relative(root, p));
  } }
  visit(root); return rows.sort();
}
async function worker(command, root, crashAt) {
  if (!["read", "migrate"].includes(command)) throw Error("isolated_migration_command_invalid");
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt });
  let result, authorizationMs = 0, allowedSources = [];
  try {
    const before = store.load(); assert.equal(before.available, true, before.reason);
    result = command === "read" ? before : await store.migrateSourceSet(E.requestFor(before.record, Fixture.GATE));
    const r = result.record;
    if (r?.schemaVersion === E.VERSION) {
      const started = performance.now();
      allowedSources = P.SOURCE_IDS.filter(sourceId => P.evaluate({ ...Fixture.candidate(r.historicalRecord, sourceId, sourceId), record: r }).writeAllowed);
      authorizationMs = performance.now() - started;
    }
  } finally { store.close(); }
  return { pid: process.pid, result, allowedSources, authorizationMs, audit: store.audit(), artifacts: artifacts(root) };
}
async function withSeed(action, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const record = Fixture.historical(options), store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try {
    const r = await store.provisionHistoricalFixture(record); assert.equal(r.saved, true, r.reason); store.close();
    return await action(root, record);
  } finally { store.close(); fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
async function nativeAcceptance() {
  const success = await withSeed((root, old) => {
    const m = child("migrate", root), fresh = child("read", root);
    assert.equal(m.code, 0); assert.equal(m.output.result.saved, true, m.output.result.reason);
    assert.equal(fresh.output.result.available, true); assert.notEqual(m.output.pid, fresh.output.pid);
    assert.deepEqual(fresh.output.result.record, E.migrateSourceSet(old, E.requestFor(old, Fixture.GATE)));
    assert.deepEqual(fresh.output.allowedSources, [require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js").SOURCE]);
    for (const c of [m, fresh]) { assert.equal(c.output.audit.fileHandles, 0); assert.equal(c.output.audit.lockHandles, 0);
      assert.equal(c.output.artifacts.length, 0); assert.equal(c.output.audit.writerExecution, 0); }
    assert.equal(fresh.output.audit.writes, 0);
    return { beforeSequence: old.safety.sequence, afterSequence: fresh.output.result.record.safety.sequence,
      migrationValidationMs: m.output.audit.migrationValidationMs, persistMs: m.output.audit.persistMs,
      freshReloadMs: fresh.elapsedMs, loadMs: fresh.output.audit.loadMs, authorizationMs: fresh.output.authorizationMs,
      fileSyncs: m.output.audit.syncs, directorySyncs: m.output.audit.directorySyncs, artifacts: 0 };
  }, { cycles: 9, failureCycles: 2, suspendSource: true });
  const crashes = [];
  for (const crashAt of Store.CRASH_POINTS) await withSeed((root, old) => {
    const crashed = child("migrate", root, crashAt); assert.equal(crashed.code, 86);
    const fresh = child("read", root); assert.equal(fresh.code, 0); assert.equal(fresh.output.result.available, true);
    const next = E.migrateSourceSet(old, E.requestFor(old, Fixture.GATE)), observed = fresh.output.result.record;
    assert([old.checksum, next.checksum].includes(observed.checksum)); assert.equal(E.validate(observed).valid, true);
    const isNew = observed.checksum === next.checksum;
    assert.equal(isNew, crashAt === "after_publish"); assert.equal(fresh.output.audit.writes, 0);
    assert.equal(fresh.output.audit.fileHandles, 0); assert.equal(fresh.output.audit.lockHandles, 0);
    crashes.push({ crashAt, selected: isNew ? "new" : "old", sequence: observed.safety.sequence,
      valid: true, artifacts: fresh.output.artifacts, autoRepair: 0, readerWrites: 0 });
  }, { cycles: 3 });
  return { status: "PASS", success, crashes, freshProcesses: 2 + 2 * crashes.length,
    cleanup: { tempProfiles: 0, handles: 0, childProcesses: 0 },
    productionUserDataAccess: 0, network: 0, writerExecution: 0, formalAccess: 0 };
}
if (require.main === module) {
  const mode = process.argv[2];
  (mode ? worker(mode, process.argv[3], process.argv[4] === "none" ? null : process.argv[4]) : nativeAcceptance())
    .then(r => process.stdout.write(JSON.stringify(r) + "\n"), () => { console.error("isolated_source_set_acceptance_failed"); process.exitCode = 1; });
}
module.exports = Object.freeze({ child, artifacts, withSeed, nativeAcceptance });
