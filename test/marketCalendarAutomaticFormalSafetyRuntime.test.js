"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const Store = require("../js/marketCalendarHistory/writerSafetyStore.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const R = require("../js/marketCalendarRuntime/automaticFormalSafetyRuntime.js");
const Runtime = require("../js/marketCalendarRuntime/automaticFormalShadowRuntime.js");
const Shadow = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const F = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const ID = "jp-esri-machinery-orders-calendar";
async function fixture(fn, provision = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  try { if (provision) assert.equal((await store.provisionDisabled()).saved, true); store.close();
    return await fn(root, Reader.createReader(root));
  } finally { store.close(); assert.equal(store.audit().fileHandles, 0); fs.rmSync(root, { recursive: true }); }
}
async function report(reader, token, shadow) {
  const cycle = await R.begin(reader.load, token);
  return R.finish(cycle, shadow || { status: "evaluated", sourceRows: A.SOURCE_IDS.map(sourceId => ({
    sourceId, acquisition: "complete", eligible: sourceId !== A.BOJ, changed: 0, unchanged: 1, new: 0, notEvaluated: 0, counts: {} })) });
}
async function update(root, kind) {
  const s = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  try { const sequence = s.load().safety.sequence;
    const input = kind === "pending" ? { expectedSequence: sequence, sourceId: ID, attemptIdentity: A.hash({ a: 1 }),
      cycleIdentity: A.hash({ c: 1 }), operation: "startup", phase: "prepared" } :
      { expectedSequence: sequence, signal: { sourceId: ID, category: null, outcome: "failure",
        reason: kind === "global" ? "orphan" : "unsupported_changed", cycleOrdinal: 1, cycleIdentity: A.hash({ c: 1 }) } };
    assert.equal((await (kind === "pending" ? s.persistPendingFence(input) : s.persistTransition(input))).saved, true);
  } finally { s.close(); }
}
test("R1 valid disabled: 12 rows, 11 approved, BOJ ineligible, all writes false", () => fixture(async (_, r) => {
  const v = await report(r); assert.equal(v.storeStatus, "valid"); assert.equal(v.authorityState, "disabled");
  assert.equal(v.approvedSourceCount, 11); assert.equal(v.writerIneligibleCount, 1); assert.equal(v.sourceRows.length, 12);
  assert.ok(v.sourceRows.every(s => !s.writeAllowed)); assert.equal(v.eligibleCandidateCount, 0);
}));
test("R2 missing: fail-closed without filesystem creation", () => fixture(async (root, r) => {
  const v = await report(r); assert.equal(v.storeStatus, "missing"); assert.equal(v.effectiveState, "suspended");
  assert.ok(v.sourceRows.every(s => !s.writeAllowed)); assert.deepEqual(fs.readdirSync(root), []);
}, false));
for (const [label, edit] of [["R3 malformed", () => "{"], ["version mismatch", r => JSON.stringify({ ...r, schemaVersion: 2 })],
  ["checksum mismatch", r => JSON.stringify({ ...r, checksum: "0".repeat(64) })]])
  test(`${label} continues read-only evaluation`, () => fixture(async (root, reader) => {
    const file = path.join(root, Reader.RELATIVE_PATH), value = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, edit(value)); const before = fs.readFileSync(file);
    const v = await report(reader); assert.equal(v.storeStatus, "corrupt"); assert.equal(v.globalSafety, "unsafe");
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(reader.audit().writes, 0);
  }));
for (const [label, kind] of [["R4 global suspend", "global"], ["R5 source suspend", "source"], ["R6 pending fence", "pending"]])
  test(label, () => fixture(async (root, reader) => {
    await update(root, kind); const v = await report(reader); assert.ok(v.sourceRows.every(s => !s.writeAllowed));
    if (kind === "source") { assert.equal(v.suspendedSourceCount, 1); assert.equal(v.sourceRows.find(s => s.sourceId === ID).reason, "source_suspended");
      assert.equal(v.sourceRows.filter(s => s.suspended).length, 1); }
    else assert.equal(v.effectiveState, "suspended");
    assert.equal(v.persistentWrites, 0);
  }));
test("R7 BOJ reason preserved even missing store", () => fixture(async (_, r) => {
  const b = (await report(r)).sourceRows.find(s => s.sourceId === A.BOJ);
  assert.equal(b.codePermission, "writer_ineligible"); assert.equal(b.reason, "writer_ineligible_identity_transition");
}, false));
test("R8/R9 forged startup/JSON/token never grants startup provenance", () => fixture(async (_, reader) => {
  for (const token of [{ trigger: "startup" }, {}, JSON.parse(JSON.stringify(R.createStartupContext()))]) {
    const v = await report(reader, token); assert.equal(v.trustedStartup, false); assert.equal(v.operation, "manual");
    assert.ok(v.sourceRows.every(s => !s.writeAllowed));
  }
}));
test("R10 main opaque context one-use/cycle-bound even global disabled", () => fixture(async (_, r) => {
  const token = R.createStartupContext(); const v = await report(r, token);
  assert.equal(v.trustedStartup, true); assert.equal(v.operation, "startup");
  assert.ok(v.sourceRows.every(s => !s.writeAllowed)); assert.equal((await report(r, token)).trustedStartup, false);
  const old = global.window; global.window = { document: {} };
  try { assert.throws(() => R.createStartupContext(), /main_side_only/); } finally { if (old === undefined) delete global.window; else global.window = old; }
}));
test("R11/R14/R15 missing safety real pipeline continues, one load + one Formal snapshot", () => fixture(async (_, reader) => {
  const f = await F.fixture(), s = f.sources.find(s => s.sourceId === ID); let reads = 0, calls = 0;
  const runtime = Runtime.createRuntime({ loadSafety: reader.load, now: () => F.FRESH,
    stores: Object.fromEntries(["labor", "cpi", "bls"].map(name => [name, Object.fromEntries(
      ["read", "reserveReevaluation", "completeReevaluation", "completeActiveAcquisition",
        "completeInitialAcquisition"].map(method => [method, async () => { throw Error("unrequested_state"); }]))])),
    fetchImpl: () => { throw Error("extra_network"); }, acquire: async () => {
      assert.equal(reader.audit().loads, calls + 1); calls++; return { success: true, sourceId: ID, documents: [] }; },
    builder: { buildCalendarCandidate: async () => ({ ...F.envelope(s).candidateEnvelope, formalEligible: true,
      recordCount: 1, parserStatus: "success", canonicalDiagnostics: [] }) },
    simulator: { simulateCalendarTransition: async () => ({ simulationStatus: "preview", commitOutcome: "writer_disabled" }) },
    readFormal: async () => { reads++; return { status: "ok", snapshot: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT }; } });
  const result = await runtime.check({ trigger: "startup", sourceIds: [ID] });
  assert.equal(result.state, "success"); assert.equal(runtime.diagnostics().shadow.status, "evaluated");
  assert.equal(runtime.diagnostics().safety.storeStatus, "missing"); assert.equal(runtime.diagnostics().safety.trustedStartup, false);
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(reader.audit().loads, 1);
  assert.equal(Object.hasOwn(result, "safety"), false); assert.equal(runtime.diagnostics().metrics.complete, true);
  const token = R.createStartupContext();
  const manual = runtime.check({ sourceIds: [ID] });
  const joined = runtime.checkStartup({ sourceIds: [ID] }, token); assert.equal(joined, manual);
  await joined; assert.equal(runtime.diagnostics().safety.trustedStartup, false);
  await runtime.checkStartup({ sourceIds: [ID] }, token); assert.equal(runtime.diagnostics().safety.trustedStartup, true);
  await runtime.checkStartup({ sourceIds: [ID] }, token); assert.equal(runtime.diagnostics().safety.trustedStartup, false);
  assert.equal(reader.audit().writes, 0);
}, false));
test("R12/R13 repeated failure classification memory-only and state unchanged", () => fixture(async (root, reader) => {
  const pathName = path.join(root, Reader.RELATIVE_PATH), before = fs.readFileSync(pathName);
  const v = await report(reader, null, { status: "evaluated", sourceRows: [{ sourceId: ID, acquisition: "failed", reason: "source_failure", changed: 0 }] });
  const own = v.sourceRows.find(s => s.sourceId === ID); assert.equal(own.classification.action, "skip");
  assert.equal(own.wouldIncrement, true); assert.equal(own.wouldSuspend, false); assert.equal(own.persistentWrites, 0);
  assert.deepEqual(fs.readFileSync(pathName), before);
}));
test("changed/partial source restrictions do not suppress other shadow plans", () => fixture(async (_, reader) => {
  const f = await F.fixture(); f.sources.find(s => s.sourceId === "us-bls-calendar").acquisitionOutcome = "partial";
  const shadow = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  const v = await report(reader, null, shadow); const b = v.sourceRows.find(s => s.sourceId === "us-bls-calendar");
  assert.ok(Object.values(b.plannedCounts).every(n => n === 0)); assert.equal(b.classification.action, "skip");
  assert.equal(v.sourceRows.find(s => s.sourceId === ID).shadowEligibility, true);
}));
test("sequence checkpoint mismatch and missing checkpoint are corrupt", () => fixture(async (root, r) => {
  const file = path.join(root, "market-calendar-writer-safety", "sequence.json");
  fs.writeFileSync(file, "{}"); assert.equal((await report(r)).storeStatus, "corrupt");
  fs.unlinkSync(file); assert.equal((await report(r)).storeStatus, "corrupt");
}));
test("R17 fresh process evaluates persisted pending fence identically", () => fixture(async (root, reader) => {
  await update(root, "pending"); const first = await report(reader);
  const script = `const R=require(${JSON.stringify(require.resolve('../js/marketCalendarRuntime/automaticFormalSafetyRuntime.js'))});
    const reader=require(${JSON.stringify(require.resolve('../js/marketCalendarRuntime/writerSafetyReadOnly.js'))}).createReader(process.argv[1]);
    R.begin(reader.load).then(c=>console.log(JSON.stringify(R.finish(c,{status:'evaluated',sourceRows:[]}))));`;
  const second = JSON.parse(cp.execFileSync(process.execPath, ["-e", script, root], { encoding: "utf8" }));
  for (const key of ["storeStatus", "effectiveState", "safetySequence", "pendingFence", "globalSuspend"]) assert.deepEqual(second[key], first[key]);
  assert.equal(second.actualWriteExecutionCount, 0);
}));
test("R16/R18 no executor/writes; reader handles close, authority unchanged", () => fixture(async (_, reader) => {
  const v = await report(reader); assert.equal(v.actualWriteExecutionCount, 0); assert.equal(reader.audit().handles, 0);
  assert.equal(reader.audit().writes, 0); assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
  for (const name of ["writerSafetyReadOnly", "automaticFormalSafetyRuntime"]) {
    const source = fs.readFileSync(path.join(__dirname, "../js/marketCalendarRuntime", name + ".js"), "utf8");
    assert.doesNotMatch(source, /require\([^\n]*(?:Executor|ControlledWriter|writerSafetyStore)/);
    assert.doesNotMatch(source, /mkdirSync|writeFileSync|renameSync|unlinkSync/);
  }
}));
for (const kind of ["valid", "global", "source"]) test(`fresh process ${kind} state: same runtime evaluation`, () => fixture(async (root, reader) => {
  if (kind !== "valid") await update(root, kind);
  const a = await report(reader);
  const script = `const R=require(${JSON.stringify(require.resolve('../js/marketCalendarRuntime/automaticFormalSafetyRuntime.js'))});
    const reader=require(${JSON.stringify(require.resolve('../js/marketCalendarRuntime/writerSafetyReadOnly.js'))}).createReader(process.argv[1]);
    R.begin(reader.load).then(c=>console.log(JSON.stringify(R.finish(c,{status:'evaluated',sourceRows:[]}))));`;
  const b = JSON.parse(cp.execFileSync(process.execPath, ["-e", script, root], { encoding: "utf8" }));
  for (const key of ["storeStatus", "effectiveState", "safetySequence", "globalSuspend", "suspendedSourceCount"]) assert.deepEqual(b[key], a[key]);
}));
test("valid disabled store latency and immutable single-cycle snapshot", () => fixture(async (_, reader) => {
  const c = await R.begin(reader.load, R.createStartupContext()); assert.ok(Object.isFrozen(c.snapshot.safety));
  assert.ok(Object.isFrozen(c.permissions)); assert.equal(reader.audit().loads, 1);
  const v = R.finish(c, { status: "evaluated", sourceRows: [] });
  for (const n of [v.safetyLoadMs, v.evaluationMs]) assert.ok(Number.isFinite(n) && n >= 0);
  console.log(JSON.stringify({ benchmark: "runtime-safety-valid", loadMs: v.safetyLoadMs, evaluationMs: v.evaluationMs,
    loads: reader.audit().loads, writes: reader.audit().writes, handles: reader.audit().handles }));
}));
