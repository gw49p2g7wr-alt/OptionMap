"use strict";

// E4e-2b envelope only. The E4e-2a safety/authority contract is not extended.
const A = require("./formalWriterAuthorityV2.js");
const Safety = require("./formalWriterSafetyEvaluator.js");
const VERSION = 1, MAX_AUDIT = 128, MAX_BYTES = 512 * 1024;
const PHASES = Object.freeze(["prepared", "transaction_started", "committed_unverified"]);
const AUDIT_KEYS = Object.freeze(["previousAuthorityVersion", "nextAuthorityVersion", "previousPermissionVersion",
  "nextPermissionVersion", "previousSafetySequence", "nextSafetySequence", "reasonCode", "activatedSources",
  "suspendedSources", "previousAuditIdentity", "auditIdentity"]);
function parse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw Error("safety_file_size_invalid");
  // JSON.parse alone silently accepts duplicate object keys. Reject them at every depth.
  const token = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  let offset = 0;
  function next() { token.lastIndex = offset; const m = token.exec(text); if (!m) throw Error("safety_json_invalid");
    offset = token.lastIndex; return m[1]; }
  function value(t, depth) {
    if (depth > 64) throw Error("safety_json_invalid");
    if (t === "{") {
      const keys = new Set(); let key = next(); if (key === "}") return;
      while (true) {
        if (!key.startsWith('"')) throw Error("safety_json_invalid");
        key = JSON.parse(key); if (keys.has(key)) throw Error("safety_json_duplicate_key"); keys.add(key);
        if (next() !== ":") throw Error("safety_json_invalid"); value(next(), depth + 1);
        const sep = next(); if (sep === "}") return; if (sep !== ",") throw Error("safety_json_invalid"); key = next();
      }
    }
    if (t === "[") { let item = next(); if (item === "]") return;
      while (true) { value(item, depth + 1); const sep = next(); if (sep === "]") return;
        if (sep !== ",") throw Error("safety_json_invalid"); item = next(); } }
    if (/^[{}\[\]:,]$/.test(t)) throw Error("safety_json_invalid");
  }
  value(next(), 0); if (text.slice(offset).trim()) throw Error("safety_json_invalid");
  return JSON.parse(text);
}
function checksum(value) { const { checksum: _, ...material } = value; return A.hash(material); }
function seal(material) { return A.freeze({ ...structuredClone(material), checksum: checksum(material) }); }
function reasonValid(reason) {
  return ["provision_disabled", "evaluated_success", "pending_prepared", "pending_transaction_started",
    "pending_committed_unverified"].includes(reason) || typeof reason === "string" && Safety.classifyFailure(reason).reason === reason;
}
function auditRow(previous, safety, reasonCode, policy) {
  const material = { previousAuthorityVersion: policy.global.authorityVersion, nextAuthorityVersion: policy.global.authorityVersion,
    previousPermissionVersion: policy.permissions.permissionVersion, nextPermissionVersion: policy.permissions.permissionVersion,
    previousSafetySequence: previous ? previous.safety.sequence : null, nextSafetySequence: safety.sequence,
    reasonCode, activatedSources: [], suspendedSources: safety.sources.filter(s => s.suspended).map(s => s.sourceId).sort(),
    previousAuditIdentity: previous ? previous.transitionAudit.at(-1).auditIdentity : null };
  return A.freeze({ ...material, auditIdentity: A.hash(material) });
}
function build(previous, safety, fenceDetails, reason, policy) {
  if (previous && previous.transitionAudit.length >= MAX_AUDIT) throw Error("safety_audit_capacity_reached");
  return seal({ schemaVersion: VERSION, safety, fenceDetails,
    transitionAudit: [...(previous?.transitionAudit || []), auditRow(previous, safety, reason, policy)] });
}
function validate(record, policy = A.PRODUCTION_POLICY) {
  try {
    if (!A.exact(record, ["schemaVersion", "safety", "fenceDetails", "transitionAudit", "checksum"]) ||
        record.schemaVersion !== VERSION) throw Error("safety_file_schema_invalid");
    const check = Safety.validateSafety(record.safety, policy); if (!check.valid) throw Error(check.reason);
    if (!A.isHash(record.checksum) || checksum(record) !== record.checksum) throw Error("safety_file_checksum_invalid");
    const f = record.fenceDetails, s = record.safety, p = s.pendingFence;
    if (p === null ? f !== null : !A.exact(f, ["attemptIdentity", "cycleIdentity", "sourceId", "authorityVersion",
      "sourcePermissionVersion", "safetySequence", "operation", "phase"]) || f.sourceId === A.BOJ ||
      !policy.global.permittedSources.includes(f.sourceId) || policy.permissions.entries.find(e => e.sourceId === f.sourceId)?.permission !== "approved" ||
      f.authorityVersion !== s.persistedAuthorityVersion || f.sourcePermissionVersion !== s.sourcePermissionVersion ||
      !A.integer(f.safetySequence) || f.safetySequence < 1 || f.safetySequence > s.sequence || f.operation !== "startup" ||
      ["attemptIdentity", "cycleIdentity", "sourceId", "phase"].some(k => f[k] !== p[k])) throw Error("safety_fence_invalid");
    const rows = record.transitionAudit;
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_AUDIT) throw Error("safety_audit_invalid");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], { auditIdentity, ...material } = r;
      if (!A.exact(r, AUDIT_KEYS) || !reasonValid(r.reasonCode) ||
          r.previousAuthorityVersion !== policy.global.authorityVersion || r.nextAuthorityVersion !== policy.global.authorityVersion ||
          r.previousPermissionVersion !== policy.permissions.permissionVersion || r.nextPermissionVersion !== policy.permissions.permissionVersion ||
          r.previousSafetySequence !== (i ? rows[i - 1].nextSafetySequence : null) || r.nextSafetySequence !== i ||
          r.previousAuditIdentity !== (i ? rows[i - 1].auditIdentity : null) || !A.isHash(auditIdentity) || A.hash(material) !== auditIdentity ||
          !Array.isArray(r.activatedSources) || r.activatedSources.length || !Array.isArray(r.suspendedSources) ||
          new Set(r.suspendedSources).size !== r.suspendedSources.length ||
          r.suspendedSources.some(id => !A.SOURCE_IDS.includes(id) || id === A.BOJ) ||
          (i === 0 ? r.reasonCode !== "provision_disabled" : r.reasonCode === "provision_disabled")) throw Error("safety_audit_invalid");
      if (i && rows[i - 1].suspendedSources.some(id => !r.suspendedSources.includes(id))) throw Error("safety_audit_invalid");
    }
    if (rows.at(-1).nextSafetySequence !== s.sequence ||
        rows.at(-1).suspendedSources.join("|") !== s.sources.filter(r => r.suspended).map(r => r.sourceId).sort().join("|"))
      throw Error("safety_audit_invalid");
    return A.freeze({ valid: true, reason: null });
  } catch (e) { return A.freeze({ valid: false, reason: e.message && /^[a-z_]+$/.test(e.message) ? e.message : "safety_file_invalid" }); }
}
module.exports = Object.freeze({ VERSION, MAX_AUDIT, MAX_BYTES, PHASES, parse, seal, build, validate });
