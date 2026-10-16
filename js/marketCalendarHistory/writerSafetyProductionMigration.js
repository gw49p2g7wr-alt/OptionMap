"use strict";

// Explicit migration only. No arbitrary state setter, writer, auto-upgrade or
// caller-provided production path. The historical pair remains byte-identical.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("./formalWriterAuthorityV2.js");
const Envelope = require("./writerSafetySourceSetEnvelope.js"), Core = require("./writerSafetySourceSetAtomicCore.js");
const Profile = require("./writerSafetyInitialProvisioning.js");
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
const reason = e => /^[a-z_]+$/.test(e.message) ? e.message : "source_set_migration_failed";
function build(root, crashAt) {
  const reader = Reader.createReader(root);
  let attempted = false, closed = false, busy = false, store = null;
  function preflight(input) {
    if (closed || busy) return A.freeze({ eligible: false, reason: "migration_adapter_unavailable", writes: 0 });
    const loaded = reader.load();
    if (loaded.status !== "valid") return A.freeze({ eligible: false, reason: loaded.reason, writes: 0 });
    try {
      if (loaded.generation !== "legacy") throw Error("source_set_migration_already_prepared");
      // Existing abandoned preparation is never adopted/deleted/retried.
      try { fs.lstatSync(path.join(root, Core.DIRECTORY)); throw Error("source_set_preparation_exists"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      Envelope.migrateSourceSet(loaded.record, input);
      return A.freeze({ eligible: true, reason: null, record: loaded.record, sequence: loaded.safety.sequence,
        nextSequence: loaded.safety.sequence + 1, writes: 0, executionAllowed: false });
    } catch (e) { return A.freeze({ eligible: false, reason: reason(e), writes: 0 }); }
  }
  async function migrateSourceSet(input) {
    if (attempted || closed) return A.freeze({ saved: false, reason: "migration_attempt_consumed", executionAllowed: false });
    attempted = true;
    const before = preflight(input);
    if (!before.eligible) return A.freeze({ saved: false, reason: before.reason, executionAllowed: false });
    busy = true;
    try {
      store = Core.createProfileMigrationStore(root, crashAt);
      // The only mutable operation exposed is the accepted dedicated API.
      const migrated = await store.migrateSourceSet(input);
      if (!migrated.saved) throw Error(migrated.reason);
      const fresh = Reader.createReader(root).load();
      if (fresh.status !== "valid" || fresh.record.checksum !== migrated.record.checksum || fresh.envelopeVersion !== 3)
        throw Error("safety_fresh_load_failed");
      return A.freeze({ ...migrated, freshReadback: true, executionAllowed: false });
    } catch (e) { return A.freeze({ saved: false, reason: reason(e), writerStopped: true, executionAllowed: false }); }
    finally { try { store?.close(); } finally { busy = false; } }
  }
  function close() { if (busy) throw Error("safety_update_in_progress"); store?.close(); closed = true; }
  function audit() { return A.freeze({ attempted, busy, closed, reader: reader.audit(),
    generations: store?.audit().generations || [], retained: store?.audit().retained || null, writerExecution: 0 }); }
  return Object.freeze({ preflight, migrateSourceSet, close, audit });
}
function createProductionAdapter(...args) {
  if (args.length) throw Error("production_path_override_rejected");
  return build(Profile.resolveProductionProfile(), null);
}
function createIsolatedAdapter(options) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (!A.exact(options, ["targetEnvironment", "userData", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
      options.crashAt !== null && !Core.PROFILE_CRASH_POINTS.includes(options.crashAt)) throw Error("isolated_source_set_store_invalid");
  // Reject non-temp inputs lexically before probing any caller-supplied path.
  if (typeof options.userData !== "string" || !path.isAbsolute(options.userData) ||
      !path.basename(options.userData).startsWith("optionmap-writer-safety-") ||
      !Filesystem.samePath(path.dirname(options.userData), fs.realpathSync(os.tmpdir()))) throw Error("isolated_store_path_invalid");
  const root = fs.realpathSync(options.userData);
  if (!Filesystem.samePath(root, options.userData)) throw Error("isolated_store_path_invalid");
  return build(root, options.crashAt);
}
module.exports = Object.freeze({ createProductionAdapter, createIsolatedAdapter });
