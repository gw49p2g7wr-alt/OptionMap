"use strict";

// Internal shared persistence mechanics. Only fixed-path boundaries may call this.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const DIRECTORY = "market-calendar-writer-safety";
const NAMES = Object.freeze({ state: "safety.json", checkpoint: "sequence.json", lock: "ownership.lock",
  intent: "update.intent", temp: "safety.tmp", checkpointTemp: "sequence.tmp" });
const CRASH_POINTS = Object.freeze(["before_temp_write", "after_temp_write", "after_sync", "after_replace", "after_checkpoint"]);
function create(directory, { crashAt = null } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const root = fs.realpathSync(path.dirname(directory)), rootStat = fs.lstatSync(root);
  if (path.basename(directory) !== DIRECTORY || root !== path.dirname(directory) ||
      crashAt !== null && !CRASH_POINTS.includes(crashAt)) throw Error("safety_core_path_invalid");
  const audit = { fileHandles: 0, lockHandles: 0, opens: 0, reads: 0, writes: 0, syncs: 0,
    directorySyncs: 0, replaces: 0, lockAcquires: 0, lockConflicts: 0, healthy: true };
  const owner = randomUUID(); let owned = false;
  const file = name => path.join(directory, NAMES[name]);
  function handle(name, flags, action) {
    const fd = fs.openSync(file(name), flags | (fs.constants.O_NOFOLLOW || 0), 0o600); audit.fileHandles++; audit.opens++;
    if (name === "lock") audit.lockHandles++;
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) throw Error("safety_file_type_invalid");
      return action(fd, stat); } finally { fs.closeSync(fd); audit.fileHandles--; if (name === "lock") audit.lockHandles--; }
  }
  function checkDirectory() {
    const currentRoot = fs.lstatSync(root);
    if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino || currentRoot.isSymbolicLink()) throw Error("safety_directory_invalid");
    const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("safety_directory_invalid");
    if (process.platform !== "win32" && (stat.mode & 0o077)) throw Error("safety_permissions_invalid");
  }
  function exists(name) { try { fs.lstatSync(file(name)); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
  function read(name, maxBytes) {
    checkDirectory(); return handle(name, fs.constants.O_RDONLY, (fd, stat) => {
      if (stat.size > maxBytes || process.platform !== "win32" && (stat.mode & 0o077)) throw Error("safety_file_access_invalid");
      audit.reads++; return fs.readFileSync(fd, "utf8"); });
  }
  function syncDirectory() {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); audit.fileHandles++;
    try { fs.fsyncSync(fd); audit.directorySyncs++; } finally { fs.closeSync(fd); audit.fileHandles--; }
  }
  function writeNew(name, text, sync = true) {
    handle(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
      fs.writeFileSync(fd, text, "utf8"); audit.writes++;
      if (sync) { fs.fsyncSync(fd); audit.syncs++; }
    });
  }
  function lockVisibleToOther() {
    return exists("lock") && (!owned || read("lock", 1024) !== owner);
  }
  function acquire({ provision = false } = {}) {
    if (!audit.healthy) throw Error("safety_io_interrupted");
    if (provision && !fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 });
      const fd = fs.openSync(path.dirname(directory), fs.constants.O_RDONLY); audit.fileHandles++;
      try { fs.fsyncSync(fd); audit.directorySyncs++; } finally { fs.closeSync(fd); audit.fileHandles--; } }
    checkDirectory();
    if (!owned) {
      try { writeNew("lock", owner); owned = true; syncDirectory(); audit.lockAcquires++; }
      catch (e) { if (e.code === "EEXIST") { audit.lockConflicts++; throw Error("safety_ownership_conflict"); }
        audit.healthy = false; throw e; }
    }
    if (!exists("lock") || read("lock", 1024) !== owner) throw Error("safety_ownership_conflict");
    if (exists("intent")) throw Error("safety_io_interrupted");
  }
  function point(name) { if (crashAt === name) process.exit(86); }
  function replace(record, checkpoint) {
    if (!owned || !audit.healthy || !exists("lock") || read("lock", 1024) !== owner)
      throw Error("safety_ownership_conflict");
    try {
      // Durable intent + ownership survive a crash, even before the first state temp write.
      writeNew("intent", JSON.stringify({ sequence: record.safety.sequence, checksum: record.checksum })); syncDirectory();
      point("before_temp_write");
      writeNew("temp", JSON.stringify(record) + "\n", false); point("after_temp_write");
      handle("temp", fs.constants.O_RDWR, fd => { fs.fsyncSync(fd); audit.syncs++; }); point("after_sync");
      fs.renameSync(file("temp"), file("state")); audit.replaces++; syncDirectory(); point("after_replace");
      writeNew("checkpointTemp", JSON.stringify(checkpoint) + "\n");
      fs.renameSync(file("checkpointTemp"), file("checkpoint")); audit.replaces++; syncDirectory(); point("after_checkpoint");
      fs.unlinkSync(file("intent")); syncDirectory();
    } catch (e) { audit.healthy = false; throw e; } // Never repair/delete interrupted artifacts here.
  }
  function close() {
    if (owned && audit.healthy && !exists("intent")) {
      if (!exists("lock") || read("lock", 1024) !== owner) { audit.healthy = false; throw Error("safety_ownership_conflict"); }
      fs.unlinkSync(file("lock")); syncDirectory(); owned = false;
    }
  }
  return Object.freeze({ read, exists, acquire, lockVisibleToOther, replace, close,
    audit: () => Object.freeze({ ...audit, owned, interruptedIntent: fs.existsSync(directory) && exists("intent") }) });
}
module.exports = Object.freeze({ DIRECTORY, NAMES, CRASH_POINTS, create });
