"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Acquisition = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const Fixture = require("./fixtures/marketCalendar/partialSourcePreparationFixture.js");

const SOURCE = "jp-esri-machinery-orders-calendar", BLS = "us-bls-calendar";
const prepare = input => Preparation.prepareCalendarFormalSourceMutation(input);

test("P1 empty DB and one eligible source prepare the first-source schema plan", async () => {
  const result = await prepare(await Fixture.input(SOURCE));
  assert.equal(result.status, "ready_first_source");
  assert.equal(result.operationType, "create_schema_and_commit_first_source");
  assert.equal(result.preconditions.expectedDatabaseStatus, "absent");
  assert.equal(result.preconditions.expectedSchemaVersion, Schema.VERSION);
  assert.equal(result.preconditions.expectedSchemaFingerprint, Schema.EXPECTED_FINGERPRINT);
  assert.deepEqual(result.mutationCounts, { eventEntryCreate: 1, eventEntryUpdate: 0,
    semanticRevisionCreate: 1, semanticRevisionClose: 0, evidenceCreate: 1,
    observationCreate: 1, sourceRunCreate: 1, sourceCursorUpdate: 1 });
  assert.equal(result.writeAllowed, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.receiptExpectation.commitClaimed, false);
});

test("P2 existing partial DB with BLS absent prepares only BLS", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => sourceId !== BLS), snapshot =
    await Fixture.snapshotWithSources(existing), result = await prepare(await Fixture.input(BLS, snapshot));
  assert.equal(result.status, "ready_append_source");
  assert.equal(result.sourceId, BLS);
  for (const field of Preparation.MUTATION_KEYS) for (const value of result.mutations[field])
    if (value.sourceId !== undefined) assert.equal(value.sourceId, BLS, field);
  assert.deepEqual(result.preconditions.expectedSourceState,
    { cursor: null, runs: [], activeRevisionIdentities: [] });
});

test("P3 existing source unchanged creates no semantic revision", async () => {
  const snapshot = await Fixture.snapshotWithSources([SOURCE]), result = await prepare(
    await Fixture.input(SOURCE, snapshot));
  assert.equal(result.status, "no_semantic_change");
  assert.equal(result.mutationCounts.semanticRevisionCreate, 0);
  assert.equal(result.mutationCounts.semanticRevisionClose, 0);
  assert.equal(result.mutationCounts.sourceRunCreate, 1);
  assert.equal(result.mutationCounts.observationCreate, 1);
});

test("P4 changed existing source appends one immutable revision and closes the old revision", async () => {
  const snapshot = await Fixture.snapshotWithSources([SOURCE]), result = await prepare(
    await Fixture.input(SOURCE, snapshot, await Fixture.changedAcquisition(SOURCE)));
  assert.equal(result.status, "ready_new_revision");
  assert.equal(result.mutationCounts.semanticRevisionCreate, 1);
  assert.equal(result.mutationCounts.semanticRevisionClose, 1);
  assert.equal(result.mutations.appendRevisions[0].revisionOrigin, "authority_semantic_change");
  assert.equal(result.mutations.closeRevisions[0].validTo, Acquisition.ACCEPTED_AT);
  assert.notEqual(result.mutations.closeRevisions[0].revisionKey,
    result.mutations.appendRevisions[0].revisionKey);
});

test("P5 generation mismatch rejects before a plan is produced", async () => {
  const input = await Fixture.input(SOURCE); input.generation = Acquisition.STALE_GENERATION;
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "acquisition_generation_stale");
  assert.ok(Object.values(result.mutationCounts).every(value => value === 0));
});

test("P6 stale or mismatched snapshot fingerprint rejects", async () => {
  const input = await Fixture.input(SOURCE); input.formalSnapshot.snapshotFingerprint = "0".repeat(64);
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "snapshot_fingerprint_mismatch");
});

test("P7 cross-source eventKey collision fails closed", async () => {
  const snapshot = await Fixture.snapshotWithSources([SOURCE]), acquisition =
    await Acquisition.validSource(BLS), collisionKey = snapshot.entries[0].eventKey,
    record = structuredClone(acquisition.canonicalRecords[0]);
  record.eventKey = collisionKey;
  record.revisionKey = `${collisionKey}|sha256:${record.canonicalContentHash}`;
  const result = await prepare(await Fixture.input(BLS, snapshot,
    await Fixture.replaceRecords(acquisition, [record])));
  assert.equal(result.status, "collision");
  assert.equal(result.reason, "cross_source_event_key_collision");
});

test("P8 multi-source acquisition control input is rejected", async () => {
  const input = await Fixture.input(SOURCE);
  input.acquisition.relatedSource = { sourceId: BLS };
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "source_scope_violation");
  assert.equal(result.diagnostics.foreignSourceId, BLS);
});

test("P9 arbitrary store or mutation injection is rejected and targets remain fixed", async () => {
  const input = await Fixture.input(SOURCE);
  input.acquisition.stores = ["arbitraryStore"];
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "mutation_input_forbidden");
  assert.deepEqual(Object.keys(result.mutations).sort(), [...Preparation.MUTATION_KEYS].sort());
  assert.equal(JSON.stringify(result).includes("arbitraryStore"), false);
});

test("P10 identical inputs produce byte-equivalent deterministic plans", async () => {
  const input = await Fixture.input(SOURCE), first = await prepare(structuredClone(input)),
    second = await prepare(structuredClone(input));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.planIdentity, second.planIdentity);
});

test("P11 failed source eligibility produces no mutation plan", async () => {
  const acquisition = Acquisition.parserFailure(await Acquisition.validSource(BLS)), result =
    await prepare(await Fixture.input(BLS, await Fixture.absentDescriptor(), acquisition));
  assert.equal(result.status, "ineligible");
  assert.ok(Object.values(result.mutationCounts).every(value => value === 0));
  assert.equal(result.receiptExpectation, null);
});

test("P12 preparing the thirteenth source leaves the existing twelve byte-unchanged", async () => {
  const existing = Contract.EXPECTED_SOURCE_IDS.filter(sourceId => sourceId !== BLS), before =
    await Fixture.snapshotWithSources(existing), plan = await prepare(await Fixture.input(BLS, before)),
    after = await Fixture.applyPrepared(before, plan);
  for (const field of Preparation.SNAPSHOT_FIELDS) {
    const left = before[field].filter(value => value.sourceId !== BLS),
      right = after[field].filter(value => value.sourceId !== BLS);
    assert.deepEqual(right, left, field);
  }
});

test("P13 schema fingerprint mismatch rejects without mutation", async () => {
  const input = await Fixture.input(SOURCE);
  input.formalSnapshot.schemaFingerprint = "0".repeat(64);
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "schema_fingerprint_mismatch");
});

test("P14 stale prior-cycle candidate is rejected", async () => {
  const input = await Fixture.input(SOURCE);
  input.acquisition.generationIdentity = Acquisition.STALE_GENERATION;
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "acquisition_generation_stale");
});

test("PB2-1 committed run is deterministic already_committed write0", async () => {
  const first = await prepare(await Fixture.input(SOURCE)), snapshot = await Fixture.applyPrepared(
    await Fixture.absentDescriptor(), first), result = await prepare(await Fixture.input(SOURCE, snapshot));
  assert.equal(result.status, "already_committed");
  assert.ok(Object.values(result.mutationCounts).every(value => value === 0));
  assert.equal(result.receiptExpectation.commitClaimed, false);
});

test("PB2-2 BOJ, BLS, BEA, JPX and MOF same-source provenance groups remain eligible", async () => {
  for (const sourceId of ["jp-boj-calendar", BLS, "us-bea-calendar",
    "jp-jpx-derivatives-calendar", "jp-mof-jgb-auction-calendar"]) {
    const result = await prepare(await Fixture.input(sourceId));
    assert.equal(result.status, "ready_first_source", `${sourceId}:${result.reason}`);
    assert.deepEqual(result.diagnostics.specialGuards, Contract.SOURCES[sourceId].specialGuards);
  }
});

test("PB2-3 preparation carries exact stale-plan preconditions and bounded receipt expectation", async () => {
  const result = await prepare(await Fixture.input(SOURCE));
  assert.match(result.preconditions.formalSnapshotFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.preconditions.acquisitionGenerationIdentity, Acquisition.GENERATION);
  assert.match(result.preconditions.semanticSetIdentity, /^[0-9a-f]{64}$/);
  assert.equal(result.preconditions.authorityVersion, Preparation.AUTHORITY.version);
  assert.deepEqual(result.mutationCeiling, Object.fromEntries(Preparation.MUTATION_KEYS.map(key =>
    [key, result.mutations[key].length])));
  assert.match(result.receiptExpectation.expectedRunIdentity, /^[0-9a-f]{64}$/);
  assert.match(result.receiptExpectation.expectedCursorIdentity, /^[0-9a-f]{64}$/);
  assert.match(result.receiptExpectation.expectedSnapshotFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.receiptExpectation.commitClaimed, false);
});

test("PB2-4 source preparation remains pure and disconnected from production surfaces", () => {
  const root = path.join(__dirname, ".."), modulePath = path.join(root,
    "js/marketCalendarHistory/calendarPartialSourcePreparation.js"), source =
    fs.readFileSync(modulePath, "utf8");
  assert.doesNotMatch(source, /globalThis\.indexedDB|indexedDB\.|ipcMain\.|ipcRenderer\.|\.fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /prepareExecution|executePrepared|createBootstrapFirstSourceWriter|readwrite/);
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js", "js/fullExportCollector.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"),
      /calendarPartialSourcePreparation/, file);
  }
});

test("PB2-5 incomplete source state is not treated as a missing source", async () => {
  const snapshot = await Fixture.snapshotWithSources([SOURCE]);
  snapshot.cursors = [];
  snapshot.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(snapshot);
  const result = await prepare(await Fixture.input(BLS, snapshot));
  assert.equal(result.status, "invalid_snapshot");
  assert.equal(result.reason, "formal_snapshot_integrity_invalid");
});

test("PB2-6 acquisition acceptedAt cannot diverge from preparation acceptance", async () => {
  const input = await Fixture.input(SOURCE);
  input.acquisition.acceptedAt = "2026-10-02T00:00:01.000Z";
  const result = await prepare(input);
  assert.equal(result.status, "precondition_failed");
  assert.equal(result.reason, "accepted_at_inconsistent");
});
