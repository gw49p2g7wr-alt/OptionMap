"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Automatic = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");
const Plan = require("../js/marketCalendarHistory/formalShadowWritePlan.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const F = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const evaluate = f => Automatic.evaluate({ sourceResults: f.sources, before: f.snapshot,
  schemaFingerprint: Schema.EXPECTED_FINGERPRINT });

test("O1 full six-store streaming precondition exactly matches existing serializer/hash", async () => {
  const f = await F.fixture({ historyRuns: 3 });
  f.snapshot.observations[0].extraAudit = { unicode: "日本語🌙", values: [null, true, "quoted\"text"] };
  const expected = await Gate.formalPreconditionIdentity(f.snapshot, Schema.EXPECTED_FINGERPRINT);
  const token = Cycle.create(f.snapshot, Schema.EXPECTED_FINGERPRINT);
  try {
    const context = Cycle.get(token, f.snapshot);
    assert.equal(context.snapshotIdentity, expected);
    assert.equal(context.metrics.snapshotValidationCount, 1);
    assert.equal(context.metrics.fullSnapshotSortCount, 1);
    assert.equal(context.metrics.storeSortCount, 6);
    assert.equal(context.metrics.fullSnapshotHashCount, 1);
    assert.equal(context.metrics.fullMaterialCopies, 0);
    assert.equal(context.sorted.evidence[0], f.snapshot.evidence.find(e => e.evidenceLinkKey === context.sorted.evidence[0].evidenceLinkKey));
  } finally { Cycle.close(token); }
  assert.equal(Cycle.activeCount(), 0);
});
test("O2 comparison + every source's plan/mutations/identities preserve existing E2a semantics", async () => {
  const f = await F.fixture({ historyRuns: 3 });
  const original = await Compare.compare({ sourceResults: f.sources, formalSnapshot: f.snapshot });
  const token = Cycle.create(f.snapshot, Schema.EXPECTED_FINGERPRINT);
  try {
    const optimized = await Compare.compare({ sourceResults: f.sources, formalSnapshot: f.snapshot, cycleContext: token });
    assert.deepEqual(optimized, original);
    for (const source of f.sources) {
      const run = { sourceId: source.sourceId, runId: "opt-parity", acceptedAt: F.FRESH,
        fetchedAt: [F.FRESH], status: "accepted", semanticSetHash: Cycle.sourceHash(Cycle.get(token, f.snapshot),
          source.canonicalRecords.map(r => r.revisionKey).sort()) };
      const input = { sourceId: source.sourceId, sourceResult: source, comparison: original,
        formalSnapshot: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, run };
      const before = await Plan.buildSourceShadowPlan(input);
      const after = await Plan.buildSourceShadowPlan({ ...input, cycleContext: token });
      assert.deepEqual(after, before, source.sourceId);
    }
  } finally { Cycle.close(token); }
});
test("O3 one snapshot/validation/sort/hash shared by twelve distinct source plans; cache disposed", async () => {
  const report = await evaluate(await F.fixture());
  assert.equal(report.status, "evaluated");
  for (const field of ["snapshotValidationCount", "fullSnapshotSortCount", "fullSnapshotHashCount"])
    assert.equal(report.performance[field], 1);
  assert.equal(new Set(report.sourceRows.map(r => r.snapshotIdentity)).size, 1);
  assert.equal(new Set(report.plans.map(p => p.planIdentity)).size, 12);
  assert.equal(report.performance.cacheDisposed, true); assert.equal(Cycle.activeCount(), 0);
  assert.equal(report.performance.fullMaterialCopies, 0);
  assert.equal(report.futureWriteRequiresFreshPlan, true);
});
test("O4 ordering changes neither full snapshot nor source plan identity", async () => {
  const f = await F.fixture({ perSource: 2, historyRuns: 3 }), reordered = structuredClone(f);
  for (const rows of Object.values(reordered.snapshot)) rows.reverse();
  reordered.sources.reverse().forEach(s => s.canonicalRecords.reverse());
  const a = await evaluate(f), b = await evaluate(reordered);
  assert.equal(a.snapshotIdentity, b.snapshotIdentity);
  assert.deepEqual(a.plans, b.plans);
});
test("O5 new cycles re-read/re-hash; mutation of any of six stores changes full precondition", async () => {
  const f = await F.fixture({ historyRuns: 3 }), original = await evaluate(structuredClone(f));
  for (const field of Object.keys(f.snapshot)) {
    const changed = structuredClone(f);
    // Harmless additional historical metadata must still contribute to full hash.
    changed.snapshot[field][0].diagnosticNote = "changed-between-cycles";
    const result = await evaluate(changed);
    assert.equal(result.status, "evaluated", field);
    assert.notEqual(result.snapshotIdentity, original.snapshotIdentity, field);
    assert.equal(result.performance.fullSnapshotHashCount, 1);
  }
  const result = await evaluate(structuredClone(f)); assert.deepEqual(result.plans, original.plans);
  assert.equal(Cycle.activeCount(), 0);
});
test("O6 acquisition identity change affects relevant plan only, never semantic identity", async () => {
  const f = await F.fixture(), changed = structuredClone(f);
  changed.sources[0].candidateIdentity = "second-legitimate-acquisition";
  const a = await evaluate(f), b = await evaluate(changed);
  assert.equal(a.snapshotIdentity, b.snapshotIdentity);
  for (const source of a.sourceRows) {
    const next = b.sourceRows.find(s => s.sourceId === source.sourceId);
    if (source.sourceId === changed.sources[0].sourceId && source.eligible) assert.notEqual(next.planIdentity, source.planIdentity);
    else assert.equal(next.planIdentity, source.planIdentity);
  }
});
test("O7 validated cache cannot mutate; closed/forged/wrong snapshot token rejected", async () => {
  const f = await F.fixture(), token = Cycle.create(f.snapshot, Schema.EXPECTED_FINGERPRINT);
  const context = Cycle.get(token, f.snapshot);
  assert.throws(() => { f.snapshot.entries[0].activeRevisionKey = "mutated"; }, TypeError);
  assert.throws(() => { f.snapshot.entries.push({}); }, TypeError);
  assert.throws(() => { f.snapshot.entries = []; }, TypeError);
  assert.throws(() => Cycle.get({}, f.snapshot), /invalid_or_closed/);
  assert.throws(() => Cycle.get(token, structuredClone(f.snapshot)), /invalid_or_closed/);
  Cycle.close(token);
  assert.throws(() => Cycle.get(token, f.snapshot), /invalid_or_closed/);
  assert.equal(context.metrics.cacheDisposed, true); assert.equal(context.snapshot, null);
  assert.equal(context.evidenceByKey.size, 0); assert.equal(Cycle.activeCount(), 0);
});
test("O8 all historical integrity checks remain global; later history corruption never sampled away", async () => {
  for (const corrupt of ["evidence", "observation", "run", "cursor", "revision", "duplicate"]) {
    const f = await F.fixture({ historyRuns: 3 });
    if (corrupt === "evidence") f.snapshot.evidence.at(-1).acquisitionEvidence.rawContentHash = "b".repeat(64);
    if (corrupt === "observation") f.snapshot.observations.at(-1).runId = "absent";
    if (corrupt === "run") f.snapshot.runs.at(-1).runKey = "invalid";
    if (corrupt === "cursor") f.snapshot.cursors.at(-1).acceptedAt = F.FRESH;
    if (corrupt === "revision") f.snapshot.revisions.at(-1).canonicalContentHash = "b".repeat(64);
    if (corrupt === "duplicate") f.snapshot.observations.push(structuredClone(f.snapshot.observations.at(-1)));
    const result = await evaluate(f);
    assert.equal(result.status, "unsafe", corrupt); assert.deepEqual(result.sourceRows, []);
    assert.equal(Cycle.activeCount(), 0);
  }
});
test("O9 schema mismatch/cache failure never carries a previous cycle's cached success", async () => {
  const f = await F.fixture(); assert.equal((await evaluate(f)).status, "evaluated");
  const failed = await Automatic.evaluate({ sourceResults: f.sources, before: f.snapshot, schemaFingerprint: "wrong" });
  assert.equal(failed.status, "unsafe"); assert.equal(Cycle.activeCount(), 0);
  const next = await evaluate(f); assert.equal(next.performance.fullSnapshotHashCount, 1);
});
test("O10 transitive shadow dependencies cannot reach writer/core/one-shot or production integration", () => {
  const root = path.resolve(__dirname, ".."), seen = new Set();
  function visit(file) {
    if (seen.has(file)) return; seen.add(file);
    assert.doesNotMatch(file, /(?:ControlledWriter|WriteExecutor|WriteBoundary|productionHistoryWriter)/);
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/require\(["'](\.[^"']+)["']\)/g)) visit(path.resolve(path.dirname(file), match[1]));
  }
  visit(path.join(root, "js/marketCalendarRuntime/automaticFormalShadow.js"));
  for (const file of ["main.js", "preload.js", "index.html"])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"),
      /automaticFormalShadow|formalShadowCycle|formalShadowElectronRead/);
});
test("O11 serialized native reader binds schema explicitly and reads all six stores in one readonly tx", async () => {
  const { IDBFactory } = require("fake-indexeddb"), vm = require("node:vm"), crypto = require("node:crypto");
  const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js"), indexedDB = new IDBFactory();
  const f = await F.fixture();
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
    r.onupgradeneeded = () => Schema.createInUpgrade(r.result);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const stores = require("../js/marketCalendarHistory/bootstrapSchemaV1.js").STORE_ORDER;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores.map(s => s[1]), "readwrite");
    for (const [field, store] of stores) for (const value of f.snapshot[field]) tx.objectStore(store).add(value);
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  }); db.close();
  const context = vm.createContext({ indexedDB, crypto: crypto.webcrypto, TextEncoder, setTimeout, clearTimeout });
  const result = await Reader.createReader({ executeJavaScript: script => vm.runInContext(script, context) })();
  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.schemaFingerprint, Schema.EXPECTED_FINGERPRINT);
  assert.equal(result.audit.readonly, 1); assert.equal(result.audit.readwrite, 0);
  assert.equal(result.audit.handles, 0); assert.equal(result.audit.create, 0); assert.equal(result.audit.upgrade, 0);
  assert.equal(await Gate.formalPreconditionIdentity(result.snapshot, Schema.EXPECTED_FINGERPRINT),
    await Gate.formalPreconditionIdentity(f.snapshot, Schema.EXPECTED_FINGERPRINT));
  for (const field of Object.keys(f.snapshot)) assert.equal(result.snapshot[field].length, f.snapshot[field].length);
});
