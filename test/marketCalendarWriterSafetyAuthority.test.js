"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const B = require("../js/marketCalendarHistory/formalWriterAuthorizationV2.js");
const V1 = require("../js/marketCalendarHistory/formalWriterAuthority.js");
const ID = V1.FIRST_WRITE_SOURCE_ID, OTHER = "jp-esri-sna-calendar";
const H = label => A.hash({ label });
const policy = options => A.createIsolatedPolicy({ targetEnvironment: "isolated_test", ...options });
function input(p = policy(), sourceId = ID) {
  const cycleIdentity = H("cycle"), attemptIdentity = H("attempt");
  return { policy: p, safety: S.createMemorySafety(p), sourceId, operation: "startup", cycleIdentity,
    context: A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity }),
    acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: H("route"), expectedRouteIdentity: H("route"),
    schemaFingerprint: p.global.schemaFingerprint, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: H("acquisition"), candidateIdentity: H("candidate"),
    comparisonIdentity: H("comparison"), formalPrecondition: H("precondition"), planIdentity: H("plan"),
    mutationCeiling: { eventEntryCreate: 0, eventEntryUpdate: 4, semanticRevisionCreate: 0, semanticRevisionClose: 0,
      evidenceCreate: 4, observationCreate: 4, sourceRunCreate: 1, sourceCursorUpdate: 1 } };
}
function safety(i, modify) { const s = structuredClone(i.safety); modify(s); return S.sealSafetyMaterial(s); }
function signal(reason, n = 1, sourceId = ID, outcome = "failure", category = S.classifyFailure(reason).category) {
  return { sourceId, category, outcome, reason: outcome === "failure" ? reason : null,
    cycleOrdinal: n, cycleIdentity: H(`cycle-${n}`) };
}
function reduce(i, value) { const r = S.reduceSafetySignal({ policy: i.policy, state: i.safety, signal: value });
  assert.equal(r.valid, true, r.reason); if (r.state) i.safety = r.state; return r; }
test("A1 production v2 disabled: all 12 writes false; v1 unchanged and identities distinct", () => {
  assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
  assert.equal(A.PRODUCTION_POLICY.global.contractVersion, 2);
  assert.equal(V1.AUTHORITY_VERSION, 1); assert.ok(V1.PRODUCTION_AUTHORITY.entries.every(e => e.state === "disabled"));
  assert.notEqual(A.PRODUCTION_POLICY.global.identity, V1.PRODUCTION_AUTHORITY.identity);
  for (const id of A.SOURCE_IDS) assert.equal(S.evaluate(input(A.PRODUCTION_POLICY, id)).writeAllowed, false);
});
test("A2 active/approved + all fresh facts => candidate, never an executor", () => {
  const i = input(), result = S.evaluate(i); assert.equal(result.writeAllowed, true);
  assert.equal(result.candidateEligible, true); assert.equal(result.executionAllowed, false);
});
test("A3/A6 BOJ cannot be promoted by active global or persistent input", () => {
  const i = input(policy(), A.BOJ); assert.equal(S.evaluate(i).reason, "writer_ineligible_identity_transition");
  assert.equal(S.evaluate(i).writeAllowed, false);
  assert.throws(() => policy({ permittedSources: [A.BOJ] }), /isolated_policy_invalid/);
  i.safety = safety(i, s => { s.sources.find(r => r.sourceId === A.BOJ).permission = "approved"; });
  assert.equal(S.evaluate(i).writeAllowed, false); assert.equal(S.validateSafety(i.safety, i.policy).valid, false);
});
test("A4 global code suspend and persistent latch each block every source", () => {
  const p = policy({ state: "suspended" });
  for (const id of A.SOURCE_IDS) assert.equal(S.evaluate(input(p, id)).writeAllowed, false);
  const i = input(); i.safety = safety(i, s => { s.globalSuspend = { suspended: true, reason: "orphan" }; });
  for (const sourceId of A.SOURCE_IDS) assert.equal(S.evaluate({ ...i, sourceId }).writeAllowed, false);
});
test("A5/A27 source suspend stops only its source, code ceiling separate", () => {
  const i = input(); i.safety = safety(i, s => { const own = s.sources.find(s => s.sourceId === ID);
    own.suspended = true; own.reason = "unsupported_changed"; });
  assert.equal(S.evaluate(i).writeAllowed, false);
  assert.equal(S.evaluate({ ...i, sourceId: OTHER }).writeAllowed, true);
  const p = policy({ suspendedSources: [ID] });
  assert.equal(S.evaluate(input(p)).writeAllowed, false); assert.equal(S.evaluate(input(p, OTHER)).writeAllowed, true);
});
test("A6 safety has no active/approved fields and cannot elevate disabled policy", () => {
  const i = input(A.PRODUCTION_POLICY);
  for (const field of ["state", "approved", "active", "writerAuthority", "runtimeState"]) {
    const s = { ...i.safety, [field]: "active" }; assert.equal(S.evaluate({ ...i, safety: S.sealSafetyMaterial(s) }).writeAllowed, false);
  }
});
test("A7 missing safety input => unavailable/suspended, not provisioned", () => {
  const i = input(); const r = S.evaluate({ ...i, safety: null });
  assert.equal(r.reason, "safety_state_missing"); assert.equal(r.effectiveState, "suspended"); assert.equal(r.writeAllowed, false);
});
test("A8 malformed/checksum/counter/unknown field fail closed", () => {
  const i = input();
  const faults = [s => { s.sources.pop(); }, s => { s.sources.push(s.sources[0]); },
    s => { s.sources[0].sourceId = "unknown"; }, s => { s.sequence = -1; }, s => { s.globalSuspend.reason = "raw/path"; },
    s => { s.sources[0].counters.stale.count = 3; }, s => { s.pendingFence = {}; }, s => { s.extra = true; }];
  for (const fault of faults) assert.equal(S.evaluate({ ...i, safety: safety(i, fault) }).writeAllowed, false);
  assert.equal(S.evaluate({ ...i, safety: { ...i.safety, sequence: 1 } }).reason, "safety_validation_failed");
});
test("A9 incompatible safety and unknown authority versions reject", () => {
  const i = input();
  for (const change of [s => { s.safetyContractVersion = 2; }, s => { s.persistedAuthorityVersion++; },
    s => { s.sourcePermissionVersion++; }, s => { s.persistedAuthorityIdentity = H("other"); }])
    assert.equal(S.evaluate({ ...i, safety: safety(i, change) }).writeAllowed, false);
  assert.equal(A.validatePolicy(V1.PRODUCTION_AUTHORITY).valid, false);
  assert.equal(A.validatePolicy({ ...i.policy, global: { ...i.policy.global, contractVersion: 99 } }).valid, false);
});
test("A10 pending fences at every phase globally block; evaluator/reducer never clear", () => {
  const i = input();
  for (const phase of ["prepared", "transaction_started", "committed_unverified"]) {
    i.safety = safety(i, s => { s.pendingFence = { sourceId: ID, phase, attemptIdentity: H("pending"), cycleIdentity: H("cycle") }; });
    const before = structuredClone(i.safety); assert.equal(S.evaluate(i).reason, "interrupted_pending_fence");
    reduce(i, signal("network_failure", 1)); assert.deepEqual(i.safety.pendingFence, before.pendingFence);
    assert.equal(S.evaluate({ ...i, sourceId: OTHER }).writeAllowed, false);
  }
});
test("A11 first network/timeout/partial/route/stale => skip", () => {
  for (const reason of ["network_failure", "timeout", "partial", "route_mismatch", "stale_precondition"]) {
    const i = input(); assert.equal(reduce(i, signal(reason)).action, "skip");
    assert.equal(i.safety.sources.find(s => s.sourceId === ID).suspended, false);
  }
});
test("A12 third consecutive acquisition failures suspend across serialized restart", () => {
  const i = input();
  for (let n = 1; n <= 3; n++) {
    const r = reduce(i, signal(["network_failure", "timeout", "partial"][n - 1], n));
    assert.equal(r.action, n === 3 ? "source_suspend" : "skip");
    i.safety = JSON.parse(JSON.stringify(i.safety)); assert.equal(S.validateSafety(i.safety, i.policy).valid, true);
  }
  assert.equal(i.safety.sources.find(s => s.sourceId === ID).counters.acquisition_failure.count, 3);
  assert.equal(S.evaluate(i).writeAllowed, false); assert.equal(S.evaluate({ ...i, sourceId: OTHER }).writeAllowed, true);
});
test("A13 successful phase resets only matching counter, input immutable", () => {
  const i = input(); reduce(i, signal("network_failure", 1)); reduce(i, signal("stale_precondition", 1));
  const before = structuredClone(i.safety); reduce(i, signal("network_failure", 2, ID, "success"));
  const counters = i.safety.sources.find(s => s.sourceId === ID).counters;
  assert.equal(counters.acquisition_failure.count, 0); assert.equal(counters.stale.count, 1);
  assert.equal(before.sources.find(s => s.sourceId === ID).counters.acquisition_failure.count, 1);
});
test("A14 skip/cooldown/unobserved neither increment nor reset", () => {
  const i = input(); reduce(i, signal("network_failure"));
  for (const outcome of ["skip", "cooldown", "not_evaluated"]) {
    const before = i.safety; reduce(i, signal("network_failure", 2, ID, outcome)); assert.equal(i.safety, before);
  }
});
test("A15 repeated stale and route mismatch threshold exactly three", () => {
  for (const reason of ["stale_precondition", "route_mismatch"]) {
    const i = input(); for (let n = 1; n <= 3; n++) assert.equal(reduce(i, signal(reason, n)).action, n === 3 ? "source_suspend" : "skip");
  }
});
test("A16 changed source stopped, shadow remains available, no Revision transition", () => {
  const i = input(); const r = S.evaluate({ ...i, changed: 1 });
  assert.equal(r.writeAllowed, false); assert.equal(r.scope, "source"); assert.equal(r.shadowAllowed, true);
  assert.equal(reduce(i, signal("unsupported_changed", 1, ID, "failure", null)).action, "source_suspend");
  assert.equal(S.evaluate({ ...input(), revisionTransitionCount: 1 }).writeAllowed, false);
});
for (const [name, reasons] of [["A17", ["schema_mismatch"]], ["A18", ["orphan", "duplicate_active", "multiple_active_revision", "db_integrity_failure"]],
  ["A19", ["commit_ambiguous"]], ["A20", ["readback_mismatch", "readback_incomplete"]]]) test(`${name} global failures latch all writer permissions`, () => {
  for (const reason of reasons) {
    const i = input(); assert.equal(reduce(i, signal(reason, 1, ID, "failure", null)).action, "global_suspend");
    assert.equal(S.evaluate({ ...i, sourceId: OTHER }).writeAllowed, false);
  }
});
function staleAuthorization(modify) {
  const i = input(), issued = B.issueAuthorizationCandidate(i); assert.equal(issued.valid, true);
  const next = modify(i); assert.equal(B.validateAuthorizationCandidate(issued.authorization, next).valid, false);
}
test("A21 newer global version invalidates old candidate even with newly valid safety", () => {
  staleAuthorization(i => { const p = policy({ authorityVersion: 3 }); return { ...i, policy: p, safety: S.createMemorySafety(p) }; });
});
test("A22 source permission version update invalidates old candidate", () => {
  staleAuthorization(i => { const p = policy({ permissionVersion: 2 }); return { ...i, policy: p, safety: S.createMemorySafety(p) }; });
});
test("A23 safety sequence/latches/fence invalidate old authorization", () => {
  for (const change of [s => { s.sequence++; }, s => { s.globalSuspend = { suspended: true, reason: "orphan" }; },
    s => { const own = s.sources.find(s => s.sourceId === ID); own.suspended = true; own.reason = "unsupported_changed"; },
    s => { s.pendingFence = { sourceId: ID, phase: "prepared", attemptIdentity: H("a"), cycleIdentity: H("c") }; }])
    staleAuthorization(i => ({ ...i, safety: safety(i, change) }));
});
test("A24 renderer startup trigger/JSON/clone/arbitrary token cannot authorize", () => {
  const i = input(); for (const context of [{ trigger: "startup" }, JSON.parse(JSON.stringify(i.context)), structuredClone(i.context), null, "startup"])
    assert.equal(S.evaluate({ ...i, context, trigger: "startup" }).writeAllowed, false);
  assert.equal(A.validatePolicy(JSON.parse(JSON.stringify(i.policy))).valid, false);
});
test("A25 manual stays disabled even if singleflight shares a startup token", () => {
  const i = input(); assert.equal(S.evaluate({ ...i, operation: "manual" }).writeAllowed, false);
  i.context = A.createMainContextCandidate({ operation: "manual", cycleIdentity: i.cycleIdentity, attemptIdentity: H("manual") });
  i.operation = "manual"; assert.equal(S.evaluate(i).reason, "manual_writer_disabled");
  assert.equal(B.issueAuthorizationCandidate(i).valid, false);
});
test("A26 main-only startup context cycle-bound and one-use, no execution", () => {
  const i = input(); assert.equal(S.evaluate({ ...i, cycleIdentity: H("other-cycle") }).writeAllowed, false);
  const issued = B.issueAuthorizationCandidate(i); assert.equal(issued.valid, true);
  assert.equal(B.issueAuthorizationCandidate(i).valid, false);
  assert.equal(B.validateAuthorizationCandidate(issued.authorization, i).valid, true);
  assert.equal(B.validateAuthorizationCandidate({}, i).valid, false);
  const consumed = B.consumeAuthorizationCandidate(issued.authorization, i);
  assert.equal(consumed.valid, true); assert.equal(consumed.executionAllowed, false);
  assert.equal(S.evaluate(i).writeAllowed, false); assert.equal(B.consumeAuthorizationCandidate(issued.authorization, i).valid, false);
});
test("A28 global Resume requires receipt/Gate/new authority/fresh integrity/no pending", () => {
  const p = policy({ state: "suspended" }), state = S.createMemorySafety(p), next = policy({ authorityVersion: 3 });
  const data = { previousPolicy: p, nextPolicy: next, previousSafety: state, diagnosisReceipt: H("diagnosis"), resumeGateIdentity: H("gate"),
    pendingFence: null, freshIntegrityValid: true, reasonCode: "explicit_resume_gate" };
  const r = S.validateResumeTransition(data); assert.equal(r.valid, true); assert.equal(r.mutationAllowed, false);
  assert.equal(r.auditMaterial.previousAuthorityVersion, 2); assert.equal(r.auditMaterial.nextAuthorityVersion, 3);
  assert.equal(r.auditMaterial.approvedSourceSet.length, 11);
  for (const patch of [{ diagnosisReceipt: null }, { resumeGateIdentity: null }, { previousSafety: null }, { freshIntegrityValid: false },
    { pendingFence: {} }, { reasonCode: "free-form text" }, { nextPolicy: policy() }]) assert.equal(S.validateResumeTransition({ ...data, ...patch }).valid, false);
});
test("source Resume newer permission version, no global elevation and BOJ never resume", () => {
  const p = policy({ suspendedSources: [ID] }), next = policy({ permissionVersion: 2 });
  const data = { previousPolicy: p, nextPolicy: next, previousSafety: S.createMemorySafety(p), sourceId: ID,
    diagnosisReceipt: H("d"), resumeGateIdentity: H("g"), pendingFence: null, freshIntegrityValid: true, reasonCode: "explicit_resume_gate" };
  assert.equal(S.validateResumeTransition(data).valid, true);
  assert.equal(S.validateResumeTransition({ ...data, nextPolicy: policy() }).valid, false);
  assert.equal(S.validateResumeTransition({ ...data, sourceId: A.BOJ }).valid, false);
  assert.equal(S.validateResumeTransition({ ...data, nextPolicy: policy({ state: "active", authorityVersion: 2, permissionVersion: 1 }) }).valid, false);
});
test("duplicate same-cycle and delayed signals cannot double increment; conflict latches", () => {
  const i = input(); const s = signal("network_failure"); reduce(i, s); const before = i.safety;
  assert.equal(reduce(i, s).reason, "duplicate_signal"); assert.equal(i.safety, before);
  reduce(i, signal("network_failure", 2)); const later = i.safety;
  assert.equal(reduce(i, s).reason, "stale_signal"); assert.equal(i.safety, later);
  assert.equal(reduce(i, { ...signal("network_failure", 2), cycleIdentity: H("conflict") }).action, "source_suspend");
  assert.equal(S.evaluate(i).writeAllowed, false);
});
test("BOJ counter excluded, but integrity anomalies still global; suspension never auto-resumes", () => {
  const i = input(); const before = i.safety;
  reduce(i, signal("network_failure", 1, A.BOJ)); assert.equal(i.safety, before);
  reduce(i, signal("orphan", 2, A.BOJ, "failure", null));
  const stopped = i.safety; reduce(i, signal("network_failure", 3, ID, "success")); assert.equal(i.safety, stopped);
});
test("all required failure classes and unknown codes fail closed at correct scope", () => {
  for (const reason of ["source_identity_conflict", "source_security_rejection", "encoding_rejection", "parser_rejection"])
    assert.equal(S.classifyFailure(reason).action, "source_suspend");
  for (const reason of ["cross_source_mutation", "actual_mutation_mismatch", "readback_incomplete", "unknown-code", "malformed_safety_state"])
    assert.equal(S.classifyFailure(reason).action, "global_suspend");
});
test("binding deterministic, every identity/ceiling matters; invalid material denied", () => {
  const i = input(), before = structuredClone(i.safety), binding = B.bindingMaterial(i);
  assert.equal(binding.authorizationIdentity, B.bindingMaterial(i).authorizationIdentity); assert.deepEqual(i.safety, before);
  for (const key of B.IDENTITY_FIELDS) {
    assert.notEqual(B.bindingMaterial({ ...i, [key]: H("other") }).authorizationIdentity, binding.authorizationIdentity);
    assert.equal(B.bindingMaterial({ ...i, [key]: "" }), null);
  }
  assert.equal(B.bindingMaterial({ ...i, mutationCeiling: { ...i.mutationCeiling, delete: 1 } }), null);
  assert.equal(B.bindingMaterial({ ...i, mutationCeiling: { ...i.mutationCeiling, semanticRevisionClose: 1 } }), null);
});
test("every eligibility conjunct fails closed independently", () => {
  const i = input();
  for (const patch of [{ acquisition: { outcome: "partial" } }, { acquisition: { outcome: "failed" } },
    { acquisition: { outcome: "complete", failedRoles: ["jolts"] } }, { routeIdentity: null }, { expectedRouteIdentity: H("wrong") },
    { schemaFingerprint: H("wrong") }, { integrityValid: false }, { changed: -1 }, { planValid: false }, { absenceAuthority: "complete" }])
    assert.equal(S.evaluate({ ...i, ...patch }).writeAllowed, false);
});
test("v2 authorities/context remain main-only; unknown/missing/duplicate permissions rejected", () => {
  const i = input();
  for (const entries of [i.policy.permissions.entries.slice(1), [...i.policy.permissions.entries, i.policy.permissions.entries[0]],
    i.policy.permissions.entries.map((e, n) => n === 0 ? { ...e, sourceId: "unknown" } : e)])
    assert.equal(A.validatePolicy({ ...i.policy, permissions: { ...i.policy.permissions, entries } }).valid, false);
  assert.throws(() => A.createIsolatedPolicy({ state: "active" }), /isolated_policy_invalid/);
  const old = global.window; global.window = { document: {} };
  try { assert.throws(() => policy(), /main_side_only/);
    assert.throws(() => A.createMainContextCandidate({}), /main_side_only/); }
  finally { if (old === undefined) delete global.window; else global.window = old; }
});
test("static boundaries: new graph has no storage/writer/runtime wiring and no production importer", () => {
  const root = path.resolve(__dirname, ".."), modules = ["formalWriterAuthorityV2", "formalWriterSafetyEvaluator", "formalWriterAuthorizationV2"];
  for (const name of modules) {
    const code = fs.readFileSync(path.join(root, "js/marketCalendarHistory", name + ".js"), "utf8");
    assert.doesNotMatch(code, /require\(["'](?:node:)?(?:fs|http|https|electron)["']\)|indexedDB|\.transaction\(|\.executePrepared\(/);
  }
  for (const file of ["main.js", "preload.js", "js/marketCalendarRuntime/automaticFormalShadowRuntime.js", "js/marketCalendarRuntime/automaticFormalShadow.js"])
    for (const name of modules) assert.equal(fs.readFileSync(path.join(root, file), "utf8").includes(name), false);
});
test("suspend transition exact reducer material only; clearing/resetting state cannot resume", () => {
  const i = input(), previousSafety = i.safety, event = signal("unsupported_changed", 1, ID, "failure", null);
  reduce(i, event);
  assert.equal(S.validateSuspendTransition({ policy: i.policy, previousSafety, nextSafety: i.safety, signal: event }).valid, true);
  assert.equal(S.validateSuspendTransition({ policy: i.policy, previousSafety: i.safety,
    nextSafety: S.createMemorySafety(i.policy), signal: signal("network_failure", 2, ID, "success") }).valid, false);
  const stopped = i.safety; reduce(i, signal("network_failure", 2, ID, "success")); assert.equal(i.safety, stopped);
});
test("Resume cannot conceal an interrupted fence, other source changes, or version downgrade", () => {
  const p = policy({ state: "suspended", authorityVersion: 3, permissionVersion: 2 });
  const i = input(p), next = policy({ authorityVersion: 4, permissionVersion: 2 });
  const data = { previousPolicy: p, nextPolicy: next, previousSafety: i.safety, diagnosisReceipt: H("d"), resumeGateIdentity: H("g"),
    pendingFence: null, freshIntegrityValid: true, reasonCode: "explicit_resume_gate" };
  const pending = safety(i, s => { s.pendingFence = { sourceId: ID, phase: "committed_unverified", attemptIdentity: H("a"), cycleIdentity: H("c") }; });
  assert.equal(S.validateResumeTransition({ ...data, previousSafety: pending }).valid, false);
  assert.equal(S.validateResumeTransition({ ...data, nextPolicy: policy({ authorityVersion: 4, permissionVersion: 1 }) }).valid, false);
  assert.equal(S.validateResumeTransition({ ...data, nextPolicy: policy({ authorityVersion: 4, permissionVersion: 2, suspendedSources: [OTHER] }) }).valid, false);
});
test("authorization pending attempt/cycle/route/ceiling binding differs and stale consume exhausts context", () => {
  const i = input(), issued = B.issueAuthorizationCandidate(i);
  const altered = { ...i, mutationCeiling: { ...i.mutationCeiling, evidenceCreate: 5 } };
  assert.equal(B.validateAuthorizationCandidate(issued.authorization, altered).valid, false);
  assert.equal(B.consumeAuthorizationCandidate(issued.authorization, altered).valid, false);
  assert.equal(B.consumeAuthorizationCandidate(issued.authorization, i).valid, false);
  assert.equal(B.issueAuthorizationCandidate(i).valid, false);
  const a = input(), b = { ...a, context: A.createMainContextCandidate({ operation: "startup", cycleIdentity: a.cycleIdentity, attemptIdentity: H("new-attempt") }) };
  assert.notEqual(B.bindingMaterial(a).authorizationIdentity, B.bindingMaterial(b).authorizationIdentity);
  assert.notEqual(B.bindingMaterial(a).authorizationIdentity, B.bindingMaterial({ ...a, routeIdentity: H("new-route"), expectedRouteIdentity: H("new-route") }).authorizationIdentity);
});
test("malformed top-level inputs and unknown source never authorize", () => {
  for (const value of [null, [], "active"]) {
    assert.equal(S.evaluate(value).writeAllowed, false); assert.equal(B.bindingMaterial(value), null);
    assert.equal(S.reduceSafetySignal(value).valid, false); assert.equal(S.validateResumeTransition(value).valid, false);
    assert.equal(S.validateSuspendTransition(value).valid, false);
  }
  const i = input(), issued = B.issueAuthorizationCandidate(i);
  assert.equal(B.validateAuthorizationCandidate(issued.authorization, null).valid, false);
  assert.equal(B.consumeAuthorizationCandidate(issued.authorization, null).valid, false);
  assert.equal(B.consumeAuthorizationCandidate(issued.authorization, i).valid, false);
  for (const failedRoles of [null, 0, {}, ""]) assert.equal(S.evaluate({ ...input(), acquisition: { outcome: "complete", failedRoles } }).writeAllowed, false);
  const b = input(); b.safety = safety(b, s => { s.sources.find(r => r.sourceId === A.BOJ).counters.stale =
    { count: 1, cycleOrdinal: 1, cycleIdentity: H("b"), outcome: "failure" }; });
  assert.equal(S.validateSafety(b.safety, b.policy).valid, false);
  assert.equal(S.evaluate({ ...input(), sourceId: "unknown" }).reason, "source_unknown");
});
