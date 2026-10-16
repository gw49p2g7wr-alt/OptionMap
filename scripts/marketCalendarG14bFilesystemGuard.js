"use strict";

// Migration-harness access policy only. No adapter invocation, state load,
// provisioning, migration, Electron launch or filesystem mutation on import.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const PRODUCTION_PROFILE = "/Users/natsu/Library/Application Support/OptionMap";
const PRODUCTION_PARENTS = Object.freeze(["/Users/natsu/Library", "/Users/natsu/Library/Application Support"]);
const METADATA = Object.freeze(["lstatSync", "statSync", "realpathSync"]);
const PARENT_METADATA = Object.freeze(["lstatSync"]);
const FILE_NAMES = Object.freeze(["safety.json", "sequence.json", "ownership.lock", "update.intent", "safety.tmp", "sequence.tmp"]);
const fail = reason => { const e = Error(reason); e.code = "EACCES"; throw e; };
function build(profile, parents, isolated) {
  const windowsProfile = /^(?:[a-z]:[\\/]|\\\\)/i.test(profile), pathApi = windowsProfile ? path.win32 : path.posix;
  const join = (...parts) => pathApi.join(...parts), child = (root, target) => target.startsWith(root + pathApi.sep);
  const legacy = join(profile, "market-calendar-writer-safety"), generations = join(profile, "market-calendar-source-set-safety");
  const directories = [profile, legacy, generations, ...["baseline", "extended"].flatMap(g =>
    [join(generations, g), join(generations, g, "market-calendar-writer-safety")])];
  const files = [...FILE_NAMES.map(n => join(legacy, n)), ...["migration.lock", "selection.json", "selection.tmp"].map(n => join(generations, n)),
    ...["baseline", "extended"].flatMap(g => FILE_NAMES.map(n => join(generations, g, "market-calendar-writer-safety", n)))];
  const writes = [join(legacy, "ownership.lock"), ...files.filter(p => child(generations, p))];
  function classify(p) {
    if (typeof p !== "string" || !pathApi.isAbsolute(p) || p.includes("\0") || pathApi.normalize(p) !== p) return "invalid";
    if (parents.includes(p)) return "parent_metadata";
    if (directories.includes(p)) return "safety_directory";
    if (files.includes(p)) return "safety_file";
    return "forbidden";
  }
  function permits(p, operation, writing = false) {
    const kind = classify(p);
    if (kind === "parent_metadata") return !writing && PARENT_METADATA.includes(operation);
    if (kind === "safety_directory") return METADATA.includes(operation) || !writing && ["existsSync", "openDirectoryForSync"].includes(operation) ||
      writing && p !== profile && p !== legacy && operation === "mkdirSync";
    if (kind !== "safety_file") return false;
    if (METADATA.includes(operation) || operation === "existsSync") return !writing;
    if (!writing) return ["openSync", "readFileSync", "readSync", "fstatSync", "closeSync"].includes(operation);
    return writes.includes(p) && ["openSync", "writeFileSync", "writeSync", "fsyncSync", "renameSync", "unlinkSync"].includes(operation);
  }
  function assertAccess(p, operation, writing = false) {
    if (!permits(p, operation, writing)) fail("migration_guard_access_denied");
  }
  function scopedMetadataFs(rawFs = fs) {
    const raw = Object.fromEntries(["lstatSync", "statSync", "realpathSync"].map(n => [n, rawFs[n].bind(rawFs)]));
    const touches = [];
    function noSymlinks(p) {
      // Only the two explicitly approved parents and fixed target segments are
      // inspected. A link is rejected before resolving or reading its target.
      // Realpath already needs these fixed ancestor metadata checks. Inspect
      // their link type first, rather than following an alias into another tree.
      const ancestors = [];
      let ancestor = pathApi.parse(parents[0]).root;
      for (const part of parents[0].slice(ancestor.length).split(pathApi.sep).filter(Boolean)) {
        ancestor = pathApi.join(ancestor, part); ancestors.push(ancestor);
      }
      const checks = [...ancestors, ...parents, ...directories.filter(d => p === d || child(d, p)), ...(files.includes(p) ? [p] : [])];
      for (const part of [...new Set(checks)]) {
        try { const s = raw.lstatSync(part); touches.push({ path: part, operation: "lstatSync", validation: true });
          if (s.isSymbolicLink()) fail("migration_guard_symlink_rejected"); }
        catch (e) { if (e.code === "ENOENT" && !parents.includes(part)) break; throw e; }
      }
    }
    function checked(p, operation, args) {
      assertAccess(p, operation); noSymlinks(p);
      const result = raw[operation](p, ...args); touches.push({ path: p, operation, validation: false });
      if (operation === "realpathSync" && result !== p) fail("migration_guard_resolved_path_mismatch");
      return result;
    }
    return Object.freeze({ lstatSync: (p, ...args) => checked(p, "lstatSync", args), statSync: (p, ...args) => checked(p, "statSync", args),
      realpathSync: (p, ...args) => checked(p, "realpathSync", args), audit: () => touches.map(t => ({ ...t })) });
  }
  function seatbeltProfile() {
    const literal = p => `(literal ${JSON.stringify(p)})`, except = list => list.map(p => `(require-not ${literal(p)})`).join("\n");
    // file-read-data is deliberately NOT granted to parent directories.
    // Seatbelt's metadata permission is coarser than the JS lstat-only rule.
    const library = parents[0], support = parents[1], home = path.dirname(library);
    const metadataPaths = [...parents, ...directories, ...files];
    const dataPaths = [profile, ...directories.slice(1), ...files];
    const out = ["(version 1)", "(allow default)", "(deny network*)",
      `(deny file-read-data ${literal(home)})`,
      `(deny file-read-data (require-all (subpath ${JSON.stringify(library)})\n${except(dataPaths)}))`,
      `(deny file-read-metadata (require-all (subpath ${JSON.stringify(library)})\n${except(metadataPaths)}))`,
      `(deny file-write* (require-all (subpath ${JSON.stringify(library)})\n${except([...directories, ...writes])}))`,
      `(deny file-write* ${literal(support)})`, `(deny file-write* ${literal(library)})`,
      `(deny file-write* ${literal(join(legacy, "safety.json"))})`, `(deny file-write* ${literal(join(legacy, "sequence.json"))})`];
    if (isolated) out.push(`(deny file-read* (subpath ${JSON.stringify(PRODUCTION_PROFILE)}))`,
      `(deny file-write* (subpath ${JSON.stringify(PRODUCTION_PROFILE)}))`);
    return out.join("\n") + "\n";
  }
  return Object.freeze({ profile, parents: Object.freeze([...parents]), parentOperations: PARENT_METADATA,
    directories: Object.freeze(directories), files: Object.freeze(files), classify, permits, assertAccess, scopedMetadataFs, seatbeltProfile });
}
function createProductionPolicy(...args) {
  if (args.length) fail("migration_guard_production_override_rejected");
  return build(PRODUCTION_PROFILE, PRODUCTION_PARENTS, false);
}
function windowsMainAuthority(app) {
  const profile = app.getPath("userData"), appData = app.getPath("appData");
  if (!path.win32.isAbsolute(profile) || !path.win32.isAbsolute(appData) ||
      !Filesystem.contains(appData, profile, "win32") ||
      path.win32.dirname(Filesystem.normalize(profile, "win32")) !== Filesystem.normalize(appData, "win32") ||
      path.win32.basename(profile).toLowerCase() !== "optionmap") fail("migration_guard_windows_profile_invalid");
  return Object.freeze({ profile, parents: Object.freeze([path.win32.dirname(appData), appData]) });
}
function createWindowsMainPolicy(...args) {
  if (args.length || process.platform !== "win32" || process.type !== "browser" || !process.versions.electron)
    fail("migration_guard_windows_main_required");
  const authority = windowsMainAuthority(require("electron").app);
  return build(authority.profile, authority.parents, false);
}
function createIsolatedPolicy(options) {
  if (!options || Object.keys(options).sort().join("|") !== "fixtureRoot|targetEnvironment" || options.targetEnvironment !== "isolated_test")
    fail("migration_guard_fixture_invalid");
  const root = options.fixtureRoot;
  if (typeof root !== "string" || !path.isAbsolute(root) || !path.basename(root).startsWith("optionmap-g14bg-fixture-") ||
    !Filesystem.samePath(path.dirname(root), fs.realpathSync(os.tmpdir())) || fs.lstatSync(root).isSymbolicLink() ||
    !Filesystem.samePath(fs.realpathSync(root), root))
    fail("migration_guard_fixture_invalid");
  const library = root + "/Users/natsu/Library", support = library + "/Application Support";
  return build(support + "/OptionMap", [library, support], true);
}
module.exports = Object.freeze({ PRODUCTION_PROFILE, PRODUCTION_PARENTS, PARENT_METADATA,
  createProductionPolicy, windowsMainAuthority, createWindowsMainPolicy, createIsolatedPolicy });
