"use strict";

// E2b isolated public contract unchanged; only IO mechanics are shared.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Core = require("./writerSafetyAtomicCore.js");
const { DIRECTORY, NAMES, CRASH_POINTS } = Core;
function create(directory, { crashAt = null } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const root = fs.realpathSync(path.dirname(directory));
  if (path.basename(directory) !== DIRECTORY || path.dirname(root) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(root).startsWith("optionmap-writer-safety-") || root !== path.dirname(directory) ||
      crashAt !== null && !CRASH_POINTS.includes(crashAt)) throw Error("isolated_store_path_invalid");
  return Core.create(directory, { crashAt });
}
module.exports = Object.freeze({ DIRECTORY, NAMES, CRASH_POINTS, create });
