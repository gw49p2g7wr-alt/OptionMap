"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), { IDBFactory } = require("fake-indexeddb");
const Boundary = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js").census;
const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Shadow = require("../js/marketCalendarHistory/formalShadowWritePlan.js");
const Transition = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Routes = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const NetworkPolicy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Adapter = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const vm = require("node:vm");
const Executor = require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").census;
const Authority = require("../js/marketCalendarHistory/formalWriterAuthority.js");
const SOURCE = Boundary.SOURCE_ID, OLD = "2026-09-01T00:00:00.000Z";
const empty = () => Object.fromEntries(Core.STORE_ORDER.map(([field]) => [field, []]));
async function event(sourceId, fetchedAt, referencePeriod) {
  const source = Registry.getSource(sourceId), result = await Canonical.canonicalize({
    ...Fixtures.record(sourceId), ...(referencePeriod ? { referencePeriod } : {}),
    sourceId, fetchedAt, rawContentHash: "a".repeat(64), parserId: source.parserId,
    parserVersion: source.parserVersion });
  assert.equal(result.ok, true, result.reason);
  return result.event;
}
async function records(sourceId, fetchedAt) {
  return Promise.all((sourceId === SOURCE ? ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"] :
    [null]).map(month => event(sourceId, fetchedAt, month)));
}
async function fixture() {
  const before = empty();
  for (const sourceId of Compare.SOURCE_IDS) {
    const canonicalSet = await records(sourceId, OLD), run = { sourceId, runId: "before",
      acceptedAt: "2026-09-02T00:00:00.000Z", fetchedAt: [OLD], status: "accepted",
      semanticSetHash: await Canonical.sha256(canonicalSet.map(value => value.revisionKey).sort()) },
      transition = Transition.planTransition({ snapshot: empty(), run, canonicalSet });
    assert.equal(transition.ok, true);
    const mapped = Mapper.mapPlan(transition.plan);
    for (const [field, key] of [["entries", "appendEntries"], ["revisions", "appendRevisions"],
      ["evidence", "appendEvidence"], ["observations", "appendObservations"],
      ["runs", "appendRuns"], ["cursors", "updateCursors"]]) before[field].push(...mapped[key]);
  }
  const session = Boundary.beginPrewrite();
  assert.equal((await Boundary.captureFormalRead(session, before, Schema.EXPECTED_FINGERPRINT)).status, "captured");
  const fetchedAt = new Date().toISOString(), sourceResults = [];
  for (const sourceId of Compare.SOURCE_IDS) sourceResults.push({ sourceId,
    canonicalRecords: await records(sourceId, fetchedAt), acquisitionOutcome: "complete",
    candidateStatus: "available", failedRoles: [], absenceAuthority: "none",
    // Independent expected values from the fixed manifest, not the selector under test.
    routeIdentity: Routes.PRODUCTION_AUTHORITY.entries.find(value => value.sourceId === sourceId).routeIdentity,
    documentHealth: (sourceId === "us-bls-calendar" ?
      ["cpi", "ppi", "employment_situation", "jolts"] : ["primary"]).map(role =>
      ({ role, fetchOutcome: "success", parseOutcome: "success" })) });
  const completedAt = new Date().toISOString();
  return { session, before, sourceResults, completedAt,
    input: { sourceResults, endingFormalSnapshot: before, completedAt } };
}
async function planFor(f, runId = "fixture-current") {
  const sourceResult = f.sourceResults.find(value => value.sourceId === SOURCE),
    comparison = await Compare.compare({ sourceResults: f.sourceResults, formalSnapshot: f.before }),
    run = { sourceId: SOURCE, runId, acceptedAt: f.completedAt, status: "accepted",
      fetchedAt: [...new Set(sourceResult.canonicalRecords.map(value => value.acquisitionEvidence.fetchedAt))],
      semanticSetHash: await Canonical.sha256(sourceResult.canonicalRecords.map(value => value.revisionKey).sort()) };
  return Shadow.buildSourceShadowPlan({ sourceId: SOURCE, sourceResult, comparison,
    formalSnapshot: f.before, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, run });
}
async function accepted() {
  const f = await fixture(), report = await Boundary.completePrewrite(f.session, f.input);
  assert.equal(report.status, "prewrite_eligible", report.reason);
  return { ...f, report };
}
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const finished = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
});
async function database(before) {
  const idb = new IDBFactory(), opening = idb.open(Schema.DATABASE_NAME, 1);
  opening.onupgradeneeded = () => Bootstrap.createAndPopulate(opening.result, opening.transaction, before);
  return { idb, db: await request(opening) };
}
async function read(db) {
  const tx = db.transaction(Core.STORE_NAMES, "readonly"), done = finished(tx),
    fields = await Promise.all(Core.STORE_ORDER.map(async ([field, name]) =>
      [field, await request(tx.objectStore(name).getAll())]));
  await done;
  return Core.sorted(Object.fromEntries(fields));
}
const metrics = () => ({ readwriteTransactions: 0, committedTransactions: 0,
  abortedTransactions: 0, committedWrites: Core.emptyCounts() });


const expectedWrites = { entries: 13, revisions: 0, evidence: 13, observations: 13, runs: 1, cursors: 1 };
async function executionFixture() {
  const f = await accepted(), { idb, db } = await database(f.before);
  db.close();
  const auth = Boundary.authorizeFirstProductionWrite({ ticket: f.report.ticket, binding: f.report.binding });
  const context = vm.createContext({ indexedDB: idb, crypto: globalThis.crypto,
    TextEncoder, structuredClone, console });
  const probe = { executeJavaScript: code => vm.runInContext(code, context) };
  return { ...f, idb, auth, context, probe };
}
async function execute(f) {
  return Executor.executeFirstProductionWrite(f.probe, f.auth.authorization, f.auth.binding);
}
test("E4b-2 exact Census write uses the actual shared core then closes and freshly reopens", async () => {
  const f = await executionFixture(), outcome = await execute(f);
  assert.equal(outcome.status, "verified", JSON.stringify(outcome));
  assert.equal(outcome.committed, true);
  assert.equal(outcome.verification.valid, true);
  assert.deepEqual(outcome.audit.committedWrites, expectedWrites);
  assert.equal(outcome.audit.readwrite, 1);
  assert.equal(outcome.audit.committed, 1);
  assert.equal(outcome.audit.aborted, 0);
  assert.equal(outcome.audit.opens, 2);
  assert.equal(outcome.audit.readonly, 4);
  assert.equal(outcome.audit.readbackReopens, 1);
  assert.equal(outcome.audit.openHandles, 0);
  assert.equal(outcome.audit.delete, 0);
  assert.equal(outcome.audit.upgrade, 0);
  assert.equal(Authority.selectWriterState(SOURCE).state, "disabled");
});
test("E4b-2 authorization binds all seven fresh identities and the exact set", async () => {
  const f = await executionFixture(), binding = f.auth.binding;
  assert.deepEqual(binding.identities, f.report.identities);
  assert.deepEqual(binding.exactMutationCeiling, Boundary.MUTATION_CEILING);
  assert.equal(binding.databaseName, Schema.DATABASE_NAME);
  assert.equal(binding.sourceId, SOURCE);
  assert.equal(binding.plannedReadwriteTransactions, 1);
  assert.equal(binding.authorityMode, "E4b2_census_explicit_one_shot");
  assert.equal(Boundary.requestProductionWrite({ ticket: f.report.ticket, binding: f.report.binding }).reason,
    "writer_authority_disabled");
});
test("E4b-2 forged ticket or input extra fields cannot authorize", async () => {
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: {}, binding: {} }),
    /fresh_authorization_binding_mismatch/);
  const f = await accepted();
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: f.report.ticket,
    binding: f.report.binding, sourceId: SOURCE }), /fresh_authorization_binding_mismatch/);
});
test("E4b-2 one ticket cannot issue a second one-shot token", async () => {
  const f = await executionFixture();
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: f.report.ticket,
    binding: f.report.binding }), /authorization_already_issued/);
});
for (const field of ["sourceId", "databaseName", "identities", "exactMutationCeiling", "plannedReadwriteTransactions"]) {
  test("E4b-2 forged binding " + field + " rejects before any DB transaction and exhausts token", async () => {
    const f = await executionFixture(), binding = structuredClone(f.auth.binding);
    binding[field] = "forged";
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, binding),
      /fresh_authorization_binding_mismatch/);
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
      /authorization_invalid_or_reused/);
  });
}
test("E4b-2 token reuse rejects after successful execution; serialized program also has same-window replay guard", async () => {
  const f = await executionFixture(), prepared = Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding);
  const first = await f.probe.executeJavaScript(prepared.program);
  assert.equal(first.status, "verified", first.reason);
  const repeated = await f.probe.executeJavaScript(prepared.program);
  assert.equal(repeated.reason, "authorization_invalid_or_reused");
  assert.equal(repeated.audit.readwrite, 0);
  assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
    /authorization_invalid_or_reused/);
});
test("E4b-2 aged authorization rejects before script/transaction execution", async () => {
  const f = await executionFixture(), original = Date.now;
  try {
    Date.now = () => original() + 301000;
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
      /authorization_expired/);
  } finally { Date.now = original; }
});
test("E4b-2 immediate precondition mismatch rejects with zero readwrite and no retry", async () => {
  const f = await executionFixture(), db = await request(f.idb.open(Schema.DATABASE_NAME));
  const tx = db.transaction(Core.STORE_NAMES, "readwrite"), completed = finished(tx);
  tx.objectStore(Core.STORE_ORDER[0][1])
    .put({ ...f.before[Core.STORE_ORDER[0][0]][0], acceptedAt: "2026-09-03T00:00:00.000Z" });
  await completed; db.close();
  const outcome = await execute(f);
  assert.equal(outcome.reason, "stale_precondition_before_transaction");
  assert.equal(outcome.committed, false);
  assert.equal(outcome.audit.readwrite, 0);
  assert.equal(outcome.audit.openHandles, 0);
});
test("E4b-2 inside-transaction stale state aborts actual core, no partial writes/no second attempt", async () => {
  const f = await executionFixture(), originalOpen = f.idb.open.bind(f.idb);
  let injected = false;
  f.idb.open = (...args) => {
    const opening = originalOpen(...args);
    opening.addEventListener("success", () => {
      const db = opening.result, transaction = db.transaction.bind(db);
      db.transaction = (stores, mode) => {
        if (mode === "readwrite" && !injected) {
          injected = true;
          const preceding = transaction(Core.STORE_NAMES, "readwrite");
          const entry = f.before.entries[0];
          preceding.objectStore(Core.STORE_ORDER.find(([field]) => field === "entries")[1])
            .put({ ...entry, lastObservedAt: "2026-09-03T00:00:00.000Z" });
        }
        return transaction(stores, mode);
      };
    });
    return opening;
  };
  const outcome = await execute(f);
  assert.equal(outcome.reason, "stale_precondition_inside_transaction");
  assert.equal(outcome.audit.readwrite, 1);
  assert.equal(outcome.audit.aborted, 1);
  assert.equal(outcome.audit.committed, 0);
  assert.deepEqual(structuredClone(outcome.audit.attemptedWrites), Core.emptyCounts());
  assert.equal(outcome.audit.openHandles, 0);
});
test("E4b-2 schema mismatch rejects before write/create/upgrade", async () => {
  const f = await executionFixture();
  f.context.indexedDB = new IDBFactory();
  const opening = f.context.indexedDB.open(Schema.DATABASE_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("wrong");
  const db = await request(opening); db.close();
  const outcome = await execute(f);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.audit.readwrite, 0);
  assert.equal(outcome.audit.upgrade, 0);
  assert.equal(outcome.audit.openHandles, 0);
});
test("E4b-2 absent DB cannot create it", async () => {
  const f = await executionFixture(); f.context.indexedDB = new IDBFactory();
  const outcome = await execute(f);
  assert.equal(outcome.reason, "existing_schema_v1_required");
  assert.equal(outcome.audit.opens, 0);
  assert.equal((await f.context.indexedDB.databases()).length, 0);
});
test("E4b-2 exact readback retains every other source record, prior evidence and all revisions", async () => {
  const f = await executionFixture(), outcome = await execute(f);
  assert.equal(outcome.status, "verified", outcome.reason);
  const db = await request(f.idb.open(Schema.DATABASE_NAME)), after = await read(db); db.close();
  assert.deepEqual(after.revisions, Core.sorted(f.before).revisions);
  assert.equal(after.entries.length, f.before.entries.length);
  assert.equal(after.evidence.length, f.before.evidence.length + 13);
  assert.equal(after.observations.length, f.before.observations.length + 13);
  assert.equal(after.runs.length, f.before.runs.length + 1);
  for (const [field] of Core.STORE_ORDER) {
    assert.deepEqual(after[field].filter(v => v.sourceId !== SOURCE),
      Core.sorted(f.before)[field].filter(v => v.sourceId !== SOURCE));
  }
  for (const old of f.before.evidence) assert.deepEqual(after.evidence.find(v => v.evidenceLinkKey === old.evidenceLinkKey), old);
  for (const entry of after.entries.filter(v => v.sourceId === SOURCE)) {
    const old = f.before.entries.find(v => v.eventKey === entry.eventKey);
    assert.deepEqual(entry, { ...old, lastObservedAt: f.report.expectation.cursorAfter.acceptedAt });
  }
});
test("E4b-2 transaction lifetime has zero crypto/timer/network inside the actual readwrite phase", async () => {
  const f = await executionFixture(), originalOpen = f.idb.open.bind(f.idb);
  let active = false, insideDigest = 0;
  f.context.crypto = { subtle: { digest: (...args) => {
    if (active) insideDigest++;
    return globalThis.crypto.subtle.digest(...args);
  } } };
  f.idb.open = (...args) => {
    const opening = originalOpen(...args);
    opening.addEventListener("success", () => {
      const db = opening.result, transaction = db.transaction.bind(db);
      db.transaction = (stores, mode) => {
        const tx = transaction(stores, mode);
        if (mode === "readwrite") {
          active = true;
          tx.addEventListener("complete", () => { active = false; });
          tx.addEventListener("abort", () => { active = false; });
        }
        return tx;
      };
    });
    return opening;
  };
  f.context.setTimeout = () => assert.fail("renderer timer forbidden");
  f.context.fetch = () => assert.fail("renderer network forbidden");
  const outcome = await execute(f);
  assert.equal(outcome.status, "verified", outcome.reason);
  assert.equal(insideDigest, 0);
});
test("E4b-2 delayed precomputation still precedes transaction start", async () => {
  for (const delay of [0, 5, 100]) {
    const f = await executionFixture();
    await new Promise(resolve => setTimeout(resolve, delay));
    assert.equal((await execute(f)).status, "verified");
  }
});
test("E4b-2 mismatch after commit is FAIL with committed=true, never hidden as NOT COMMITTED", async () => {
  const f = await executionFixture(), probe = { async executeJavaScript(code) {
    const result = await f.probe.executeJavaScript(code);
    if (result.readback) result.readback.entries[0].lastObservedAt = "wrong";
    return result;
  } };
  const outcome = await Executor.executeFirstProductionWrite(probe, f.auth.authorization, f.auth.binding);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.committed, true);
  assert.equal(outcome.verification.valid, false);
});
// Faults are introduced only into the in-memory program in an isolated fake
// factory. The production executor exposes no failure injection parameter.
for (const [name, original, replacement] of [
  ["extra operation", "store[mode](value); attempted[field] += 1;",
    "store[mode](value); store[mode](value); attempted[field] += 1;"],
  ["wrong Entry field", "store[mode](value); attempted[field] += 1;",
    "if (field === 'entries') value.unexpected = true; store[mode](value); attempted[field] += 1;"],
  ["other source", "store[mode](value); attempted[field] += 1;",
    "value.sourceId = 'jp-stat-cpi'; store[mode](value); attempted[field] += 1;"],
  ["delete", "store[mode](value); attempted[field] += 1;",
    "store.delete(value.eventKey); store[mode](value); attempted[field] += 1;"],
  ["Revision put", "store[mode](value); attempted[field] += 1;",
    "tx.objectStore(STORE_FOR.revisions).put(value); store[mode](value); attempted[field] += 1;"],
  ["missing Cursor", 'queue("updateCursors", "cursors", "put", m.updateCursors);', ""]
]) {
  test("E4b-2 exact set rejects " + name + " and rolls back all stores", async () => {
    const f = await executionFixture(), prepared = Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding);
    assert.ok(prepared.program.includes(original));
    const outcome = await f.probe.executeJavaScript(prepared.program.replace(original, replacement));
    assert.equal(outcome.committed, false, outcome.reason);
    assert.equal(outcome.audit.readwrite, 1);
    assert.equal(outcome.audit.committed, 0);
    assert.equal(outcome.audit.aborted, 1);
    assert.equal(outcome.audit.openHandles, 0);
    const db = await request(f.idb.open(Schema.DATABASE_NAME)), after = await read(db); db.close();
    assert.deepEqual(after, Core.sorted(f.before));
  });
}
test("E4b-2 executor/harness are unreachable from production startup/manual/renderer", () => {
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarStartupRuntime.js", "js/marketCalendarRuntime/calendarManualCheckService.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /firstProductionWriteExecutor|marketCalendarE4b2CensusWrite|authorizeFirstProductionWrite/);
  const source = fs.readFileSync(require.resolve("../js/marketCalendarHistory/firstProductionWriteExecutor.js"), "utf8");
  assert.match(source, /Core.executePrepared\(guarded, prepared, null, metrics\)/);
  assert.match(source, /formalControlledWriterCore.js/);
  assert.doesNotMatch(source, /injected_failure|failurePoint:/);
  const harness = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarE4b2CensusWrite.js"), "utf8");
  assert.match(harness, /--execute-census-write/);
  assert.match(harness, /sendAndConfirm\(control, "prewrite"/);
});

test("E4b-2 only the fixed Census closure is exported; machinery authorization cannot cross into Census", async () => {
  assert.equal(SOURCE, "us-census-calendar");
  const firstBoundary = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(firstBoundary.SOURCE_ID, "jp-esri-machinery-orders-calendar");
  const f = await executionFixture();
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js")
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
  assert.equal(Boundary.fixedBoundary, undefined);
  assert.equal(Executor.fixedExecutor, undefined);
});
for (const failure of ["count", "changed", "partial", "route", "duplicate"]) {
  test("E4b-2 fresh Census gate rejects " + failure + " before authorization", async () => {
    const f = await fixture(), source = f.sourceResults.find(value => value.sourceId === SOURCE);
    if (failure === "count") source.canonicalRecords.pop();
    if (failure === "changed") source.canonicalRecords[0] = await event(SOURCE,
      source.canonicalRecords[0].acquisitionEvidence.fetchedAt, "2028-01");
    if (failure === "partial") source.acquisitionOutcome = "partial";
    if (failure === "route") source.routeIdentity = "forged";
    if (failure === "duplicate") source.canonicalRecords.push(source.canonicalRecords[0]);
    const report = await Boundary.completePrewrite(f.session, f.input);
    assert.equal(report.status, "rejected", JSON.stringify(report));
    assert.equal(report.writeAllowed, false);
    assert.equal(report.coreWriteExecutions, 0);
    assert.equal(report.ticket, undefined);
  });
}
test("E4b-2 neither production authority nor approved machinery source contract changes", () => {
  assert.equal(Authority.selectWriterState(SOURCE).state, "disabled");
  assert.equal(Authority.selectWriterState("jp-esri-machinery-orders-calendar").state, "disabled");
  const original = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(original.EXPECTED_COUNTS.eventEntryUpdate, 4);
  assert.equal(original.sna.EXPECTED_COUNTS.eventEntryUpdate, 4);
  assert.equal(Boundary.EXPECTED_COUNTS.eventEntryUpdate, 13);
});

test("E4b-2 SNA executor cannot consume Census authorization", async () => {
  const f = await executionFixture();
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").sna
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4b-2 BEA executor cannot consume Census authorization and keeps its eight-record contract", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.bea.SOURCE_ID, "us-bea-calendar");
  assert.equal(boundaries.bea.EXPECTED_COUNTS.eventEntryUpdate, 8);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").bea
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});
