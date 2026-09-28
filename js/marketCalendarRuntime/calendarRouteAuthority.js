"use strict";

// Main-side infrastructure only. Never exposed through preload or renderer inputs.
const { createHash } = require("node:crypto");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Policy = require("./calendarNetworkPolicy.js");
const Estat = require("../marketCalendarIsolated/estatRoute.js");
const Bls = require("../marketCalendarIsolated/blsFixedRoute.js");
const AUTHORITY_VERSION = 1;
const SOURCE_IDS = Object.freeze(Object.keys(Registry.SOURCES).sort());
const STATES = Object.freeze(["legacy_active", "alternative_shadow", "alternative_active", "suspended"]);
const alternative = id => Object.hasOwn(Estat.ROUTES, id) ? "estat_release_calendar"
  : id === Bls.SOURCE_ID ? "bls_fixed_schedule_pages" : null;
const plain = x => x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) => plain(x) && Object.keys(x).sort().join("|") === [...keys].sort().join("|");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const hash = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function descriptor(sourceId, kind) {
  if (kind === "suspended") return { sourceId, routeKind: kind, sourceContractVersion: 1,
    routeContractVersion: 1, security: { acquisitionAllowed: false } };
  const common = { httpsOnly: true, credentialsAllowed: false, arbitraryHeadersAllowed: false,
    requestTimeoutMs: Policy.REQUEST_TIMEOUT_MS, bodyTimeoutMs: Policy.BODY_TIMEOUT_MS };
  if (kind === "legacy") return { sourceId, routeKind: kind,
    // Delivery contract v1 denotes the existing route; not a new canonical schema version.
    sourceContractVersion: 1, routeContractVersion: 1, security: { ...common,
      allowedHosts: Registry.getSource(sourceId).allowedHosts, query: "none",
      maxRedirects: Policy.MAX_REDIRECTS, maxRetries: Policy.MAX_RETRIES,
      documents: Policy.getPolicy(sourceId).documents.map(d => ({ ...d,
        pathPattern: d.pathPattern ? { source: d.pathPattern.source, flags: d.pathPattern.flags } : null })) } };
  if (kind === "estat_release_calendar") return { sourceId, routeKind: kind,
    sourceContractVersion: Estat.SOURCE_CONTRACT_VERSION, routeContractVersion: 1,
    security: { ...common, exactUrlOnly: true, maxRedirects: Policy.MAX_REDIRECTS,
      redirectPolicy: "same_exact_url_only", maxRetries: 0, encodingPolicy: "declared_strict_utf8",
      documents: [Estat.ROUTES[sourceId]] } };
  return { sourceId, routeKind: kind, sourceContractVersion: Bls.SOURCE_CONTRACT_VERSION, routeContractVersion: 1,
    security: { ...common, exactUrlOnly: true, maxRedirects: 0, maxRetries: 0,
      encodingPolicy: "bls_fixed_four_pages_undeclared_utf8", encodingPolicyVersion: 1,
      documents: Bls.ROLES.map(r => ({ role: r.role, url: r.url, allowedMime: ["text/html"], maxBytes: Bls.MAX_BYTES })) } };
}
function entry(sourceId, activationState, activationVersion) {
  if (!SOURCE_IDS.includes(sourceId) || !STATES.includes(activationState) ||
      !Number.isSafeInteger(activationVersion) || activationVersion < 1 ||
      activationState.startsWith("alternative_") && !alternative(sourceId)) throw Error("authority_entry_invalid");
  const routeKind = activationState === "suspended" ? "suspended"
    : activationState === "alternative_active" ? alternative(sourceId) : "legacy";
  const d = descriptor(sourceId, routeKind);
  return { sourceId, activationState, activationVersion, routeKind,
    sourceContractVersion: d.sourceContractVersion, routeContractVersion: d.routeContractVersion,
    securityContractIdentity: hash(d.security), routeIdentity: hash(d) };
}
// Trusted main-side construction/test seam, not a route override request API.
// Only state/generation vary; endpoints and security descriptors are never configurable.
function createAuthoritySnapshot(overrides = {}) {
  if (!plain(overrides) || Object.keys(overrides).some(id => !SOURCE_IDS.includes(id))) throw Error("authority_overrides_invalid");
  const entries = SOURCE_IDS.map(id => {
    const o = Object.hasOwn(overrides, id) ? overrides[id] : {
      activationState: alternative(id) ? "alternative_shadow" : "legacy_active", activationVersion: 1 };
    if (!exact(o, ["activationState", "activationVersion"])) throw Error("authority_overrides_invalid");
    return entry(id, o.activationState, o.activationVersion);
  });
  return freeze({ authorityVersion: AUTHORITY_VERSION, entries, authorityIdentity: hash({ authorityVersion: AUTHORITY_VERSION, entries }) });
}
const DEFAULT_AUTHORITY = createAuthoritySnapshot();
// D2d3-Labor: explicit production authority, independent of persisted Runtime State.
const PRODUCTION_AUTHORITY = createAuthoritySnapshot({
  "jp-stat-cpi": { activationState: "alternative_active", activationVersion: 2 },
  "jp-stat-labor": { activationState: "alternative_active", activationVersion: 2 },
  "us-bls-calendar": { activationState: "alternative_active", activationVersion: 2 }
});
function validateAuthority(snapshot) {
  try {
    if (!exact(snapshot, ["authorityVersion", "entries", "authorityIdentity"]) || snapshot.authorityVersion !== AUTHORITY_VERSION ||
        !Array.isArray(snapshot.entries) || snapshot.entries.length !== SOURCE_IDS.length) throw Error();
    const seen = new Set(), overrides = {};
    for (const e of snapshot.entries) {
      if (!plain(e) || seen.has(e.sourceId) || !SOURCE_IDS.includes(e.sourceId)) throw Error();
      seen.add(e.sourceId);
      if (JSON.stringify(stable(e)) !== JSON.stringify(stable(entry(e.sourceId, e.activationState, e.activationVersion)))) throw Error();
      overrides[e.sourceId] = { activationState: e.activationState, activationVersion: e.activationVersion };
    }
    const normalized = createAuthoritySnapshot(overrides);
    if (snapshot.authorityIdentity !== normalized.authorityIdentity) throw Error();
    return { valid: true, snapshot: normalized, reason: null };
  } catch (_) { return { valid: false, snapshot: null, reason: "authority_invalid" }; }
}
function selectRoute(request, snapshot = DEFAULT_AUTHORITY) {
  if (!exact(request, ["sourceId", "operation"])) return freeze({ valid: false, reason: "request_shape_invalid", acquisitionAllowed: false });
  if (!SOURCE_IDS.includes(request.sourceId) || request.operation !== Policy.OPERATION)
    return freeze({ valid: false, reason: "source_or_operation_invalid", acquisitionAllowed: false });
  const checked = validateAuthority(snapshot);
  if (!checked.valid) return freeze({ valid: false, reason: checked.reason, acquisitionAllowed: false });
  const selected = checked.snapshot.entries.find(e => e.sourceId === request.sourceId);
  return freeze({ valid: true, ...selected, authorityIdentity: checked.snapshot.authorityIdentity,
    operation: Policy.OPERATION, acquisitionAllowed: selected.activationState !== "suspended",
    reason: selected.activationState === "suspended" ? "source_suspended" : null });
}
module.exports = Object.freeze({ AUTHORITY_VERSION, SOURCE_IDS, STATES, DEFAULT_AUTHORITY, PRODUCTION_AUTHORITY,
  createAuthoritySnapshot, validateAuthority, selectRoute });
