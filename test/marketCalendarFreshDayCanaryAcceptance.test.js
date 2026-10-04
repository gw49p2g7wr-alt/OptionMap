"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const cp = require("node:child_process"), { webcrypto } = require("node:crypto"), IDB = require("fake-indexeddb");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js"), Old = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const OldStore = require("../js/marketCalendarHistory/writerSafetyStore.js"), Store = require("../js/marketCalendarHistory/writerSafetyCanaryStore.js");
const P = require("../js/marketCalendarRuntime/freshDayCanaryPreflight.js"), R = require("../js/marketCalendarRuntime/freshDayCanaryReceipt.js");
const Controller = require("../scripts/marketCalendarE4fFreshDayCanary.js"), Historical = require("../scripts/marketCalendarE4fStartupCanary.js");
const Canary = require("../js/marketCalendarRuntime/machineryStartupCanary.js"), Fixture = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const Native = require("../scripts/marketCalendarE4fEnvelopeNative.js");
const H = label => A.hash({ label });
function legacy() { return Old.build(null, S.createMemorySafety(), null, "provision_disabled", A.PRODUCTION_POLICY); }
function versioned() {
  return E.append(E.migrate(legacy(), H("fixture")), { type: "authority_transition", expectedAuthorityVersion: 2,
    nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE], suspendedSourceSet: [] }, H("fixture"));
}
const loaded = record => ({ available: true, record, contentHash: H(record) });
test("C1 migrated v3 production-shape preflight accepted", () => {
  const result = P.validateState(loaded(versioned())); assert.equal(result.valid, true); assert.equal(result.sequence, 2);
});
test("C2 legacy rejected without migration", () => assert.equal(P.validateState(loaded(legacy())).valid, false));
test("C3 wrong authority rejected", () => assert.equal(P.validateState(loaded(E.migrate(legacy(), H("fixture")))).valid, false));
for (const [name, mutate] of [["C4 pending", r => { r.safety.pendingFence = {}; }],
  ["C5 global suspend", r => { r.safety.globalSuspend.suspended = true; }],
  ["C5 source suspend", r => { r.safety.sources[0].suspended = true; }],
  ["sequence mismatch", r => { r.safety.sequence = 3; }],
  ["history corruption", r => { r.transitionAudit[1].previousAuditIdentity = H("wrong"); }]]) test(name, () => {
  const r = structuredClone(versioned()); mutate(r); assert.equal(P.validateState(loaded(Old.seal(r))).valid, false);
});
test("C6 Machinery-only code ceiling is exact", () => assert.deepEqual(E.policyFor(3).global.permittedSources, [E.SOURCE]));
test("C7 manual denied; C8 other 11 denied; C9 BOJ ineligible", () => {
  const p = E.policyFor(3), r = versioned();
  for (const sourceId of A.SOURCE_IDS) for (const operation of ["manual", "startup"]) {
    const cycleIdentity = H(sourceId + operation), input = { policy: p, safety: E.safetyInput(r.safety), sourceId, operation,
      cycleIdentity, context: A.createMainContextCandidate({ operation, cycleIdentity, attemptIdentity: H("attempt" + sourceId + operation) }),
      acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: H("route"), expectedRouteIdentity: H("route"),
      schemaFingerprint: p.global.schemaFingerprint, integrityValid: true, changed: 0, planValid: true, revisionTransitionCount: 0,
      absenceAuthority: "none" };
    assert.equal(S.evaluate(input).writeAllowed, sourceId === E.SOURCE && operation === "startup");
  }
  assert.equal(p.permissions.entries.find(x => x.sourceId === A.BOJ).permission, "writer_ineligible");
});
test("parent-bound approval rejects uncommitted/unapproved controller without a current HEAD constant", () => {
  assert.equal(Object.hasOwn(P, "BASE_HEAD"), false);
  assert.equal(Object.hasOwn(P, "validateRevision"), false);
  // New implementation alone is deliberately not an execution authorization.
  assert.equal(P.revision(path.resolve(__dirname, "..")).valid, false);
});
function wcFixture() {
  const factory = new IDB.IDBFactory(), worlds = new Map();
  function context(world) {
    if (!worlds.has(world)) {
      // Each Chromium isolated world owns distinct wrapper prototypes. Sharing the
      // fake library prototypes would falsely stack three realm instrumentation hooks.
      const databases = new WeakMap();
      class ObjectStore {
        constructor(raw, transaction) { this.raw = raw; this.transaction = transaction; }
        get name() { return this.raw.name; } get keyPath() { return this.raw.keyPath; }
        get indexNames() { return this.raw.indexNames; } get autoIncrement() { return this.raw.autoIncrement; }
        add(...args) { return this.raw.add(...args); } put(...args) { return this.raw.put(...args); }
        delete(...args) { return this.raw.delete(...args); } clear(...args) { return this.raw.clear(...args); }
        getAll(...args) { return this.raw.getAll(...args); } get(...args) { return this.raw.get(...args); }
        index(...args) { return this.raw.index(...args); } createIndex(...args) { return this.raw.createIndex(...args); }
      }
      class Database {
        constructor(raw) { this.raw = raw; }
        get name() { return this.raw.name; } get version() { return this.raw.version; }
        get objectStoreNames() { return this.raw.objectStoreNames; }
        createObjectStore(...args) { return this.raw.createObjectStore(...args); }
        close() { return this.raw.close(); }
        transaction(...args) {
          const raw = this.raw.transaction(...args), db = this; let wrapped;
          wrapped = new Proxy(raw, { get(target, key) {
            if (key === "db") return db;
            if (key === "objectStore") return name => new ObjectStore(raw.objectStore(name), wrapped);
            const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
          }, set(target, key, value) { return Reflect.set(target, key, value, target); } }); return wrapped;
        }
      }
      const indexedDB = { databases: () => factory.databases(), deleteDatabase: name => factory.deleteDatabase(name), open: (...args) => {
        const raw = factory.open(...args); return new Proxy(raw, { get(target, key) {
          if (key === "result") { const db = raw.result; if (!databases.has(db)) databases.set(db, new Database(db)); return databases.get(db); }
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
      } };
      const c = vm.createContext({ indexedDB, IDBDatabase: Database, IDBObjectStore: ObjectStore,
        crypto: webcrypto, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, performance,
        Storage: class {}, document: {} });
      vm.runInContext("window = globalThis", c); worlds.set(world, c);
    } return worlds.get(world);
  }
  return { executeJavaScript: code => vm.runInContext(code, context(0)),
    executeJavaScriptInIsolatedWorld: (world, entries) => vm.runInContext(entries[0].code, context(world)) };
}
async function fixture(fn, { sameDay = false, wrongCount = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const old = OldStore.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  let setup;
  try {
    assert.equal((await old.provisionDisabled()).saved, true); old.close(); setup = Store.createIsolatedStore(root);
    assert.equal((await setup.migrate(0)).saved, true); assert.equal((await setup.transition(1)).saved, true); setup.close();
    const wc = wcFixture(), f = await Fixture.fixture({ perSource: 4 });
    if (wrongCount) f.sources.find(s => s.sourceId === E.SOURCE).canonicalRecords.pop();
    const states = Object.keys(require("../js/marketCalendarRuntime/routeReevaluationPolicy.js").APPROVALS).map(id => Historical.completed(id, Fixture.FRESH));
    if (sameDay) for (const source of f.sources) if (!states.some(s => s.sourceId === source.sourceId)) states.push({ sourceId: source.sourceId,
      lastAttemptAt: Fixture.FRESH, lastSuccessAt: Fixture.FRESH, lastOutcome: "success", retryAfter: null,
      lastHttpStatus: 200, lastDiagnosticClass: null, coordinatorVersion: 1 });
    await Historical.seed(wc, f, states);
    const controller = Controller.createIsolatedController({ root, wc, runtimeStateStore: Canary.genericStore(wc), runtimeOptions: Historical.fixtureOptions(f) });
    return await fn({ root, controller, wc });
  } finally { setup?.close(); old.close(); fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
test("C10 migration call0 / C11 transition call0 during acceptance", () => fixture(async ({ controller }) => {
  const r = await controller.accept(); assert.equal(r.status, "PASS", r.reason);
  assert.equal(r.migrationCalls, 0); assert.equal(r.transitionCalls, 0);
  assert.deepEqual(r.runtime.safetyAudit.states.map(s => s.stage), ["pending_prepared", "formal_write_started", "commit_observed", "readback_verified", "completion"]);
}));
test("C12 exactly one startup; C13 no retry / second attempt", () => fixture(async ({ controller }) => {
  const r = await controller.accept(); assert.equal(r.status, "PASS", r.reason); assert.equal(r.startupInvocations, 1);
  assert.equal(r.retryCount, 0); assert.equal((await controller.accept()).reason, "acceptance_attempt_consumed");
}));
test("C14 same-day skip gives HOLD / authorization/fence/write0", () => fixture(async ({ controller }) => {
  const r = await controller.accept(); assert.equal(r.status, "HOLD", r.reason); assert.equal(r.authorizationCount, 0);
  assert.equal(r.fenceCount, 0); assert.equal(r.formalWrite, 0); assert.equal(r.finalSequence, 2);
  assert.equal(r.storageAudits.reduce((n, a) => n + a.runtimeWrites, 0), 0);
}, { sameDay: true }));
test("preflight mismatch starts zero cycles, preserves failure and never retries", () => fixture(async ({ root, controller }) => {
  fs.writeFileSync(path.join(root, OldStore.RELATIVE_STATE_PATH), "invalid isolated safety fixture");
  const r = await controller.accept(); assert.equal(r.status, "FAIL"); assert.equal(r.startupInvocations, 0);
  assert.equal(r.runtime, null); assert.equal((await controller.accept()).reason, "acceptance_attempt_consumed");
}));
test("runtime failure returns reached receipt with zero fence/write and no retry", () => fixture(async ({ controller }) => {
  const r = await controller.accept(); assert.equal(r.status, "FAIL"); assert.equal(r.reason, "machinery_contract_mismatch");
  assert.equal(r.startupInvocations, 1); assert.equal(r.runtime.writerExecution, 0);
  assert.equal(r.runtime.safetyAudit.states.length, 0); assert.equal(r.finalSafety.record.safety.sequence, 2);
  assert.equal(r.storageAudits.reduce((n, a) => n + a.readwrite, 0), 0);
  assert.equal((await controller.accept()).reason, "acceptance_attempt_consumed");
}, { wrongCount: true }));
test("C15 real isolated core receipt gives PASS + fresh process final safety reload", () => fixture(async ({ root, controller }) => {
  const before = P.loadIsolated(root), r = await controller.accept(); assert.equal(r.status, "PASS", r.reason);
  assert.equal(r.authorizationCount, 1); assert.equal(r.fenceCount, 1); assert.equal(r.completionCount, 1);
  assert.equal(r.finalSequence, 7); assert.deepEqual(r.mutationCounts, R.COUNTS);
  const fresh = Native.freshRead(root); assert.equal(fresh.result.available, true); assert.deepEqual(fresh.result.record, r.finalSafety.record);
  assert.equal(fresh.audit.fileHandles, 0); assert.equal(fresh.audit.lockHandles, 0);
  assert.equal(R.validate({ before, after: r.finalSafety, runtime: r.runtime, storageAudits: r.storageAudits }).status, "PASS");
}));
test("C16 source/attempt/cycle/auth/sequence and fresh identity mismatches fail", () => fixture(async ({ root, controller }) => {
  const before = P.loadIsolated(root), r = await controller.accept(); assert.equal(r.status, "PASS", r.reason);
  for (const mutate of [x => { x.runtime.fresh.identities.plan = H("wrong"); },
    x => { x.after.record.transitionAudit[2].event.binding.sourceId = A.BOJ; },
    x => { x.after.record.transitionAudit[2].event.binding.pendingAttemptIdentity = H("wrong"); },
    x => { x.after.record.transitionAudit[2].event.binding.cycleIdentity = H("wrong"); },
    x => { x.after.record.transitionAudit[2].event.binding.authorizationIdentity = H("wrong"); },
    x => { x.after.record.transitionAudit[2].event.binding.safetySequence = 0; },
    x => { x.runtime.execution.result.verification.observedIdentity = H("wrong"); },
    x => { x.runtime.execution.result.audit.committedWrites.revisions = 1; }]) {
    const x = structuredClone({ before, after: r.finalSafety, runtime: r.runtime, storageAudits: r.storageAudits }); mutate(x);
    assert.equal(R.validate(x).status, "FAIL");
  }
}));
test("missing storage audit / completion evidence cannot become PASS", () => fixture(async ({ root, controller }) => {
  const before = P.loadIsolated(root), r = await controller.accept(); assert.equal(r.status, "PASS", r.reason);
  assert.equal(R.validate({ before, after: r.finalSafety, runtime: r.runtime }).status, "FAIL");
  const runtime = structuredClone(r.runtime); runtime.execution.pendingCleared = false;
  assert.equal(R.validate({ before, after: r.finalSafety, runtime, storageAudits: r.storageAudits }).status, "FAIL");
  const missingMetric = structuredClone(r.runtime); delete missingMetric.timings.planningMs;
  assert.equal(R.validate({ before, after: r.finalSafety, runtime: missingMetric, storageAudits: r.storageAudits }).status, "FAIL");
  const wrongStore = structuredClone(r.storageAudits); const key = Object.keys(wrongStore[0].perStore)[0]; wrongStore[0].perStore[key]++;
  assert.equal(R.validate({ before, after: r.finalSafety, runtime: r.runtime, storageAudits: wrongStore }).status, "FAIL");
}));
test("C17 direct worker/production factory unavailable; Node CLI cannot mint authority", () => {
  assert.deepEqual(Object.keys(Controller), ["createIsolatedController", "runProductionAcceptance"]);
  const result = cp.spawnSync(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js"))}).runProductionAcceptance().catch(e => { console.error(e.message); process.exitCode = 1; });`], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /native_controller_required/);
  const worker = cp.spawnSync(process.execPath, [require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js"), "--worker", "--production"], { encoding: "utf8" });
  assert.equal(worker.status, 0); assert.equal(worker.stdout, ""); assert.equal(worker.stderr, "");
});
test("C18 renderer-style startup spoof rejected without consuming real owner", () => fixture(async ({ controller }) => {
  const spoof = await controller.accept({ trigger: "startup" }); assert.equal(spoof.reason, "acceptance_arguments_forbidden");
  assert.equal(spoof.startupInvocations, 0); assert.equal((await controller.accept()).status, "HOLD");
}, { sameDay: true }));
test("renderer cannot create controller; arbitrary profile unavailable", () => {
  assert.throws(() => Controller.createIsolatedController({ root: path.resolve(__dirname, "..") }), /isolated_profile_invalid/);
  const source = fs.readFileSync(require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js"), "utf8"), module = { exports: {} };
  vm.runInNewContext(source, { require: require("node:module").createRequire(require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js")),
    module, __dirname: path.resolve(__dirname, "../scripts"), process: { type: "renderer" }, window: { document: {} }, console });
  assert.throws(() => module.exports.createIsolatedController({}), /main_side_only/);
});
test("preflight load does not rewrite isolated safety; historical/core/schema/main/preload unchanged", () => fixture(({ root }) => {
  const file = path.join(root, OldStore.RELATIVE_STATE_PATH), before = fs.readFileSync(file);
  P.loadIsolated(root); assert.deepEqual(fs.readFileSync(file), before);
  for (const p of ["scripts/marketCalendarE4fStartupCanary.js", "js/marketCalendarHistory/formalControlledWriterCore.js",
    "js/marketCalendarHistory/writerSafetyVersionedEnvelope.js", "js/marketCalendarHistory/productionSchemaV1.js", "main.js", "preload.js"])
    assert.deepEqual(fs.readFileSync(path.resolve(__dirname, "..", p)), cp.execFileSync("git", ["show", `HEAD:${p}`]));
  for (const p of P.IMPLEMENTATION_FILES.filter(p => !p.startsWith("test/"))) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
    assert.equal(/\.migrate\s*\(|\.transition\s*\(|\.append\s*\(|\.issueAuthorizationCandidate\s*\(/.test(source), false);
  }
}));
