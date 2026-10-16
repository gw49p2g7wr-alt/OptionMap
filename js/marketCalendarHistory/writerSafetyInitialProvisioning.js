"use strict";

// Explicit one-time boundary, never imported by normal startup/manual runtime.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createHash } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), S = require("./formalWriterSafetyEvaluator.js");
const Schema = require("./writerSafetyFileSchema.js"), Core = require("./writerSafetyAtomicCore.js");
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
function mainOnly() { if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only"); }
function productionProfileAuthority(app, platform = process.platform) {
  const appData = app.getPath("appData"), userData = app.getPath("userData");
  if (platform !== "win32") return { fixed: path.join(appData, "OptionMap"), userData };
  if (!path.win32.isAbsolute(appData) || !path.win32.isAbsolute(userData) ||
      !Filesystem.contains(appData, userData, "win32") ||
      path.win32.dirname(Filesystem.normalize(userData, "win32")) !== Filesystem.normalize(appData, "win32") ||
      path.win32.basename(userData).toLowerCase() !== "optionmap") throw Error("production_profile_identity_invalid");
  return { fixed: userData, userData };
}
function resolveProductionProfile() {
  mainOnly();
  if (!process.versions.electron || process.type !== "browser") throw Error("native_main_required");
  const { app } = require("electron"), authority = productionProfileAuthority(app), fixed = authority.fixed;
  if (!Filesystem.samePath(authority.userData, fixed) || fs.lstatSync(fixed).isSymbolicLink() ||
      !Filesystem.samePath(fs.realpathSync(fixed), fixed))
    throw Error("production_profile_identity_invalid");
  return fixed;
}
function initial(record) {
  return Schema.validate(record).valid && record.safety.sequence === 0 && record.safety.pendingFence === null &&
    !record.safety.globalSuspend.suspended && record.fenceDetails === null && record.transitionAudit.length === 1 &&
    record.safety.sources.every(s => !s.suspended && Object.values(s.counters).every(c => c.count === 0 && c.cycleOrdinal === 0 && c.cycleIdentity === null && c.outcome === null));
}
function build(root) {
  const directory = path.join(root, Core.DIRECTORY), io = Core.create(directory);
  let attempted = false;
  function provision() {
    if (attempted) return { saved: false, reason: "provision_attempt_consumed", writeAllowed: false };
    attempted = true; const start = performance.now();
    try {
      // Even a partial/unknown existing directory is not adopted or repaired.
      try { fs.lstatSync(directory); throw Error("safety_store_already_exists"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (A.PRODUCTION_POLICY.global.state !== "disabled") throw Error("writer_authority_invalid");
      const record = Schema.build(null, S.createMemorySafety(), null, "provision_disabled", A.PRODUCTION_POLICY);
      if (!initial(record)) throw Error("initial_state_invalid");
      io.acquire({ provision: true });
      if (["state", "checkpoint", "temp", "checkpointTemp"].some(io.exists)) throw Error("safety_provision_requires_empty_store");
      const checkpoint = Schema.seal({ schemaVersion: 1, sequence: 0, stateChecksum: record.checksum });
      io.replace(record, checkpoint);
      const actual = Schema.parse(io.read("state", Schema.MAX_BYTES)), c = Schema.parse(io.read("checkpoint", 1024));
      if (!initial(actual) || actual.checksum !== record.checksum || JSON.stringify(c) !== JSON.stringify(checkpoint)) throw Error("safety_durable_readback_mismatch");
      io.close();
      const fresh = Reader.createReader(root).load();
      if (fresh.status !== "valid" || fresh.safety.sequence !== 0 || fresh.safety.pendingFence) throw Error("safety_fresh_load_failed");
      return { saved: true, reason: null, persistMs: performance.now() - start, sequence: 0, checksum: record.checksum,
        contentHash: createHash("sha256").update(fs.readFileSync(path.join(directory, Core.NAMES.state))).digest("hex"),
        audit: { initialProvision: 1, canonicalCreates: 2, readBack: 1, freshLoad: 1, unintendedRewrite: 0, ...io.audit() },
        writeAllowed: false, writerExecution: 0 };
    } catch (e) {
      // No retry, adoption, deletion or repair after interrupted persistence.
      return { saved: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "provision_failed", audit: io.audit(), writeAllowed: false };
    }
  }
  return Object.freeze({ provision, close: io.close, audit: io.audit });
}
function createProductionProvisioner() { return build(resolveProductionProfile()); }
function createIsolatedProvisioner(root) {
  mainOnly(); const canonical = fs.realpathSync(root);
  if (canonical !== root || fs.lstatSync(root).isSymbolicLink() || path.dirname(root) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(root).startsWith("optionmap-writer-safety-")) throw Error("isolated_profile_invalid");
  return build(root);
}
module.exports = Object.freeze({ productionProfileAuthority, resolveProductionProfile, createProductionProvisioner, createIsolatedProvisioner, initial });
