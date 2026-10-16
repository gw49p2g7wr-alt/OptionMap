"use strict";

// Internal fixed-boundary persistence mechanics shared by isolated and production
// factories. No arbitrary state setter, DB connection or writer executor.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), File = require("./writerSafetyFileSchema.js");
const E = require("./writerSafetySourceSetEnvelope.js"), L = require("./writerSafetyControlledLifecycle.js");
const Atomic = require("./writerSafetyAtomicCore.js");
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Generation = require("../marketCalendarRuntime/writerSafetyGenerationReadOnly.js");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
const CRASH_POINTS = Object.freeze(["after_authorization", "before_completion_persist", "after_completion_persist",
  ...L.PHASES.flatMap(p => [`before_${p}`, `after_${p}`, `before_publish_${p}`,
    ...Atomic.CRASH_POINTS.map(a => `${p}:${a}`)]), ...Atomic.CRASH_POINTS.map(p => `completion_${p}`)]);
function createBoundStore(root, { crashAt = null } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof root !== "string" || !path.isAbsolute(root) || !Filesystem.samePath(fs.realpathSync(root), root) ||
    crashAt !== null && !CRASH_POINTS.includes(crashAt)) throw Error("controlled_bound_store_invalid");
  const userData = root;
  const directory = path.join(userData, Generation.DIRECTORY); Generation.secureDirectory(directory);
  const rootStat = fs.lstatSync(userData), directoryStat = fs.lstatSync(directory);
  const owner = randomUUID(), lock = path.join(directory, "controlled.lock"), pointer = path.join(directory, "selection.json");
  const audit = { persists: 0, writes: 0, handles: 0 };
  let current = null, base = null, owned = false, healthy = true, attempted = false, completed = false;
  function point(name) { if (crashAt === name) process.exit(86); }
  function handle(file, flags, action) {
    const fd = fs.openSync(file, flags | Filesystem.noFollowFlag(), 0o600); audit.handles++;
    try { const s = fs.fstatSync(fd); if (!Filesystem.secureFileStat(s, { maxBytes: File.MAX_BYTES }))
      throw Error("controlled_file_invalid"); return action(fd); }
    finally { fs.closeSync(fd); audit.handles--; }
  }
  function syncDir(d) { Filesystem.syncDirectory(d); }
  function checkDirectories() {
    const r = fs.lstatSync(userData), d = fs.lstatSync(directory);
    if (r.dev !== rootStat.dev || r.ino !== rootStat.ino || d.dev !== directoryStat.dev || d.ino !== directoryStat.ino ||
      r.isSymbolicLink() || d.isSymbolicLink() || !Filesystem.samePath(fs.realpathSync(directory), directory)) throw Error("controlled_path_changed");
  }
  function checkOwned() {
    checkDirectories();
    if (!owned || !healthy || handle(lock, fs.constants.O_RDONLY, fd => fs.readFileSync(fd, "utf8")) !== owner)
      throw Error("controlled_ownership_invalid");
    const selection = handle(pointer, fs.constants.O_RDONLY, fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (File.seal(selection).checksum !== selection.checksum || selection.sequence !== current.safety.sequence ||
      selection.stateChecksum !== current.checksum) throw Error("controlled_safety_stale");
    const selected = Generation.select(userData, (dir, name) => handle(path.join(dir, name), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8"))));
    Generation.secureDirectory(selected.directory);
    const record = handle(path.join(selected.directory, "safety.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    const checkpoint = handle(path.join(selected.directory, "sequence.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (record.checksum !== current.checksum || !E.validate(record).valid ||
      !A.exact(checkpoint, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || checkpoint.schemaVersion !== 3 ||
      checkpoint.sequence !== selection.sequence ||
      checkpoint.stateChecksum !== record.checksum || File.seal(checkpoint).checksum !== checkpoint.checksum)
      throw Error("controlled_safety_stale");
    const retainedDirectory = path.join(userData, Atomic.DIRECTORY); Generation.secureDirectory(retainedDirectory);
    const retained = handle(path.join(retainedDirectory, "safety.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    const retainedCheckpoint = handle(path.join(retainedDirectory, "sequence.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (A.hash(retained) !== A.hash(current.historicalRecord) || !E.validate(retained).valid ||
      !A.exact(retainedCheckpoint, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) ||
      retainedCheckpoint.schemaVersion !== retained.schemaVersion ||
      retainedCheckpoint.stateChecksum !== retained.checksum || retainedCheckpoint.sequence !== retained.safety.sequence ||
      File.seal(retainedCheckpoint).checksum !== retainedCheckpoint.checksum) throw Error("controlled_retained_state_changed");
  }
  function persist(next, phase) {
    checkOwned(); if (!E.validate(next).valid) throw Error("controlled_next_state_invalid");
    const name = `controlled-${next.safety.sequence}`, parent = path.join(directory, name);
    let io;
    try {
      point(`before_${phase}`);
      if (phase === "completed") point("before_completion_persist");
      fs.mkdirSync(parent, { mode: 0o700 }); syncDir(directory);
      const atomicPoint = crashAt?.startsWith(`${phase}:`) ? crashAt.slice(phase.length + 1) :
        phase === "completed" && crashAt?.startsWith("completion_") ? crashAt.slice("completion_".length) : null;
      io = Atomic.create(path.join(parent, Atomic.DIRECTORY), { crashAt: atomicPoint });
      io.acquire({ provision: true });
      const checkpoint = File.seal({ schemaVersion: 3, sequence: next.safety.sequence, stateChecksum: next.checksum });
      io.replace(next, checkpoint);
      if (A.hash(File.parse(io.read("state", File.MAX_BYTES))) !== A.hash(next) ||
        A.hash(File.parse(io.read("checkpoint", 1024))) !== A.hash(checkpoint)) throw Error("controlled_persist_readback_failed");
      io.close();
      const selection = File.seal({ schemaVersion: 1, generation: name, sequence: next.safety.sequence, stateChecksum: next.checksum });
      const temp = path.join(directory, "controlled-selection.tmp");
      handle(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
        fs.writeFileSync(fd, JSON.stringify(selection) + "\n"); fs.fsyncSync(fd); audit.writes++; });
      point(`before_publish_${phase}`);
      fs.renameSync(temp, pointer); syncDir(directory);
      current = next; checkOwned(); audit.persists++;
      if (phase === "completed") { completed = true; point("after_completion_persist"); }
      point(`after_${phase}`);
    } catch (e) { healthy = false; throw e; }
    finally { io?.close(); }
  }

  function begin(expected) {
    if (attempted) throw Error("controlled_attempt_already_issued"); attempted = true;
    const loaded = Reader.createReader(userData).load();
    if (loaded.status !== "valid" || loaded.record.schemaVersion !== 3 || loaded.record.controlledLifecycleAudit ||
      loaded.record.safety.pendingFence || loaded.record.checksum !== expected.checksum) throw Error("controlled_safety_unavailable");
    current = loaded.record;
    base = E.migrateSourceSet(current.historicalRecord, E.requestFor(current.historicalRecord, current.sourceSetAudit[0].gateIdentity));
    checkDirectories();
    handle(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
      fs.writeFileSync(fd, owner); fs.fsyncSync(fd); audit.writes++; });
    owned = true; syncDir(directory); checkOwned(); return current;
  }
  function advance(phase, binding, proof = null) { checkOwned(); persist(L.append(base, current, phase, binding, proof), phase); return current; }
  function close() {
    if (owned && healthy && completed) { checkOwned(); fs.unlinkSync(lock); syncDir(directory); owned = false; }
  }
  return Object.freeze({ begin, checkOwned, point,
    createPreparedFence: binding => advance("prepared", binding),
    markWriteStarted: binding => advance("formal_write_started", binding),
    markCommitObserved: (binding, proof) => advance("commit_observed", binding, proof),
    markReadbackVerified: (binding, proof) => advance("readback_verified", binding, proof),
    completeAttempt: (binding, proof) => { const record = advance("completed", binding, proof); close(); return record; },
    close, audit: () => structuredClone({ ...audit, owned, healthy }) });
}
module.exports = Object.freeze({ CRASH_POINTS, createBoundStore });
