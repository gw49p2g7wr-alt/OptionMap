"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const Auth = require("../js/marketCalendarHistory/formalWriterAuthorizationV2.js");
const OldStore = require("../js/marketCalendarHistory/writerSafetyStore.js"), Old = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const Store = require("../js/marketCalendarHistory/writerSafetyVersionedStore.js"), E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Native = require("../scripts/marketCalendarE4fEnvelopeNative.js");
const H = label => A.hash({ label }), gate = H("explicit-isolated-gate");
const file = root => path.join(root, OldStore.RELATIVE_STATE_PATH);
async function fixture(fn, transitioned = false, legacySetup = null) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const old = OldStore.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  let store;
  try {
    assert.equal((await old.provisionDisabled()).saved, true);
    if (legacySetup) await legacySetup(old);
    old.close(); store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
    if (transitioned) { assert.equal((await migrate(store)).saved, true); assert.equal((await transition(store)).saved, true); }
    return await fn(store, root);
  } finally {
    if (store) { store.close(); assert.equal(store.audit().fileHandles, 0); assert.equal(store.audit().lockHandles, 0); }
    old.close(); fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false);
  }
}
const record = s => { const r = s.load(); assert.equal(r.available, true, r.reason); return r.record; };
const seq = s => record(s).safety.sequence;
const migrate = s => s.migrateLegacy({ expectedSequence: seq(s), gateIdentity: gate });
const transition = (s, patch = {}) => s.transitionAuthority({ expectedSequence: seq(s), expectedAuthorityVersion: 2,
  nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE], suspendedSourceSet: [], reasonCode: "machinery_startup_canary_gate", gateIdentity: gate, ...patch });
function candidate(s, label = "first") {
  const current = record(s).safety, policy = E.policyFor(current.persistedAuthorityVersion), cycleIdentity = H("cycle-" + label);
  return { policy, safety: E.safetyInput(current), sourceId: E.SOURCE, operation: "startup", cycleIdentity,
    context: A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity: H("attempt-" + label) }),
    acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: H("route"), expectedRouteIdentity: H("route"),
    schemaFingerprint: policy.global.schemaFingerprint, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: H("acquisition"), candidateIdentity: H("candidate"),
    comparisonIdentity: H("comparison"), formalPrecondition: H("precondition"), planIdentity: H("plan"), mutationCeiling: E.COUNTS };
}
async function pending(s) {
  const input = candidate(s), issued = Auth.issueAuthorizationCandidate(input); assert.equal(issued.valid, true);
  const result = await s.createPendingFence({ expectedSequence: seq(s), authorization: issued.authorization, authorizationInput: input, gateIdentity: gate });
  assert.equal(result.saved, true, result.reason); return { ...result, input, issued };
}
const advance = (s, ticket, phase, receipt = null, patch = {}) => s.advancePendingFence({ expectedSequence: seq(s), ticket, phase, receipt, gateIdentity: gate, ...patch });
const receipt = (s, ticket, kind, patch = {}) => s.createIsolatedReceipt({ targetEnvironment: "isolated_test", ticket, kind,
  outcome: "committed", mutationCounts: E.COUNTS, freshReadonly: true, integrityValid: true, otherSourcesUnchanged: true,
  expectedIdentity: H("readback"), observedIdentity: H("readback"), ...patch });
const complete = (s, ticket, proof, patch = {}) => s.completePendingFence({ expectedSequence: seq(s), ticket, receipt: proof, gateIdentity: gate, ...patch });
async function verified(s, ticket) {
  assert.equal((await advance(s, ticket, "formal_write_started")).saved, true);
  assert.equal((await advance(s, ticket, "commit_observed", receipt(s, ticket, "commit"))).saved, true);
  const proof = receipt(s, ticket, "readback"); assert.equal((await advance(s, ticket, "readback_verified", proof)).saved, true);
  return proof;
}
test("M1 legacy provisioned disabled recognised without corrupt/auto-upgrade", () => fixture((s, root) => {
  const bytes = fs.readFileSync(file(root)); assert.equal(s.load().kind, "legacy");
  assert.equal(E.validateEnvelope(record(s)).valid, true); assert.equal(s.load().reason, "explicit_migration_required");
  assert.deepEqual(fs.readFileSync(file(root)), bytes); assert.equal(s.audit().writes, 0);
}));
test("M2 explicit migration keeps old record/audit byte-material and increments sequence", () => fixture(async s => {
  const before = record(s); assert.equal((await migrate(s)).saved, true);
  const after = record(s); assert.deepEqual(after.legacyRecord, before); assert.equal(after.safety.sequence, 1);
  assert.equal(after.transitionAudit[0].previousSafetySequence, 0); assert.ok(A.isHash(after.migrationIdentity));
}));
test("M3 v2→v3 isolated authority transition, without old history rewrite", () => fixture(async s => {
  await migrate(s); const before = record(s); const r = await transition(s); assert.equal(r.saved, true, r.reason);
  const after = record(s); assert.equal(after.safety.persistedAuthorityVersion, 3); assert.equal(after.safety.sequence, 2);
  assert.deepEqual(after.legacyRecord, before.legacyRecord); assert.deepEqual(after.transitionAudit[0], before.transitionAudit[0]);
}));
test("M4 historical v2 audit remains valid under current v3", () => fixture(s => {
  const r = record(s); assert.equal(r.legacyRecord.transitionAudit[0].nextAuthorityVersion, 2);
  assert.equal(r.transitionAudit.at(-1).nextAuthorityVersion, 3); assert.equal(E.validateEnvelope(r).valid, true);
}, true));
test("historical validator remains pinned when a future production default is v3", () => fixture(s => {
  const vm = require("node:vm"), module = { exports: {} }, actual = record(s);
  const source = fs.readFileSync(require.resolve("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js"), "utf8");
  vm.runInNewContext(source, { module, require: name => {
    if (name === "./formalWriterAuthorityV2.js") return { ...A, PRODUCTION_POLICY: E.CANARY_CANDIDATE };
    if (name === "./formalWriterSafetyEvaluator.js") return S;
    if (name === "./writerSafetyFileSchema.js") return Old;
    throw Error("unexpected_fixture_dependency");
  }, structuredClone });
  assert.equal(module.exports.policyFor(2).global.state, "disabled");
  assert.equal(module.exports.validateEnvelope(actual).valid, true);
}, true));
test("M5 chain gaps/forks/duplicates and self-rehashed wrong version rejected", () => fixture(s => {
  const r = record(s);
  for (const mutate of [x => { x.transitionAudit[1].previousAuthorityVersion = 3; }, x => { x.transitionAudit.reverse(); },
    x => { x.transitionAudit[1].previousAuditIdentity = H("fork"); }, x => { x.transitionAudit.push(x.transitionAudit[1]); }]) {
    const bad = structuredClone(r); mutate(bad); assert.equal(E.validateEnvelope(Old.seal(bad)).valid, false);
  }
}, true));
test("M6 sequence continuity rejects reset, duplicate and gap", () => fixture(s => {
  for (const number of [0, 1, 9]) { const bad = structuredClone(record(s)); bad.transitionAudit[1].nextSafetySequence = number;
    assert.equal(E.validateEnvelope(Old.seal(bad)).valid, false); }
}, true));
test("M7 fresh process after transition verifies entire history and current identities", () => fixture((s, root) => {
  const before = record(s); s.close(); const fresh = Native.freshRead(root);
  assert.equal(fresh.result.available, true); assert.deepEqual(fresh.result.record, before); assert.equal(fresh.result.writeAllowed, false);
}, true));
test("M8 authority/sequence/fence/latch changes invalidate old authorization", () => fixture(async s => {
  const input = candidate(s), a = Auth.issueAuthorizationCandidate(input); assert.equal(a.valid, true);
  const modifiers = [x => { x.sequence++; }, x => { x.persistedAuthorityVersion = 2; },
    x => { x.globalSuspend = { suspended: true, reason: "commit_ambiguous" }; },
    x => { x.pendingFence = { sourceId: E.SOURCE, phase: "prepared", attemptIdentity: H("a"), cycleIdentity: H("c") }; },
    x => { x.sourcePermissionVersion++; }];
  for (const modify of modifiers) { const changed = structuredClone(input.safety); modify(changed);
    assert.equal(Auth.validateAuthorizationCandidate(a.authorization, { ...input, safety: S.sealSafetyMaterial(changed) }).valid, false); }
}, true));
test("F1 authorization-bound pending durable/read-back, no executor", () => fixture(async s => {
  const r = await pending(s), f = record(s).safety.pendingFence;
  assert.equal(f.authorizationIdentity, r.issued.binding.authorizationIdentity); assert.equal(f.safetySequence, 3);
  assert.equal(f.sourceId, E.SOURCE); assert.equal(f.operation, "startup"); assert.equal(r.durable, true); assert.equal(r.executionAllowed, false);
}, true));
for (const [name, patch] of [["F2 stale authorization", { safety: null }], ["F3 wrong source", { sourceId: "jp-esri-sna-calendar" }],
  ["F4 wrong authority version", { policy: A.PRODUCTION_POLICY }]]) test(name, () => fixture(async s => {
    const input = candidate(s), a = Auth.issueAuthorizationCandidate(input), bytes = JSON.stringify(record(s));
    const r = await s.createPendingFence({ expectedSequence: seq(s), authorization: a.authorization, authorizationInput: { ...input, ...patch }, gateIdentity: gate });
    assert.equal(r.saved, false); assert.equal(JSON.stringify(record(s)), bytes);
  }, true));
test("F5 stale expected safety sequence rejected before fence persistence", () => fixture(async s => {
  const input = candidate(s), a = Auth.issueAuthorizationCandidate(input);
  assert.equal((await s.createPendingFence({ expectedSequence: 1, authorization: a.authorization, authorizationInput: input, gateIdentity: gate })).reason, "safety_sequence_stale");
  assert.equal(record(s).safety.pendingFence, null);
}, true));
test("F6 prepared fence survives restart; missing/forged process ticket cannot progress", () => fixture(async (s, root) => {
  await pending(s); const before = record(s); s.close(); const fresh = Native.freshRead(root);
  assert.equal(fresh.result.reason, "interrupted_pending_fence"); assert.deepEqual(fresh.result.record, before);
  const next = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try { assert.equal((await advance(next, {}, "formal_write_started")).saved, false); } finally { next.close(); }
}, true));
test("F7 commit observed without fresh readback cannot clear and blocks restart", () => fixture(async (s, root) => {
  const { ticket } = await pending(s); await advance(s, ticket, "formal_write_started");
  const commit = receipt(s, ticket, "commit"); await advance(s, ticket, "commit_observed", commit);
  assert.equal((await complete(s, ticket, commit)).saved, false); s.close();
  assert.equal(Native.freshRead(root).result.record.safety.pendingFence.phase, "commit_observed");
}, true));
test("F8 verified fresh readback + exact mutations + integrity permits completion", () => fixture(async s => {
  const { ticket } = await pending(s), proof = await verified(s, ticket), before = record(s);
  assert.equal((await complete(s, ticket, proof)).saved, true);
  const after = record(s); assert.equal(after.safety.pendingFence, null); assert.equal(after.safety.sequence, 7);
  assert.deepEqual(after.legacyRecord, before.legacyRecord); assert.deepEqual(after.transitionAudit.slice(0, -1), before.transitionAudit);
}, true));
test("F9 completion persist failure leaves pending/unsafe, no second write; restart blocked", () => fixture(async (s, root) => {
  const { ticket } = await pending(s), proof = await verified(s, ticket), before = record(s);
  fs.writeFileSync(path.join(path.dirname(file(root)), "safety.tmp"), "injected IO collision", { mode: 0o600 });
  assert.equal((await complete(s, ticket, proof)).saved, false); assert.equal(s.audit().writerExecution, 0);
  s.close(); const fresh = Native.freshRead(root); assert.equal(fresh.result.available, false);
  assert.equal(Old.parse(fs.readFileSync(file(root), "utf8")).safety.pendingFence.phase, before.safety.pendingFence.phase);
}, true));
test("F10 completed attempt cannot replay, even using a new valid authorization token", () => fixture(async s => {
  const { ticket } = await pending(s), proof = await verified(s, ticket); await complete(s, ticket, proof);
  assert.equal((await complete(s, ticket, proof)).saved, false);
  const input = candidate(s), a = Auth.issueAuthorizationCandidate(input);
  const r = await s.createPendingFence({ expectedSequence: seq(s), authorization: a.authorization, authorizationInput: input, gateIdentity: gate });
  assert.equal(r.reason, "envelope_attempt_replayed"); assert.equal(record(s).safety.pendingFence, null);
}, true));
test("T1 transition requires explicit gate and fixed reason; no object patch API", () => fixture(async s => {
  await migrate(s); for (const patch of [{ gateIdentity: null }, { reasonCode: "active" }, { state: "active" }])
    assert.equal((await transition(s, patch)).saved, false);
  assert.equal((await transition(s)).saved, true); for (const method of ["write", "reset", "replace", "resume", "provisionDisabled"])
    assert.equal(s[method], undefined);
}));
test("T2/T3 code-fixed canary candidate Machinery only; other source elevation reject", () => fixture(async s => {
  const i = candidate(s), allowed = A.SOURCE_IDS.filter(sourceId => S.evaluate({ ...i, sourceId }).writeAllowed);
  assert.deepEqual(allowed, [E.SOURCE]); assert.deepEqual(i.policy.global.permittedOperations, ["startup"]);
  assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
}, true));
test("T3 transition cannot broaden ceiling, including arbitrary unknown source", () => fixture(async s => {
  await migrate(s);
  for (const approvedSourceCeiling of [[E.SOURCE, "jp-esri-sna-calendar"], ["unknown"], [], [A.BOJ]])
    assert.equal((await transition(s, { approvedSourceCeiling })).saved, false);
}));
test("T4 manual and renderer JSON/context spoof stay false", () => fixture(s => {
  const i = candidate(s);
  for (const context of [{ trigger: "startup" }, {}, JSON.parse(JSON.stringify(i.context)), null])
    assert.equal(S.evaluate({ ...i, context }).writeAllowed, false);
  assert.equal(S.evaluate({ ...i, operation: "manual" }).writeAllowed, false);
}, true));
test("T5 BOJ remains writer_ineligible irrespective of persistent candidate envelope", () => fixture(s => {
  const i = candidate(s); assert.equal(S.evaluate({ ...i, sourceId: A.BOJ }).writeAllowed, false);
  assert.equal(i.policy.permissions.entries.find(s => s.sourceId === A.BOJ).permission, "writer_ineligible");
}, true));
test("T6 transition with pending fence rejected, no rewriting", () => fixture(async s => {
  await pending(s); const before = record(s); assert.equal((await transition(s)).saved, false); assert.deepEqual(record(s), before);
}, true));
for (const [label, reason] of [["T7 global suspend", "orphan"], ["T7 source suspend", "unsupported_changed"]])
  test(label, () => fixture(async s => { await migrate(s);
    assert.equal((await transition(s, { suspendedSourceSet: reason === "orphan" ? [] : [E.SOURCE] })).saved, false);
  }, false, old => old.persistTransition({ expectedSequence: 0, signal: { sourceId: E.SOURCE, category: null, outcome: "failure",
    reason, cycleOrdinal: 1, cycleIdentity: H("failed-cycle") } })));
test("T8 wrong previous authority/version downgrade rejected", () => fixture(async s => {
  await migrate(s); for (const patch of [{ expectedAuthorityVersion: 1 }, { nextAuthorityVersion: 2 }, { nextAuthorityVersion: 4 }])
    assert.equal((await transition(s, patch)).saved, false);
}));
test("T9 wrong sequence rejected without version change", () => fixture(async s => {
  await migrate(s); assert.equal((await transition(s, { expectedSequence: 0 })).reason, "safety_sequence_stale");
  assert.equal(record(s).safety.persistedAuthorityVersion, 2);
}));
test("ambiguous commit keeps pending and global suspend candidate; no automatic retry", () => fixture(async (s, root) => {
  const { ticket } = await pending(s); await advance(s, ticket, "formal_write_started");
  const bad = receipt(s, ticket, "commit", { outcome: "ambiguous" });
  const result = await advance(s, ticket, "commit_observed", bad); assert.equal(result.reason, "commit_ambiguous");
  assert.equal(result.globalSuspendCandidate, true); assert.equal(record(s).safety.pendingFence.phase, "formal_write_started");
  s.close(); assert.equal(Native.freshRead(root).result.reason, "interrupted_pending_fence");
}, true));
test("readback mismatch/incomplete/cross-source/mutation mismatch cannot verify", () => fixture(async s => {
  const { ticket } = await pending(s); await advance(s, ticket, "formal_write_started");
  await advance(s, ticket, "commit_observed", receipt(s, ticket, "commit"));
  for (const patch of [{ observedIdentity: H("mismatch") }, { freshReadonly: false }, { integrityValid: false },
    { otherSourcesUnchanged: false }, { mutationCounts: { ...E.COUNTS, evidenceCreate: 5 } }]) {
    const result = await advance(s, ticket, "readback_verified", receipt(s, ticket, "readback", patch));
    assert.equal(result.saved, false); assert.equal(record(s).safety.pendingFence.phase, "commit_observed");
  }
}, true));
test("serialized/forged receipt cannot clear or advance a fence", () => fixture(async s => {
  const { ticket } = await pending(s); await advance(s, ticket, "formal_write_started");
  for (const receipt of [{ committed: true, readback: true }, {}, null]) assert.equal((await advance(s, ticket, "commit_observed", receipt)).saved, false);
}, true));
test("phase forward-only, cannot skip commit/readback; completion requires the verified receipt", () => fixture(async s => {
  const { ticket } = await pending(s); assert.equal((await advance(s, ticket, "commit_observed", {})).saved, false);
  const proof = await verified(s, ticket); assert.equal((await advance(s, ticket, "prepared", null)).saved, false);
  assert.equal((await complete(s, ticket, {}, { expectedSequence: seq(s) })).saved, false);
  assert.equal((await complete(s, ticket, proof)).saved, true);
}, true));
test("completed final state verified in fresh process, no active execution permissions", () => fixture(async (s, root) => {
  const { ticket } = await pending(s); await complete(s, ticket, await verified(s, ticket));
  const before = record(s); s.close(); const fresh = Native.freshRead(root);
  assert.equal(fresh.result.record.safety.pendingFence, null); assert.equal(fresh.result.record.safety.globalSuspend.suspended, false);
  assert.equal(fresh.result.record.checksum, before.checksum); assert.equal(fresh.result.record.safety.sequence, 7);
  assert.equal(fresh.result.writeAllowed, false);
}, true));
test("legacy nonzero sequence/counters retained; no migration reset", () => fixture(async s => {
  const before = record(s); await migrate(s); const after = record(s);
  assert.equal(after.safety.sequence, before.safety.sequence + 1); assert.deepEqual(after.safety.sources, before.safety.sources);
  assert.deepEqual(after.legacyRecord, before);
}, false, old => old.persistTransition({ expectedSequence: 0, signal: { sourceId: E.SOURCE, category: "acquisition_failure", outcome: "failure",
  reason: "network_failure", cycleOrdinal: 1, cycleIdentity: H("old-cycle") } })));
test("legacy pending recognised but migration does not adopt/clear it", () => fixture(async s => {
  assert.equal(s.load().kind, "legacy"); assert.equal((await migrate(s)).saved, false); assert.ok(record(s).safety.pendingFence);
}, false, old => old.persistPendingFence({ expectedSequence: 0, sourceId: E.SOURCE, attemptIdentity: H("old-a"),
  cycleIdentity: H("old-c"), operation: "startup", phase: "prepared" })));
test("bounded legacy+new audit stops at 128; never trims history", () => fixture(async s => {
  const before = record(s); assert.equal(before.transitionAudit.length, 127);
  assert.equal((await migrate(s)).saved, true); const migrated = record(s);
  assert.equal((await transition(s)).reason, "safety_audit_capacity_reached"); assert.deepEqual(record(s), migrated);
}, false, async old => {
  for (let n = 1; n <= 126; n++) assert.equal((await old.persistTransition({ expectedSequence: n - 1, signal: {
    sourceId: E.SOURCE, category: "acquisition_failure", outcome: "success", reason: null, cycleOrdinal: n, cycleIdentity: H("capacity-" + n) } })).saved, true);
}));
test("unknown fields/checksum, legacy rewrite and envelope identity tampering fail closed", () => fixture(s => {
  for (const mutate of [r => { r.extra = true; }, r => { r.safety.pendingFence = {}; },
    r => { r.legacyRecord.transitionAudit[0].nextAuthorityVersion = 3; }, r => { r.safety.validationIdentity = H("bad"); }]) {
    const r = structuredClone(record(s)); mutate(r); assert.equal(E.validateEnvelope(Old.seal(r)).valid, false);
  }
}, true));
test("concurrent updates and another owner reject; checkpoint state-only replay detected", () => fixture(async (s, root) => {
  const oldBytes = fs.readFileSync(file(root)); const first = migrate(s), second = await migrate(s);
  assert.equal(second.reason, "safety_update_concurrent"); assert.equal((await first).saved, true);
  const other = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try {
    assert.equal(other.load().available, false);
    assert.equal((await other.transitionAuthority({ expectedSequence: 1, expectedAuthorityVersion: 2,
      nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE], suspendedSourceSet: [],
      reasonCode: "machinery_startup_canary_gate", gateIdentity: gate })).reason, "safety_ownership_conflict");
  } finally { other.close(); }
  fs.writeFileSync(file(root), oldBytes); assert.equal(s.load().available, false);
}));
test("isolated path/main-only + no production/runtime/writer imports; API does not mutate on load", () => {
  assert.throws(() => Store.createIsolatedStore({ targetEnvironment: "production", userData: os.tmpdir(), crashAt: null }), /invalid/);
  assert.throws(() => Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: fs.realpathSync(os.tmpdir()), crashAt: null }), /path_invalid/);
  const old = global.window; global.window = { document: {} };
  try { assert.throws(() => Store.createIsolatedStore({}), /main_side_only/); } finally { if (old === undefined) delete global.window; else global.window = old; }
  for (const name of ["main.js", "preload.js", "js/marketCalendarRuntime/automaticFormalShadowRuntime.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), /writerSafetyVersioned/);
  for (const name of ["writerSafetyVersionedEnvelope", "writerSafetyVersionedStore"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../js/marketCalendarHistory", name + ".js"), "utf8"),
      /require\([^\n]*(?:electron|ControlledWriter|WriteExecutor|RuntimeState)|indexedDB|\.transaction\(/);
});
