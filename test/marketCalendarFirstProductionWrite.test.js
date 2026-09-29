"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), { IDBFactory } = require("fake-indexeddb");
const Boundary = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js");
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
const Harness = require("../scripts/marketCalendarE3aPrewrite.js");
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
  return Promise.all((sourceId === SOURCE ? ["2026-04", "2026-05", "2026-06", "2026-07"] :
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
  const idb = new IDBFactory(), opening = idb.open("E3aIsolatedFixture", 1);
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

test("R1 valid source and authority operation select the expected active route for all twelve sources", () => {
  assert.equal(NetworkPolicy.OPERATION, "source-document-set");
  for (const expected of Routes.PRODUCTION_AUTHORITY.entries) {
    const selected = Routes.selectRoute({ sourceId: expected.sourceId, operation: NetworkPolicy.OPERATION },
      Routes.PRODUCTION_AUTHORITY);
    assert.equal(selected.valid, true);
    assert.equal(selected.reason, null);
    assert.equal(selected.acquisitionAllowed, true);
    assert.equal(selected.routeIdentity, expected.routeIdentity);
    assert.equal(selected.routeKind, expected.routeKind);
  }
});
test("R2 missing operation is request_shape_invalid, never an undefined identity success", () => {
  const selected = Routes.selectRoute({ sourceId: SOURCE }, Routes.PRODUCTION_AUTHORITY);
  assert.equal(selected.valid, false);
  assert.equal(selected.reason, "request_shape_invalid");
  assert.equal(selected.acquisitionAllowed, false);
});
test("R3 every valid selector identity exists and is non-empty", () => {
  for (const sourceId of Compare.SOURCE_IDS) {
    const selected = Routes.selectRoute({ sourceId, operation: NetworkPolicy.OPERATION }, Routes.PRODUCTION_AUTHORITY);
    assert.equal(selected.valid, true);
    assert.equal(selected.reason, null);
    assert.match(selected.routeIdentity, /^[a-f0-9]{64}$/);
  }
});
test("R4 actual acquisition adapter envelope and fresh boundary match the independent active manifest", async () => {
  const sourceId = "jp-boj-calendar", expected = Routes.PRODUCTION_AUTHORITY.entries.find(value => value.sourceId === sourceId);
  let requests = 0;
  const adapter = Adapter.createRouteAdapter({ getAuthority: () => Routes.PRODUCTION_AUTHORITY,
    assessmentDateJst: "2026-09-30", fetchImpl: async () => {
      requests++;
      return new Response('<h2 id="p02">次回</h2><p>2026年9月17日（木）、18日（金）</p>' +
        '<h2 id="p03">会見</h2><p>2026年9月18日（金）15:30～（ライブ配信予定）</p>',
      { headers: { "content-type": "text/html; charset=utf-8" } });
    } });
  const acquired = await adapter.acquire({ sourceId, operation: NetworkPolicy.OPERATION });
  assert.equal(acquired.acquisitionOutcome, "complete");
  assert.equal(acquired.routeIdentity, expected.routeIdentity);
  assert.equal(requests, 1);
  const f = await fixture();
  f.sourceResults.find(value => value.sourceId === sourceId).routeIdentity = acquired.routeIdentity;
  const result = await Boundary.completePrewrite(f.session, f.input);
  assert.equal(result.status, "prewrite_eligible", result.reason);
  assert.equal(result.routeAudit.length, 12);
  for (const row of result.routeAudit) {
    assert.equal(row.operation, NetworkPolicy.OPERATION);
    assert.equal(row.selectorValid, true);
    assert.equal(row.match, true);
    assert.equal(row.selectorRouteIdentity, Routes.PRODUCTION_AUTHORITY.entries.find(value =>
      value.sourceId === row.sourceId).routeIdentity);
    assert.equal(row.acquisitionRouteIdentity, row.selectorRouteIdentity);
  }
});
test("R5 undefined, null, empty and whitespace acquisition identities fail closed", async () => {
  for (const identity of [undefined, null, "", "   "]) {
    const f = await fixture(); f.sourceResults[0].routeIdentity = identity;
    const result = await Boundary.completePrewrite(f.session, f.input);
    assert.equal(result.reason, "route_identity_missing");
    assert.equal(result.firstLiveWriteEligible, false);
    assert.equal(result.coreWriteExecutions, 0);
    assert.equal(result.routeAudit[0].match, false);
  }
});
test("R6 wrong operation rejects without acquisition; unknown selector and wrong identity reject at boundary", async () => {
  const selected = Routes.selectRoute({ sourceId: SOURCE, operation: "wrong" }, Routes.PRODUCTION_AUTHORITY);
  assert.equal(selected.valid, false);
  assert.equal(selected.reason, "source_or_operation_invalid");
  const adapter = Adapter.createRouteAdapter({ getAuthority: () => Routes.PRODUCTION_AUTHORITY,
    assessmentDateJst: "2026-09-30", fetchImpl: async () => assert.fail("no network"),
    legacyAcquire: async () => assert.fail("no acquisition") });
  const acquired = await adapter.acquire({ sourceId: SOURCE, operation: "wrong" });
  assert.equal(acquired.acquisitionOutcome, "rejected");
  const f = await fixture(); f.sourceResults[0].routeIdentity = acquired.routeIdentity;
  assert.equal((await Boundary.completePrewrite(f.session, f.input)).reason, "route_identity_missing");
  const unknown = await fixture(); unknown.sourceResults[0].sourceId = "unknown";
  assert.equal((await Boundary.completePrewrite(unknown.session, unknown.input)).reason, "route_selector_invalid");
  const wrong = await fixture(); wrong.sourceResults[0].routeIdentity = "a".repeat(64);
  assert.equal((await Boundary.completePrewrite(wrong.session, wrong.input)).reason, "route_identity_mismatch");
});
const readAudit = (extra = {}) => ({ ...Harness.createCumulativeAudit(),
  catalogReads: 1, opens: 1, readonly: 2, ...extra });
test("A1 cumulative read audit adds both stages without overwriting earlier counts", () => {
  const total = Harness.createCumulativeAudit();
  Harness.mergeReadAudit(total, "initial_formal_read", { status: "ok", audit: readAudit() });
  Harness.mergeReadAudit(total, "ending_formal_read", { status: "ok", audit: readAudit() });
  assert.equal(total.opens, 2); assert.equal(total.readonly, 4); assert.equal(total.catalogReads, 2);
  assert.equal(total.auditComplete, true); assert.equal(total.readonlyOnly, true);
  assert.equal(total.openHandles, 0); assert.equal(total.stages.length, 2);
  Harness.assertReadOnlyAudit(total);
});
test("A2 per-store counts accumulate and safety flags remain false after a violation", () => {
  const total = Harness.createCumulativeAudit(), a = readAudit(), b = readAudit();
  const name = Object.keys(a.perStoreWrites)[0];
  a.perStoreWrites[name] = 2; a.writes = 2; a.readwrite = 1; a.readonlyOnly = false;
  b.perStoreWrites[name] = 3; b.writes = 3;
  Harness.mergeReadAudit(total, "first", { status: "failed", audit: a });
  Harness.mergeReadAudit(total, "second", { status: "ok", audit: b });
  assert.equal(total.perStoreWrites[name], 5); assert.equal(total.writes, 5);
  assert.equal(total.readwrite, 1); assert.equal(total.readonlyOnly, false);
  assert.throws(() => Harness.assertReadOnlyAudit(total), /readonly_boundary_violated/);
});
test("A3 failure after the second read reports cumulative counts, network and exact failure stage", () => {
  const total = Harness.createCumulativeAudit();
  for (const stage of ["initial_formal_read", "ending_formal_read"])
    Harness.mergeReadAudit(total, stage, { status: "ok", audit: readAudit() });
  const result = Harness.failureResult(Error("route_identity_mismatch"), "first_write_eligibility",
    total, 17, 0, [], [{ match: false }]);
  assert.equal(result.reason, "route_identity_mismatch");
  assert.equal(result.failureStage, "first_write_eligibility");
  assert.equal(result.formalAudit.opens, 2); assert.equal(result.formalAudit.readonly, 4);
  assert.deepEqual(result.network, { requests: 17, activeRequests: 0 });
  total.opens = 99;
  assert.equal(result.formalAudit.opens, 2);
});
test("A4 first/second read failure retains exactly the reached operation counts", () => {
  for (const completedReads of [0, 1]) {
    const total = Harness.createCumulativeAudit();
    if (completedReads) Harness.mergeReadAudit(total, "initial", { status: "ok", audit: readAudit() });
    Harness.mergeReadAudit(total, "failed_read", { status: "schema_fingerprint_mismatch",
      audit: readAudit({ readonly: 1 }) });
    const result = Harness.failureResult(Error("schema_fingerprint_mismatch"), "failed_read", total, 0, 0, [], []);
    assert.equal(result.formalAudit.opens, completedReads + 1);
    assert.equal(result.formalAudit.readonly, completedReads * 2 + 1);
    assert.equal(result.formalAudit.stages.at(-1).status, "schema_fingerprint_mismatch");
  }
});
test("A5 missing or malformed audit fails closed and cannot erase prior counters", () => {
  for (const invalid of [null, { ...readAudit(), readonly: -1 },
    { ...readAudit(), auditComplete: undefined }, { ...readAudit(), perStoreWrites: {} }]) {
    const total = Harness.createCumulativeAudit();
    Harness.mergeReadAudit(total, "initial", { status: "ok", audit: readAudit() });
    Harness.mergeReadAudit(total, "broken", { status: "failed", audit: invalid });
    assert.equal(total.auditComplete, false);
    assert.ok(total.opens >= 1); assert.ok(total.readonly >= 2);
    assert.throws(() => Harness.assertReadOnlyAudit(total), /cumulative_audit_incomplete/);
  }
});
test("A6 create/upgrade and live handles survive stage merging and cleanup uses cumulative state", () => {
  const total = Harness.createCumulativeAudit();
  Harness.mergeReadAudit(total, "first", { status: "ok", audit: readAudit() });
  Harness.mergeReadAudit(total, "second", { status: "upgrade_forbidden",
    audit: readAudit({ create: 1, upgrade: 2, createUpgrade: 3, openHandles: 1, readonlyOnly: false }) });
  assert.equal(total.create, 1); assert.equal(total.upgrade, 2); assert.equal(total.createUpgrade, 3);
  assert.equal(total.openHandles, 1);
  assert.equal(total.readonlyOnly, false);
  const harness = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarE3aPrewrite.js"), "utf8");
  assert.match(harness, /dbHandles: formalAudit\.openHandles/);
  assert.doesNotMatch(harness, /formalAudit: formal\?\.audit|dbHandles: formal\?\.audit/);
});

test("P1 disabled authority rejects a valid fresh ticket before core execution", async () => {
  const { report } = await accepted(), result = Boundary.requestProductionWrite({
    ticket: report.ticket, binding: report.binding });
  assert.equal(result.reason, "writer_authority_disabled");
  assert.equal(result.coreWriteExecutions, 0);
});
test("P2 wrong source rejects before a transaction", async () => {
  const { report } = await accepted();
  assert.equal(Boundary.requestProductionWrite({ ticket: report.ticket,
    binding: { ...report.binding, sourceId: "jp-stat-cpi" } }).reason, "first_source_required");
});
test("P3 arbitrary database identity is not accepted", async () => {
  const { report } = await accepted();
  assert.equal(Boundary.requestProductionWrite({ ticket: report.ticket,
    binding: { ...report.binding, databaseName: "other" } }).reason, "fixed_database_required");
  assert.equal(Boundary.requestProductionWrite({ databaseName: Boundary.DATABASE_NAME }).reason,
    "production_input_invalid");
});
test("P4 persisted E2c identities cannot mint fresh authorization", () => {
  const result = Boundary.requestProductionWrite({ ticket: {}, binding: {
    databaseName: Boundary.DATABASE_NAME, sourceId: SOURCE,
    planIdentity: "91a2957f1b4a693bb6b404411355036b37e40897f95bd790e391793765024857",
    preconditionIdentity: "683eb51ee5614f62b18964a3495c7a8abaad7bd201c5fa40cefd0d9357cd4e28" } });
  assert.equal(result.reason, "fresh_authorization_binding_mismatch");
});
test("P5 fresh authorization is bound to invocation, source, plan and precondition", async () => {
  const { report } = await accepted();
  assert.equal(Boundary.validateFreshBinding(report.ticket, report.binding).valid, true);
  for (const key of Object.keys(report.binding)) assert.equal(Boundary.validateFreshBinding(
    report.ticket, { ...report.binding, [key]: "wrong" }).valid, false);
  assert.equal(Boundary.validateFreshBinding(structuredClone(report.ticket), report.binding).valid, false);
  report.binding.planIdentity = "modified in place";
  assert.equal(Boundary.validateFreshBinding(report.ticket, report.binding).valid, false);
});
test("P6 core ceiling overflow aborts all six stores after queued writes", async () => {
  const f = await fixture(), plan = await planFor(f), { db } = await database(f.before), m = metrics();
  try {
    const excess = structuredClone(plan);
    excess.mutations.appendObservations.push({ ...excess.mutations.appendObservations[0], observationKey: "extra" });
    excess.counts.observationCreate++;
    const { planIdentity: _old, ...material } = excess;
    excess.planIdentity = await Canonical.sha256(material);
    assert.equal((await Boundary.validateFirstWritePlan(excess, f.before)).reason, "mutation_expectation_mismatch");
    const token = Core.prepareExecution(plan, f.before, { ...Boundary.MUTATION_CEILING, appendEvidence: 3 });
    const result = await Core.executePrepared(db, token, null, m);
    assert.equal(result.reason, "mutation_ceiling_exceeded");
    assert.equal(m.abortedTransactions, 1);
    assert.deepEqual(await read(db), Core.sorted(f.before));
    assert.ok(Object.values(m.committedWrites).every(value => value === 0));
  } finally { db.close(); }
});
test("P7 delete operations are rejected by boundary and shared core", async () => {
  const f = await fixture(), plan = structuredClone(await planFor(f));
  plan.mutations.deleteEntries = [];
  assert.equal((await Boundary.validateFirstWritePlan(plan, f.before)).reason, "delete_forbidden");
  assert.throws(() => Core.prepareExecution(plan, f.before), /mutation_precondition_invalid/);
});
test("P8 revision creation or transition is forbidden for first write", async () => {
  const f = await fixture(), plan = await planFor(f);
  for (const key of ["appendRevisions", "closeRevisions"]) {
    const changed = structuredClone(plan); changed.mutations[key] = [{}];
    assert.equal((await Boundary.validateFirstWritePlan(changed, f.before)).reason, "revision_mutation_forbidden");
  }
});
test("P9 exact fresh machinery plan has expected counts and safe before/after material", async () => {
  const { report } = await accepted();
  assert.equal(report.sourceSuccessCount, 12);
  assert.deepEqual(report.expectedMutationCounts, Boundary.EXPECTED_COUNTS);
  assert.equal(report.firstLiveWriteEligible, true);
  assert.deepEqual(report.expectation.beforeSafety, report.expectation.afterSafety);
  assert.equal(report.expectation.otherSourceMutation, 0);
  assert.equal(report.expectation.newEvidenceKeys.length, 4);
  assert.equal(report.expectation.newObservationKeys.length, 4);
});
test("P10 PREWRITE_ONLY has no production execution branch and keeps authority disabled", async () => {
  const { report } = await accepted();
  assert.equal(report.mode, "PREWRITE_ONLY");
  assert.equal(report.writerAuthorityState, "disabled");
  assert.equal(report.writeAllowed, false);
  assert.equal(report.coreWriteExecutions, 0);
  const source = fs.readFileSync(path.join(__dirname, "../js/marketCalendarHistory/firstProductionWriteBoundary.js"), "utf8");
  assert.doesNotMatch(source, /Core\.executePrepared\s*\(|indexedDB\.open\s*\(/);
});
test("freshness rejects old acquisition and repeated session completion", async () => {
  const f = await fixture();
  f.input.sourceResults[0].canonicalRecords[0] = { ...f.sourceResults[0].canonicalRecords[0],
    acquisitionEvidence: { ...f.sourceResults[0].canonicalRecords[0].acquisitionEvidence, fetchedAt: OLD } };
  assert.equal((await Boundary.completePrewrite(f.session, f.input)).reason, "fresh_acquisition_required");
  assert.equal((await Boundary.completePrewrite(f.session, f.input)).reason, "fresh_session_required");
});
test("Formal mutation during fresh acquisition rejects as stale", async () => {
  const f = await fixture(); f.input.endingFormalSnapshot = structuredClone(f.before);
  f.input.endingFormalSnapshot.entries[0].lastObservedAt = f.completedAt;
  assert.equal((await Boundary.completePrewrite(f.session, f.input)).reason, "stale_readonly_shadow");
});
test("changed, partial, route drift and wrong first-source count never substitute another source", async () => {
  for (const scenario of ["partial", "route", "count", "changed"]) {
    const f = await fixture(), source = f.sourceResults.find(value => value.sourceId === SOURCE);
    if (scenario === "partial") source.acquisitionOutcome = "partial";
    if (scenario === "route") source.routeIdentity = "wrong";
    if (scenario === "count") source.canonicalRecords.pop();
    if (scenario === "changed") {
      const record = structuredClone(source.canonicalRecords[0]); record.title.ja = "changed";
      record.canonicalContentHash = await Canonical.sha256(require("../js/marketCalendarHistory/historyIntegrity.js").semanticContent(record));
      record.revisionKey = `${record.eventKey}|sha256:${record.canonicalContentHash}`;
      source.canonicalRecords[0] = record;
    }
    assert.equal((await Boundary.completePrewrite(f.session, f.input)).firstLiveWriteEligible, false);
  }
});
test("shared core rejects cross-source material and forged execution contexts", async () => {
  const f = await fixture(), plan = structuredClone(await planFor(f));
  plan.mutations.appendEvidence[0].sourceId = "jp-stat-cpi";
  assert.throws(() => Core.prepareExecution(plan, f.before), /mutation_precondition_invalid/);
  const db = { transaction() { assert.fail("must reject before transaction"); } };
  assert.equal((await Core.executePrepared(db, {}, null, metrics())).reason, "execution_context_invalid");
});
test("isolated core commit and fresh reopen satisfy exact first-write readback contract", async () => {
  const f = await accepted(), plan = await planFor(f, f.report.expectation.cursorAfter.runId),
    { db, idb } = await database(f.before), m = metrics();
  let reopened;
  try {
    assert.equal(plan.planIdentity, f.report.identities.plan);
    const prepared = Core.prepareExecution(plan, f.before, Boundary.MUTATION_CEILING);
    const result = await Core.executePrepared(db, prepared, null, m);
    assert.equal(result.committed, true);
    assert.deepEqual(m.committedWrites, { entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 });
    db.close(); reopened = await request(idb.open("E3aIsolatedFixture"));
    const after = await read(reopened);
    assert.equal((await Boundary.verifyReadback(f.report.ticket, after)).valid, true);
    f.report.expectation.entries[0].lastObservedAt = "mutated output";
    assert.equal((await Boundary.verifyReadback(f.report.ticket, after)).valid, true);
    after.entries[0].lastObservedAt = "wrong";
    assert.equal((await Boundary.verifyReadback(f.report.ticket, after)).valid, false);
    assert.equal((await Core.executePrepared(reopened, prepared, null, m)).reason, "execution_context_invalid");
  } finally { db.close(); reopened?.close(); }
});
test("core transaction lifetime has zero digest calls and synchronous request-chain stale rejection", async () => {
  const f = await fixture(), plan = await planFor(f), { db } = await database(f.before), m = metrics();
  const digest = globalThis.crypto.subtle.digest; let calls = 0;
  const token = Core.prepareExecution(plan, f.before);
  try {
    globalThis.crypto.subtle.digest = function (...args) { calls++; return digest.apply(this, args); };
    assert.equal((await Core.executePrepared(db, token, null, m)).committed, true);
    assert.equal(calls, 0);
  } finally { globalThis.crypto.subtle.digest = digest; db.close(); }
});
test("shared core is reachable only through isolated/production boundaries, never startup or renderer", () => {
  for (const file of ["main.js", "preload.js", "index.html", "js/marketCalendarRuntime/calendarStartupRuntime.js",
    "js/marketCalendarRuntime/calendarManualCheckService.js"]) assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /formalControlledWriterCore|firstProductionWriteBoundary/);
  for (const file of ["formalControlledWriterCore.js", "firstProductionWriteBoundary.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../js/marketCalendarHistory", file), "utf8"),
      /require\([^)]*(?:productionHistoryWriter|existingDbControlledWriter)/);
  const harness = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarE3aPrewrite.js"), "utf8");
  assert.doesNotMatch(harness, /requestProductionWrite\s*\(|executePrepared\s*\(/);
  assert.match(harness, /explicit_prewrite_only_invocation_required/);
});
