"use strict";

// Read-only acceptance gate; no provisioning, migration, transition or state setter.
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const E = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Store = require("../marketCalendarHistory/writerSafetyCanaryStore.js");
const Approval = require("./freshDayCanaryApproval.js");
const EXPECTED_SEQUENCE = 2;
const IMPLEMENTATION_FILES = Object.freeze([
  "js/marketCalendarRuntime/freshDayCanaryPreflight.js",
  "js/marketCalendarRuntime/freshDayCanaryReceipt.js",
  "js/marketCalendarRuntime/freshDayCanaryApproval.js",
  "scripts/marketCalendarE4fFreshDayCanary.js",
  "test/marketCalendarFreshDayCanaryAcceptance.test.js"
]);
const same = (a, b) => A.hash(a) === A.hash(b);
function validateState(loaded) {
  try {
    if (!loaded?.available || !A.isHash(loaded.contentHash)) throw Error("safety_read_unavailable");
    const r = loaded.record, checked = E.validateEnvelope(r);
    if (!checked.valid || checked.kind !== "versioned") throw Error("versioned_envelope_required");
    const s = r.safety, policy = E.policyFor(3);
    if (s.persistedAuthorityVersion !== 3 || s.persistedAuthorityIdentity !== policy.global.identity ||
        s.sourcePermissionVersion !== policy.permissions.permissionVersion || s.sourcePermissionIdentity !== policy.permissions.identity)
      throw Error("canary_authority_mismatch");
    if (s.sequence !== EXPECTED_SEQUENCE) throw Error("canary_sequence_mismatch");
    if (s.pendingFence) throw Error("pending_fence_blocks_startup");
    if (s.globalSuspend.suspended || s.sources.some(source => source.suspended)) throw Error("suspend_blocks_startup");
    if (!same(policy.global.permittedSources, [E.SOURCE]) || !same(policy.global.permittedOperations, ["startup"]) ||
        policy.global.state !== "active" || policy.permissions.entries.find(x => x.sourceId === A.BOJ)?.permission !== "writer_ineligible" ||
        policy.permissions.entries.filter(x => x.sourceId !== A.BOJ).some(x => x.permission !== "approved"))
      throw Error("canary_ceiling_mismatch");
    if (r.transitionAudit.length !== 2 || r.transitionAudit[0].event.type !== "migration" ||
        r.transitionAudit[1].event.type !== "authority_transition") throw Error("initial_transition_history_required");
    return A.freeze({ valid: true, reason: null, sourceId: E.SOURCE, authorityVersion: 3, sequence: s.sequence,
      contentHash: loaded.contentHash, manualWriteAllowed: false, otherSourceWriteAllowed: false,
      bojPermission: "writer_ineligible", pending: null, historyValid: true });
  } catch (e) { return A.freeze({ valid: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "preflight_invalid" }); }
}
// Implementation A is approved only by a manifest-only, exact-parent child B.
// No current/future HEAD constant, ancestry shortcut or caller-selected manifest.
function revision(root) { return Approval.verifyRepository(root); }
function loadProduction() {
  // Fixed native-main factory resolves the production profile; only load/close is exposed here.
  const store = Store.createProductionStore();
  try { return store.load(); } finally { store.close(); }
}
function loadIsolated(root) {
  const store = Store.createIsolatedStore(root);
  try { return store.load(); } finally { store.close(); }
}
module.exports = Object.freeze({ EXPECTED_SEQUENCE, IMPLEMENTATION_FILES, validateState,
  revision, loadProduction, loadIsolated });
