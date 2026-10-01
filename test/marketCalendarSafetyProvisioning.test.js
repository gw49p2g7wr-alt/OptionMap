"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const P = require("../js/marketCalendarHistory/writerSafetyInitialProvisioning.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const R = require("../js/marketCalendarRuntime/automaticFormalSafetyRuntime.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Atomic = require("../js/marketCalendarHistory/writerSafetyAtomicFile.js");
const Store = require("../js/marketCalendarHistory/writerSafetyStore.js");
const F = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const Shadow = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Harness = require("../scripts/marketCalendarE4fSafetyProvision.js");
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-")), p = P.createIsolatedProvisioner(root);
  try { return await fn(root, p); } finally { p.close(); assert.equal(p.audit().fileHandles, 0); fs.rmSync(root, { recursive: true }); }
}
test("F1 production fixed Electron app path, no Node/renderer/arbitrary root provisioning", () => {
  assert.throws(() => P.createProductionProvisioner(), /native_main_required/);
  assert.throws(() => P.createIsolatedProvisioner(os.tmpdir()), /isolated_profile_invalid/);
  assert.equal(P.resolveProductionProfile.length, 0);
  const old = global.window; global.window = { document: {} };
  try { assert.throws(() => P.createProductionProvisioner(), /main_side_only/); }
  finally { if (old === undefined) delete global.window; else global.window = old; }
});
test("F2 existing store rejected without any write; single attempt consumed", () => fixture((root, p) => {
  assert.equal(p.provision().saved, true); const before = fs.readFileSync(path.join(root, Reader.RELATIVE_PATH));
  assert.equal(p.provision().reason, "provision_attempt_consumed");
  const other = P.createIsolatedProvisioner(root);
  try { assert.equal(other.provision().reason, "safety_store_already_exists"); assert.equal(other.audit().writes, 0); }
  finally { other.close(); }
  assert.deepEqual(fs.readFileSync(path.join(root, Reader.RELATIVE_PATH)), before);
}));
test("F3 initial disabled exact, same E2b schema/checkpoint, real fsync/rename", () => fixture((root, p) => {
  const v = p.provision(); assert.equal(v.saved, true); const read = Harness.readback(root);
  assert.equal(read.sequence, 0); assert.equal(read.authority, "disabled"); assert.equal(read.pendingFence, null);
  assert.equal(read.countersZero, true); assert.equal(v.audit.initialProvision, 1);
  assert.equal(v.audit.writes, 4); assert.equal(v.audit.replaces, 2); assert.equal(v.audit.syncs, 4);
  assert.equal(v.audit.fileHandles, 0); assert.equal(v.audit.owned, false); assert.equal(v.contentHash, read.contentHash);
}));
test("F4 fixed BOJ ineligible, 11 approved candidates; no persistent permission", () => fixture((root, p) => {
  p.provision(); const v = Harness.readback(root);
  assert.equal(v.sourcePermissions.find(s => s.sourceId === A.BOJ).permission, "writer_ineligible");
  assert.equal(v.sourcePermissions.filter(s => s.permission === "approved").length, 11);
  assert.ok(Reader.createReader(root).load().safety.sources.every(s => !Object.hasOwn(s, "permission")));
}));
test("F5 fresh process readback hash/checksum/sequence unchanged", () => fixture((root, p) => {
  p.provision(); const before = Harness.readback(root);
  const code = `console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../scripts/marketCalendarE4fSafetyProvision.js'))}).readback(process.argv[1])))`;
  const after = JSON.parse(cp.execFileSync(process.execPath, ["-e", code, root], { encoding: "utf8" }));
  assert.notEqual(before.pid, after.pid);
  for (const key of ["sequence", "checksum", "contentHash", "sourcePermissions"]) assert.deepEqual(after[key], before[key]);
}));
test("F6 valid disabled 12-source runtime evaluation all writes false", () => fixture(async (root, p) => {
  p.provision(); const reader = Reader.createReader(root);
  const c = await R.begin(reader.load), v = R.finish(c, { status: "evaluated", sourceRows: [] });
  assert.equal(v.storeStatus, "valid"); assert.equal(v.effectiveState, "disabled");
  assert.equal(v.sourceRows.length, 12); assert.ok(v.sourceRows.every(s => !s.writeAllowed)); assert.equal(reader.audit().loads, 1);
}));
test("F7 trusted opaque candidate one-use, disabled remains disabled", () => fixture(async (root, p) => {
  p.provision(); const reader = Reader.createReader(root), token = R.createStartupContext();
  const first = R.finish(await R.begin(reader.load, token), { status: "evaluated", sourceRows: [] });
  assert.equal(first.trustedStartup, true); assert.equal(first.actualWriteExecutionCount, 0);
  assert.equal((await R.begin(reader.load, token)).trustedStartup, false);
}));
test("F8 renderer startup/JSON spoof rejected", () => fixture(async (root, p) => {
  p.provision(); const c = await R.begin(Reader.createReader(root).load, { trigger: "startup" });
  assert.equal(c.trustedStartup, false); assert.equal(c.operation, "manual");
  assert.ok(R.finish(c, { status: "evaluated", sourceRows: [] }).sourceRows.every(s => !s.writeAllowed));
}));
test("F9 manual valid store cannot authorize write", () => fixture(async (root, p) => {
  p.provision(); const v = R.finish(await R.begin(Reader.createReader(root).load), { status: "evaluated", sourceRows: [] });
  assert.equal(v.operation, "manual"); assert.ok(v.sourceRows.filter(s => s.sourceId !== A.BOJ).every(s => s.reason === "manual_writer_disabled"));
}));
for (const label of ["F10 Formal boundary", "F11 Runtime State boundary"]) test(label, () => {
  for (const file of ["writerSafetyInitialProvisioning", "writerSafetyAtomicCore"]) {
    const text = fs.readFileSync(path.join(__dirname, "../js/marketCalendarHistory", file + ".js"), "utf8");
    assert.doesNotMatch(text, /require\([^\n]*(?:Executor|ControlledWriter|RuntimeState|productionHistoryWriter)/);
    assert.doesNotMatch(text, /indexedDB|\.transaction\(/);
  }
});
test("F12 readonly cycle does not rewrite safety", () => fixture(async (root, p) => {
  p.provision(); const file = path.join(root, Reader.RELATIVE_PATH), before = fs.readFileSync(file), reader = Reader.createReader(root);
  R.finish(await R.begin(reader.load), { status: "evaluated", sourceRows: [] });
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(reader.audit().writes, 0);
}));
test("F13 fresh fixture comparison Machinery Orders canary readiness", () => fixture(async (root, p) => {
  p.provision(); const f = await F.fixture(), shadow = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  const own = shadow.sourceRows.find(s => s.sourceId === "jp-esri-machinery-orders-calendar");
  assert.equal(own.eligible, true); assert.equal(own.changed, 0); assert.equal(own.new, 0); assert.equal(own.evidenceOnly, 0);
  const safety = R.finish(await R.begin(Reader.createReader(root).load, R.createStartupContext()), shadow);
  assert.equal(safety.sourceRows.find(s => s.sourceId === own.sourceId).writeAllowed, false);
}));
test("F14 cleanup, no production importer, no update/counter/fence API", () => fixture((_, p) => {
  p.provision(); p.close(); assert.equal(p.audit().fileHandles, 0); assert.equal(p.audit().lockHandles, 0);
  for (const key of ["persistTransition", "persistCounterUpdate", "persistPendingFence", "reset"]) assert.equal(p[key], undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), /writerSafetyInitialProvisioning/);
}));
test("existing partial directory preserved: no adoption or repair", () => fixture((root, p) => {
  fs.mkdirSync(path.join(root, "market-calendar-writer-safety"), { mode: 0o700 });
  assert.equal(p.provision().saved, false); assert.equal(p.audit().writes, 0);
}));
test("E2b isolated atomic path guard remains exact after shared-core extraction", () => {
  assert.throws(() => Atomic.create(path.join(fs.realpathSync(os.tmpdir()), "market-calendar-writer-safety")), /isolated_store_path_invalid/);
});
test("pending fence dry-run persisted/restart blocks only in disposable isolated store", () => fixture(async (root, p) => {
  p.provision(); const s = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  try { assert.equal((await s.persistPendingFence({ expectedSequence: 0, sourceId: "jp-esri-machinery-orders-calendar",
    attemptIdentity: A.hash({ a: 1 }), cycleIdentity: A.hash({ c: 1 }), operation: "startup", phase: "prepared" })).saved, true); }
  finally { s.close(); }
  const script = `const Reader=require(${JSON.stringify(require.resolve('../js/marketCalendarRuntime/writerSafetyReadOnly.js'))});console.log(JSON.stringify(Reader.createReader(process.argv[1]).load()));`;
  const v = JSON.parse(cp.execFileSync(process.execPath, ["-e", script, root], { encoding: "utf8" }));
  assert.equal(v.status, "valid"); assert.equal(v.safety.pendingFence.phase, "prepared");
  assert.equal((R.finish(await R.begin(Reader.createReader(root).load), { status: "evaluated", sourceRows: [] })).effectiveState, "suspended");
}));
