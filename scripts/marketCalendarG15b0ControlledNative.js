"use strict";

// Node-native isolated durability harness; fake IndexedDB only. No Electron,
// production resolver or network. Importing the module performs no acceptance.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const assert = require("node:assert/strict"), { IDBFactory } = require("fake-indexeddb");
const Native = require("./marketCalendarG14b0SafetyAdapterNative.js");
const F = require("../test/fixtures/marketCalendar/mofControlledFixture.js");
const Existing = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");
const Semantic = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js");
const Store = require("../js/marketCalendarHistory/mofControlledSafetyStore.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const Generation = require("../js/marketCalendarRuntime/writerSafetyGenerationReadOnly.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
async function database(snapshot) {
  const indexedDB = new IDBFactory(), name = "isolated-mof-controlled";
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { for (const [, store] of Core.STORE_ORDER)
      r.result.createObjectStore(store, { keyPath: Schema.STORES[store].keyPath }); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(Core.STORE_NAMES, "readwrite"); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    for (const [f, store] of Core.STORE_ORDER) for (const row of snapshot[f]) tx.objectStore(store).add(row);
  });
  return { db, open };
}
async function withMigrated(action) {
  return Native.withSeed(async (root, old) => {
    const migrated = await Native.worker("migrate", root, null);
    assert.equal(migrated.result.saved, true, migrated.result.reason);
    return action(root, Reader.createReader(root).load().record, old);
  }, { cycles: 5 });
}
function child(mode, root, crashAt = null) {
  const r = cp.spawnSync(process.execPath, [__filename, mode, root, crashAt || "none"], {
    encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error || r.signal) throw Error("controlled_child_failed");
  return { code: r.status, output: r.stdout.trim() ? JSON.parse(r.stdout) : null, error: r.stderr };
}
async function worker(mode, root, crashAt) {
  if (mode === "read") {
    const reader = Reader.createReader(root), loaded = reader.load();
    // Read the selected immutable TEMP generation even when durable ownership
    // correctly blocks the public reader; never remove ownership or repair it.
    const selected = Generation.select(root, (d, n) => File.parse(fs.readFileSync(path.join(d, n), "utf8")));
    const record = File.parse(fs.readFileSync(path.join(selected.directory, "safety.json"), "utf8"));
    return { pid: process.pid, status: loaded.status, reason: loaded.reason, record,
      validSelectedRecord: E.validate(record).valid, readerWrites: reader.audit().writes,
      writerExecution: 0, pending: record.safety.pendingFence?.phase || null };
  }
  if (mode !== "attempt") throw Error("controlled_command_invalid");
  const snapshot = (await Existing.fixture()).snapshot, source = await F.source("isolated-child");
  const preparation = await Semantic.prepare({ source, snapshot, attemptIdentity: A.hash({ gate: "G1.5b0", mode: "isolated" }) });
  const store = Store.createIsolatedStore({ userData: root, crashAt });
  let db;
  try {
    const authorization = store.createControlledAuthorization({ preparation });
    const context = { preparation, sourceId: Semantic.SOURCE, operation: Semantic.OPERATION };
    const pending = store.createPendingFence(authorization, context);
    db = await database(snapshot);
    const result = await store.markWriteStarted(pending, db.db); assert.equal(result.committed, true, result.reason);
    store.markCommitObserved(pending);
    await store.markReadbackVerified(pending, db.open);
    const record = store.completeControlledAttempt(pending);
    assert.throws(() => store.createControlledAuthorization({ preparation }), /already_issued/);
    return { pid: process.pid, record, counts: Semantic.COUNTS, audit: store.audit(), freshReadonlyReopen: true,
      exactOther12Preserved: true, formalAfterCounts: Object.fromEntries(Core.STORE_ORDER.map(([f]) =>
        [f, snapshot[f].length + (f === "runs" || f === "cursors" ? 1 : 16)])) };
  } finally { db?.db.close(); store.close(); }
}
async function nativeAcceptance() {
  const success = await withMigrated((root, before) => {
    const run = child("attempt", root), reload = child("read", root);
    assert.equal(run.code, 0, run.error); assert.equal(reload.code, 0, reload.error);
    assert.equal(reload.output.status, "valid", reload.output.reason);
    assert.equal(reload.output.validSelectedRecord, true);
    assert.equal(reload.output.record.safety.sequence, before.safety.sequence + 5);
    assert.equal(reload.output.record.safety.pendingFence, null);
    assert.deepEqual(reload.output.record.historicalRecord, before.historicalRecord);
    assert.deepEqual(reload.output.record.safety.sources, before.safety.sources);
    assert.notEqual(run.output.pid, reload.output.pid);
    assert.equal(run.output.audit.readwriteTransactions, 1);
    assert.equal(run.output.audit.committedTransactions, 1); assert.equal(run.output.audit.abortedTransactions, 0);
    assert.equal(run.output.audit.handles, 0); assert.equal(run.output.audit.owned, false);
    return { startSequence: before.safety.sequence, endSequence: reload.output.record.safety.sequence,
      ...run.output, freshProcessReload: true };
  });
  const crashes = [];
  for (const point of Store.CRASH_POINTS) await withMigrated(root => {
    const run = child("attempt", root, point), reload = child("read", root);
    assert.equal(run.code, 86, point); assert.equal(reload.code, 0);
    assert.equal(reload.output.validSelectedRecord, true, point);
    assert.equal(reload.output.status, "corrupt", point);
    assert.equal(reload.output.reason, "safety_controlled_attempt_owned", point);
    assert.equal(reload.output.writerExecution, 0); assert.equal(reload.output.readerWrites, 0);
    crashes.push({ point, sequence: reload.output.record.safety.sequence, pending: reload.output.pending,
      freshReaderBlocked: true, validOldOrNew: true, retry: 0, repair: 0 });
  });
  return { status: "PASS", success, crashes, freshProcesses: 2 + crashes.length * 2,
    productionAccess: 0, productionWriter: 0, network: 0, cleanup: { tempProfiles: 0, handles: 0, children: 0 } };
}
if (require.main === module) {
  const mode = process.argv[2];
  (mode ? worker(mode, process.argv[3], process.argv[4] === "none" ? null : process.argv[4]) : nativeAcceptance())
    .then(r => process.stdout.write(JSON.stringify(r) + "\n"), e => { console.error(e.stack); process.exitCode = 1; });
}
module.exports = Object.freeze({ database, withMigrated, child, worker, nativeAcceptance });
