"use strict";

// Fixed main-side path; no mkdir/open-for-write/provisioning/recovery capability.
const fs = require("node:fs"), path = require("node:path");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const Schema = require("../marketCalendarHistory/writerSafetyFileSchema.js");
const Envelope = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const SourceSet = require("../marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const Permission = require("../marketCalendarHistory/writerSafetySourceSetPermission.js");
const Generation = require("./writerSafetyGenerationReadOnly.js");
const Canary = require("../marketCalendarHistory/mofStartupCanaryEnvelope.js");
const RELATIVE_PATH = "market-calendar-writer-safety/safety.json";
function createReader(userData) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof userData !== "string" || !path.isAbsolute(userData)) throw Error("main_profile_required");
  let highWater = -1, canaryHighWater = -1, foundState = false;
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
  function readHistoricalState(diagnosticControlledOwnership = false) {
    const start = performance.now();
    let status = "corrupt", reason = null, safety = null, record = null, selected = null, controlledAttemptOwned = false;
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
      try { fs.lstatSync(path.join(userData, Generation.DIRECTORY, "controlled.lock"));
        if (!diagnosticControlledOwnership) throw Error("safety_controlled_attempt_owned");
        controlledAttemptOwned = true; }
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
      ...(diagnosticControlledOwnership ? { controlledAttemptOwned, retryAllowed: false } : {}),
      writeAllowed: false, executionAllowed: false, latencyMs: performance.now() - start, audit: { ...audit } });
  }
  function readState(diagnosticControlledOwnership = false) {
    audit.loads++; const start = performance.now();
    const directory = path.join(userData, Canary.DIRECTORY);
    try { fs.lstatSync(directory); }
    catch (e) { if (e.code === "ENOENT") return readHistoricalState(diagnosticControlledOwnership);
      return A.freeze({status:"corrupt",reason:"safety_read_failed",record:null,safety:null,writeAllowed:false,executionAllowed:false}); }
    // A present Envelope4 namespace (even partially activated) never falls back.
    try {
      Generation.secureDirectory(userData); Generation.secureDirectory(directory);
      const p = read(directory, "selection.json", 1024);
      if (!A.exact(p,["schemaVersion","generation","sequence","stateChecksum","checksum"]) || p.schemaVersion !== 1 ||
          !A.integer(p.sequence) || p.generation !== `mof-canary-${p.sequence}` || Schema.seal(p).checksum !== p.checksum)
        throw Error("canary_selection_invalid");
      const parent = path.join(directory,p.generation); Generation.secureDirectory(parent);
      const d = path.join(parent,"market-calendar-writer-safety"), r = read(d,"safety.json",Schema.MAX_BYTES), c = read(d,"sequence.json",1024);
      if (!Canary.validate(r).valid || r.schemaVersion !== 4 || r.checksum !== p.stateChecksum || r.safety.sequence !== p.sequence ||
          !A.exact(c,["schemaVersion","sequence","stateChecksum","checksum"]) || c.schemaVersion !== 4 || c.sequence !== p.sequence ||
          c.stateChecksum !== r.checksum || Schema.seal(c).checksum !== c.checksum) throw Error("canary_generation_invalid");
      for(const name of ["ownership.lock","update.intent"]) {
        try { fs.lstatSync(path.join(d,name)); throw Error("canary_generation_unverified"); } catch(e) { if(e.code!=="ENOENT")throw e; }
      }
      let owned=false;
      try { fs.lstatSync(path.join(directory,"attempt.lock")); owned=true; } catch(e) { if(e.code!=="ENOENT")throw e; }
      if(owned&&!diagnosticControlledOwnership)throw Error("canary_attempt_owned");
      const old=readHistoricalState(true);
      if(old.status!=="valid"||old.controlledAttemptOwned||old.envelopeVersion!==3||old.record.checksum!==r.historicalRecord.checksum)
        throw Error("canary_retained_history_changed");
      if(p.sequence<canaryHighWater)throw Error("safety_sequence_invalid"); canaryHighWater=p.sequence;
      return A.freeze({status:"valid",reason:null,record:r,safety:r.safety,generation:p.generation,envelopeVersion:4,
        sourceSetVersion:2,permissionVersion:2,permissions:Permission.PERMISSIONS,authorityCeiling:Envelope.policyFor(3).global,
        canaryAuthority:Canary.AUTHORITY,...(diagnosticControlledOwnership?{controlledAttemptOwned:owned,retryAllowed:false}:{}),
        writeAllowed:false,executionAllowed:false,latencyMs:performance.now()-start,audit:{...audit}});
    } catch(e) {
      return A.freeze({status:"corrupt",reason:/^[a-z_]+$/.test(e.message)?e.message:"safety_read_failed",record:null,safety:null,
        writeAllowed:false,executionAllowed:false,latencyMs:performance.now()-start,audit:{...audit}});
    }
  }
  // Explicit read-only diagnosis preserves all generation/checkpoint/history
  // checks. It can describe owned state but never releases ownership or resumes.
  return Object.freeze({ load: () => readState(), inspectControlledState: () => readState(true), audit: () => ({ ...audit }) });
}
module.exports = Object.freeze({ RELATIVE_PATH, createReader });
