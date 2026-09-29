"use strict";

// Main-side planning authority. No writer or IPC imports belong in this module.
const { createHash } = require("node:crypto");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Schema = require("./productionSchemaV1.js");

const AUTHORITY_VERSION = 1;
const STATES = Object.freeze(["disabled", "shadow", "active", "suspended"]);
const SOURCE_IDS = Object.freeze(Object.keys(Registry.SOURCES).sort());
const BOJ_SOURCE_ID = "jp-boj-calendar";
const FIRST_WRITE_SOURCE_ID = "jp-esri-machinery-orders-calendar";
const stable = value => Array.isArray(value) ? value.map(stable) : value &&
  typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, stable(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function fixedAuthority(state) {
  const entries = SOURCE_IDS.map(sourceId => ({ sourceId, state,
    writeEligible: sourceId !== BOJ_SOURCE_ID }));
  const identity = hash({ authorityVersion: AUTHORITY_VERSION,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, entries });
  return freeze({ authorityVersion: AUTHORITY_VERSION,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, entries, identity });
}
// Production remains disabled. Shadow is reachable only through explicit imports.
const PRODUCTION_AUTHORITY = fixedAuthority("disabled");
const SHADOW_AUTHORITY = fixedAuthority("shadow");
function validateAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !==
        ["authorityVersion", "schemaFingerprint", "entries", "identity"].sort().join("|") ||
      value.authorityVersion !== AUTHORITY_VERSION ||
      value.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      !Array.isArray(value.entries) || value.entries.length !== SOURCE_IDS.length)
    return freeze({ valid: false, reason: "writer_authority_invalid" });
  const state = value.entries[0]?.state;
  if (!STATES.includes(state) ||
      hash(value) !== hash(fixedAuthority(state)))
    return freeze({ valid: false, reason: "writer_authority_invalid" });
  return freeze({ valid: true, reason: null, identity: value.identity });
}
function selectWriterState(sourceId, authority = PRODUCTION_AUTHORITY) {
  if (!SOURCE_IDS.includes(sourceId)) return freeze({ valid: false, reason: "source_unknown" });
  const checked = validateAuthority(authority);
  if (!checked.valid) return checked;
  const entry = authority.entries.find(value => value.sourceId === sourceId);
  return freeze({ valid: true, sourceId, state: entry.state,
    writeEligible: entry.writeEligible, reason: entry.writeEligible ? null :
      "writer_ineligible_identity_transition", authorityIdentity: authority.identity });
}

module.exports = Object.freeze({ AUTHORITY_VERSION, STATES, SOURCE_IDS, BOJ_SOURCE_ID,
  FIRST_WRITE_SOURCE_ID, PRODUCTION_AUTHORITY, SHADOW_AUTHORITY,
  validateAuthority, selectWriterState });
