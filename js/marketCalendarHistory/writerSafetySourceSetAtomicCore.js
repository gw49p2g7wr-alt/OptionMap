"use strict";

// Internal generation engine. No profile resolver, runtime factory, auto-upgrade,
// repair or writer. An immutable generation is published only after both the
// canonical state and checkpoint have passed read-back. A crash cannot select
// a half-persisted pair. Abandoned preparation is retained, never auto-repaired.
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), File = require("./writerSafetyFileSchema.js");
const Core = require("./writerSafetyAtomicCore.js"), E = require("./writerSafetySourceSetEnvelope.js");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
const DIRECTORY = "market-calendar-source-set-safety";
const CRASH_POINTS = Object.freeze(["pre_persist", "after_temp_write", "before_rename", "after_rename",
  "before_checkpoint", "after_checkpoint", "before_publish", "after_publish"]);
const PROFILE_CRASH_POINTS = Object.freeze([...CRASH_POINTS, ...CRASH_POINTS.map(p => "adopt_" + p)]);
const CORE_POINTS = Object.freeze({ after_temp_write: "after_temp_write", before_rename: "after_sync",
  after_rename: "after_replace", before_checkpoint: "after_replace", after_checkpoint: "after_checkpoint" });
const fail = reason => { throw Error(reason); };
function createGenerationStore(root, crashAt = null) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) fail("main_side_only");
  if (!Filesystem.samePath(root, fs.realpathSync(root)) || fs.lstatSync(root).isSymbolicLink() ||
      crashAt !== null && !CRASH_POINTS.includes(crashAt)) fail("source_set_store_invalid");
  const rootStat = fs.lstatSync(root), directory = path.join(root, DIRECTORY), owner = randomUUID(), ios = [];
  let closed = false, busy = false, owned = false, interrupted = false, highWater = -1;
  const counts = { fileHandles: 0, lockHandles: 0, writes: 0, syncs: 0, directorySyncs: 0, publishes: 0,
    loads: 0, persists: 0, writerExecution: 0, migrationValidationMs: 0, persistMs: 0, loadMs: 0 };
  function checkDirectory() {
    const r = fs.lstatSync(root), d = fs.lstatSync(directory);
    if (r.dev !== rootStat.dev || r.ino !== rootStat.ino || r.isSymbolicLink() || !Filesystem.secureDirectoryStat(d)) fail("safety_directory_invalid");
  }
  function handle(name, flags, action) {
    const fd = fs.openSync(path.join(directory, name), flags | Filesystem.noFollowFlag(), 0o600);
    counts.fileHandles++; if (name === "migration.lock") counts.lockHandles++;
    try {
      const s = fs.fstatSync(fd);
      if (!Filesystem.secureFileStat(s)) fail("safety_file_access_invalid");
      return action(fd, s);
    } finally { fs.closeSync(fd); counts.fileHandles--; if (name === "migration.lock") counts.lockHandles--; }
  }
  function syncDirectory() {
    const result = Filesystem.syncDirectory(directory); if (result.synced) counts.directorySyncs++;
  }
  function readSmall(name) {
    return handle(name, fs.constants.O_RDONLY, (fd, s) => {
      if (s.size > 1024) fail("safety_file_size_invalid"); return File.parse(fs.readFileSync(fd, "utf8"));
    });
  }
  function acquire(provision = false) {
    if (closed || interrupted) fail("safety_store_unavailable");
    if (provision && !fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 });
      const result = Filesystem.syncDirectory(root); if (result.synced) counts.directorySyncs++; }
    checkDirectory();
    if (!owned) {
      handle("migration.lock", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
        fs.writeFileSync(fd, JSON.stringify({ owner })); counts.writes++; fs.fsyncSync(fd); counts.syncs++;
      }); owned = true; syncDirectory();
    }
    if (readSmall("migration.lock").owner !== owner) fail("safety_ownership_conflict");
  }
  function generationIO(generation, crashAt = null) {
    if (!["baseline", "extended"].includes(generation)) fail("safety_generation_invalid");
    const parent = path.join(directory, generation), stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !Filesystem.samePath(fs.realpathSync(parent), parent) ||
      process.platform !== "win32" && (stat.mode & 0o077)) fail("safety_generation_invalid");
    const io = Core.create(path.join(parent, Core.DIRECTORY), { crashAt }); ios.push(io); return io;
  }
  function readPair(io) {
    if (io.lockVisibleToOther() || io.exists("intent")) fail("safety_selected_generation_interrupted");
    const record = File.parse(io.read("state", File.MAX_BYTES)), checked = E.validate(record);
    if (!checked.valid) fail(checked.reason);
    const c = File.parse(io.read("checkpoint", 1024));
    if (!A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== record.schemaVersion ||
      c.sequence !== record.safety.sequence || c.stateChecksum !== record.checksum || A.hash(c) !== A.hash(File.seal(c)))
      fail("safety_checkpoint_invalid");
    return record;
  }
  function read() {
    if (closed) fail("safety_store_closed"); checkDirectory();
    const selection = readSmall("selection.json");
    if (!A.exact(selection, ["schemaVersion", "generation", "sequence", "stateChecksum", "checksum"]) ||
      selection.schemaVersion !== 1 || !A.integer(selection.sequence) || selection.sequence < highWater ||
      A.hash(selection) !== A.hash(File.seal(selection))) fail("safety_selection_invalid");
    const io = generationIO(selection.generation); let record;
    try { record = readPair(io); } finally { io.close(); }
    if (record.safety.sequence !== selection.sequence || record.checksum !== selection.stateChecksum ||
      (selection.generation === "extended") !== (record.schemaVersion === E.VERSION)) fail("safety_selection_mismatch");
    highWater = selection.sequence; return record;
  }
  function load() {
    const start = performance.now(); counts.loads++;
    try {
      const record = read(); return A.freeze({ available: true, record, kind: E.validate(record).kind,
        autoUpgrade: false, writerStopped: true, writeAllowed: false, executionAllowed: false });
    } catch (e) { return A.freeze({ available: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_load_failed",
      record: null, writeAllowed: false, executionAllowed: false }); }
    finally { counts.loadMs = performance.now() - start; }
  }
  function point(name) { if (crashAt === name) process.exit(86); }
  function persist(record, generation) {
    if (Buffer.byteLength(JSON.stringify(record)) > File.MAX_BYTES) fail("safety_file_size_invalid");
    const start = performance.now(); interrupted = true; point("pre_persist");
    fs.mkdirSync(path.join(directory, generation), { mode: 0o700 }); syncDirectory();
    const io = generationIO(generation, CORE_POINTS[crashAt] || null);
    try {
      io.acquire({ provision: true });
      io.replace(record, File.seal({ schemaVersion: record.schemaVersion, sequence: record.safety.sequence, stateChecksum: record.checksum }));
      const checked = readPair(io); if (checked.checksum !== record.checksum) fail("safety_durable_readback_mismatch");
    } finally { io.close(); }
    // All generation handles/ownership/intent are closed before publication.
    point("before_publish");
    const selection = File.seal({ schemaVersion: 1, generation, sequence: record.safety.sequence, stateChecksum: record.checksum });
    handle("selection.tmp", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
      fs.writeFileSync(fd, JSON.stringify(selection) + "\n"); counts.writes++; fs.fsyncSync(fd); counts.syncs++;
    });
    fs.renameSync(path.join(directory, "selection.tmp"), path.join(directory, "selection.json")); syncDirectory(); counts.publishes++;
    point("after_publish");
    const after = read(); if (after.checksum !== record.checksum) fail("safety_durable_readback_mismatch");
    interrupted = false; counts.persists++; counts.persistMs = performance.now() - start;
    return { saved: true, durable: true, record: after, sequence: after.safety.sequence, writeAllowed: false, executionAllowed: false };
  }
  async function exclusive(action) {
    if (closed || busy) return A.freeze({ saved: false, reason: closed ? "safety_store_closed" : "safety_update_concurrent" });
    busy = true;
    try { await Promise.resolve(); return A.freeze(action()); }
    catch (e) { return A.freeze({ saved: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "safety_persist_failed",
      writerStopped: true, executionAllowed: false }); }
    finally { busy = false; }
  }
  function provisionHistoricalFixture(record) {
    return exclusive(() => {
      if (record?.schemaVersion !== 2 || !E.validate(record).valid) fail("historical_fixture_invalid");
      acquire(true); if (fs.existsSync(path.join(directory, "selection.json"))) fail("safety_already_provisioned");
      return persist(record, "baseline");
    });
  }
  function migrateSourceSet(input) {
    return exclusive(() => {
      acquire(); const previous = read(), start = performance.now(), next = E.migrateSourceSet(previous, input);
      if (!E.validate(next).valid) fail("source_set_migration_invalid"); counts.migrationValidationMs = performance.now() - start;
      return persist(next, "extended");
    });
  }
  function close() {
    if (busy) fail("safety_update_in_progress");
    if (owned && !interrupted) {
      checkDirectory(); if (readSmall("migration.lock").owner !== owner) fail("safety_ownership_conflict");
      fs.unlinkSync(path.join(directory, "migration.lock")); syncDirectory(); owned = false;
    }
    closed = true;
  }
  function audit() {
    const value = { ...counts, busy, closed, owned, interrupted };
    for (const io of ios) for (const k of ["fileHandles", "lockHandles", "writes", "syncs", "directorySyncs"])
      value[k] += io.audit()[k];
    return Object.freeze(value);
  }
  return Object.freeze({ load, provisionHistoricalFixture, migrateSourceSet, close, audit });
}
// Fixed-profile migration engine. Baseline adoption is private to the dedicated
// migration operation; callers cannot provision/replace arbitrary record JSON.
function createProfileMigrationStore(root, crashAt = null) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) fail("main_side_only");
  if (crashAt !== null && !PROFILE_CRASH_POINTS.includes(crashAt)) fail("source_set_store_invalid");
  const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
  let attempted = false, busy = false, closed = false, store = null, original = null;
  const generations = [];
  async function migrateSourceSet(input) {
    if (attempted || closed) return A.freeze({ saved: false, reason: "migration_attempt_consumed", executionAllowed: false });
    attempted = true; busy = true;
    try {
      const loaded = Reader.createReader(root).load();
      if (loaded.status !== "valid" || loaded.generation !== "legacy") fail(loaded.reason || "historical_envelope_required");
      E.migrateSourceSet(loaded.record, input); // Exact dedicated request before any writes.
      try { fs.lstatSync(path.join(root, DIRECTORY)); fail("source_set_preparation_exists"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      // Before publication, readers continue to validate the untouched original.
      // Abandoned preparation is retained and blocks a new migration attempt.
      const adoptingCrash = crashAt?.startsWith("adopt_") ? crashAt.slice(6) : null;
      store = createGenerationStore(root, adoptingCrash); generations.push(store);
      const adopted = await store.provisionHistoricalFixture(loaded.record);
      if (!adopted.saved) fail(adopted.reason);
      store.close();
      original = Core.create(path.join(root, Core.DIRECTORY)); original.acquire();
      const retained = File.parse(original.read("state", File.MAX_BYTES));
      const c = File.parse(original.read("checkpoint", 1024));
      if (retained.checksum !== loaded.record.checksum || !E.validate(retained).valid ||
          !A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) ||
          c.schemaVersion !== retained.schemaVersion || c.sequence !== retained.safety.sequence ||
          c.stateChecksum !== retained.checksum || File.seal(c).checksum !== c.checksum) fail("source_set_precondition_stale");
      store = createGenerationStore(root, adoptingCrash ? null : crashAt); generations.push(store);
      return await store.migrateSourceSet(input);
    } catch (e) { return A.freeze({ saved: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "source_set_migration_failed",
      writerStopped: true, executionAllowed: false }); }
    finally { try { store?.close(); } finally { original?.close(); busy = false; } }
  }
  function close() { if (busy) fail("safety_update_in_progress"); store?.close(); original?.close(); closed = true; }
  function audit() { return A.freeze({ attempted, busy, closed, generations: generations.map(s => s.audit()),
    retained: original?.audit() || null, writerExecution: 0 }); }
  return Object.freeze({ migrateSourceSet, close, audit });
}
module.exports = Object.freeze({ DIRECTORY, CRASH_POINTS, PROFILE_CRASH_POINTS, createGenerationStore, createProfileMigrationStore });
