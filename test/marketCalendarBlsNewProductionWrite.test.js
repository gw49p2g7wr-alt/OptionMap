"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), { IDBFactory } = require("fake-indexeddb");
const Boundary = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js").blsNew;
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
const Executor = require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").blsNew;
const Authority = require("../js/marketCalendarHistory/formalWriterAuthority.js");
const Bls = require("../js/marketCalendarIsolated/blsFixedRoute.js");
const SOURCE = Boundary.SOURCE_ID, OLD = "2026-09-01T00:00:00.000Z";
const empty = () => Object.fromEntries(Core.STORE_ORDER.map(([field]) => [field, []]));
async function event(sourceId, fetchedAt, referencePeriod, role = Bls.ROLES[0]) {
  const fresh = sourceId === SOURCE && fetchedAt !== OLD,
    source = Registry.getSource(sourceId), canonicalizer = fresh ?
      Canonical.createCanonicalizer(Bls.shadowRegistry) : Canonical;
  const result = await canonicalizer.canonicalize({ ...Fixtures.record(sourceId),
    ...(referencePeriod ? { referencePeriod } : {}),
    ...(sourceId === SOURCE ? { eventType: role.eventType, title: role.title, scope: "national",
      edition: "initial", sourceUrl: fresh ? role.url : source.canonicalUrl,
      parserVersion: fresh ? Bls.PARSER_VERSION : source.parserVersion } :
      { sourceUrl: source.canonicalUrl, parserVersion: source.parserVersion }),
    sourceId, fetchedAt, rawContentHash: "a".repeat(64), parserId: source.parserId });
  assert.equal(result.ok, true, result.reason);
  return result.event;
}
async function records(sourceId, fetchedAt) {
  if (sourceId !== SOURCE) return [await event(sourceId, fetchedAt)];
  const set = await Promise.all(Bls.ROLES.flatMap(role =>
    ["2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05",
      "2026-06","2026-07","2026-08","2026-09","2026-10","2026-11"]
      .map(month => event(sourceId, fetchedAt, month, role))));
  return fetchedAt === OLD ? set.slice(0, 5) : set;
}
async function fixture(mutateBefore = null) {
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
  if (mutateBefore) mutateBefore(before);
  const session = Boundary.beginPrewrite();
  assert.equal((await Boundary.captureFormalRead(session, before, Schema.EXPECTED_FINGERPRINT)).status, "captured");
  const fetchedAt = new Date().toISOString(), sourceResults = [];
  for (const sourceId of Compare.SOURCE_IDS) sourceResults.push({ sourceId,
    canonicalRecords: await records(sourceId, fetchedAt), acquisitionOutcome: "complete",
    candidateStatus: "available", failedRoles: [], absenceAuthority: "none",
    coverage: sourceId === SOURCE ? { coverageState: "sufficient", absenceAuthority: "none",
      roleCoverage: Bls.ROLES.map(({ role }) => ({ role, state: "sufficient", absenceAuthority: "none" })) } : null,
    // Independent expected values from the fixed manifest, not the selector under test.
    routeIdentity: Routes.PRODUCTION_AUTHORITY.entries.find(value => value.sourceId === sourceId).routeIdentity,
    documentHealth: (sourceId === "us-bls-calendar" ?
      ["cpi", "ppi", "employment_situation", "jolts"] : ["primary"]).map(role =>
      ({ role, httpStatus: 200, redirectCount: 0, fetchOutcome: "success", parseOutcome: "success" })) });
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


const expectedWrites = { entries: 52, revisions: 47, evidence: 52, observations: 52, runs: 1, cursors: 1 };
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
test("E4d-BLS exact BLS new-47 write uses the actual shared core then closes and freshly reopens", async () => {
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
test("E4d-BLS authorization binds all seven fresh identities and the exact set", async () => {
  const f = await executionFixture(), binding = f.auth.binding;
  assert.deepEqual(binding.identities, f.report.identities);
  assert.deepEqual(binding.exactMutationCeiling, Boundary.MUTATION_CEILING);
  assert.equal(binding.databaseName, Schema.DATABASE_NAME);
  assert.equal(binding.sourceId, SOURCE);
  assert.equal(binding.plannedReadwriteTransactions, 1);
  assert.equal(binding.authorityMode, "E4d_bls_explicit_one_shot");
  assert.equal(Boundary.requestProductionWrite({ ticket: f.report.ticket, binding: f.report.binding }).reason,
    "writer_authority_disabled");
});
test("E4d-BLS forged ticket or input extra fields cannot authorize", async () => {
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: {}, binding: {} }),
    /fresh_authorization_binding_mismatch/);
  const f = await accepted();
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: f.report.ticket,
    binding: f.report.binding, sourceId: SOURCE }), /fresh_authorization_binding_mismatch/);
});
test("E4d-BLS one ticket cannot issue a second one-shot token", async () => {
  const f = await executionFixture();
  assert.throws(() => Boundary.authorizeFirstProductionWrite({ ticket: f.report.ticket,
    binding: f.report.binding }), /authorization_already_issued/);
});
for (const field of ["sourceId", "databaseName", "identities", "exactMutationCeiling", "plannedReadwriteTransactions"]) {
  test("E4d-BLS forged binding " + field + " rejects before any DB transaction and exhausts token", async () => {
    const f = await executionFixture(), binding = structuredClone(f.auth.binding);
    binding[field] = "forged";
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, binding),
      /fresh_authorization_binding_mismatch/);
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
      /authorization_invalid_or_reused/);
  });
}
test("E4d-BLS token reuse rejects after successful execution; serialized program also has same-window replay guard", async () => {
  const f = await executionFixture(), prepared = Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding);
  const first = await f.probe.executeJavaScript(prepared.program);
  assert.equal(first.status, "verified", first.reason);
  const repeated = await f.probe.executeJavaScript(prepared.program);
  assert.equal(repeated.reason, "authorization_invalid_or_reused");
  assert.equal(repeated.audit.readwrite, 0);
  assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
    /authorization_invalid_or_reused/);
});
test("E4d-BLS aged authorization rejects before script/transaction execution", async () => {
  const f = await executionFixture(), original = Date.now;
  try {
    Date.now = () => original() + 301000;
    assert.throws(() => Executor.prepareProbeProgram(f.auth.authorization, f.auth.binding),
      /authorization_expired/);
  } finally { Date.now = original; }
});
test("E4d-BLS immediate precondition mismatch rejects with zero readwrite and no retry", async () => {
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
test("E4d-BLS inside-transaction stale state aborts actual core, no partial writes/no second attempt", async () => {
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
test("E4d-BLS schema mismatch rejects before write/create/upgrade", async () => {
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
test("E4d-BLS absent DB cannot create it", async () => {
  const f = await executionFixture(); f.context.indexedDB = new IDBFactory();
  const outcome = await execute(f);
  assert.equal(outcome.reason, "existing_schema_v1_required");
  assert.equal(outcome.audit.opens, 0);
  assert.equal((await f.context.indexedDB.databases()).length, 0);
});
test("E4d-BLS exact readback retains every other source record, prior evidence and all revisions", async () => {
  const f = await executionFixture(), outcome = await execute(f);
  assert.equal(outcome.status, "verified", outcome.reason);
  const db = await request(f.idb.open(Schema.DATABASE_NAME)), after = await read(db); db.close();
  for (const old of f.before.revisions) assert.deepEqual(after.revisions.find(x => x.revisionKey === old.revisionKey), old);
  assert.equal(after.revisions.length, f.before.revisions.length + 47);
  assert.equal(after.entries.length, f.before.entries.length + 47);
  assert.equal(after.evidence.length, f.before.evidence.length + 52);
  assert.equal(after.observations.length, f.before.observations.length + 52);
  assert.equal(after.runs.length, f.before.runs.length + 1);
  for (const [field] of Core.STORE_ORDER) {
    assert.deepEqual(after[field].filter(v => v.sourceId !== SOURCE),
      Core.sorted(f.before)[field].filter(v => v.sourceId !== SOURCE));
  }
  for (const old of f.before.evidence) assert.deepEqual(after.evidence.find(v => v.evidenceLinkKey === old.evidenceLinkKey), old);
  for (const entry of after.entries.filter(v => v.sourceId === SOURCE && f.before.entries.some(x => x.eventKey === v.eventKey))) {
    const old = f.before.entries.find(v => v.eventKey === entry.eventKey);
    assert.deepEqual(entry, { ...old, lastObservedAt: f.report.expectation.cursorAfter.acceptedAt });
  }
});
test("E4d-BLS transaction lifetime has zero crypto/timer/network inside the actual readwrite phase", async () => {
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
test("E4d-BLS delayed precomputation still precedes transaction start", async () => {
  for (const delay of [0, 5, 100]) {
    const f = await executionFixture();
    await new Promise(resolve => setTimeout(resolve, delay));
    assert.equal((await execute(f)).status, "verified");
  }
});
test("E4d-BLS mismatch after commit is FAIL with committed=true, never hidden as NOT COMMITTED", async () => {
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
    "value.sourceId = 'jp-stat-labor'; store[mode](value); attempted[field] += 1;"],
  ["delete", "store[mode](value); attempted[field] += 1;",
    "store.delete(value.eventKey); store[mode](value); attempted[field] += 1;"],
  ["Revision put", "store[mode](value); attempted[field] += 1;",
    "tx.objectStore(STORE_FOR.revisions).put(value); store[mode](value); attempted[field] += 1;"],
  ["missing Cursor", 'queue("updateCursors", "cursors", "put", m.updateCursors);', ""]
]) {
  test("E4d-BLS exact set rejects " + name + " and rolls back all stores", async () => {
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
test("E4d-BLS executor/harness are unreachable from production startup/manual/renderer", () => {
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarStartupRuntime.js", "js/marketCalendarRuntime/calendarManualCheckService.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /firstProductionWriteExecutor|marketCalendarE4dBlsWrite|authorizeFirstProductionWrite/);
  const source = fs.readFileSync(require.resolve("../js/marketCalendarHistory/firstProductionWriteExecutor.js"), "utf8");
  assert.match(source, /Core.executePrepared\(guarded, prepared, null, metrics\)/);
  assert.match(source, /formalControlledWriterCore.js/);
  assert.doesNotMatch(source, /injected_failure|failurePoint:/);
  const harness = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarE4dBlsWrite.js"), "utf8");
  assert.match(harness, /--execute-bls-write/);
  assert.match(harness, /sendAndConfirm\(control, "prewrite"/);
});

test("E4d-BLS only the fixed BLS new-47 closure is exported; machinery authorization cannot cross into BLS new-47", async () => {
  assert.equal(SOURCE, "us-bls-calendar");
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
  test("E4d-BLS fresh BLS new-47 gate rejects " + failure + " before authorization", async () => {
    const f = await fixture(), source = f.sourceResults.find(value => value.sourceId === SOURCE);
    if (failure === "count") source.canonicalRecords.pop();
    if (failure === "changed") source.canonicalRecords[0] = await event(SOURCE,
      source.canonicalRecords[0].acquisitionEvidence.fetchedAt, "2028-01-01");
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
test("E4d-BLS neither production authority nor approved machinery source contract changes", () => {
  assert.equal(Authority.selectWriterState(SOURCE).state, "disabled");
  assert.equal(Authority.selectWriterState("jp-esri-machinery-orders-calendar").state, "disabled");
  const original = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(original.EXPECTED_COUNTS.eventEntryUpdate, 4);
  assert.equal(original.sna.EXPECTED_COUNTS.eventEntryUpdate, 4);
  assert.equal(Boundary.EXPECTED_COUNTS.eventEntryUpdate, 5);
});

test("E4d-BLS SNA executor cannot consume BLS new-47 authorization", async () => {
  const f = await executionFixture();
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").sna
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS BEA executor cannot consume BLS new-47 authorization and keeps its eight-record contract", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.bea.SOURCE_ID, "us-bea-calendar");
  assert.equal(boundaries.bea.EXPECTED_COUNTS.eventEntryUpdate, 8);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").bea
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS Census executor cannot consume BLS new-47 authorization and retains its thirteen-record contract", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.census.SOURCE_ID, "us-census-calendar");
  assert.equal(boundaries.census.EXPECTED_COUNTS.eventEntryUpdate, 13);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").census
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS FOMC executor cannot consume BLS new-47 authorization and retains its twenty-four-record contract", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.fomc.SOURCE_ID, "us-fed-fomc-calendar");
  assert.equal(boundaries.fomc.EXPECTED_COUNTS.eventEntryUpdate, 24);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").fomc
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS JPX derivatives executor cannot consume BLS new-47 authorization and retains its twenty-four-record contract", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.jpxDerivatives.SOURCE_ID, "jp-jpx-derivatives-calendar");
  assert.equal(boundaries.jpxDerivatives.EXPECTED_COUNTS.eventEntryUpdate, 24);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").jpxDerivatives
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS NYSE executor cannot consume BLS new-47 authorization and keeps thirty-four records", async () => {
  const f = await executionFixture(), boundaries = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
  assert.equal(boundaries.nyse.SOURCE_ID, "us-nyse-market-holidays");
  assert.equal(boundaries.nyse.EXPECTED_COUNTS.eventEntryUpdate, 34);
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").nyse
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS existing five old/new evidence identities link to unchanged revisions before and after write", async () => {
  const f = await executionFixture();
  assert.equal(f.report.provenanceAudit.valid, true);
  assert.equal(f.report.provenanceAudit.eventCount, 5);
  assert.equal(f.report.sourceRows.find(value => value.sourceId === SOURCE).evidenceOnly, 5);
  for (const row of f.report.provenanceAudit.rows) {
    assert.equal(row.newUrl, Bls.ROLES.find(x => x.eventType === f.before.revisions.find(r => r.revisionKey === row.revisionKey).logical.eventType).url);
    assert.ok(row.oldUrls.includes(Registry.getSource(SOURCE).canonicalUrl));
    assert.ok(row.oldEvidenceKeys.length);
    assert.ok(!row.oldEvidenceKeys.includes(row.newEvidenceKey));
    assert.ok(row.distinct && row.sameRevision && row.provenanceChanged);
  }
  const result = await execute(f);
  assert.equal(result.verification.provenanceAudit.valid, true);
  assert.equal(result.verification.provenanceAudit.eventCount, 5);
  assert.ok(result.verification.provenanceAudit.rows.every(row =>
    row.oldPreserved && row.revisionPreserved && row.newLinked));
});
test("E4d-BLS legacy representation cannot pass new route provenance gate", async () => {
  const f = await fixture(), source = f.sourceResults.find(x => x.sourceId === SOURCE);
  source.canonicalRecords = await Promise.all(source.canonicalRecords.map(async record => {
    const role = Bls.ROLES.find(x => x.eventType === record.logical.eventType),
      legacy = await event(SOURCE, OLD, record.logical.referencePeriod, role);
    const raw = { ...Fixtures.record(SOURCE), sourceId: SOURCE, eventType: role.eventType, title: role.title,
      referencePeriod: record.logical.referencePeriod, fetchedAt: f.completedAt, rawContentHash: "a".repeat(64),
      sourceUrl: Registry.getSource(SOURCE).canonicalUrl,
      parserId: Registry.getSource(SOURCE).parserId, parserVersion: 1 };
    return (await Canonical.canonicalize(raw)).event;
  }));
  assert.equal((await Boundary.completePrewrite(f.session, f.input)).status, "rejected");
});
test("E4d-BLS missing old evidence is fail-closed with no authorization", async () => {
  const f = await fixture(before => {
    const key = before.entries.find(value => value.sourceId === SOURCE).eventKey;
    before.evidence = before.evidence.filter(value => value.eventKey !== key);
  });
  const report = await Boundary.completePrewrite(f.session, f.input);
  assert.equal(report.status, "rejected");
  assert.equal(report.reason, "evidence_transition_invalid");
  assert.equal(report.ticket, undefined);
});
test("E4d-BLS readback rejects old evidence overwrite, loss or revision/provenance corruption", async () => {
  for (const fault of ["old_overwrite", "old_delete", "new_link", "new_url", "revision_hash"]) {
    const f = await executionFixture(), probe = { async executeJavaScript(code) {
      const result = await f.probe.executeJavaScript(code);
      if (result.readback) {
        const old = result.readback.evidence.find(value => value.sourceId === SOURCE &&
          value.acquisitionEvidence.sourceUrl === Registry.getSource(SOURCE).canonicalUrl),
          fresh = result.readback.evidence.find(value => value.sourceId === SOURCE &&
            Bls.ROLES.some(role => role.url === value.acquisitionEvidence.sourceUrl));
        if (fault === "old_overwrite") old.acquisitionEvidence.sourceUrl = fresh.acquisitionEvidence.sourceUrl;
        if (fault === "old_delete") result.readback.evidence.splice(result.readback.evidence.indexOf(old), 1);
        if (fault === "new_link") fresh.revisionKey = "forged";
        if (fault === "new_url") fresh.acquisitionEvidence.sourceUrl = "https://invalid.example/";
        if (fault === "revision_hash") result.readback.revisions.find(value =>
          value.revisionKey === fresh.revisionKey).canonicalContentHash = "b".repeat(64);
      }
      return result;
    }};
    const result = await Executor.executeFirstProductionWrite(probe, f.auth.authorization, f.auth.binding);
    assert.equal(result.committed, true);
    assert.equal(result.verification.valid, false, fault);
  }
});
test("E4d-BLS JPX Holidays executor cannot consume BLS authorization", async () => {
  const f = await executionFixture();
  assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js").jpxHolidays
    .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
  assert.equal((await execute(f)).status, "verified");
});

test("E4d-BLS new47 exact initial linkage, existing5 preservation and operation split", async () => {
  const f = await executionFixture(), result = await execute(f);
  assert.equal(f.report.linkageAudit.valid, true);
  assert.equal(f.report.linkageAudit.eventCount, 47);
  assert.equal(result.verification.linkageAudit.valid, true);
  assert.equal(result.verification.linkageAudit.eventCount, 47);
  assert.ok(result.verification.linkageAudit.rows.every(row => row.valid));
  assert.deepEqual(structuredClone(result.audit.entryOperations), { create: 47, update: 5 });
  assert.equal(result.verification.audit.activeCount, f.before.entries.length + 47);
  assert.equal(result.verification.provenanceAudit.eventCount, 5);
  assert.ok(f.report.documentAudit.every(x => x.valid));
  assert.equal(f.report.resourceAudit.operationCount, 205);
  assert.ok(f.report.resourceAudit.preparationMs < f.report.resourceAudit.authorizationTtlMs);
  assert.ok(f.report.resourceAudit.transactionMaterialBytes > 0);
});
for (const fault of ["missing_role", "duplicate_role", "fetch_failed", "parse_failed",
  "redirect", "http_failure", "coverage_partial", "coverage_missing", "absence_authority"]) {
  test("E4d-BLS four documents fail-closed " + fault, async () => {
    const f = await fixture(), source = f.sourceResults.find(x => x.sourceId === SOURCE);
    if (fault === "missing_role") source.documentHealth.pop();
    if (fault === "duplicate_role") source.documentHealth[1].role = "cpi";
    if (fault === "fetch_failed") source.documentHealth[0].fetchOutcome = "failure";
    if (fault === "parse_failed") source.documentHealth[0].parseOutcome = "failure";
    if (fault === "redirect") source.documentHealth[0].redirectCount = 1;
    if (fault === "http_failure") source.documentHealth[0].httpStatus = 404;
    if (fault === "coverage_partial") source.coverage.roleCoverage[0].state = "partial";
    if (fault === "coverage_missing") source.coverage.roleCoverage.pop();
    if (fault === "absence_authority") source.absenceAuthority = "complete";
    const result = await Boundary.completePrewrite(f.session, f.input);
    assert.equal(result.reason, "bls_document_contract_invalid");
    assert.equal(result.ticket, undefined);
    assert.equal(result.coreWriteExecutions, 0);
  });
}
for (const field of ["appendEntries", "appendRevisions", "appendEvidence", "appendObservations"]) {
  test("E4d-BLS plan duplicate or broken linkage rejects " + field, async () => {
    const f = await fixture(), plan = structuredClone(await planFor(f));
    plan.mutations[field].push(structuredClone(plan.mutations[field][0]));
    assert.equal((await Boundary.validateFirstWritePlan(plan, f.before)).valid, false);
    const broken = structuredClone(await planFor(f));
    const row = broken.mutations[field].find(x =>
      !f.before.entries.some(prior => prior.eventKey === x.eventKey));
    if (field === "appendEntries") row.activeRevisionKey = "forged";
    if (field === "appendRevisions") row.revisionOrigin = "authority_semantic_change";
    if (field === "appendEvidence") row.revisionKey = "forged";
    if (field === "appendObservations") row.eventKey = "forged";
    assert.equal((await Boundary.validateFirstWritePlan(broken, f.before)).valid, false);
  });
}
test("E4d-BLS new47 readback rejects Entry, Revision, Evidence and Observation corruption", async () => {
  for (const fault of ["entry", "revision", "evidence", "observation"]) {
    const f = await executionFixture(), probe = { async executeJavaScript(code) {
      const result = await f.probe.executeJavaScript(code);
      if (result.readback) {
        const key = f.report.linkageAudit.rows[0].eventKey;
        if (fault === "entry") result.readback.entries.find(x => x.eventKey === key).activeRevisionKey = "forged";
        if (fault === "revision") result.readback.revisions.find(x => x.eventKey === key).canonicalContentHash = "b".repeat(64);
        if (fault === "evidence") result.readback.evidence.find(x => x.eventKey === key).revisionKey = "forged";
        if (fault === "observation") result.readback.observations.find(x => x.eventKey === key).runId = "forged";
      }
      return result;
    }};
    const result = await Executor.executeFirstProductionWrite(probe, f.auth.authorization, f.auth.binding);
    assert.equal(result.committed, true);
    assert.equal(result.verification.valid, false);
    assert.equal(result.verification.linkageAudit.valid, false);
  }
});
for (const key of ["cpiEvidence", "laborEvidence"]) {
  test("E4d-BLS Class B " + key + " cannot consume BLS authorization", async () => {
    const f = await executionFixture();
    assert.throws(() => require("../js/marketCalendarHistory/firstProductionWriteExecutor.js")[key]
      .prepareProbeProgram(f.auth.authorization, f.auth.binding), /authorization_invalid_or_reused/);
    assert.equal((await execute(f)).status, "verified");
  });
}

test("E4d-R1 temp fixture missing sourceId is fail-closed", async () => {
  const sourceId = Compare.SOURCE_IDS[0], source = Registry.getSource(sourceId),
    result = await Canonical.canonicalize({ ...Fixtures.record(sourceId), fetchedAt: OLD,
      rawContentHash: "a".repeat(64), parserId: source.parserId, parserVersion: source.parserVersion });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_unregistered");
  assert.equal(result.event, null);
});
test("E4d-R1 temp fixture unknown sourceId is fail-closed", async () => {
  const result = await Canonical.canonicalize({ ...Fixtures.record(Compare.SOURCE_IDS[0]),
    sourceId: "unknown-source", fetchedAt: OLD, rawContentHash: "a".repeat(64), parserVersion: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_unregistered");
  assert.equal(result.event, null);
});
test("E4d-R1 explicit fixture source identity generates canonical events for all twelve registered sources", async () => {
  for (const sourceId of Compare.SOURCE_IDS) {
    const source = Registry.getSource(sourceId),
      result = await Canonical.canonicalize({ ...Fixtures.record(sourceId), sourceId,
        fetchedAt: OLD, rawContentHash: "a".repeat(64), parserId: source.parserId,
        parserVersion: source.parserVersion });
    assert.equal(result.ok, true, sourceId + ": " + result.reason);
    assert.equal(result.event.acquisitionEvidence.sourceId, sourceId);
  }
});
test("E4d-R1 both native dry canonicalization sites explicitly bind the iterated registry sourceId", () => {
  const text = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarE4dBlsWrite.js"), "utf8"),
    dry = text.slice(text.indexOf("async function runIsolatedDry"), text.indexOf("function sendAndConfirm"));
  assert.equal((dry.match(/\.\.\.Fixtures\.record\(sourceId\), sourceId,/g) || []).length, 2);
});
