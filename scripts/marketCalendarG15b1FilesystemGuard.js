"use strict";

// Exact extension of G1.4b-G, not a Library/** allowance. This module performs
// no filesystem access on import. Parent operations remain lstatSync only.
const fs = require("node:fs"), path = require("node:path");
const Base = require("./marketCalendarG14bFilesystemGuard.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const Generation = require("../js/marketCalendarRuntime/writerSafetyGenerationReadOnly.js");
const Atomic = require("../js/marketCalendarHistory/writerSafetyAtomicCore.js");
const template = Base.createProductionPolicy();
function deny() { const e = Error("controlled_guard_access_denied"); e.code = "EACCES"; throw e; }
function bindResolvedProfile(root, selection = null, record = null) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root || path.basename(root) !== "OptionMap")
    throw Error("controlled_guard_profile_invalid");
  if (selection && (!A.exact(selection, ["schemaVersion", "generation", "sequence", "stateChecksum", "checksum"]) ||
    selection.schemaVersion !== 1 || !A.integer(selection.sequence) || !A.isHash(selection.stateChecksum) ||
    File.seal(selection).checksum !== selection.checksum || !(["baseline", "extended"].includes(selection.generation) ||
      Generation.controlledGeneration(selection.generation, selection.sequence)))) throw Error("safety_selection_invalid");
  if (record && (record.schemaVersion !== 3 || !E.validate(record).valid)) throw Error("controlled_guard_state_invalid");
  const support = path.dirname(root), library = path.dirname(support), parents = [library, support];
  const sourceSet = path.join(root, Generation.DIRECTORY), names = Object.values(Atomic.NAMES);
  const frames = new Set(selection && Generation.controlledGeneration(selection.generation, selection.sequence) ? [selection.generation] : []);
  if (record) for (let i = 1; i <= 5; i++) frames.add(`controlled-${record.sourceSetAudit[0].nextSequence + i}`);
  const directories = new Set([...frames].flatMap(g => [path.join(sourceSet, g), path.join(sourceSet, g, Atomic.DIRECTORY)]));
  const files = new Set([...frames].flatMap(g => names.map(n => path.join(sourceSet, g, Atomic.DIRECTORY, n))));
  const latch = path.join(sourceSet, "controlled.lock"), temp = path.join(sourceSet, "controlled-selection.tmp"), pointer = path.join(sourceSet, "selection.json");
  const map = p => p === parents[0] ? template.parents[0] : p === parents[1] ? template.parents[1] :
    p === root || p.startsWith(root + "/") ? template.profile + p.slice(root.length) : null;
  function permits(p, operation, writing = false) {
    if (typeof p !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p || p.includes("\0")) return false;
    if (parents.includes(p)) return !writing && Base.PARENT_METADATA.includes(operation);
    // Read-only generation dispatch may test the exact additive namespace.
    // No contents, enumeration or mutation: a present new version stops this
    // historical controlled adapter rather than granting it new authority.
    if(p===path.join(root,"market-calendar-mof-startup-canary"))return !writing&&operation==="lstatSync";
    const translated = map(p);
    if (!writing && translated && template.permits(translated, operation, false)) return true;
    if (directories.has(p)) return !writing && ["lstatSync", "statSync", "realpathSync", "existsSync", "openDirectoryForSync"].includes(operation) ||
      writing && !!record && operation === "mkdirSync";
    if (![latch, temp].includes(p) && !files.has(p) && !(writing && p === pointer)) return false;
    if (!writing) return ["lstatSync", "statSync", "realpathSync", "existsSync", "openSync", "readFileSync"].includes(operation);
    if (!record) return false;
    if (operation === "unlinkSync") return p === latch || [Atomic.NAMES.lock, Atomic.NAMES.intent].includes(path.basename(p));
    if (operation === "renameSync") return p === temp || p === pointer || [Atomic.NAMES.temp, Atomic.NAMES.checkpointTemp,
      Atomic.NAMES.state, Atomic.NAMES.checkpoint].includes(path.basename(p));
    return ["openSync", "writeFileSync"].includes(operation) && (p === latch || p === temp ||
      [Atomic.NAMES.lock, Atomic.NAMES.intent, Atomic.NAMES.temp, Atomic.NAMES.checkpointTemp].includes(path.basename(p)));
  }
  return Object.freeze({ profile: root, parents: Object.freeze(parents), parentOperations: Base.PARENT_METADATA,
    generations: Object.freeze([...frames]), permits, assertAccess: (p, op, writing = false) => { if (!permits(p, op, writing)) deny(); } });
}
function scoped(policy, action) {
  const keys = ["lstatSync", "statSync", "realpathSync", "existsSync", "openSync", "fstatSync", "readFileSync", "writeFileSync",
    "readSync", "writeSync", "closeSync", "fsyncSync", "mkdirSync", "renameSync", "unlinkSync", "readdirSync"];
  const raw = Object.fromEntries(keys.map(k => [k, fs[k]])), descriptors = new Map(), touches = [];
  const forbidden = ["opendirSync", "globSync", "watch", "watchFile", "readdir", "opendir", "readFile", "writeFile", "open",
    "mkdir", "rename", "unlink", "rmSync", "rmdirSync", "copyFileSync", "linkSync", "symlinkSync", "truncateSync"];
  for (const k of forbidden) if (typeof fs[k] === "function") { raw[k] = fs[k]; fs[k] = () => deny(); }
  const promises = Object.fromEntries(["open", "readdir", "opendir", "readFile", "writeFile", "stat", "lstat", "realpath", "mkdir",
    "rename", "unlink", "rm", "copyFile", "link", "symlink", "truncate", "watch"].filter(k => typeof fs.promises[k] === "function")
    .map(k => [k, fs.promises[k]]));
  for (const k of Object.keys(promises)) fs.promises[k] = () => deny();
  const metadata = ["lstatSync", "statSync", "realpathSync"];
  function noSymlinks(p) {
    let current = path.parse(p).root;
    for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if (raw.lstatSync(current).isSymbolicLink()) throw Error("controlled_guard_symlink_rejected"); }
      catch (e) { if (e.code === "ENOENT") break; throw e; }
    }
  }
  function access(p, op, writing = false) { policy.assertAccess(p, op, writing); noSymlinks(p); touches.push({ path: p, operation: op, writing }); }
  function fdInfo(fd, writing = false) { const info = descriptors.get(fd); if (!info || writing && !info.writing && !info.directory) deny(); return info; }
  function mode(flags) {
    if (flags === "r") return false;
    if (typeof flags === "string") { if (!["r+", "w", "w+", "wx", "wx+", "a", "a+", "ax", "ax+"].includes(flags)) deny(); return true; }
    if (!Number.isSafeInteger(flags) || flags < 0) deny();
    if (flags === fs.constants.O_RDONLY || flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) return false;
    const known = 3 | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_TRUNC | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    if ((flags & ~known) || (flags & 3) === 3 || !(flags & 3)) deny(); return true;
  }
  for (const k of metadata) fs[k] = (p, ...args) => { access(p, k); const result = raw[k](p, ...args);
    if (k === "realpathSync" && result !== p) throw Error("controlled_guard_resolved_path_mismatch"); return result; };
  fs.existsSync = p => { access(p, "existsSync"); return raw.existsSync(p); };
  fs.openSync = (p, flags, ...args) => {
    const writing = mode(flags); let directory = false;
    if (!policy.permits(p, "openSync", writing) && !policy.permits(p, "openDirectoryForSync", writing)) deny();
    try { const s = raw.lstatSync(p); directory = s.isDirectory();
      if (!directory && !s.isFile()) throw Error("controlled_guard_file_type_rejected"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    access(p, directory ? "openDirectoryForSync" : "openSync", writing);
    const fd = raw.openSync(p, flags, ...args); descriptors.set(fd, { path: p, writing, directory }); return fd;
  };
  fs.fstatSync = fd => { fdInfo(fd); return raw.fstatSync(fd); };
  fs.readFileSync = (p, ...args) => { if (typeof p === "number") fdInfo(p); else access(p, "readFileSync"); return raw.readFileSync(p, ...args); };
  fs.writeFileSync = (p, ...args) => { if (typeof p === "number") fdInfo(p, true); else access(p, "writeFileSync", true); return raw.writeFileSync(p, ...args); };
  fs.readSync = (fd, ...args) => { fdInfo(fd); return raw.readSync(fd, ...args); };
  fs.writeSync = (fd, ...args) => { fdInfo(fd, true); return raw.writeSync(fd, ...args); };
  fs.fsyncSync = fd => { fdInfo(fd, true); return raw.fsyncSync(fd); };
  fs.closeSync = fd => { fdInfo(fd); try { return raw.closeSync(fd); } finally { descriptors.delete(fd); } };
  fs.mkdirSync = (p, options) => { access(p, "mkdirSync", true); if (options?.recursive) deny(); return raw.mkdirSync(p, options); };
  fs.renameSync = (p, next) => { access(p, "renameSync", true); access(next, "renameSync", true); return raw.renameSync(p, next); };
  fs.unlinkSync = p => { access(p, "unlinkSync", true); return raw.unlinkSync(p); };
  fs.readdirSync = () => deny();
  try { const value = action(); if (value?.then) throw Error("controlled_guard_async_scope_forbidden");
    return { value, touches }; }
  finally { for (const [k, fn] of Object.entries(raw)) fs[k] = fn;
    for (const [k, fn] of Object.entries(promises)) fs.promises[k] = fn; }
}
function policyFor(root, record = null) {
  const cold = bindResolvedProfile(root); let selection = null;
  const pointer = path.join(root, Generation.DIRECTORY, "selection.json");
  const observed = scoped(cold, () => {
    let fd;
    try { fd = fs.openSync(pointer, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (fs.fstatSync(fd).size > 1024) throw Error("safety_selection_invalid");
      selection = File.parse(fs.readFileSync(fd, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  return Object.freeze({ ...bindResolvedProfile(root, selection, record), selectionTouches: observed.touches });
}
module.exports = Object.freeze({ bindResolvedProfile, scoped, policyFor });
