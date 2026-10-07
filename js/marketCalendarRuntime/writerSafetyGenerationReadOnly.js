"use strict";

// Selection is read-only. Only ENOENT at the fixed pointer permits legacy read.
// A present but invalid pointer/generation never falls back or repairs itself.
const fs = require("node:fs"), path = require("node:path");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const File = require("../marketCalendarHistory/writerSafetyFileSchema.js");
const DIRECTORY = "market-calendar-source-set-safety";
function secureDirectory(directory) {
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      process.platform !== "win32" && (s.mode & 0o077)) throw Error("safety_directory_invalid");
}
function select(root, read) {
  if (root !== fs.realpathSync(root) || fs.lstatSync(root).isSymbolicLink()) throw Error("safety_profile_invalid");
  const directory = path.join(root, DIRECTORY);
  try { secureDirectory(directory); }
  catch (e) { if (e.code === "ENOENT") return { generation: "legacy", directory: path.join(root, "market-calendar-writer-safety"), selection: null };
    throw e; }
  let selection;
  try { selection = read(directory, "selection.json", 1024); }
  catch (e) { if (e.code === "ENOENT") return { generation: "legacy", directory: path.join(root, "market-calendar-writer-safety"), selection: null };
    throw e; }
  if (!A.exact(selection, ["schemaVersion", "generation", "sequence", "stateChecksum", "checksum"]) ||
      selection.schemaVersion !== 1 || !["baseline", "extended"].includes(selection.generation) ||
      !A.integer(selection.sequence) || !A.isHash(selection.stateChecksum) || File.seal(selection).checksum !== selection.checksum)
    throw Error("safety_selection_invalid");
  const parent = path.join(directory, selection.generation); secureDirectory(parent);
  return { generation: selection.generation, directory: path.join(parent, "market-calendar-writer-safety"), selection };
}
module.exports = Object.freeze({ DIRECTORY, secureDirectory, select });
