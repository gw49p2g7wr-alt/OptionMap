"use strict";

// Fixed main-side path; no mkdir/open-for-write/provisioning/recovery capability.
const fs = require("node:fs"), path = require("node:path");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const Schema = require("../marketCalendarHistory/writerSafetyFileSchema.js");
const Envelope = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const SourceSet = require("../marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const Permission = require("../marketCalendarHistory/writerSafetySourceSetPermission.js");
const Generation = require("./writerSafetyGenerationReadOnly.js");
const RELATIVE_PATH = "market-calendar-writer-safety/safety.json";
function createReader(userData) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof userData !== "string" || !path.isAbsolute(userData)) throw Error("main_profile_required");
  let highWater = -1, foundState = false;
  const audit = { loads: 0, reads: 0, writes: 0, handles: 0 };
  function read(directory, name, limit) {
    Generation.secureDirectory(directory);
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    audit.handles++;
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > limit || process.platform !== "win32" && (s.mode & 0o077)) throw Error("safety_file_access_invalid");
      const bytes = Buffer.alloc(limit + 1); let length = 0, n;
      while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
      if (length > limit) throw Error("safety_file_access_invalid");
      audit.reads++; if (name === "safety.json") foundState = true;
      return Schema.parse(bytes.subarray(0, length).toString("utf8"));
    } finally { fs.closeSync(fd); audit.handles--; }
  }
  function pair(directory, selectedGeneration = null, checkOwnership = true) {
    const record = read(directory, "safety.json", Schema.MAX_BYTES);
    if (![1, 2, 3].includes(record?.schemaVersion)) throw Error("safety_envelope_version_unsupported");
    const controlled = Generation.controlledGeneration(selectedGeneration, record.safety.sequence);
    if (record.schemaVersion === 3 && selectedGeneration !== "extended" && !controlled) throw Error("safety_generation_required");
    if (controlled !== !!record.controlledLifecycleAudit) throw Error("safety_controlled_generation_mismatch");
    const checked = record.schemaVersion === 3 ? SourceSet.validate(record) : Envelope.validateEnvelope(record);
    if (!checked.valid) throw Error(checked.reason);
    const c = read(directory, "sequence.json", 1024);
    if (!A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== record.schemaVersion ||
        !A.integer(c.sequence) || c.sequence !== record.safety.sequence || c.stateChecksum !== record.checksum ||
        Schema.seal(c).checksum !== c.checksum) throw Error("safety_sequence_invalid");
    for (const name of checkOwnership ? ["ownership.lock", "update.intent"] : ["update.intent"]) {
      try { fs.lstatSync(path.join(directory, name)); throw Error("safety_io_interrupted_or_owned"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return record;
  }
  function load() {
    audit.loads++; const start = performance.now();
    let status = "corrupt", reason = null, safety = null, record = null, selected = null;
    foundState = false;
    try {
      selected = Generation.select(userData, read); foundState = !!selected.selection;
      record = pair(selected.directory, selected.generation); foundState = true;
      if (record.safety.sequence < highWater) throw Error("safety_sequence_invalid");
      if (selected.selection) {
        const s = selected.selection;
        if (s.sequence !== record.safety.sequence || s.stateChecksum !== record.checksum ||
            record.schemaVersion !== (s.generation === "baseline" ? 2 : 3)) throw Error("safety_selection_mismatch");
        // Pin the retained production pair. Ignore only its migration ownership:
        // selected immutable generations have their own checked lock/intent state.
        const retained = pair(path.join(userData, "market-calendar-writer-safety"), null, false);
        if (retained.checksum !== (record.schemaVersion === 3 ? record.historicalRecord : record).checksum)
          throw Error("safety_retained_baseline_changed");
      }
      highWater = record.safety.sequence;
      // An authorization-only crash has no pending record yet. Its durable
      // ownership latch prevents recreating a first-write authorization on restart.
      try { fs.lstatSync(path.join(userData, Generation.DIRECTORY, "controlled.lock")); throw Error("safety_controlled_attempt_owned"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      safety = record.schemaVersion === 2 ? Envelope.safetyInput(record.safety) : record.safety; status = "valid";
    } catch (e) {
      status = e.code === "ENOENT" && !foundState ? "missing" : "corrupt";
      reason = status === "missing" ? "safety_state_missing" : /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed";
      safety = null; record = null;
    }
    return A.freeze({ status, reason, safety, record, generation: selected?.generation || null,
      envelopeVersion: record?.schemaVersion ?? null, sourceSetVersion: record?.schemaVersion === 3 ? 2 : record ? 1 : null,
      permissionVersion: record?.safety.sourcePermissionVersion ?? null,
      permissions: record?.schemaVersion === 3 ? Permission.PERMISSIONS : null,
      authorityCeiling: record?.schemaVersion === 3 ? Envelope.policyFor(3).global : null,
      writeAllowed: false, executionAllowed: false, latencyMs: performance.now() - start, audit: { ...audit } });
  }
  return Object.freeze({ load, audit: () => ({ ...audit }) });
}
module.exports = Object.freeze({ RELATIVE_PATH, createReader });
