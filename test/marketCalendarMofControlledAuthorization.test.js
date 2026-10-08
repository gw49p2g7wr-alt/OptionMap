"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Semantic = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js");
const Auth = require("../js/marketCalendarHistory/mofControlledAuthorization.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const L = require("../js/marketCalendarHistory/writerSafetyControlledLifecycle.js");
const P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
const Historical = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const F = require("./fixtures/marketCalendar/mofControlledFixture.js");
const Safety = require("./fixtures/marketCalendar/safetySourceSetFixture.js");
const Native = require("../scripts/marketCalendarG15b0ControlledNative.js");
const Store = require("../js/marketCalendarHistory/mofControlledSafetyStore.js");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const PC = require("../js/marketCalendarHistory/planCanonicalizer.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");
const Shadow = require("../js/marketCalendarHistory/formalShadowWritePlan.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const base = () => { const old = Safety.historical({ cycles: 5 }); return E.migrateSourceSet(old, E.requestFor(old, Safety.GATE)); };
async function prepared(label = "a", snapshot = F.empty()) {
  return Semantic.prepare({ source: await F.source(label), snapshot, attemptIdentity: A.hash(label) });
}
async function authorization(label = "a") { const record = base(), preparation = await prepared(label);
  return { record, preparation, authorization: Auth.createControlledAuthorization({ record, preparation }) }; }
const context = p => ({ preparation: p, sourceId: Semantic.SOURCE, operation: Semantic.OPERATION });
function consume(a, changes = {}) { return Auth.consume(a.authorization, { record: a.record, ...context(a.preparation), ...changes }); }
test("A1 separate MOF one-shot authority leaves persistent permission false", async () => {
  const a = await authorization(), b = consume(a).binding;
  assert.equal(P.evaluate({ record: a.record, sourceId: Semantic.SOURCE }).writeAllowed, false);
  assert.equal(P.PERMISSIONS.entries.find(e => e.sourceId === Semantic.SOURCE).permission, "not_approved");
  assert.deepEqual(b.counts, Semantic.COUNTS); assert.deepEqual(Object.keys(b).sort(), [...L.BINDING_FIELDS].sort());
  assert.equal(a.record.safety.sequence, 8); assert.equal(b.semanticPlanIdentity, Semantic.SEMANTIC_IDENTITY);
});
test("A2 opaque one-use success token cannot be serialized/replayed", async () => {
  const a = await authorization(); assert.deepEqual(Object.keys(a.authorization), []);
  assert.throws(() => Auth.consume(JSON.parse(JSON.stringify(a.authorization)), { record: a.record, ...context(a.preparation) }), /unknown/);
  consume(a); assert.throws(() => consume(a), /spent_or_unknown/);
});
for (const [label, wrong] of [["Machinery", "jp-esri-machinery-orders-calendar"], ["BOJ", A.BOJ], ["CPI", "jp-stat-cpi"]])
  test(`A3 wrong source ${label} is rejected and spends token`, async () => {
    const a = await authorization(); assert.throws(() => consume(a, { sourceId: wrong }), /binding_mismatch/);
    assert.throws(() => consume(a), /spent_or_unknown/);
    assert.throws(() => Auth.createControlledAuthorization({ record: a.record, preparation: a.preparation, sourceId: wrong }), /unavailable/);
  });
for (const operation of ["startup", "manual", "fresh-day-startup-canary"])
  test(`A4 wrong operation ${operation}`, async () => { const a = await authorization();
    assert.throws(() => consume(a, { operation }), /binding_mismatch/); assert.throws(() => consume(a), /spent/); });
test("A5 stale sequence/envelope/source-set/permission/authority fail closed", async () => {
  for (const [field, value] of [["sequence", 9], ["safetyEnvelopeVersion", 2], ["sourceSetVersion", 1],
    ["sourcePermissionVersion", 1], ["persistedAuthorityVersion", 2]]) {
    const a = await authorization(), bad = structuredClone(a.record); bad.safety[field] = value;
    const { validationIdentity: _, ...material } = bad.safety;
    bad.safety.validationIdentity = A.hash(material);
    assert.throws(() => consume(a, { record: File.seal(bad) }), /binding_mismatch/);
    assert.throws(() => consume(a), /spent/);
  }
});
test("A6 different fresh acquisition/attempt cannot reuse authorization", async () => {
  const a = await authorization(); const next = await prepared("different");
  assert.throws(() => consume(a, { preparation: next }), /binding_mismatch/);
  assert.throws(() => consume(a), /spent/);
});
test("D1 fetchedAt only changes semantic identity unchanged, fresh observation binding changes", async () => {
  const s = await F.source(), first = await Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash("same") });
  for (const r of s.canonicalRecords) { r.acquisitionEvidence.fetchedAt = "2026-10-10T00:01:00.000Z";
    r.source = r.acquisitionEvidence; r.acquisitionEvidenceHash = A.hash(r.acquisitionEvidence);
    r.acquisitionEvidenceKey = `${Semantic.SOURCE}|sha256:${r.acquisitionEvidenceHash}`; }
  const next = await Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash("same") });
  assert.equal(Semantic.inspect(first).semanticPlanIdentity, Semantic.inspect(next).semanticPlanIdentity);
  assert.notEqual(Semantic.inspect(first).acquisitionIdentity, Semantic.inspect(next).acquisitionIdentity);
  assert.notEqual(Semantic.inspect(first).planIdentity, Semantic.inspect(next).planIdentity);
  const a = Auth.createControlledAuthorization({ record: base(), preparation: next }); assert(consume({ record: base(), preparation: next, authorization: a }));
});
test("D2 fresh Evidence observation identities are bound, not approved semantic hashes", async () => {
  const first = await prepared("first"), next = await prepared("next");
  assert.equal(Semantic.inspect(first).semanticPlanIdentity, Semantic.inspect(next).semanticPlanIdentity);
  assert.notDeepEqual(Semantic.inspect(first).evidenceIdentities, Semantic.inspect(next).evidenceIdentities);
  const a = await authorization("first"); assert.throws(() => consume(a, { preparation: next }), /binding_mismatch/);
});
for (const [id, mutate] of [["D3 identity", s => { s.canonicalRecords[0].eventKey += "-drift"; }],
  ["D4 semantic hash", s => { s.canonicalRecords[0].canonicalContentHash = "f".repeat(64); }],
  ["D5 count", s => { s.canonicalRecords.pop(); }]])
  test(`${id} drift rejects count-only authorization`, async () => { const s = await F.source(); mutate(s);
    await assert.rejects(Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash(id) }), /ceiling_mismatch/); });
test("D6 mutation-class drift cannot manufacture a preparation", async () => {
  const real = await prepared(), plan = structuredClone(Semantic.inspect(real).plan);
  plan.mutations.updateEntries.push(plan.mutations.appendEntries.pop()); plan.counts = Semantic.count(plan.mutations);
  plan.planIdentity = A.hash(Object.fromEntries(Object.entries(plan).filter(([k]) => k !== "planIdentity")));
  assert.notDeepEqual(plan.counts, Semantic.COUNTS);
  assert.throws(() => Auth.createControlledAuthorization({ record: base(), preparation: { ...Semantic.inspect(real), plan } }), /preparation_invalid/);
});
test("A7 public exact8 count and operation contracts, no deletes", async () => {
  const p = Semantic.inspect(await prepared()).plan;
  assert.deepEqual(Object.keys(p.counts), [...Gate.FIELDS]);
  assert.deepEqual(Object.keys(p.mutations), [...PC.ARRAY_KEYS]);
  assert.equal((await Shadow.validateShadowPlan(p)).valid, true);
  const bad = structuredClone(p); bad.mutations.deleteEntries = [];
  assert.throws(() => Semantic.count(bad.mutations), /operation_set_invalid/);
  assert.equal((await Shadow.validateShadowPlan(bad)).valid, false);
});
test("A8 canonical contents are rehashed, not just claimed hashes", async () => {
  const s = await F.source(); s.canonicalRecords[0].title.ja += "drift";
  await assert.rejects(Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash("bad") }), /evidence_invalid/);
});
test("A12 original G1.5a Evidence cannot be reused as fresh observation", async () => {
  const s = await F.source();
  for (const r of s.canonicalRecords) {
    r.acquisitionEvidence.fetchedAt = "2026-10-08T11:23:58.819Z"; r.acquisitionEvidence.requestId = null;
    r.source = r.acquisitionEvidence; r.acquisitionEvidenceHash = A.hash(r.acquisitionEvidence);
    r.acquisitionEvidenceKey = `${Semantic.SOURCE}|sha256:${r.acquisitionEvidenceHash}`;
  }
  await assert.rejects(Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash("replay") }), /old_observation_replay/);
});
test("A9 incomplete/bad documents or index evidence reject", async () => {
  for (const mutate of [s => s.documentHealth.pop(), s => { s.documentHealth[1].redirectCount = 1; },
    s => { s.documentHealth[1].requestedUrl = "https://evil.invalid/"; },
    s => { const r = s.canonicalRecords[0]; r.acquisitionEvidence.sourceUrl = s.documentHealth[0].requestedUrl;
      r.source = r.acquisitionEvidence; r.acquisitionEvidenceHash = A.hash(r.acquisitionEvidence);
      r.acquisitionEvidenceKey = `${Semantic.SOURCE}|sha256:${r.acquisitionEvidenceHash}`; }]) {
    const s = await F.source(); mutate(s); await assert.rejects(Semantic.prepare({ source: s, snapshot: F.empty(), attemptIdentity: A.hash("bad") }));
  }
});
test("A10 unexpected existing MOF first-write presence rejects", async () => {
  const p = Semantic.inspect(await prepared());
  await assert.rejects(prepared("next", p.expected), /first_write_only/);
});
test("A11 Formal precondition drift invalidates authorization", async () => {
  const a = await authorization(); const snapshot = (await require("./fixtures/marketCalendar/automaticShadowFixture.js").fixture()).snapshot;
  const next = await prepared("next", snapshot);
  assert.notEqual(Semantic.inspect(a.preparation).formalPrecondition, Semantic.inspect(next).formalPrecondition);
  assert.throws(() => consume(a, { preparation: next }), /binding_mismatch/);
});
test("L1 lifecycle cannot skip commit/read-back or synthesize completion", async () => {
  const a = await authorization(), b = consume(a).binding, current = L.append(a.record, a.record, "prepared", b);
  assert(E.validate(current).valid); assert.equal(current.safety.sequence, 9);
  assert.throws(() => L.append(a.record, current, "completed", b), /phase_invalid/);
  const started = L.append(a.record, current, "formal_write_started", b);
  assert.throws(() => L.append(a.record, started, "commit_observed", b, {}), /receipt_invalid/);
  assert.equal(P.evaluate({ record: current, sourceId: Semantic.SOURCE }).writeAllowed, false);
});
test("L2 resealed arbitrary patch or audit binding drift rejects", async () => {
  const a = await authorization(), b = consume(a).binding, current = L.append(a.record, a.record, "prepared", b);
  for (const mutate of [r => { r.safety.sequence++; }, r => { r.safety.sources[0].counters.acquisition_failure.count++; },
    r => { r.controlledLifecycleAudit[0].binding.operation = "manual"; }, r => { r.safety.pendingFence = null; }]) {
    const bad = structuredClone(current); mutate(bad); const { validationIdentity: _, ...s } = bad.safety;
    bad.safety.validationIdentity = A.hash(s); assert.equal(E.validate(File.seal(bad)).valid, false);
  }
});
test("L3 Machinery historical authority, BOJ and MOF permissions stay fixed", () => {
  const record = base(); assert(E.validate(record).valid);
  assert.equal(Historical.validateEnvelope(record.historicalRecord).valid, true);
  assert.equal(Historical.policyFor(3).permissions.entries.find(e => e.sourceId === "jp-esri-machinery-orders-calendar").permission, "approved");
  assert.equal(P.PERMISSIONS.entries.find(e => e.sourceId === A.BOJ).permission, "writer_ineligible");
  assert.equal(P.evaluate({ record, sourceId: A.BOJ }).writeAllowed, false);
  assert.equal(P.evaluate({ record, sourceId: Semantic.SOURCE }).reason, "unavailable_not_approved");
});
test("L4 isolated-only factory rejects production/arbitrary path before opening it", () => {
  assert.throws(() => Store.createIsolatedStore({ userData: "relative" }), /path_invalid/);
  assert.throws(() => Store.createIsolatedStore({ userData: "/Users/natsu/Library/Application Support/OptionMap" }), /path_invalid/);
});
test("L5 full native fresh-process lifecycle + crash/restart acceptance", { timeout: 45000 }, async () => {
  const report = await Native.nativeAcceptance(); assert.equal(report.status, "PASS");
  assert.equal(report.success.startSequence, 8); assert.equal(report.success.endSequence, 13);
  assert.equal(report.crashes.length, Store.CRASH_POINTS.length);
  assert.equal(report.success.audit.authorizations, 1); assert.equal(report.success.audit.persists, 5);
  assert.deepEqual(report.success.audit.committedWrites, { entries: 16, revisions: 16, evidence: 16, observations: 16, runs: 1, cursors: 1 });
  assert.deepEqual(report.cleanup, { tempProfiles: 0, handles: 0, children: 0 }); assert.equal(Cycle.activeCount(), 0);
});
test("L6 durable completed history prevents a new authorization on restart", async () => {
  await Native.withMigrated(async root => {
    const run = Native.child("attempt", root); assert.equal(run.code, 0);
    const record = Reader.createReader(root).load().record;
    assert.throws(() => Auth.createControlledAuthorization({ record, preparation: {} }), /unavailable/);
    const s = Store.createIsolatedStore({ userData: root });
    assert.throws(() => s.createControlledAuthorization({ preparation: {} }), /unavailable/); s.close();
  });
});
test("L9 exclusive ownership prevents concurrent attempts", async () => {
  await Native.withMigrated(async root => {
    const first = Store.createIsolatedStore({ userData: root }), second = Store.createIsolatedStore({ userData: root });
    const preparation = await prepared(); first.createControlledAuthorization({ preparation });
    assert.throws(() => second.createControlledAuthorization({ preparation }), /safety_unavailable/);
    assert.equal(first.audit().authorizations, 1); assert.equal(second.audit().authorizations, 0);
    assert.equal(first.audit().readwriteTransactions + second.audit().readwriteTransactions, 0);
    first.close(); second.close(); assert.equal(Reader.createReader(root).load().status, "corrupt");
  });
});
test("L10 sequence progression derives from current sequence, not a fixed 8", async () => {
  const old = Safety.historical({ cycles: 7 }), record = E.migrateSourceSet(old, E.requestFor(old, Safety.GATE));
  const preparation = await prepared(), a = Auth.createControlledAuthorization({ record, preparation });
  const binding = Auth.consume(a, { record, ...context(preparation) }).binding;
  const pending = L.append(record, record, "prepared", binding);
  assert.equal(pending.safety.sequence, record.safety.sequence + 1); assert.equal(pending.safety.sequence, 11);
  assert(E.validate(pending).valid); assert.deepEqual(pending.historicalRecord, old);
});
test("L11 exact receipt identity/counts and fresh readback facts are mandatory", async () => {
  const a = await authorization(), b = consume(a).binding;
  let current = L.append(a.record, a.record, "prepared", b);
  current = L.append(a.record, current, "formal_write_started", b);
  const common = Object.fromEntries(["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity", "counts"]
    .map(k => [k, b[k]]));
  const commit = { ...common, readwriteTransactions: 1, committedTransactions: 1, abortedTransactions: 0 };
  for (const bad of [{ ...commit, committedTransactions: 0 }, { ...commit, sourceId: A.BOJ },
    { ...commit, counts: { ...commit.counts, evidenceCreate: 15 } }, { ...commit, attemptIdentity: A.hash("wrong") }])
    assert.throws(() => L.append(a.record, current, "commit_observed", b, bad));
  current = L.append(a.record, current, "commit_observed", b, commit);
  const readback = { ...common, freshReadonlyReopen: true, integrity: true, otherSourcesUnchanged: true,
    expectedFormalIdentity: b.expectedFormalIdentity, actualFormalIdentity: b.expectedFormalIdentity };
  for (const key of ["freshReadonlyReopen", "integrity", "otherSourcesUnchanged"])
    assert.throws(() => L.append(a.record, current, "readback_verified", b, { ...readback, [key]: false }), /incomplete/);
  assert.throws(() => L.append(a.record, current, "readback_verified", b,
    { ...readback, actualFormalIdentity: A.hash("wrong") }), /incomplete/);
  current = L.append(a.record, current, "readback_verified", b, readback);
  current = L.append(a.record, current, "completed", b, readback);
  assert(E.validate(current).valid); assert.equal(current.safety.pendingFence, null);
  assert.deepEqual(current.safety.sources, a.record.safety.sources);
  assert.deepEqual(current.sourceSetAudit, a.record.sourceSetAudit);
  assert.throws(() => L.append(a.record, current, "prepared", b), /phase_invalid/);
});
test("L12 audit capacity stops instead of trimming history", async () => {
  const old = Safety.historical({ cycles: 124 }), record = E.migrateSourceSet(old, E.requestFor(old, Safety.GATE));
  const preparation = await prepared();
  assert.throws(() => Auth.createControlledAuthorization({ record, preparation }), /audit_capacity_reached/);
  assert.equal(E.validate(record).valid, true);
});
test("L13 full post-write identity detects other-source changes; no completion/retry", async () => {
  await Native.withMigrated(async root => {
    const before = (await require("./fixtures/marketCalendar/automaticShadowFixture.js").fixture()).snapshot;
    const preparation = await prepared("isolation", before), store = Store.createIsolatedStore({ userData: root });
    const a = store.createControlledAuthorization({ preparation }), h = store.createPendingFence(a, context(preparation));
    const db = await Native.database(before);
    try {
      await store.markWriteStarted(h, db.db); store.markCommitObserved(h);
      const tampered = await db.open();
      await new Promise((resolve, reject) => { const tx = tampered.transaction([Core.STORE_NAMES[0]], "readwrite");
        tx.oncomplete = resolve; tx.onabort = reject;
        tx.objectStore(Core.STORE_NAMES[0]).put({ ...before.entries[0], lastObservedAt: "2026-10-10T00:00:00.000Z" }); });
      tampered.close();
      await assert.rejects(store.markReadbackVerified(h, db.open), /readback_mismatch/);
      assert.throws(() => store.completeControlledAttempt(h), /handle_invalid/);
      assert.equal(store.audit().readwriteTransactions, 1); assert.equal(Reader.createReader(root).load().status, "corrupt");
    } finally { db.db.close(); store.close(); }
  });
});
test("L14 resealed malformed checkpoint rejects before Formal transaction", async () => {
  for (const target of ["selected", "retained"]) await Native.withMigrated(async root => {
    const preparation = await prepared(), store = Store.createIsolatedStore({ userData: root });
    const a = store.createControlledAuthorization({ preparation }), h = store.createPendingFence(a, context(preparation));
    const directory = target === "selected" ? path.join(root, "market-calendar-source-set-safety", "controlled-9", "market-calendar-writer-safety") :
      path.join(root, "market-calendar-writer-safety");
    const file = path.join(directory, "sequence.json"), checkpoint = File.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify(File.seal({ ...checkpoint, arbitrary: true })));
    await assert.rejects(store.markWriteStarted(h, null), /safety_stale|retained_state_changed/);
    assert.equal(store.audit().readwriteTransactions, 0); store.close();
  });
});
test("L7 shared core stale transaction abort leaves started fence; no retry", async () => {
  await Native.withMigrated(async root => {
    const preparation = await prepared(), store = Store.createIsolatedStore({ userData: root });
    const a = store.createControlledAuthorization({ preparation }), h = store.createPendingFence(a, context(preparation));
    const different = (await require("./fixtures/marketCalendar/automaticShadowFixture.js").fixture()).snapshot;
    const db = await Native.database(different);
    try { const result = await store.markWriteStarted(h, db.db); assert.equal(result.committed, false);
      assert.equal(result.reason, "stale_precondition_inside_transaction");
      assert.throws(() => store.markCommitObserved(h), /ambiguous_or_mismatch/);
      await assert.rejects(store.markWriteStarted(h, db.db), /handle_invalid/);
      assert.equal(store.audit().abortedTransactions, 1); assert.deepEqual(store.audit().committedWrites, Core.emptyCounts());
      assert.equal(Reader.createReader(root).load().status, "corrupt");
    } finally { db.db.close(); store.close(); }
  });
});
for (const failure of ["same_handle", "incomplete_snapshot"])
test(`L8 ${failure} fresh read-back cannot complete or retry`, async () => {
  await Native.withMigrated(async root => {
    const preparation = await prepared(), store = Store.createIsolatedStore({ userData: root });
    const a = store.createControlledAuthorization({ preparation }), h = store.createPendingFence(a, context(preparation));
    const db = await Native.database(F.empty());
    try { await store.markWriteStarted(h, db.db); store.markCommitObserved(h);
      assert.throws(() => store.completeControlledAttempt(h), /handle_invalid/);
      if (failure === "same_handle") await assert.rejects(store.markReadbackVerified(h, () => db.db), /fresh_readback_required/);
      else { const empty = await Native.database(F.empty());
        await assert.rejects(store.markReadbackVerified(h, empty.open), /readback_mismatch/); empty.db.close(); }
      await assert.rejects(store.markReadbackVerified(h, db.open), /handle_invalid/);
      assert.equal(store.audit().readwriteTransactions, 1); assert.equal(Reader.createReader(root).load().status, "corrupt");
    } finally { db.db.close(); store.close(); }
  });
});
