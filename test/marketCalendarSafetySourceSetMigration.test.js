"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const Auth = require("../js/marketCalendarHistory/formalWriterAuthorizationV2.js");
const Historical = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js"), File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js"), P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
const Store = require("../js/marketCalendarHistory/writerSafetySourceSetStore.js"), Native = require("../scripts/marketCalendarG14aSafetyMigration.js");
const F = require("./fixtures/marketCalendar/safetySourceSetFixture.js");
const old = () => F.historical(), migrate = r => E.migrateSourceSet(r, E.requestFor(r, F.GATE));
const rejected = (r, patch, reason) => assert.throws(() => E.migrateSourceSet(r, { ...E.requestFor(r, F.GATE), ...patch }), reason);
const input = (r, sourceId = Historical.SOURCE, operation = "startup", label = "new") =>
  ({ ...F.candidate(r.historicalRecord, label, sourceId, operation), record: r });
test("M1 explicit envelope2/source-set1/permission1 → envelope3/source-set2/permission2", () => {
  const r = old(), next = migrate(r); assert.equal(E.validate(next).valid, true);
  assert.equal(next.schemaVersion, 3); assert.equal(next.safety.sourceSetVersion, 2); assert.equal(next.safety.sourcePermissionVersion, 2);
  assert.equal(next.safety.sequence, r.safety.sequence + 1); assert.deepEqual(next.historicalRecord, r);
});
test("M2 exact MOF-only addition and fixed13, independent of registry metadata", () => {
  assert.equal(P.SOURCE_IDS.length, 13); assert.deepEqual(P.SOURCE_IDS.filter(id => !A.SOURCE_IDS.includes(id)), [P.MOF]);
  for (const addedSourceIds of [[], ["unknown"], [P.MOF, P.MOF], [P.MOF, Historical.SOURCE]]) rejected(old(), { addedSourceIds }, /extension_invalid/);
});
test("M3 source removal is forbidden, not a replacement API", () => rejected(old(), { removedSourceIds: ["jp-stat-cpi"] }, /extension_invalid/));
test("M4 arbitrary valid N advances exactly once; stale/wrong sequence rejected", () => {
  for (const cycles of [0, 1, 4, 19]) {
    const r = F.historical({ cycles }); assert.equal(migrate(r).safety.sequence, cycles + 3);
    for (const expectedSequence of [r.safety.sequence - 1, r.safety.sequence + 1, -1, "2"])
      rejected(r, { expectedSequence }, /precondition_stale/);
  }
});
test("M5 wrong permission/envelope/source-set versions reject", () => {
  for (const patch of [{ expectedPermissionVersion: 2 }, { expectedEnvelopeVersion: 3 }, { expectedSourceSetVersion: 2 },
    { nextPermissionVersion: 1 }, { nextEnvelopeVersion: 2 }, { nextSourceSetVersion: 1 }]) rejected(old(), patch);
});
test("M6 duplicate/already-migrated state cannot migrate again", () => {
  const r = migrate(old()); rejected(r, {}, /historical_envelope_required/);
});
test("M7 pending authorization-bound fence blocks migration", () => rejected(F.pending(old()), {}, /pending_fence/));
test("M8 valid historical global-suspend envelope blocks migration", () => {
  const r = F.historical({ globalSuspend: true }); assert.equal(Historical.validateEnvelope(r).valid, true);
  rejected(r, {}, /global_suspended/);
});
test("M9 existing source suspend/counters retained byte-material, no resume/reset", () => {
  const r = F.historical({ cycles: 2, failureCycles: 2, suspendSource: true }), next = migrate(r);
  const before = r.safety.sources.find(s => s.sourceId === "jp-stat-cpi"); assert.equal(before.suspended, true);
  assert.equal(before.counters.acquisition_failure.count, 2);
  assert.deepEqual(next.safety.sources.filter(s => s.sourceId !== P.MOF), r.safety.sources);
  assert.deepEqual(next.safety.sources.find(s => s.sourceId === before.sourceId), before);
  assert.equal(P.evaluate(input(next, before.sourceId)).writeAllowed, false);
});
test("M10 MOF zero counters/no suspend/no pending, not copied from existing source", () => {
  const r = migrate(F.historical({ cycles: 2, suspendSource: true }));
  assert.deepEqual(r.safety.sources.find(s => s.sourceId === P.MOF), P.emptySource());
  assert.equal(r.safety.pendingFence, null);
});
test("M11 MOF permission v2 not_approved; authorization cannot be issued", () => {
  const r = migrate(old()), i = input(r, P.MOF);
  assert.equal(P.PERMISSIONS.entries.find(s => s.sourceId === P.MOF).permission, "not_approved");
  assert.equal(P.evaluate(i).reason, "unavailable_not_approved"); assert.equal(P.issueAuthorizationCandidate(i).valid, false);
});
test("M12 all13 startup/manual scope: only Machinery startup is potentially allowed", () => {
  const r = migrate(old());
  for (const sourceId of P.SOURCE_IDS) for (const operation of ["startup", "manual"])
    assert.equal(P.evaluate(input(r, sourceId, operation, sourceId + operation)).writeAllowed,
      sourceId === Historical.SOURCE && operation === "startup");
  assert.equal(r.safety.persistedAuthorityIdentity, Historical.policyFor(3).global.identity);
  assert.deepEqual(Historical.policyFor(3).global.permittedSources, [Historical.SOURCE]);
});
test("M13 BOJ writer-ineligible preserved in permission v1/v2", () => {
  assert.equal(P.PERMISSIONS.entries.find(s => s.sourceId === A.BOJ).permission, "writer_ineligible");
  assert.equal(P.evaluate(input(migrate(old()), A.BOJ)).reason, "writer_ineligible_identity_transition");
});
test("M14 old authorization cannot replay against migrated sequence/permission/source set", () => {
  const r = old(), i = F.candidate(r), issued = Auth.issueAuthorizationCandidate(i), next = migrate(r);
  assert.equal(issued.valid, true); assert.equal(Auth.validateAuthorizationCandidate(issued.authorization, i).valid, true);
  assert.equal(Auth.validateAuthorizationCandidate(issued.authorization, { ...i, safety: next.safety }).valid, false);
  assert.equal(P.validateAuthorizationCandidate(issued.authorization, { ...i, record: next }).valid, false);
  assert.equal(Historical.validateEnvelope(r).valid, true); // Old identities are not rewritten.
});
test("M15 old audit entries/checksum and authority/permission histories unchanged", () => {
  const r = F.historical({ cycles: 5, suspendSource: true }), next = migrate(r);
  assert.deepEqual(next.historicalRecord, r); assert.equal(Historical.validateEnvelope(next.historicalRecord).valid, true);
  assert.equal(next.sourceSetAudit[0].previousAuditIdentity, r.transitionAudit.at(-1).auditIdentity);
  assert.equal(A.hash(next.historicalRecord), A.hash(r));
});
test("M16 migration audit exact chain/version/sequence/source-set/gate continuity", () => {
  const r = old(), next = migrate(r), row = next.sourceSetAudit[0];
  assert.deepEqual(row.sourceSetBefore, A.SOURCE_IDS); assert.deepEqual(row.sourceSetAfter, P.SOURCE_IDS);
  assert.deepEqual(row.addedSourceIds, [P.MOF]); assert.deepEqual(row.removedSourceIds, []);
  assert.equal(row.gateIdentity, F.GATE); assert.equal(row.previousSequence, r.safety.sequence);
  assert.equal(row.nextSequence, next.safety.sequence); assert.equal(row.previousPermissionVersion, 1); assert.equal(row.nextPermissionVersion, 2);
  for (const mutate of [x => { x.sourceSetAudit[0].previousSequence++; }, x => { x.sourceSetAudit[0].sourceSetBefore.pop(); },
    x => { x.sourceSetAudit[0].previousAuditIdentity = F.H("fork"); }, x => { x.sourceSetAudit.push(x.sourceSetAudit[0]); },
    x => { x.historicalRecord.transitionAudit[0].reasonCode = "rewritten"; }]) {
    const bad = structuredClone(next); mutate(bad); assert.equal(E.validate(File.seal(bad)).valid, false);
  }
});
test("M17 fresh process load exact13/p2/sequence/history/ceiling, without IO per source", () => Native.withSeed(async (root, r) => {
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try { assert.equal((await store.migrateSourceSet(E.requestFor(r, F.GATE))).saved, true); } finally { store.close(); }
  const fresh = Native.child("read", root); assert.equal(fresh.code, 0);
  const value = fresh.output.result.record; assert.equal(value.safety.sources.length, 13); assert.equal(value.safety.sourcePermissionVersion, 2);
  assert.deepEqual(value.historicalRecord, r); assert.deepEqual(fresh.output.allowedSources, [Historical.SOURCE]);
  assert.equal(fresh.output.audit.writes, 0); assert.equal(fresh.output.audit.fileHandles, 0);
}));
test("M18 total audit128 fails closed without trim/delete/reset", () => {
  const r = F.historical({ cycles: 125 });
  assert.equal(r.legacyRecord.transitionAudit.length + r.transitionAudit.length, 128);
  assert.equal(Historical.validateEnvelope(r).valid, true); rejected(r, {}, /audit_capacity_reached/);
  const room = F.historical({ cycles: 124 }), next = migrate(room);
  assert.equal(next.historicalRecord.legacyRecord.transitionAudit.length + next.historicalRecord.transitionAudit.length + next.sourceSetAudit.length, 128);
});
test("load dispatch recognizes historical/new without auto-upgrade; old reader rejects new version", () => Native.withSeed(async (root, r) => {
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try {
    const before = fs.readFileSync(path.join(root, Store.DIRECTORY, "selection.json"));
    assert.equal(store.load().kind, "historical"); assert.equal(store.load().autoUpgrade, false); assert.equal(store.audit().writes, 0);
    assert.deepEqual(fs.readFileSync(path.join(root, Store.DIRECTORY, "selection.json")), before);
    const migrated = await store.migrateSourceSet(E.requestFor(r, F.GATE)); assert.equal(migrated.saved, true);
    assert.equal(Historical.validateEnvelope(migrated.record).valid, false); assert.equal(E.validate(r).valid, true);
    const oldReader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js").createReader(path.join(root, Store.DIRECTORY, "extended"));
    assert.equal(oldReader.load().status, "corrupt"); assert.equal(oldReader.audit().writes, 0);
  } finally { store.close(); }
}));
test("migration requires exact input schema/reason/gate; no arbitrary replacement", () => {
  for (const patch of [{ extra: true }, { gateIdentity: null }, { reasonCode: "activate" }, { addedSourceIds: null }]) rejected(old(), patch);
  const request = { ...E.requestFor(old(), F.GATE) }; delete request.expectedSourceSetVersion;
  assert.throws(() => E.migrateSourceSet(old(), request), /input_invalid/);
});
test("current13 mutation, permission elevation, unknown/duplicate/missing source fail closed", () => {
  for (const mutate of [x => { x.safety.sources.pop(); }, x => { x.safety.sources.push(x.safety.sources[0]); },
    x => { x.safety.sourcePermissionIdentity = F.H("approved-mof"); }, x => { x.safety.sequence = 0; },
    x => { x.safety.sources.find(s => s.sourceId === P.MOF).suspended = true; }, x => { x.safety.globalSuspend.suspended = true; },
    x => { x.extra = true; }]) {
    const bad = structuredClone(migrate(old())); mutate(bad); assert.equal(E.validate(File.seal(bad)).valid, false);
  }
});
test("new candidate binding has new version/p2 identity; one-use/context-bound, never executable", () => {
  const r = migrate(old()), i = input(r), issued = P.issueAuthorizationCandidate(i);
  assert.equal(issued.valid, true); assert.equal(issued.executionAllowed, false);
  assert.equal(issued.binding.bindingContractVersion, 3); assert.equal(issued.binding.sourcePermissionVersion, 2);
  assert.equal(issued.binding.sourceSetVersion, 2); assert.equal(issued.binding.sourcePermissionIdentity, P.PERMISSIONS.identity);
  assert.equal(P.validateAuthorizationCandidate(issued.authorization, i).valid, true);
  assert.equal(P.validateAuthorizationCandidate({}, i).valid, false); assert.equal(P.validateAuthorizationCandidate(issued.authorization).valid, false);
  assert.equal(P.issueAuthorizationCandidate(i).valid, false);
  assert.equal(P.consumeAuthorizationCandidate(issued.authorization, i).valid, true);
  assert.equal(P.consumeAuthorizationCandidate(issued.authorization, i).valid, false);
});
test("renderer/context/policy override spoof and acquisition/route/integrity/changed fail closed", () => {
  const r = migrate(old()), i = input(r);
  for (const patch of [{ context: { trigger: "startup" } }, { context: structuredClone(i.context) },
    { policy: A.createIsolatedPolicy({ targetEnvironment: "isolated_test", permittedSources: A.SOURCE_IDS.filter(x => x !== A.BOJ) }) },
    { cycleIdentity: F.H("other") }, { acquisition: { outcome: "partial", failedRoles: [] } }, { expectedRouteIdentity: F.H("wrong") },
    { integrityValid: false }, { changed: 1 }, { revisionTransitionCount: 1 }, { absenceAuthority: "cancel" }])
    assert.equal(P.evaluate({ ...i, ...patch }).writeAllowed, false);
});
test("new authorization cannot broaden the exact Machinery mutation ceiling", () => {
  const r = migrate(old());
  for (const mutationCeiling of [{ ...Historical.COUNTS, eventEntryCreate: 1 }, { ...Historical.COUNTS, evidenceCreate: 5 },
    { ...Historical.COUNTS, semanticRevisionClose: 1 }, { ...Historical.COUNTS, extra: 0 }])
    assert.equal(P.issueAuthorizationCandidate({ ...input(r), mutationCeiling }).valid, false);
});
test("store stale and concurrent updates cannot publish a second migration", () => Native.withSeed(async (root, r) => {
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try {
    const before = store.load().record.checksum;
    const bad = await store.migrateSourceSet({ ...E.requestFor(r, F.GATE), expectedSequence: 9 }); assert.equal(bad.saved, false);
    assert.equal(store.load().record.checksum, before);
    const [a, b] = await Promise.all([store.migrateSourceSet(E.requestFor(r, F.GATE)), store.migrateSourceSet(E.requestFor(r, F.GATE))]);
    assert.equal(a.saved, true); assert.equal(b.reason, "safety_update_concurrent");
    assert.equal((await store.migrateSourceSet(E.requestFor(r, F.GATE))).saved, false); assert.equal(store.audit().publishes, 1);
  } finally { store.close(); assert.equal(store.audit().fileHandles, 0); }
}));
test("isolated factory rejects production/arbitrary path/environment; no production factory/setter", () => {
  assert.equal(Store.createProductionStore, undefined);
  for (const targetEnvironment of ["production", "renderer", undefined])
    assert.throws(() => Store.createIsolatedStore({ targetEnvironment, userData: "/not-a-profile", crashAt: null }));
  assert.throws(() => Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: process.cwd(), crashAt: null }));
});
test("generation/checkpoint/selection tamper is rejected; no auto repair", () => Native.withSeed((root) => {
  const file = path.join(root, Store.DIRECTORY, "baseline", "market-calendar-writer-safety", "sequence.json");
  const bad = File.parse(fs.readFileSync(file, "utf8")); bad.sequence++;
  fs.writeFileSync(file, JSON.stringify(File.seal(bad)), { mode: 0o600 });
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try { assert.equal(store.load().available, false); assert.equal(store.audit().writes, 0); } finally { store.close(); }
}));
test("exclusive ownership blocks competing mutation but readonly load remains stable", () => Native.withSeed(async (root, r) => {
  const options = { targetEnvironment: "isolated_test", userData: root, crashAt: null };
  const a = Store.createIsolatedStore(options), b = Store.createIsolatedStore(options);
  try {
    assert.equal((await a.migrateSourceSet({ ...E.requestFor(r, F.GATE), expectedSequence: 9 })).saved, false);
    assert.equal(b.load().available, true); assert.equal((await b.migrateSourceSet(E.requestFor(r, F.GATE))).saved, false);
    assert.equal(a.load().record.checksum, r.checksum);
  } finally { a.close(); b.close(); }
}));
test("historical identities/authorization material remain immutable under new permission module", () => {
  assert.equal(A.PRODUCTION_POLICY.global.identity, "1fd05aefc041d299a1e3c2f0b1fe6c8f47403af11b56fa765d3ca26c7656d58c");
  assert.equal(Historical.policyFor(3).global.identity, "62d49ff8d78e01daae2bd42a556cca11e6b6a4de38e58a64355fa385bf8ea758");
  assert.equal(Historical.policyFor(3).permissions.identity, "e039f9830dada915645686bd51fbe70c2d5ad5c8eced66ce29c94d861d7f82ba");
  assert.equal(P.PERMISSIONS.permissionVersion, 2); assert.notEqual(P.PERMISSIONS.identity, Historical.policyFor(3).permissions.identity);
  assert.deepEqual(A.SOURCE_IDS, P.HISTORICAL_IDS);
});
test("nonzero failure counters1/2/3 and evaluated cycle identities survive migration", () => {
  for (const failureCycles of [1, 2, 3]) {
    const r = F.historical({ failureCycles }), next = migrate(r);
    const before = r.safety.sources.find(s => s.sourceId === "jp-stat-cpi");
    assert.equal(before.counters.acquisition_failure.count, failureCycles);
    assert.equal(before.suspended, failureCycles === 3);
    assert.deepEqual(next.safety.sources.find(s => s.sourceId === before.sourceId), before);
    assert.deepEqual(next.safety.globalSuspend, r.safety.globalSuspend);
  }
});
test("historical Machinery receipt/reconstruction remains valid without reinterpretation as13", async () => {
  const Shadow = require("../js/marketCalendarRuntime/automaticFormalShadow.js"), Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
  const Fixture = require("./fixtures/marketCalendar/automaticShadowFixture.js"), C = require("../js/marketCalendar/marketEventCanonicalizer.js");
  const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"), Reconstruction = require("../js/marketCalendarRuntime/freshDayCanaryReconstruction.js");
  const f = await Fixture.fixture({ perSource: 4 }), evaluated = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  const plan = evaluated.plans.find(p => p.sourceId === Historical.SOURCE), snapshot = Core.applyToMemory(f.snapshot, plan, Core.expectedWrites(plan, f.snapshot));
  const identity = await C.sha256(snapshot), record = F.complete(old(), identity), next = migrate(record);
  const counts = { entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 };
  const evidence = { record, snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, executionReceipt: { saved: true, finalSequence: 7, pendingCleared: true,
    result: { status: "verified", committed: true, audit: { readwrite: 1, committed: 1, aborted: 0, create: 0, upgrade: 0, delete: 0,
      openHandles: 0, readbackReopens: 1, committedWrites: counts, attemptedWrites: counts },
    verification: { valid: true, expectedIdentity: identity, observedIdentity: identity }, transactionMs: 1, readbackMs: 1 } } };
  assert.equal((await Reconstruction.reconstruct(evidence)).valid, true);
  assert.equal((await Reconstruction.reconstruct({ ...evidence, record: next.historicalRecord })).valid, true);
  assert.equal((await Reconstruction.reconstruct({ ...evidence, record: next })).valid, false);
  assert.deepEqual(next.historicalRecord, record); assert.equal(record.safety.sequence, 7); assert.equal(next.safety.sequence, 8);
});
test("crash all6 required points plus publication: real child exit + fresh restart selects only valid old/new", async () => {
  const report = await Native.nativeAcceptance(); assert.equal(report.status, "PASS"); assert.equal(report.crashes.length, 8);
  assert.equal(report.crashes.filter(r => r.selected === "new").length, 1);
  assert.equal(report.cleanup.tempProfiles, 0); assert.equal(report.cleanup.handles, 0);
  assert.equal(report.productionUserDataAccess, 0); assert.equal(report.network, 0); assert.equal(report.writerExecution, 0);
});
