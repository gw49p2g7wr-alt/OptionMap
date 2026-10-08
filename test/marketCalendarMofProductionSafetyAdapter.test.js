"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const Native = require("../scripts/marketCalendarG15b1ControlledAdapterNative.js");
const Adapter = require("../js/marketCalendarHistory/mofControlledSafetyProductionAdapter.js");
const Guard = require("../scripts/marketCalendarG15b1FilesystemGuard.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js"), A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js"), L = require("../js/marketCalendarHistory/writerSafetyControlledLifecycle.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js"), File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const Generation = require("../js/marketCalendarHistory/writerSafetySourceSetAtomicCore.js");
const Semantic = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js"), Auth = require("../js/marketCalendarHistory/mofControlledAuthorization.js");
const Safety = require("./fixtures/marketCalendar/safetySourceSetFixture.js"), History = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const pointer = root => path.join(root, Generation.DIRECTORY, "selection.json");
function files(root) {
  const out = {}; function visit(dir) { for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, row.name); if (row.isDirectory()) visit(file); else out[path.relative(root, file)] = A.hash(fs.readFileSync(file).toString("base64"));
  } } visit(root); return out;
}
function mockNative(policy, action) {
  const load = Module._load, previousType = process.type, descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  try { process.type = "browser"; Object.defineProperty(process.versions, "electron", { value: "fixture", configurable: true });
    Module._load = function(id, ...rest) { return id === "electron" ? { app: { getPath: n => n === "appData" ? policy.parents[1] : policy.profile } } : load.call(this, id, ...rest); };
    return action();
  } finally { Module._load = load; if (previousType === undefined) delete process.type; else process.type = previousType;
    if (descriptor) Object.defineProperty(process.versions, "electron", descriptor); else delete process.versions.electron; }
}
async function started(fixtureRoot, action) {
  const a = Native.adapterFor(fixtureRoot), preparation = await Native.preparation(), material = Semantic.inspect(preparation);
  try { const auth = a.createControlledAuthorization(preparation), token = a.createPreparedFence(auth, preparation), context = a.markWriteStarted(token);
    return action(a, token, context.binding, material); }
  finally { a.close(); }
}
test("P1/P3/P4 explicit production factory resolves existing fixed resolver, readonly preflight writes0", () => Native.withSeed((f, root, r, policy) => {
  const before = files(root);
  mockNative(policy, () => { const a = Adapter.createProductionAdapter();
    try { const result = a.preflight(); assert.equal(result.eligible, true, result.reason); assert.equal(result.phase, "idle");
      assert.equal(result.sequence, 8); assert.equal(result.writes, 0); assert.equal(a.audit().authorizations, 0);
      assert.equal(a.audit().reader.writes, 0); assert(a.audit().touches.every(t => !t.writing && t.path.startsWith(root)));
    } finally { a.close(); } });
  assert.deepEqual(files(root), before);
}));
test("P2 fixed production factory rejects path/options and CLI/renderer before IO", () => {
  for (const input of [undefined, "/arbitrary", {}, { userData: "/arbitrary" }]) assert.throws(() => Adapter.createProductionAdapter(input), /production_path_override_rejected/);
  assert.throws(() => Adapter.createProductionAdapter(), /native_main_required/);
  const previous = process.type; try { process.type = "renderer"; assert.throws(() => Adapter.createProductionAdapter(), /main_side_only/); }
  finally { if (previous === undefined) delete process.type; else process.type = previous; }
  assert.throws(() => Adapter.createIsolatedAdapter({ targetEnvironment: "isolated_test", fixtureRoot: process.cwd(), crashAt: null }));
});
test("production fixed factory uses same complete safety lifecycle in mirrored native-main fixture", () => Native.withSeed(async (f, root, r, policy) => {
  const p = await Native.preparation("fixed-native"), expected = Semantic.inspect(p).expected;
  mockNative(policy, () => { const a = Adapter.createProductionAdapter();
    try { const token = a.createPreparedFence(a.createControlledAuthorization(p), p), ctx = a.markWriteStarted(token);
      a.markCommitObserved(token, Native.commitReceipt(ctx.binding)); a.markReadbackVerified(token, Native.readbackReceipt(ctx.binding, expected));
      assert.equal(a.completeAttempt(token).safety.sequence, 13); assert.equal(a.audit().writerExecution, 0); assert.equal(a.audit().formalDBAccess, 0);
    } finally { a.close(); } });
}));
test("P5-P9 phase persist/reload; completion needs exact receipt and fresh readback; no writer invocation", () => Native.withSeed(async (f, root) => {
  const result = await Native.lifecycle(f, root);
  assert.deepEqual(result.phases.map(r => r.sequence), [9, 10, 11, 12, 13]);
  assert.deepEqual(result.phases.map(r => r.phase), L.PHASES); assert.equal(result.audit.writerExecution, 0);
  assert.equal(result.audit.formalDBAccess, 0); assert.equal(result.audit.safety.persists, 5);
}));
test("adapter cannot reach writer executor: throwing executor fixture remains uncalled throughout lifecycle", () => Native.withSeed(async (f, root) => {
  const filename = require.resolve("../js/marketCalendarHistory/mofControlledSafetyProductionAdapter.js"), cached = require.cache[filename], load = Module._load;
  let calls = 0, a;
  const p = await Native.preparation("no-executor"), expected = Semantic.inspect(p).expected;
  try {
    delete require.cache[filename]; Module._load = function(id, ...rest) {
      if (id === "./formalControlledWriterCore.js") return { ...Core, executePrepared: () => { calls++; throw Error("writer_forbidden"); } };
      return load.call(this, id, ...rest);
    };
    const safetyOnly = require(filename); Module._load = load;
    a = safetyOnly.createIsolatedAdapter({ targetEnvironment: "isolated_test", fixtureRoot: f, crashAt: null });
    const token = a.createPreparedFence(a.createControlledAuthorization(p), p), context = a.markWriteStarted(token);
    a.markCommitObserved(token, Native.commitReceipt(context.binding));
    a.markReadbackVerified(token, Native.readbackReceipt(context.binding, expected)); a.completeAttempt(token);
    assert.equal(calls, 0);
  } finally { a?.close(); Module._load = load; require.cache[filename] = cached; }
}));
test("readonly diagnostic retains valid owned phase while normal reader stays fail-closed", () => Native.withSeed(async (f, root) => {
  const a = Native.adapterFor(f), p = await Native.preparation();
  try { a.createPreparedFence(a.createControlledAuthorization(p), p);
    assert.equal(Reader.createReader(root).load().status, "corrupt");
    const r = Reader.createReader(root).inspectControlledState(); assert.equal(r.status, "valid", r.reason);
    assert.equal(r.controlledAttemptOwned, true); assert.equal(r.executionAllowed, false); assert.equal(r.retryAllowed, false);
    assert.equal(Native.adapterFor(f).preflight().eligible, false);
  } finally { a.close(); }
}));
test("P10 stale sequence authorization cannot create prepared fence", () => Native.withSeed(async (f, root, r) => {
  const p = await Native.preparation(), auth = Auth.createControlledAuthorization({ record: r, preparation: p });
  const a = Native.adapterFor(f), other = await Native.preparation("owner");
  try { a.createControlledAuthorization(other); assert.throws(() => a.createPreparedFence(auth, other), /binding_mismatch/);
    assert.equal(a.load().safety.sequence, 8); assert.equal(a.audit().safety.persists, 0);
  } finally { a.close(); }
}));
test("authorization bound to a different safety sequence is rejected before prepared persistence", () => Native.withSeed(async (f, root, r) => {
  const stale = E.migrateSourceSet(Safety.historical({ cycles: 4 }), E.requestFor(Safety.historical({ cycles: 4 }), Safety.GATE));
  const p = await Native.preparation("same-material"), token = Auth.createControlledAuthorization({ record: stale, preparation: p });
  const a = Native.adapterFor(f);
  try { a.createControlledAuthorization(p); assert.throws(() => a.createPreparedFence(token, p), /binding_mismatch/);
    assert.equal(a.load().safety.sequence, 8); assert.equal(a.audit().safety.persists, 0);
  } finally { a.close(); }
}));
for (const kind of ["acquisition", "Formal precondition"]) test(`authorization ${kind} drift rejects before fence`, () => Native.withSeed(async (f, root, record) => {
  const original = await Native.preparation("original"), token = Auth.createControlledAuthorization({ record, preparation: original });
  const snapshot = kind === "Formal precondition" ? (await require("./fixtures/marketCalendar/automaticShadowFixture.js").fixture()).snapshot : undefined;
  const fresh = await Native.preparation(kind === "acquisition" ? "different-acquisition" : "original", snapshot), a = Native.adapterFor(f);
  try { a.createControlledAuthorization(fresh); assert.throws(() => a.createPreparedFence(token, fresh), /binding_mismatch/);
    assert.equal(a.audit().safety.persists, 0);
  } finally { a.close(); }
}));
for (const [label, change] of [
  ["wrong source", b => ({ ...b, sourceId: "jp-stat-cpi" })],
  ["wrong operation", b => ({ ...b, operation: "manual" })],
  ["wrong plan", b => ({ ...b, planIdentity: A.hash("wrong") })],
  ["wrong attempt", b => ({ ...b, attemptIdentity: A.hash("wrong") })],
  ["wrong authorization", b => ({ ...b, authorizationIdentity: A.hash("wrong") })]
]) test(`P11 ${label} observation rejected; unsafe attempt cannot retry`, () => Native.withSeed(f => started(f, (a, token, binding) => {
  const receipt = Native.commitReceipt(binding); assert.throws(() => a.markCommitObserved(token, { ...receipt, ...change(receipt) }), /binding_invalid/);
  assert.throws(() => a.markCommitObserved(token, receipt), /handle_invalid/); assert.equal(a.load().safety.sequence, 10);
})));
test("P12 replay and arbitrary state patch/source operation input rejected", () => Native.withSeed(async f => {
  const a = Native.adapterFor(f), p = await Native.preparation(), auth = a.createControlledAuthorization(p);
  try { a.createPreparedFence(auth, p); assert.throws(() => a.createPreparedFence(auth, p));
    assert.throws(() => a.createControlledAuthorization(p)); assert.throws(() => a.load({ sourceId: "arbitrary" }));
    assert.deepEqual(Object.keys(a), ["load", "preflight", "createControlledAuthorization", "createPreparedFence", "markWriteStarted",
      "markCommitObserved", "markReadbackVerified", "completeAttempt", "close", "audit"]);
  } finally { a.close(); }
}));
for (const body of ["{", "{}", JSON.stringify({ schemaVersion: 1, generation: "extended", sequence: 8, stateChecksum: "a".repeat(64), checksum: "b".repeat(64) })])
  test(`P13 corrupt pointer never falls back to retained valid historical pair (${body.length})`, () => Native.withSeed((f, root) => {
    fs.writeFileSync(pointer(root), body, { mode: 0o600 }); const a = Native.adapterFor(f);
    try { assert.equal(a.load().status, "corrupt"); assert.equal(a.load().record, null); assert.equal(a.preflight().eligible, false); }
    finally { a.close(); }
  }));
test("P14 torn/unverified generation rejects with no fallback", () => Native.withSeed((f, root) => {
  fs.unlinkSync(path.join(root, Generation.DIRECTORY, "extended", "market-calendar-writer-safety", "sequence.json"));
  const a = Native.adapterFor(f); try { assert.equal(a.load().status, "corrupt"); assert.equal(a.preflight().eligible, false); }
  finally { a.close(); }
}));
test("unsupported/malformed Envelope3 lifecycle fails closed", () => Native.withSeed((f, root) => {
  const file = path.join(root, Generation.DIRECTORY, "extended", "market-calendar-writer-safety", "safety.json");
  const r = File.parse(fs.readFileSync(file, "utf8")); r.controlledLifecycleAudit = [{ phase: "future" }];
  fs.writeFileSync(file, JSON.stringify(File.seal(r)), { mode: 0o600 }); const a = Native.adapterFor(f);
  try { assert.equal(a.load().status, "corrupt"); assert.equal(a.preflight().eligible, false); } finally { a.close(); }
}));
test("P15 persistent MOF not_approved/manual false and Machinery/BOJ ceiling survive all phases", () => Native.withSeed(async (f, root) => {
  await Native.lifecycle(f, root); const r = Reader.createReader(root).load();
  assert.equal(r.permissions.entries.find(p => p.sourceId === P.MOF).permission, "not_approved");
  assert.equal(r.permissions.entries.find(p => p.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
  for (const sourceId of P.SOURCE_IDS) assert.equal(P.evaluate({ ...Safety.candidate(r.record.historicalRecord, sourceId, sourceId, "manual"), record: r.record }).writeAllowed, false);
  assert.deepEqual(r.authorityCeiling, History.policyFor(3).global);
}));
test("historical12/Machinery completion proof remains byte-identical and valid after controlled phases", () => Native.withSeed(async (f, root, record) => {
  const before = structuredClone(record.historicalRecord); await Native.lifecycle(f, root); const loaded = Reader.createReader(root).load();
  assert.deepEqual(loaded.record.historicalRecord, before); assert.equal(History.validateEnvelope(before).valid, true);
  assert.equal(E.validate(loaded.record).valid, true);
}, Safety.complete(Safety.historical(), A.hash("historic-Machinery-readback"))));
test("missing fresh reopen, mismatched readback and commit counts never complete", async () => {
  for (const kind of ["commit", "reopen", "snapshot"]) await Native.withSeed(f => started(f, (a, token, binding, material) => {
    const commit = Native.commitReceipt(binding);
    if (kind === "commit") { commit.result.counts.entries--; assert.throws(() => a.markCommitObserved(token, commit), /mismatch/); }
    else { a.markCommitObserved(token, commit); const read = Native.readbackReceipt(binding, material.expected);
      if (kind === "reopen") read.freshReadonlyReopen = false; else read.snapshot = material.before;
      assert.throws(() => a.markReadbackVerified(token, read), /readback/); }
    assert.throws(() => a.completeAttempt(token), /handle_invalid/);
  }));
});
test("G1.4b-G parent lstat only; enumeration/sibling/runtime/formal/arbitrary paths denied", () => Native.withSeed((f, root, record, base) => {
  const p = Guard.policyFor(root, record);
  for (const parent of base.parents) {
    assert.equal(p.permits(parent, "lstatSync"), true);
    for (const op of ["statSync", "realpathSync", "readdirSync", "openSync", "readFileSync"]) assert.equal(p.permits(parent, op), false);
    Guard.scoped(p, () => assert(fs.lstatSync(parent).isDirectory()));
    assert.throws(() => Guard.scoped(p, () => fs.readdirSync(parent)), /access_denied/);
  }
  for (const file of [path.join(base.parents[1], "Sibling", "data"), path.join(root, "IndexedDB", "state"),
    path.join(root, "market-calendar-runtime-state.json"), path.join(base.parents[0], "unrelated")])
    assert.throws(() => Guard.scoped(p, () => fs.readFileSync(file)), /access_denied/);
}));
test("symlink selection/generation/profile escape rejected; guard never trusts symlink target", () => Native.withSeed((f, root) => {
  fs.unlinkSync(pointer(root)); fs.symlinkSync(path.join(root, Reader.RELATIVE_PATH), pointer(root));
  const a = Native.adapterFor(f); try { assert.equal(a.load().status, "corrupt"); assert.equal(a.preflight().eligible, false); }
  finally { a.close(); }
}));
test("readonly flags exact; writes to canonical state and unknown flags denied", () => Native.withSeed((f, root, r) => {
  const p = Guard.policyFor(root, r), file = path.join(root, Reader.RELATIVE_PATH);
  for (const mode of ["r", fs.constants.O_RDONLY, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW])
    Guard.scoped(p, () => { const fd = fs.openSync(file, mode); fs.closeSync(fd); });
  for (const mode of ["r+", "w", "a", "unknown", fs.constants.O_RDWR])
    assert.throws(() => Guard.scoped(p, () => fs.openSync(file, mode)), /access_denied/);
}));
test("crash/restart 20 points: selected old/new phase valid, no replay, fresh reader writes0", { timeout: 60000 }, async () => {
  const r = await Native.nativeAcceptance(); assert.equal(r.status, "PASS"); assert.equal(r.crashes.length, 20);
  assert.equal(r.freshProcesses, 42); assert(r.crashes.every(v => v.valid && !v.retryAllowed));
  assert.deepEqual(r.cleanup, { profiles: 0, handles: 0, children: 0 });
});
