"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), { IDBFactory } = require("fake-indexeddb");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Transition = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Shadow = require("../js/marketCalendarHistory/formalShadowWritePlan.js");
const Writer = require("../js/marketCalendarHistory/isolatedFormalControlledWriter.js");

const SOURCE = "jp-esri-machinery-orders-calendar", OLD = "2026-09-28T00:00:00.000Z",
  NOW = "2026-09-29T00:00:00.000Z", FETCHED = "2026-09-15T00:00:00.000Z";
let sequence = 0;
const audit = { fixtureDbCreates: 0, openCalls: 0, fixtureReadonlyTransactions: 0,
  fixtureReadwriteTransactions: 0, reopenCycles: 0 };
const writerInstances = [];
class CountingIDBFactory extends IDBFactory {
  open(...args) { audit.openCalls += 1; return super.open(...args); }
}
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error("aborted"));
});
async function event(sourceId = SOURCE, overrides = {}) {
  const source = Registry.getSource(sourceId), response = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), ...overrides, sourceId, fetchedAt: FETCHED,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64) });
  assert.equal(response.ok, true, response.reason);
  return structuredClone(response.event);
}
async function withEvidence(record, sourceUrl) {
  const acquisitionEvidence = { ...record.acquisitionEvidence, sourceUrl },
    acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
  return { ...record, source: acquisitionEvidence, acquisitionEvidence,
    acquisitionEvidenceHash,
    acquisitionEvidenceKey: `${acquisitionEvidence.sourceId}|sha256:${acquisitionEvidenceHash}` };
}
async function formal(records = [], sourceId = SOURCE) {
  if (!records.length) return empty();
  const run = { sourceId, runId: "baseline", acceptedAt: OLD, fetchedAt: [FETCHED],
    status: "accepted", semanticSetHash: await Canonicalizer.sha256(
      records.map(value => value.revisionKey).sort()) };
  const transition = Transition.planTransition({ snapshot: empty(), run, canonicalSet: records });
  assert.equal(transition.ok, true, transition.errors?.join(","));
  const mapped = Mapper.mapPlan(transition.plan);
  return { entries: mapped.appendEntries, revisions: mapped.appendRevisions,
    evidence: mapped.appendEvidence, observations: mapped.appendObservations,
    runs: mapped.appendRuns, cursors: mapped.updateCursors };
}
function fixture(initial = empty()) {
  const indexedDB = new CountingIDBFactory(), databaseName =
    `optionMapMarketCalendarE2bFixture_${++sequence}`;
  return { indexedDB, databaseName, initial };
}
async function seed(f) {
  const opening = f.indexedDB.open(f.databaseName, Schema.VERSION);
  opening.onupgradeneeded = () => { audit.fixtureDbCreates += 1;
    Bootstrap.createAndPopulate(opening.result, opening.transaction, f.initial); };
  const db = await request(opening); db.close();
}
async function read(f) {
  const db = await request(f.indexedDB.open(f.databaseName)),
    tx = db.transaction(Bootstrap.STORE_ORDER.map(([, name]) => name), "readonly"),
    finished = done(tx), values = await Promise.all(Bootstrap.STORE_ORDER.map(async ([field, name]) =>
      [field, await request(tx.objectStore(name).getAll())]));
  await finished; db.close(); audit.fixtureReadonlyTransactions += 1;
  return Object.fromEntries(values.map(([field, rows]) => [field, rows.sort((a, b) =>
    String(a[Schema.STORES[Bootstrap.STORE_ORDER.find(([f0]) => f0 === field)[1]].keyPath])
      .localeCompare(String(b[Schema.STORES[Bootstrap.STORE_ORDER.find(([f0]) => f0 === field)[1]].keyPath])))]));
}
function health(sourceId) {
  return sourceId === "us-bls-calendar" ?
    ["cpi", "ppi", "employment_situation", "jolts"].map(role =>
      ({ role, fetchOutcome: "success", parseOutcome: "success" })) :
    [{ role: "primary", fetchOutcome: "success", parseOutcome: "success" }];
}
async function plan(sourceId, records, formalSnapshot, runId = "current", outcome = "complete",
  acceptedAt = NOW) {
  const sourceResult = { sourceId, canonicalRecords: records, acquisitionOutcome: outcome,
    candidateStatus: outcome === "complete" ? "available" : outcome,
    failedRoles: outcome === "complete" ? [] : ["primary"], documentHealth: health(sourceId),
    absenceAuthority: "none" }, sourceResults = Compare.SOURCE_IDS.map(id => id === sourceId ?
    sourceResult : { sourceId: id, canonicalRecords: [], acquisitionOutcome: "not_attempted",
      candidateStatus: "unavailable", absenceAuthority: "none" });
  const comparison = await Compare.compare({ sourceResults, formalSnapshot }), run = {
    sourceId, runId, acceptedAt, fetchedAt: [FETCHED], status: "accepted",
    semanticSetHash: await Canonicalizer.sha256(records.map(value => value.revisionKey).sort()) };
  return Shadow.buildSourceShadowPlan({ sourceId, sourceResult, comparison, formalSnapshot,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, run });
}
const writer = (f, extras = {}) => {
  const instance = Writer.createIsolatedFormalControlledWriter({
    indexedDB: f.indexedDB, databaseName: f.databaseName,
    fixtureAuthority: Writer.ISOLATED_FIXTURE_AUTHORITY, ...extras });
  writerInstances.push(instance);
  return instance;
};
async function setup({ sourceId = SOURCE, old = [], next = old, runId = "current" } = {}) {
  const initial = await formal(old, sourceId), f = fixture(initial);
  await seed(f);
  return { f, plan: await plan(sourceId, next, initial, runId), before: await read(f) };
}
const zero = value => Object.values(value).every(count => count === 0);

test("W1 unchanged commits observation/run/cursor without new semantic revision", async () => {
  const old = await event(), { f, plan: p, before } = await setup({ old: [old] });
  const outcome = await writer(f).write(p), after = await read(f);
  assert.equal(outcome.outcome, "committed", outcome.reason);
  assert.equal(after.entries.length, before.entries.length);
  assert.equal(after.revisions.length, before.revisions.length);
  assert.equal(after.observations.length, before.observations.length + 1);
  assert.equal(after.runs.length, before.runs.length + 1);
  assert.equal(after.cursors.length, 1);
});
test("W2 evidence-only preserves old evidence and old revision", async () => {
  const old = await event(), next = await withEvidence(old, "https://www.esri.cao.go.jp/new-evidence"),
    { f, plan: p, before } = await setup({ old: [old], next: [next] });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.revisions.length, before.revisions.length);
  assert.equal(after.evidence.length, before.evidence.length + 1);
  assert.deepEqual(after.evidence.find(v => v.evidenceLinkKey === before.evidence[0].evidenceLinkKey),
    before.evidence[0]);
});
test("W3 new creates entry/revision/evidence/observation", async () => {
  const fresh = await event(), { f, plan: p } = await setup({ next: [fresh] });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.deepEqual([after.entries.length, after.revisions.length, after.evidence.length,
    after.observations.length, after.runs.length, after.cursors.length], [1, 1, 1, 1, 1, 1]);
  assert.equal(after.entries[0].activeRevisionKey, fresh.revisionKey);
});
test("W4 changed closes old revision and switches active pointer", async () => {
  const old = await event(), next = await event(SOURCE, { titleJa: "変更" }),
    { f, plan: p } = await setup({ old: [old], next: [next] });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.revisions.length, 2);
  assert.equal(after.revisions.find(v => v.revisionKey === old.revisionKey).validTo, NOW);
  assert.equal(after.entries[0].activeRevisionKey, next.revisionKey);
});
test("W5 Formal-only adds not_evaluated Observation without deletion", async () => {
  const old = await event(), next = await event(SOURCE, { referencePeriod: "2026-08" }),
    { f, plan: p, before } = await setup({ old: [old], next: [next] });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.equal(after.revisions.find(v => v.revisionKey === old.revisionKey).validTo, null);
  assert.equal(after.observations.find(v => v.eventKey === old.eventKey &&
    v.state === "not_evaluated")?.state, "not_evaluated");
});
for (const outcome of ["partial", "failed"]) test(`W6 ${outcome} plan is a no-op`, async () => {
  const old = await event(), { f, before } = await setup({ old: [old] }),
    p = await plan(SOURCE, [old], await formal([old]), "incomplete", outcome);
  const response = await writer(f).write(p);
  assert.equal(response.saved, false);
  assert.deepEqual(await read(f), before);
});
test("W7 stale inside transaction aborts with no partial write", async () => {
  const old = await event(), { f, plan: p } = await setup({ old: [old] });
  let externalAfter;
  const instance = writer(f, { beforeWriteTransaction: async () => {
    const db = await request(f.indexedDB.open(f.databaseName)), tx =
      db.transaction(Bootstrap.STORE_ORDER[0][1], "readwrite"), finished = done(tx);
    const store = tx.objectStore(Bootstrap.STORE_ORDER[0][1]), value = await request(store.get(old.eventKey));
    store.put({ ...value, lastObservedAt: "2026-09-28T12:00:00.000Z" });
    await finished; db.close(); audit.fixtureReadwriteTransactions += 1;
    externalAfter = await read(f);
  } });
  const response = await instance.write(p), after = await read(f);
  assert.equal(response.reason, "stale_precondition_inside_transaction");
  assert.deepEqual(after, externalAfter);
  assert.equal(instance.diagnostics().staleRejects, 1);
});
test("W8 schema mismatch rejects before readwrite", async () => {
  const old = await event(), { f, plan: p } = await setup({ old: [old] }),
    tampered = structuredClone(p); tampered.schemaFingerprint = "b".repeat(64);
  const instance = writer(f), response = await instance.write(tampered);
  assert.equal(response.saved, false);
  assert.equal(instance.diagnostics().readwriteTransactions, 0);
});
test("W9 exact duplicate Evidence is idempotent on same plan rerun", async () => {
  const old = await event(), next = await withEvidence(old, "https://www.esri.cao.go.jp/new-evidence"),
    { f, plan: p } = await setup({ old: [old], next: [next] }), instance = writer(f);
  assert.equal((await instance.write(p)).outcome, "committed");
  const after = await read(f), replay = await instance.write(p);
  assert.equal(replay.outcome, "idempotent");
  assert.deepEqual(await read(f), after);
});
test("W10 conflicting Evidence rejects", async () => {
  const old = await event(), next = await withEvidence(old, "https://www.esri.cao.go.jp/new-evidence"),
    { f, plan: p } = await setup({ old: [old], next: [next] });
  const db = await request(f.indexedDB.open(f.databaseName)), tx =
    db.transaction(Bootstrap.STORE_ORDER[2][1], "readwrite"), finished = done(tx);
  tx.objectStore(Bootstrap.STORE_ORDER[2][1]).add({ ...p.mutations.appendEvidence[0],
    acquisitionEvidenceHash: "b".repeat(64) });
  await finished; db.close(); audit.fixtureReadwriteTransactions += 1;
  const before = await read(f), response = await writer(f).write(p);
  assert.equal(response.reason, "evidence_identity_conflict");
  assert.deepEqual(await read(f), before);
});
test("W11 exact duplicate Observation is idempotent on same plan rerun", async () => {
  const old = await event(), { f, plan: p } = await setup({ old: [old] }), instance = writer(f);
  assert.equal((await instance.write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal((await instance.write(p)).outcome, "idempotent");
  assert.deepEqual(await read(f), after);
});
test("W12 conflicting Observation rejects", async () => {
  const old = await event(), { f, plan: p } = await setup({ old: [old] }),
    db = await request(f.indexedDB.open(f.databaseName)), tx =
      db.transaction(Bootstrap.STORE_ORDER[3][1], "readwrite"), finished = done(tx);
  tx.objectStore(Bootstrap.STORE_ORDER[3][1]).add({ ...p.mutations.appendObservations[0],
    state: "not_evaluated" });
  await finished; db.close(); audit.fixtureReadwriteTransactions += 1;
  const before = await read(f), response = await writer(f).write(p);
  assert.equal(response.reason, "observations_identity_conflict");
  assert.deepEqual(await read(f), before);
});
test("W13 same plan replay adds no duplicate records", async () => {
  const old = await event(), { f, plan: p } = await setup({ old: [old] }), instance = writer(f);
  assert.equal((await instance.write(p)).saved, true);
  const prior = await read(f), replay = await instance.write(p);
  assert.equal(replay.outcome, "idempotent");
  assert.equal(instance.diagnostics().committedTransactions, 1);
  assert.deepEqual(await read(f), prior);
});
test("W14 different run same semantics appends audit facts but no revision", async () => {
  const old = await event(), { f, plan: first } = await setup({ old: [old] });
  assert.equal((await writer(f).write(first)).outcome, "committed");
  const current = await read(f), second = await plan(SOURCE, [old], current, "next-run",
    "complete", "2026-09-30T00:00:00.000Z");
  assert.equal(second.planStatus, "planned", second.reason);
  assert.equal((await writer(f).write(second)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.entries.length, 1); assert.equal(after.revisions.length, 1);
  assert.equal(after.observations.length, current.observations.length + 1);
  assert.equal(after.runs.length, current.runs.length + 1);
});
for (const [number, point] of Writer.FAILURE_POINTS.entries())
  test(`W${15 + number} ${point} aborts all six stores`, async () => {
    const fresh = await event(), { f, plan: p, before } = await setup({ next: [fresh] }),
      instance = writer(f, { failureInjectionPoint: point }), response = await instance.write(p);
    assert.equal(response.outcome, "rolled_back", response.reason);
    assert.deepEqual(await read(f), before);
    assert.equal(instance.diagnostics().failureInjectionAborts, 1);
    assert.equal(instance.diagnostics().committedTransactions, 0);
  });
for (const [label, ms] of [["W21 1 macrotask", 0], ["W21b", 5], ["W22", 100]])
  test(`${label} pre-transaction delay ${ms}ms does not lose transaction`, async () => {
    const fresh = await event(), { f, plan: p } = await setup({ next: [fresh] }),
      instance = writer(f, { beforeWriteTransaction: async () => {
        await new Promise(resolve => setTimeout(resolve, ms)); } });
    assert.equal((await instance.write(p)).outcome, "committed");
    assert.equal(instance.diagnostics().committedTransactions, 1);
  });
test("W23 machinery-orders first source updates four observed entries only", async () => {
  const records = await Promise.all(["2026-05", "2026-06", "2026-07", "2026-08"]
    .map(referencePeriod => event(SOURCE, { referencePeriod })));
  const { f, plan: p, before } = await setup({ old: records });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.entries.length, before.entries.length);
  assert.equal(after.revisions.length, before.revisions.length);
  assert.equal(after.observations.length, before.observations.length + 4);
});
for (const [number, sourceId] of [[24, "jp-stat-cpi"], [25, "jp-stat-labor"]])
  test(`W${number} ${sourceId} evidence-only`, async () => {
    const old = await event(sourceId), next = await withEvidence(old,
      `https://www.e-stat.go.jp/release-calendar/${sourceId}`),
      { f, plan: p, before } = await setup({ sourceId, old: [old], next: [next] });
    assert.equal((await writer(f).write(p)).outcome, "committed");
    const after = await read(f);
    assert.equal(after.entries.length, before.entries.length);
    assert.equal(after.revisions.length, before.revisions.length);
    assert.equal(after.evidence.length, before.evidence.length + 1);
  });
test("W26 BLS overlap five plus new 47 retains one SourceRun", async () => {
  const records = await Promise.all(Array.from({ length: 52 }, (_, i) =>
    event("us-bls-calendar", { referencePeriod: new Date(Date.UTC(2027, i, 1))
      .toISOString().slice(0, 7) })));
  const { f, plan: p, before } = await setup({ sourceId: "us-bls-calendar",
    old: records.slice(0, 5), next: records });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const after = await read(f);
  assert.equal(after.entries.length, before.entries.length + 47);
  assert.equal(after.revisions.length, before.revisions.length + 47);
  assert.equal(after.runs.length, before.runs.length + 1);
  assert.equal(new Set(after.entries.map(v => v.activeRevisionKey)).size, after.entries.length);
});
test("W27 BOJ remains writer-ineligible", async () => {
  const old = await event("jp-boj-calendar"), { f, before } = await setup({
    sourceId: "jp-boj-calendar", old: [old] }), p = await plan("jp-boj-calendar", [old],
      await formal([old], "jp-boj-calendar"));
  assert.equal(p.planStatus, "skipped");
  assert.equal((await writer(f).write(p)).saved, false);
  assert.deepEqual(await read(f), before);
});
test("W28 close/reopen preserves active set, linkage, run and cursor", async () => {
  const fresh = await event(), { f, plan: p } = await setup({ next: [fresh] });
  assert.equal((await writer(f).write(p)).outcome, "committed");
  const reopened = await read(f); audit.reopenCycles += 1;
  assert.equal(reopened.entries[0].activeRevisionKey, reopened.revisions[0].revisionKey);
  assert.equal(reopened.evidence[0].revisionKey, reopened.revisions[0].revisionKey);
  assert.equal(reopened.observations[0].runId, reopened.runs[0].runId);
  assert.equal(reopened.cursors[0].runKey, reopened.runs[0].runKey);
});
test("authority, unknown source and malformed identity fail closed without DB access", async () => {
  const fresh = await event(), { f, plan: p } = await setup({ next: [fresh] });
  assert.throws(() => Writer.createIsolatedFormalControlledWriter({ indexedDB: f.indexedDB,
    databaseName: Schema.DATABASE_NAME, fixtureAuthority: Writer.ISOLATED_FIXTURE_AUTHORITY }));
  assert.throws(() => Writer.createIsolatedFormalControlledWriter({ indexedDB: f.indexedDB,
    databaseName: f.databaseName, fixtureAuthority: {} }));
  const instance = writer(f), malformed = structuredClone(p);
  malformed.planIdentity = "b".repeat(64);
  assert.equal((await instance.write(malformed)).saved, false);
  assert.equal((await instance.write({ ...p, sourceId: "unknown" })).saved, false);
  assert.equal(instance.diagnostics().opens, 0);
});
test("absent isolated DB and actual schema mismatch never create or start readwrite", async () => {
  const fresh = await event(), { plan: p } = await setup({ next: [fresh] });
  const absent = fixture(), missingWriter = writer(absent);
  assert.equal((await missingWriter.write(p)).reason, "database_absent");
  assert.deepEqual(await absent.indexedDB.databases(), []);
  const malformed = fixture(), opening = malformed.indexedDB.open(malformed.databaseName, 1);
  opening.onupgradeneeded = () => {
    for (const [name, definition] of Object.entries(Schema.STORES)) {
      const store = opening.result.createObjectStore(name, { keyPath: definition.keyPath });
      for (const [indexName, keyPath, unique] of definition.indexes.slice(1))
        store.createIndex(indexName, keyPath, { unique });
    }
  };
  (await request(opening)).close(); audit.fixtureDbCreates += 1;
  const schemaWriter = writer(malformed);
  assert.equal((await schemaWriter.write(p)).reason, "schema_mismatch");
  assert.equal(schemaWriter.diagnostics().readwriteTransactions, 0);
});
test("cross-source mutation linkage and unknown failure checkpoint fail closed", async () => {
  const fresh = await event(), { f, plan: p } = await setup({ next: [fresh] }),
    altered = structuredClone(p);
  altered.mutations.appendEvidence[0].sourceId = "jp-stat-cpi";
  const { planIdentity: _oldIdentity, ...body } = altered;
  altered.planIdentity = await Canonicalizer.sha256(body);
  const instance = writer(f), before = await read(f);
  assert.equal((await instance.write(altered)).reason, "plan_invalid");
  const missing = structuredClone(p);
  missing.mutations.appendEvidence[0].revisionKey = "missing-revision";
  const { planIdentity: _unused, ...missingBody } = missing;
  missing.planIdentity = await Canonicalizer.sha256(missingBody);
  assert.equal((await instance.write(missing)).reason, "mutation_precondition_invalid");
  assert.deepEqual(await read(f), before);
  assert.throws(() => writer(f, { failureInjectionPoint: "unknown" }));
});
test("production entry points do not import isolated writer; transaction has no await or digest", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarHistory/isolatedFormalControlledWriter.js"), "utf8"),
    transaction = source.slice(source.indexOf("function transact("),
      source.indexOf("function createIsolatedFormalControlledWriter("));
  assert.doesNotMatch(transaction, /\bawait\b|\.digest\s*\(|\.sha256\s*\(|setTimeout\s*\(/);
  assert.doesNotMatch(source, /require\([^)]*(?:productionHistoryWriter|existingDbControlledWriter)/);
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarStartupRuntime.js",
    "js/marketCalendarRuntime/calendarManualCheckService.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /isolatedFormalControlledWriter/);
});
test.after(() => {
  const total = { ...audit, writer: { opens: 0, readonlyTransactions: 0,
    readwriteTransactions: 0, committedTransactions: 0, abortedTransactions: 0,
    staleRejects: 0, failureInjectionAborts: 0, committedWrites: {
      entries: 0, revisions: 0, evidence: 0, observations: 0, runs: 0, cursors: 0 },
    finalOpenHandles: 0 } };
  for (const instance of writerInstances) {
    const value = instance.diagnostics();
    for (const key of ["opens", "readonlyTransactions", "readwriteTransactions",
      "committedTransactions", "abortedTransactions", "staleRejects", "failureInjectionAborts"])
      total.writer[key] += value[key];
    total.writer.finalOpenHandles += value.openHandles;
    for (const field of Object.keys(total.writer.committedWrites))
      total.writer.committedWrites[field] += value.committedWrites[field];
  }
  console.log(`E2B_AUDIT ${JSON.stringify(total)}`);
});
