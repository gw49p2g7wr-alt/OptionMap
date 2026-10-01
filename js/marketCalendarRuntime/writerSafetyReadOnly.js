"use strict";

// Fixed main-side path; no mkdir/open-for-write/provisioning/recovery capability.
const fs = require("node:fs"), path = require("node:path");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const Schema = require("../marketCalendarHistory/writerSafetyFileSchema.js");
const Envelope = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const RELATIVE_PATH = "market-calendar-writer-safety/safety.json";
function createReader(userData) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof userData !== "string" || !path.isAbsolute(userData)) throw Error("main_profile_required");
  let highWater = -1;
  const audit = { loads: 0, reads: 0, writes: 0, handles: 0 };
  const directory = path.join(userData, "market-calendar-writer-safety");
  function read(name, limit) {
    const d = fs.lstatSync(directory);
    if (!d.isDirectory() || d.isSymbolicLink() || process.platform !== "win32" && (d.mode & 0o077)) throw Error("safety_directory_invalid");
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    audit.handles++;
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > limit || process.platform !== "win32" && (s.mode & 0o077)) throw Error("safety_file_access_invalid");
      const bytes = Buffer.alloc(limit + 1); let length = 0, n;
      while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
      if (length > limit) throw Error("safety_file_access_invalid");
      audit.reads++; return Schema.parse(bytes.subarray(0, length).toString("utf8"));
    } finally { fs.closeSync(fd); audit.handles--; }
  }
  function load() {
    audit.loads++; const start = performance.now();
    let status = "corrupt", reason = null, safety = null, foundState = false;
    try {
      const record = read("safety.json", Schema.MAX_BYTES); foundState = true;
      const checked = Envelope.validateEnvelope(record);
      if (!checked.valid) throw Error(checked.reason);
      const c = read("sequence.json", 1024);
      if (!A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== record.schemaVersion ||
          !A.integer(c.sequence) || c.sequence !== record.safety.sequence || c.sequence < highWater ||
          c.stateChecksum !== record.checksum || Schema.seal(c).checksum !== c.checksum) throw Error("safety_sequence_invalid");
      for (const name of ["ownership.lock", "update.intent"]) {
        try { fs.lstatSync(path.join(directory, name)); throw Error("safety_io_interrupted_or_owned"); }
        catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      highWater = c.sequence; safety = record.schemaVersion === 2 ? Envelope.safetyInput(record.safety) : record.safety; status = "valid";
    } catch (e) {
      status = e.code === "ENOENT" && !foundState ? "missing" : "corrupt";
      reason = status === "missing" ? "safety_state_missing" : /^[a-z_]+$/.test(e.message) ? e.message : "safety_read_failed";
    }
    return A.freeze({ status, reason, safety, latencyMs: performance.now() - start, audit: { ...audit } });
  }
  return Object.freeze({ load, audit: () => ({ ...audit }) });
}
module.exports = Object.freeze({ RELATIVE_PATH, createReader });
