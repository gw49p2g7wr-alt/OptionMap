"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Coordinator = require("../js/marketCalendarRuntime/calendarPartialBootstrapCoordinator.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Atomic = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const WriterCore = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const BootstrapSchema = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Acquisition = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const Existing = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const F = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const BOJ = "jp-boj-calendar", BLS = "us-bls-calendar", CPI = "jp-stat-cpi",
  CENSUS = "us-census-calendar", MOF = "jp-mof-jgb-auction-calendar";
function reader(indexedDB) {
  return async () => {
    const snapshot = await F.read(indexedDB);
    return snapshot ? { status: "ok", snapshot,
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, audit: { readwrite: 0, writes: 0 } } :
      { status: "unavailable", reason: "formal_database_absent",
        audit: { readwrite: 0, writes: 0 } };
  };
}
function runtime(options = {}) {
  const harness = options.harness || F.harness(), executor = options.executor || harness.executor,
    coordinator = Coordinator.createCalendarPartialBootstrapCoordinator({
      readFormal: reader(harness.indexedDB), executionAuthority: harness.authority, executor });
  return { ...harness, executor, coordinator };
}
function generation(values, identity) {
  return values.map(value => ({ ...structuredClone(value), generationIdentity: identity,
    ...(value.candidateEnvelope ? { candidateEnvelope: {
      ...structuredClone(value.candidateEnvelope), generationIdentity: identity } } : {}) }));
}
const run = (h, sourceResults, generationIdentity = Acquisition.GENERATION,
  acceptedAt = Acquisition.ACCEPTED_AT) => h.coordinator.processGeneration({ sourceResults,
  acceptedAt, generationIdentity });
const isolated = async (...values) => {
  const rows = Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  for (const value of values) rows[Contract.EXPECTED_SOURCE_IDS.indexOf(value.sourceId)] = value;
  return rows;
};
async function semanticChange(sourceId, kind = "date") {
  const acquisition = await Acquisition.validSource(sourceId), record =
    structuredClone(acquisition.canonicalRecords[0]), schedule = structuredClone(record.schedule);
  if (kind === "time") {
    assert.equal(schedule.kind, "instant");
    schedule.sourceLocal.startTime = "09:00";
    schedule.canonicalStart = "2026-09-11T13:00:00.000Z";
  } else if (schedule.kind === "instant") {
    schedule.sourceLocal.startDate = new Date(Date.parse(
      `${schedule.sourceLocal.startDate}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    schedule.canonicalStart = new Date(Date.parse(schedule.canonicalStart) + 86400000).toISOString();
  } else {
    schedule.sourceLocal.startDate = "2026-09-19";
  }
  record.schedule = schedule;
  record.canonicalContentHash = await Canonicalizer.sha256(Integrity.semanticContent(record));
  record.revisionKey = `${record.eventKey}|sha256:${record.canonicalContentHash}`;
  return F.SourceFixture.replaceRecords(acquisition, [record]);
}
async function evidenceChange(sourceId) {
  const acquisition = await Acquisition.validSource(sourceId), record =
    structuredClone(acquisition.canonicalRecords[0]), acquisitionEvidence = {
      ...record.acquisitionEvidence, fetchedAt: "2026-10-01T00:01:00.000Z",
      rawContentHash: "e".repeat(64) }, acquisitionEvidenceHash =
    await Canonicalizer.sha256(acquisitionEvidence);
  Object.assign(record, { source: acquisitionEvidence, acquisitionEvidence,
    acquisitionEvidenceHash,
    acquisitionEvidenceKey: `${sourceId}|sha256:${acquisitionEvidenceHash}` });
  return F.SourceFixture.replaceRecords(acquisition, [record]);
}
async function twoRecordAcquisition(sourceId) {
  const acquisition = await Acquisition.validSource(sourceId), first =
    structuredClone(acquisition.canonicalRecords[0]), second = await Existing.event(sourceId,
      Acquisition.FETCHED_AT, { sourceUrl: first.acquisitionEvidence.sourceUrl,
        referencePeriod: "2026-10-meeting" });
  return F.SourceFixture.replaceRecords(acquisition, [first, second]);
}
async function seedFromAcquisition(indexedDB, sourceId, acquisition) {
  const absent = await F.SourceFixture.absentDescriptor(), input =
    await F.SourceFixture.input(sourceId, absent, acquisition);
  input.acceptedAt = "2026-10-01T01:00:00.000Z";
  const plan = await Preparation.prepareCalendarFormalSourceMutation(input), descriptor =
    await F.SourceFixture.applyPrepared(absent, plan);
  await F.seed(indexedDB, descriptor);
  return descriptor;
}

test("V1 existing source unchanged is a semantic and transaction write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await Acquisition.validSource(BOJ))), after =
    await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.equal(result.sourceResults.find(value => value.sourceId === BOJ).status,
    "no_semantic_change");
  assert.equal(h.executor.diagnostics().readwriteTransactions, 0);
  assert.deepEqual(after, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, before[field]])));
});

test("V2-V4 valid BOJ date change appends one immutable revision and advances pointer", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await semanticChange(BOJ))), after =
    await F.read(h.indexedDB), oldKey = before.entries[0].activeRevisionKey,
    activeKey = after.entries[0].activeRevisionKey;
  assert.equal(result.writerExecution, 1);
  assert.equal(result.sourceResults.find(value => value.sourceId === BOJ).operation,
    "append_source_revision");
  assert.notEqual(activeKey, oldKey);
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.revisions.find(value => value.revisionKey === oldKey).validTo,
    Acquisition.ACCEPTED_AT);
  assert.equal(after.revisions.find(value => value.revisionKey === activeKey).validTo, null);
});

test("S1 valid BLS time change keeps event identity and appends a revision", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BLS]), h = runtime();
  await F.seed(h.indexedDB, before);
  const changed = await semanticChange(BLS, "time"), result = await run(h,
    await isolated(changed)), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.equal(after.entries[0].eventKey, before.entries[0].eventKey);
  assert.notEqual(after.entries[0].activeRevisionKey, before.entries[0].activeRevisionKey);
});

test("V5 disappeared row without explicit cancellation preserves prior history", async () => {
  const h = runtime(), two = await twoRecordAcquisition(BOJ), before =
    await seedFromAcquisition(h.indexedDB, BOJ, two), one = await Acquisition.validSource(BOJ),
    result = await run(h, await isolated(one)), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.equal(after.entries.length, 2);
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.revisions, before.revisions);
  assert(after.revisions.every(value => value.validTo === null));
});

test("V6 evidence-only refresh, including normalized-away source formatting, creates no semantic revision", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await evidenceChange(BOJ))), after =
    await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.equal(result.sourceResults.find(value => value.sourceId === BOJ).status,
    "no_semantic_change");
  assert.equal(after.revisions.length, before.revisions.length);
  assert.deepEqual(after, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, before[field]])));
});

test("V7 same generation callback and same semantic revision replay are write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime(), changed =
    await semanticChange(BOJ);
  await F.seed(h.indexedDB, before);
  assert.equal((await run(h, await isolated(changed))).writerExecution, 1);
  assert.equal((await run(h, await isolated(changed))).status, "duplicate_generation");
  const secondGeneration = "d".repeat(64), replay = generation(await isolated(changed),
    secondGeneration), restarted = runtime({ harness: F.harness(h.indexedDB) }), result =
    await run(restarted, replay, secondGeneration, "2026-10-03T00:00:00.000Z"), after =
    await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length, 2);
});

test("V8 stale acquisition generation is source-local write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime(), changed =
    await semanticChange(BOJ);
  await F.seed(h.indexedDB, before);
  changed.generationIdentity = Acquisition.STALE_GENERATION;
  const result = await run(h, await isolated(changed));
  assert.equal(result.writerExecution, 0);
  assert.equal(result.sourceResults.find(value => value.sourceId === BOJ).reason,
    "acquisition_generation_stale");
});

test("V9 stale Formal snapshot from a competing source commit is write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ, CPI]), base = F.harness();
  await F.seed(base.indexedDB, before);
  let injected = false;
  const executor = { executeCalendarFormalSourceMutation: async input => {
    if (!injected && input.plan.sourceId === BOJ) {
      injected = true;
      const stored = await F.read(base.indexedDB), descriptor =
        await F.SourceFixture.descriptor(stored), cpiPlan = await F.prepareExisting(CPI,
          descriptor, await semanticChange(CPI)), cpiGrant = await F.grant(base.authority, cpiPlan);
      assert.equal((await base.executor.executeCalendarFormalSourceMutation({ plan: cpiPlan,
        grant: cpiGrant })).status, "committed");
    }
    return base.executor.executeCalendarFormalSourceMutation(input);
  } }, h = runtime({ harness: base, executor }), result = await run(h,
    await isolated(await semanticChange(BOJ))), after = await F.read(base.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.equal(result.sourceResults.find(value => value.sourceId === BOJ).status,
    "precondition_failed");
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length, 1);
  assert.equal(after.revisions.filter(value => value.sourceId === CPI).length, 2);
});

test("V10 foreign-source event ownership collision is rejected", async () => {
  const before = await F.SourceFixture.snapshotWithSources(Contract.EXPECTED_SOURCE_IDS), h =
    runtime(), scenarios = await Acquisition.scenarios();
  await F.seed(h.indexedDB, before);
  const result = await run(h, scenarios.F10), after = await F.read(h.indexedDB), census =
    result.sourceResults.find(value => value.sourceId === CENSUS);
  assert.equal(census.status, "invalid");
  assert.equal(census.reason, "cross_source_event_key_collision");
  assert.equal(result.writerExecution, 0);
  assert.deepEqual(after, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, before[field]])));
});

test("V11 incomplete BLS four-role acquisition cannot revise Formal history", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BLS]), h = runtime(), failed =
    Acquisition.parserFailure(await semanticChange(BLS, "time"));
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(failed)), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 0);
  assert.deepEqual(after, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, before[field]])));
});

test("V12 BOJ revision is source-local and unrelated sources remain byte-equivalent", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ, CPI, BLS]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await semanticChange(BOJ))), after =
    await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  for (const field of Preparation.SNAPSHOT_FIELDS) assert.deepEqual(
    after[field].filter(value => value.sourceId !== BOJ),
    before[field].filter(value => value.sourceId !== BOJ), field);
});

test("V12a BOJ multi-document source revises one event and preserves its unrelated event", async () => {
  const h = runtime(), two = await twoRecordAcquisition(BOJ), before =
    await seedFromAcquisition(h.indexedDB, BOJ, two), record =
    structuredClone(two.canonicalRecords[0]);
  record.schedule.sourceLocal.startDate = "2026-09-19";
  record.canonicalContentHash = await Canonicalizer.sha256(Integrity.semanticContent(record));
  record.revisionKey = `${record.eventKey}|sha256:${record.canonicalContentHash}`;
  const changed = await F.SourceFixture.replaceRecords(two, [record,
    two.canonicalRecords[1]]), result = await run(h, await isolated(changed)), after =
    await F.read(h.indexedDB), untouched = two.canonicalRecords[1].eventKey;
  assert.equal(result.writerExecution, 1, JSON.stringify(result.sourceResults.find(value =>
    value.sourceId === BOJ)));
  assert.equal(after.entries.find(value => value.eventKey === untouched).activeRevisionKey,
    before.entries.find(value => value.eventKey === untouched).activeRevisionKey);
  assert.deepEqual(after.revisions.filter(value => value.eventKey === untouched),
    before.revisions.filter(value => value.eventKey === untouched));
});

test("V12b failed BOJ revision rolls back locally and later BLS revision still commits", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ, BLS]), base = F.harness();
  await F.seed(base.indexedDB, before);
  const executor = { executeCalendarFormalSourceMutation: input => input.plan.sourceId === BOJ
    ? Promise.resolve({ status: "transaction_aborted", reason: "transaction_aborted",
      committed: false, durableReceipt: null })
    : base.executor.executeCalendarFormalSourceMutation(input) }, h = runtime({ harness: base,
      executor }), result = await run(h, await isolated(await semanticChange(BOJ),
      await semanticChange(BLS, "time"))), after = await F.read(base.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.deepEqual(result.committedSourceIds, [BLS]);
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length,
    before.revisions.filter(value => value.sourceId === BOJ).length);
  assert.equal(after.revisions.filter(value => value.sourceId === BLS).length,
    before.revisions.filter(value => value.sourceId === BLS).length + 1);
});

test("V13 B5 owns MOF revision and narrow MOF writer is explicitly write0", async () => {
  const before = await F.SourceFixture.snapshotWithSources([MOF]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await semanticChange(MOF)));
  assert.equal(result.writerExecution, 1);
  assert.equal(result.ownershipBySource[MOF], "partial_bootstrap");
  const bridge = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/mofStartupPersistenceBridge.js"), "utf8");
  assert.match(bridge, /formalOwner==="partial_bootstrap"/);
  assert.match(bridge, /reason:"partial_bootstrap_owner",writerAttempts:0/);
});

test("V14 mixed missing, revision, unchanged and failed sources remain independent", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(value => value !== BLS), before =
    await F.SourceFixture.snapshotWithSources(existing), h = runtime(), rows =
    Contract.EXPECTED_SOURCE_IDS.map(Acquisition.notAttempted);
  await F.seed(h.indexedDB, before);
  rows[Contract.EXPECTED_SOURCE_IDS.indexOf(BOJ)] = await semanticChange(BOJ);
  rows[Contract.EXPECTED_SOURCE_IDS.indexOf(CPI)] = await Acquisition.validSource(CPI);
  rows[Contract.EXPECTED_SOURCE_IDS.indexOf(BLS)] = await Acquisition.validSource(BLS);
  rows[Contract.EXPECTED_SOURCE_IDS.indexOf(CENSUS)] = Acquisition.transportFailure(
    await Acquisition.validSource(CENSUS));
  const result = await run(h, rows), after = await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 2);
  assert.deepEqual(result.committedSourceIds, [BOJ, BLS]);
  assert.equal(result.sourceResults.find(value => value.sourceId === CPI).status,
    "no_semantic_change");
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length,
    before.revisions.filter(value => value.sourceId === BOJ).length + 1);
  assert.equal(after.entries.some(value => value.sourceId === BLS), true);
  assert.equal(after.revisions.filter(value => value.sourceId === CENSUS).length,
    before.revisions.filter(value => value.sourceId === CENSUS).length);
});

test("V15 crash/restart derives durable state and never duplicates committed revision", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(value => value !== BLS), before =
    await F.SourceFixture.snapshotWithSources(existing), first = runtime(), changed =
    await semanticChange(BOJ);
  await F.seed(first.indexedDB, before);
  assert.equal((await run(first, await isolated(changed))).writerExecution, 1);
  const restarted = runtime({ harness: F.harness(first.indexedDB) }), nextGeneration =
    "e".repeat(64), rows = generation(await isolated(changed,
      await Acquisition.validSource(BLS)), nextGeneration), result = await run(restarted, rows,
      nextGeneration, "2026-10-03T00:00:00.000Z"), after = await F.read(first.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.deepEqual(result.committedSourceIds, [BLS]);
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length,
    before.revisions.filter(value => value.sourceId === BOJ).length + 1);
});

test("V16 overlapping refreshes serialize and second generation sees committed revision", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime(), changed =
    await semanticChange(BOJ), nextGeneration = "f".repeat(64), second =
    generation(await isolated(changed), nextGeneration);
  await F.seed(h.indexedDB, before);
  const [first, later] = await Promise.all([run(h, await isolated(changed)),
    run(h, second, nextGeneration, "2026-10-03T00:00:00.000Z")]), after =
    await F.read(h.indexedDB);
  assert.equal(first.writerExecution, 1);
  assert.equal(later.writerExecution, 0);
  assert.equal(after.revisions.filter(value => value.sourceId === BOJ).length, 2);
  assert.equal(h.executor.diagnostics().maxConcurrentExecutions, 1);
});

test("V17 Time Travel selects old before and new after revision acceptedAt", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  await run(h, await isolated(await semanticChange(BOJ)));
  const after = await F.read(h.indexedDB), oldKey = before.entries[0].activeRevisionKey,
    newKey = after.entries[0].activeRevisionKey, oldView = await Integrity.queryAsKnownAt(after, {
      calendarDate: "2026-09-18", knowledgeAt: "2026-10-01T23:59:59.999Z" }), newView =
    await Integrity.queryAsKnownAt(after, { calendarDate: "2026-09-19",
      knowledgeAt: "2026-10-02T00:00:00.001Z" });
  assert.equal(oldView.status, "available");
  assert.equal(oldView.events[0].revision.revisionKey, oldKey);
  assert.equal(newView.status, "available");
  assert.equal(newView.events[0].revision.revisionKey, newKey);
});

test("V18 existing source revision works in a one-source partial DB", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  const result = await run(h, await isolated(await semanticChange(BOJ))), after =
    await F.read(h.indexedDB);
  assert.equal(result.writerExecution, 1);
  assert.equal(new Set(after.entries.map(value => value.sourceId)).size, 1);
  assert.equal(after.revisions.length, 2);
});

test("B5 source Run, Cursor, Evidence and Observation advance only on committed revision", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = runtime();
  await F.seed(h.indexedDB, before);
  await run(h, await isolated(await semanticChange(BOJ)));
  const after = await F.read(h.indexedDB), cursor = after.cursors.find(value =>
    value.sourceId === BOJ), latestRun = after.runs.find(value => value.runKey === cursor.runKey);
  assert.equal(after.runs.length, before.runs.length + 1);
  assert.equal(after.observations.length, before.observations.length + 1);
  assert.equal(after.evidence.length, before.evidence.length + 1);
  assert.equal(cursor.acceptedAt, Acquisition.ACCEPTED_AT);
  assert.equal(latestRun.acceptedAt, Acquisition.ACCEPTED_AT);
});

test("B5 production hidden-renderer operation verifies a durable revision receipt", async () => {
  const before = await F.SourceFixture.snapshotWithSources([BOJ]), h = F.harness();
  await F.seed(h.indexedDB, before);
  const plan = await F.prepareExisting(BOJ, before, await semanticChange(BOJ)), raw =
    await Atomic.executeAuthorizedMutationInRenderer(plan, "append_source_revision", WriterCore, {
      DATABASE_NAME: Schema.DATABASE_NAME, VERSION: Schema.VERSION,
      EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT, STORES: Schema.STORES },
    BootstrapSchema.STORE_ORDER, Canonicalizer.stable, h.indexedDB), result =
    await Atomic.finalizeAuthorizedRendererExecution(plan, "append_source_revision", raw);
  assert.equal(result.status, "committed");
  assert.equal(result.durableReceipt.verified, true);
  assert.equal(result.mutationCounts.semanticRevisionCreate, 1);
  assert.equal(result.mutationCounts.semanticRevisionClose, 1);
});

test("B5 adds no renderer writer IPC, UI mutation, or Full Export schema surface", () => {
  const root = path.join(__dirname, ".."), preload = fs.readFileSync(path.join(root,
    "preload.js"), "utf8"), html = fs.readFileSync(path.join(root, "index.html"), "utf8"),
    exportFile = fs.readFileSync(path.join(root, "js/fullExportCollector.js"), "utf8");
  for (const value of [preload, html, exportFile])
    assert.doesNotMatch(value, /append_source_revision|source-revision-write|revision-writer-ipc/i);
  assert.equal(Schema.VERSION, 1);
});
