"use strict";

// E4e-2a: code authority and opaque context candidates only. No runtime/storage wiring.
const { createHash } = require("node:crypto");
const V1 = require("./formalWriterAuthority.js");
const SourceSets = require("../marketCalendar/sourceRegistry.js");
const Schema = require("./productionSchemaV1.js");
const CONTRACT_VERSION = 2;
const STATES = Object.freeze(["disabled", "shadow", "active", "suspended"]);
const PERMISSIONS = Object.freeze(["approved", "suspended", "writer_ineligible"]);
const SOURCE_IDS = SourceSets.getHistoricalSourceSet(2, 1).sourceIds;
const BOJ = V1.BOJ_SOURCE_ID;
const policies = new WeakSet(), policySourceSets = new WeakMap(), contexts = new WeakMap();
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function mainOnly() {
  if (typeof window !== "undefined" && window.document) throw Error("main_side_only");
}
function makePolicy(state, authorityVersion, permissionVersion, suspendedSources, allowedSources) {
  const permissionMaterial = { contractVersion: CONTRACT_VERSION, permissionVersion,
    entries: SOURCE_IDS.map(sourceId => ({ sourceId, permission: sourceId === BOJ ? "writer_ineligible" :
      suspendedSources.includes(sourceId) ? "suspended" : "approved" })) };
  const permissions = { ...permissionMaterial, identity: hash(permissionMaterial) };
  const globalMaterial = { contractVersion: CONTRACT_VERSION, authorityVersion, state,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, permittedOperations: ["startup"],
    permittedSources: [...allowedSources].sort(), permissionIdentity: permissions.identity };
  const policy = freeze({ global: { ...globalMaterial, identity: hash(globalMaterial) }, permissions });
  // Every policy issued by this historical contract (including hypothetical
  // resume-version fixtures) retains v1's twelve sources, never current metadata.
  policies.add(policy); policySourceSets.set(policy, SOURCE_IDS); return policy;
}
const PRODUCTION_POLICY = makePolicy("disabled", 2, 1, [], [V1.FIRST_WRITE_SOURCE_ID]);
// Explicit hypothetical fixture ceiling, not a production configuration/activation API.
function createIsolatedPolicy({ targetEnvironment, state = "active", authorityVersion = 2,
  permissionVersion = 1, suspendedSources = [], permittedSources = SOURCE_IDS.filter(id => id !== BOJ) } = {}) {
  mainOnly();
  const ids = list => Array.isArray(list) && new Set(list).size === list.length &&
    list.every(id => SOURCE_IDS.includes(id) && id !== BOJ);
  if (targetEnvironment !== "isolated_test" || !STATES.includes(state) || !integer(authorityVersion) ||
      authorityVersion < 2 || !integer(permissionVersion) || permissionVersion < 1 ||
      !ids(suspendedSources) || !ids(permittedSources)) throw Error("isolated_policy_invalid");
  return makePolicy(state, authorityVersion, permissionVersion, suspendedSources, permittedSources);
}
function validatePolicy(policy) {
  try {
    if (!exact(policy, ["global", "permissions"]) || !policies.has(policy)) throw Error();
    const g = policy.global, p = policy.permissions;
    if (!exact(g, ["contractVersion", "authorityVersion", "state", "schemaFingerprint", "permittedOperations",
      "permittedSources", "permissionIdentity", "identity"]) || !exact(p, ["contractVersion", "permissionVersion", "entries", "identity"]) ||
      g.contractVersion !== 2 || p.contractVersion !== 2 || !STATES.includes(g.state) ||
      !integer(g.authorityVersion) || g.authorityVersion < 2 || !integer(p.permissionVersion) || p.permissionVersion < 1 ||
      g.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT || !Array.isArray(p.entries) ||
      p.entries.length !== sourceIdsForPolicy(policy).length ||
      p.entries.map(e => e.sourceId).sort().join("|") !== sourceIdsForPolicy(policy).join("|") ||
      p.entries.some(e => !exact(e, ["sourceId", "permission"]) || !PERMISSIONS.includes(e.permission) ||
        e.sourceId === BOJ && e.permission !== "writer_ineligible")) throw Error();
    const { identity: gi, ...gm } = g, { identity: pi, ...pm } = p;
    if (hash(gm) !== gi || hash(pm) !== pi || g.permissionIdentity !== pi) throw Error();
    return freeze({ valid: true, reason: null });
  } catch (_) { return freeze({ valid: false, reason: "writer_authority_v2_invalid" }); }
}
function sourceIdsForPolicy(policy) { return policySourceSets.get(policy) || null; }
function createMainContextCandidate({ operation, cycleIdentity, attemptIdentity } = {}) {
  mainOnly();
  if (!["startup", "manual"].includes(operation) || !isHash(cycleIdentity) || !isHash(attemptIdentity))
    throw Error("trusted_context_shape_invalid");
  const token = Object.freeze(Object.create(null));
  const material = { operation, cycleIdentity, attemptIdentity };
  contexts.set(token, { ...material, contextIdentity: hash(material), issued: false, consumed: false });
  return token;
}
function contextDetails(token, cycleIdentity, operation) {
  const value = contexts.get(token);
  return value && !value.consumed && value.cycleIdentity === cycleIdentity && value.operation === operation ?
    freeze({ ...value }) : null;
}
function issueContext(token) {
  const value = contexts.get(token);
  if (!value || value.issued || value.consumed) return false;
  value.issued = true; return true;
}
function consumeContext(token) {
  const value = contexts.get(token);
  if (!value || !value.issued || value.consumed) return false;
  value.consumed = true; return true;
}
module.exports = Object.freeze({ CONTRACT_VERSION, STATES, PERMISSIONS, SOURCE_IDS, BOJ,
  PRODUCTION_POLICY, createIsolatedPolicy, validatePolicy, sourceIdsForPolicy, createMainContextCandidate,
  contextDetails, issueContext, consumeContext, isHash, integer, exact, hash, freeze });
