"use strict";

// Historical isolated API and dedicated temp boundary remain unchanged.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
const A = require("./formalWriterAuthorityV2.js"), Core = require("./writerSafetySourceSetAtomicCore.js");
function createIsolatedStore(options) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (!A.exact(options, ["targetEnvironment", "userData", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
      options.crashAt !== null && !Core.CRASH_POINTS.includes(options.crashAt)) throw Error("isolated_source_set_store_invalid");
  const root = fs.realpathSync(options.userData);
  if (!Filesystem.samePath(root, options.userData) || !Filesystem.samePath(path.dirname(root), fs.realpathSync(os.tmpdir())) ||
      !path.basename(root).startsWith("optionmap-writer-safety-")) throw Error("isolated_store_path_invalid");
  return Core.createGenerationStore(root, options.crashAt);
}
module.exports = Object.freeze({ DIRECTORY: Core.DIRECTORY, CRASH_POINTS: Core.CRASH_POINTS, createIsolatedStore });
