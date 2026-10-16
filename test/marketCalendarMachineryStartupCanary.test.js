"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const IDB = require("fake-indexeddb"), { webcrypto } = require("node:crypto");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Old = require("../js/marketCalendarHistory/writerSafetyStore.js"), Store = require("../js/marketCalendarHistory/writerSafetyCanaryStore.js");
const Canary = require("../js/marketCalendarRuntime/machineryStartupCanary.js");
const Harness = require("../scripts/marketCalendarE4fStartupCanary.js"), Fixture = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"), Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js");
const Fresh = require("../scripts/marketCalendarE4fEnvelopeNative.js");
const sha = b => require("node:crypto").createHash("sha256").update(b).digest("hex");
async function fixture(fn, transitioned = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const old = Old.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
  let store;
  try { assert.equal((await old.provisionDisabled()).saved, true); old.close(); store = Store.createIsolatedStore(root);
    if (transitioned) { assert.equal((await store.migrate(0)).saved, true); assert.equal((await store.transition(1)).saved, true); }
    await fn(store, root);
  } finally { store?.close(); old.close(); assert.equal(store?.audit().fileHandles || 0, 0);
    assert.equal(store?.audit().lockHandles || 0, 0); fs.rmSync(root, { recursive: true }); }
}
function webContents() {
  const indexedDB = new IDB.IDBFactory(), worlds = new Map();
  function context(world) {
    if (!worlds.has(world)) {
      const c = vm.createContext({ indexedDB, IDBDatabase: IDB.IDBDatabase, IDBObjectStore: IDB.IDBObjectStore,
        crypto: webcrypto, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout,
        performance, console, Storage: class {}, document: {} });
      vm.runInContext("window = globalThis", c); worlds.set(world, c);
    } return worlds.get(world);
  }
  return { indexedDB, executeJavaScript: code => vm.runInContext(code, context(0)),
    executeJavaScriptInIsolatedWorld: (world, entries) => vm.runInContext(entries[0].code, context(world)) };
}
async function canarySetup(root, { sameDay = false, change = null } = {}) {
  const f = await Fixture.fixture({ perSource: 4 }), wc = webContents();
  const states = Object.keys(require("../js/marketCalendarRuntime/routeReevaluationPolicy.js").APPROVALS).map(id => Harness.completed(id, Fixture.FRESH));
  if (sameDay) for (const source of f.sources) if (!states.some(s => s.sourceId === source.sourceId)) states.push({ sourceId: source.sourceId,
    lastAttemptAt: Fixture.FRESH, lastSuccessAt: Fixture.FRESH, lastOutcome: "success", retryAfter: null, lastHttpStatus: 200,
    lastDiagnosticClass: null, coordinatorVersion: 1 });
  if (change) await change(f);
  await Harness.seed(wc, f, states);
  const controller = Canary.createIsolatedCanary({ root, wc, runtimeStateStore: Canary.genericStore(wc), runtimeOptions: Harness.fixtureOptions(f) });
  return { f, wc, controller };
}
test("production factory rejects plain Node without opening production userData", () => assert.throws(() => Store.createProductionStore(), /native_main_required/));
test("no arbitrary production path/source/operation factory", () => {
  assert.deepEqual(Object.keys(Store).sort(), ["GATE", "createIsolatedStore", "createProductionStore"].sort());
  assert.equal(Canary.consumeExecution({ operation: "startup" }), null);
  assert.equal(Canary.consumeExecution(null), null);
});
test("migration preserves complete legacy record/audit; disabled until explicit transition", () => fixture(async (store, root) => {
  const old = store.load().record; assert.equal((await store.migrate(0)).saved, true);
  assert.deepEqual(store.load().record.legacyRecord, old); assert.equal(store.load().record.safety.sequence, 1);
  assert.equal(store.load().record.safety.persistedAuthorityVersion, 2);
  store.close(); const fresh = Fresh.freshRead(root); assert.equal(fresh.result.available, true); assert.equal(fresh.result.record.safety.persistedAuthorityVersion, 2);
}, false));
test("wrong migration sequence rejected without changing content", () => fixture(async (s, root) => {
  const p = path.join(root, Old.RELATIVE_STATE_PATH), before = sha(fs.readFileSync(p));
  assert.equal((await s.migrate(99)).saved, false); assert.equal(sha(fs.readFileSync(p)), before);
}, false));
test("versioned record is never migrated a second time", () => fixture(async s => assert.equal((await s.migrate(2)).saved, false)));
test("authority transition fixed v2→v3; previous sequence is exact", () => fixture(async s => {
  await s.migrate(0); assert.equal((await s.transition(0)).saved, false);
  assert.equal((await s.transition(1)).saved, true); assert.equal(s.load().record.safety.persistedAuthorityVersion, 3);
  assert.equal((await s.transition(2)).saved, false);
}, false));
test("fresh-process transition history continuity and BOJ ceiling", () => fixture((s, root) => {
  const before = s.load().record; s.close(); const r = Fresh.freshRead(root).result.record;
  assert.deepEqual(r, before); assert.equal(E.validateEnvelope(r).valid, true);
  assert.equal(E.policyFor(3).permissions.entries.find(s => s.sourceId === A.BOJ).permission, "writer_ineligible");
}));
test("versioned readonly reader + runtime evaluation keep version pair and no executable/manual authority", () => fixture(async (s, root) => {
  s.close(); const reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js").createReader(root);
  const runtime = require("../js/marketCalendarRuntime/automaticFormalSafetyRuntime.js");
  const cycle = await runtime.begin(reader.load, { trigger: "startup" });
  const result = runtime.finish(cycle, { status: "skipped", sourceRows: [] });
  assert.equal(reader.audit().loads, 1); assert.equal(reader.audit().writes, 0); assert.equal(reader.audit().handles, 0);
  assert.equal(result.authorityVersion, 3); assert.equal(result.storeStatus, "valid"); assert.equal(result.operation, "manual");
  assert.equal(result.actualWriteExecutionCount, 0); assert.ok(result.sourceRows.every(s => !s.writeAllowed));
}));
for (const id of A.SOURCE_IDS) test(`only fixed source may acquire canary permission: ${id}`, () => {
  const p = E.policyFor(3), state = S.createMemorySafety(p), cycleIdentity = A.hash({ cycle: id });
  const base = { policy: p, sourceId: id, safety: state, operation: "startup", cycleIdentity,
    context: A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity: A.hash({ attempt: id }) }),
    acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: "a".repeat(64), expectedRouteIdentity: "a".repeat(64),
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none" };
  assert.equal(S.evaluate(base).writeAllowed, id === E.SOURCE);
  assert.equal(S.evaluate({ ...base, operation: "manual" }).writeAllowed, false);
  assert.equal(S.evaluate({ ...base, context: { operation: "startup" } }).writeAllowed, false);
});
test("forged JSON execution capability produces zero pending/write", () => fixture(async s => {
  const before = s.load().record; const result = await s.execute({ trigger: "startup", sourceId: E.SOURCE });
  assert.equal(result.saved, false); assert.equal(result.reason, "trusted_startup_required"); assert.deepEqual(s.load().record, before);
}));
test("valid same-day startup skips canary without forced acquisition or safety mutation", () => fixture(async (s, root) => {
  s.close(); const { controller, wc } = await canarySetup(root, { sameDay: true });
  try { const before = fs.readFileSync(path.join(root, Old.RELATIVE_STATE_PATH)), result = await controller.startup();
    assert.equal(result.status, "hold", result.reason); assert.equal(result.reason, "same_day_skip"); assert.equal(result.writerExecution, 0);
    assert.equal(controller.audit().writes, 0); assert.deepEqual(fs.readFileSync(path.join(root, Old.RELATIVE_STATE_PATH)), before);
    assert.equal(result.acquisition.sources.find(s => s.sourceId === E.SOURCE).acquisitionStatus, "not_attempted");
    assert.equal((await controller.startup()).reason, "startup_attempt_consumed");
    assert.equal((await Reader.createReader(wc)()).snapshot.runs.length, 12);
  } finally { controller.close(); }
}));
test("fresh real B1 startup + actual shared core executes one fixed-source transaction and completes receipt", () => fixture(async (s, root) => {
  s.close(); const { controller, wc, f } = await canarySetup(root);
  try { const result = await controller.startup(); assert.equal(result.status, "pass", result.reason);
    assert.equal(result.execution.result.audit.readwrite, 1); assert.equal(result.execution.result.audit.committed, 1);
    assert.equal(result.execution.result.audit.aborted, 0); assert.equal(result.execution.finalSequence, 7);
    assert.equal(result.execution.result.verification.valid, true); assert.equal(result.execution.pendingCleared, true);
    const after = (await Reader.createReader(wc)()).snapshot;
    assert.equal(after.entries.length, f.snapshot.entries.length); assert.deepEqual(Core.sorted(after).revisions, Core.sorted(f.snapshot).revisions);
    for (const [field] of Core.STORE_ORDER) assert.deepEqual(Core.sorted(after)[field].filter(s => s.sourceId !== E.SOURCE),
      Core.sorted(f.snapshot)[field].filter(s => s.sourceId !== E.SOURCE));
    assert.equal(after.evidence.length, f.snapshot.evidence.length + 4); assert.equal(after.observations.length, f.snapshot.observations.length + 4);
    assert.equal(after.runs.length, f.snapshot.runs.length + 1); assert.equal((await controller.startup()).status, "fail");
    controller.close(); assert.equal(Fresh.freshRead(root).result.record.safety.sequence, 7);
  } finally { controller.close(); }
}));
test("wrong machinery count aborts before creating a fence", () => fixture(async (s, root) => {
  s.close(); const { controller } = await canarySetup(root, { change: f => { f.sources.find(s => s.sourceId === E.SOURCE).canonicalRecords.pop(); } });
  try { const result = await controller.startup(); assert.equal(result.status, "fail");
    assert.equal(result.reason, "machinery_contract_mismatch"); assert.equal(controller.audit().writes, 0);
  } finally { controller.close(); }
}));
test("transaction stale reread aborts once and pending remains blocked after restart", () => fixture(async (s, root) => {
  s.close(); const { controller, wc } = await canarySetup(root), execute = wc.executeJavaScript;
  wc.executeJavaScript = async code => {
    if (code.includes("'E4f_startup_canary'")) await execute(`(() => {
      const native = IDBDatabase.prototype.transaction; let reads = 0;
      IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
        const tx = native.call(this, stores, mode, ...args);
        if (this.name === ${JSON.stringify(Schema.DATABASE_NAME)} && mode === 'readonly' && ++reads === 2) {
          const db = this, objectStore = tx.objectStore.bind(tx);
          tx.objectStore = name => { const s = objectStore(name);
            if (name === ${JSON.stringify(Core.STORE_NAMES[0])}) { const get = s.getAll.bind(s);
              s.getAll = (...args) => { const r = get(...args); r.addEventListener('success', () => {
                const write = native.call(db, [name], 'readwrite');
                write.objectStore(name).put({ ...r.result[0], lastObservedAt: '2026-10-01T00:00:00.001Z' });
              }, { once: true }); return r; }; } return s; };
        } return tx;
      };
    })()`);
    return execute(code);
  };
  try { const r = await controller.startup(); assert.equal(r.status, "fail");
    assert.equal(r.execution.reason, "stale_precondition_inside_transaction"); assert.equal(r.execution.result.audit.aborted, 1);
    assert.equal(r.execution.result.audit.committed, 0); controller.close();
    const persisted = Fresh.freshRead(root).result.record; assert.equal(persisted.safety.pendingFence.phase, "formal_write_started");
    assert.equal((await controller.startup()).reason, "startup_attempt_consumed");
  } finally { controller.close(); }
}));
test("read-back incomplete cannot complete fence despite observed commit", () => fixture(async (s, root) => {
  s.close(); const { controller, wc } = await canarySetup(root), execute = wc.executeJavaScript;
  wc.executeJavaScript = async code => { const r = await execute(code);
    if (code.includes("'E4f_startup_canary'")) return { ...r, status: "failed", readback: null, reason: "readback_incomplete" };
    return r; };
  try { const r = await controller.startup(); assert.equal(r.status, "fail"); assert.equal(r.execution.result.committed, true);
    controller.close(); assert.equal(Fresh.freshRead(root).result.record.safety.pendingFence.phase, "commit_observed");
  } finally { controller.close(); }
}));
test("completion persist failure after actual commit/readback stops without a second write", () => fixture(async (s, root) => {
  s.close(); const { controller } = await canarySetup(root), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, Old.RELATIVE_STATE_PATH) && JSON.parse(fs.readFileSync(from)).transitionAudit.at(-1).event.type === "fence_completed")
      throw Error("completion_persist_failed");
    return rename(from, to);
  };
  try { const r = await controller.startup(); assert.equal(r.status, "fail"); assert.equal(r.execution.reason, "completion_persist_failed");
    assert.equal(r.execution.result.status, "verified"); assert.equal(r.execution.result.audit.readwrite, 1);
    assert.equal(controller.audit().healthy, false); assert.equal(controller.audit().interruptedIntent, true);
    assert.equal((await controller.startup()).reason, "startup_attempt_consumed");
  } finally { fs.renameSync = rename; controller.close(); }
  assert.equal(Fresh.freshRead(root).result.available, false);
}));
test("fresh process pending state blocks before acquisition", () => fixture(async (s, root) => {
  s.close(); const setup = await canarySetup(root), execute = setup.wc.executeJavaScript;
  setup.wc.executeJavaScript = async code => code.includes("'E4f_startup_canary'") ?
    { committed: false, status: "failed", reason: "commit_ambiguous" } : execute(code);
  await setup.controller.startup(); setup.controller.close();
  const f = await Fixture.fixture({ perSource: 4 }), options = Harness.fixtureOptions(f);
  options.acquire = () => { throw Error("acquisition_must_not_run"); };
  const next = Canary.createIsolatedCanary({ root, wc: setup.wc, runtimeStateStore: Canary.genericStore(setup.wc), runtimeOptions: options });
  try { const r = await next.startup(); assert.equal(r.reason, "safety_not_ready"); assert.equal(r.acquisition, null);
    assert.equal(next.audit().writes, 0); } finally { next.close(); }
}));
test("missing safety never provisions during startup", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-"));
  const controller = Canary.createIsolatedCanary({ root, wc: webContents(), runtimeStateStore: {}, runtimeOptions: {} });
  try { assert.equal((await controller.startup()).status, "fail"); assert.equal(fs.existsSync(path.join(root, 'market-calendar-writer-safety')), false);
    assert.equal(controller.audit().writes, 0); } finally { controller.close(); fs.rmSync(root, { recursive: true }); }
});
test("shared transaction core and Formal schema are not changed or forked", () => {
  const cp = require("node:child_process");
  for (const p of ["js/marketCalendarHistory/formalControlledWriterCore.js", "js/marketCalendarHistory/productionSchemaV1.js"])
    assert.deepEqual(fs.readFileSync(path.join(__dirname, "..", p)),
      cp.execFileSync("git", ["cat-file", "--filters", `--path=${p}`, `HEAD:${p}`]));
});
test("canary fixed context never added to main IPC/preload/renderer", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert.equal(/machineryStartupCanary|writerSafetyCanaryStore|consumeExecution/.test(preload), false);
  assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
});
