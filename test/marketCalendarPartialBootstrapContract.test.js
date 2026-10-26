"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const WriterAuthority = require("../js/marketCalendarHistory/formalWriterAuthority.js");
const Bootstrap = require("../js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Coverage = require("../js/marketCalendarHistory/calendarPartialCoverage.js");
const Fixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");

const EXPECTED = [
  "jp-boj-calendar", "jp-esri-machinery-orders-calendar", "jp-esri-sna-calendar",
  "jp-jpx-derivatives-calendar", "jp-jpx-market-holidays", "jp-mof-jgb-auction-calendar",
  "jp-stat-cpi", "jp-stat-labor", "us-bea-calendar", "us-bls-calendar",
  "us-census-calendar", "us-fed-fomc-calendar", "us-nyse-market-holidays"
];
const input = sources => ({ sourceResults: sources, acceptedAt: Fixture.ACCEPTED_AT,
  generationIdentity: Fixture.GENERATION });
const resultFor = (result, sourceId) => result.results.find(value => value.sourceId === sourceId);
async function rehashEvidence(record, patch) {
  const acquisitionEvidence = { ...record.acquisitionEvidence, ...patch },
    acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
  return { ...record, source: acquisitionEvidence, acquisitionEvidence,
    acquisitionEvidenceHash,
    acquisitionEvidenceKey: `${acquisitionEvidence.sourceId}|sha256:${acquisitionEvidenceHash}` };
}

test("PB1 source-set v2 has exact identity, membership and deterministic registry order", () => {
  assert.equal(Contract.SOURCE_SET_ID, "calendar-source-set-v2");
  assert.equal(Contract.SOURCE_SET_VERSION, 2);
  assert.deepEqual(Contract.EXPECTED_SOURCE_IDS, EXPECTED);
  assert.deepEqual(Contract.SOURCE_SET.sourceIds, EXPECTED);
  assert.deepEqual(Contract.EXPECTED_SOURCE_IDS, Registry.getSourceSet(2).sourceIds);
  assert.equal(new Set(Contract.EXPECTED_SOURCE_IDS).size, 13);
  assert.equal(Object.isFrozen(Contract.SOURCE_SET), true);
});

test("PB2 all 13 independence declarations are explicit and Formal eligible", () => {
  for (const sourceId of EXPECTED) {
    const source = Contract.SOURCES[sourceId];
    assert.equal(source.independent, true, sourceId);
    assert.deepEqual(source.crossSourceDependencies, [], sourceId);
    assert.equal(source.formalEligible, true, sourceId);
    assert.equal(source.sameSourceDocumentGroup.atomic, true, sourceId);
  }
});

test("PB3 same-source atomic document groups and special guards remain exact", () => {
  assert.deepEqual(Contract.SOURCES["jp-boj-calendar"].sameSourceDocumentGroup.requiredRoles,
    ["primary", "speeches", "tankan", "meeting_publications"]);
  assert.deepEqual(Contract.SOURCES["us-bls-calendar"].sameSourceDocumentGroup.requiredRoles,
    ["cpi", "ppi", "employment_situation", "jolts"]);
  assert.deepEqual(Contract.SOURCES["us-bea-calendar"].sameSourceDocumentGroup.requiredRoles,
    ["scheduleAuthority", "releaseSemantics"]);
  assert.deepEqual(Contract.SOURCES["jp-jpx-derivatives-calendar"]
    .sameSourceDocumentGroup.requiredRoles, ["landing", "workbook"]);
  assert.equal(Contract.SOURCES["jp-mof-jgb-auction-calendar"]
    .sameSourceDocumentGroup.mode, "index_plus_discovered");
  for (const sourceId of ["jp-boj-calendar", "us-bls-calendar", "jp-mof-jgb-auction-calendar",
    "jp-jpx-derivatives-calendar", "jp-jpx-market-holidays", "us-fed-fomc-calendar"])
    assert.ok(Contract.SOURCES[sourceId].specialGuards.length > 0, sourceId);
});

test("F1 13/13 success yields 13 independently eligible sources", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F1));
  assert.deepEqual(result.eligibleSources, EXPECTED);
  assert.deepEqual(result.failedSources, []);
  assert.deepEqual(result.notAttemptedSources, []);
  assert.deepEqual(result.invalidSources, []);
  assert.equal(result.fullCoverageCandidate, true);
});

test("F2 BLS parser failure is isolated from the other 12 sources", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F2));
  assert.deepEqual(result.failedSources, ["us-bls-calendar"]);
  assert.equal(result.eligibleSources.length, 12);
  assert.equal(result.invalidSources.length, 0);
  assert.ok(resultFor(result, "us-bls-calendar").failedChecks.includes("structure_guard_pass"));
});

test("F3 one transport failure leaves unrelated sources eligible", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F3));
  assert.deepEqual(result.failedSources, ["us-bea-calendar"]);
  assert.equal(result.eligibleSources.length, 12);
  assert.ok(resultFor(result, "us-bea-calendar").failedChecks.includes("document_transport_success"));
});

test("F4 1/13 success remains independently eligible and 12 are explicit not-attempted", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F4));
  assert.equal(result.eligibleSources.length, 1);
  assert.equal(result.notAttemptedSources.length, 12);
  assert.deepEqual(result.failedSources, []);
  assert.deepEqual(result.invalidSources, []);
});

test("F5 all failures produce no eligible or fake Formal candidate", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F5));
  assert.equal(result.eligibleSources.length, 0);
  assert.equal(result.failedSources.length, 13);
  assert.equal(result.fullCoverageCandidate, false);
});

test("F6 incomplete same-source document group rejects only that source", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F6));
  assert.deepEqual(result.failedSources, ["jp-jpx-derivatives-calendar"]);
  assert.equal(result.eligibleSources.length, 12);
  assert.ok(resultFor(result, "jp-jpx-derivatives-calendar").failedChecks
    .includes("required_document_roles_complete"));
});

test("F7 ambiguity is fail-closed and source-local", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F7));
  assert.deepEqual(result.invalidSources, ["us-fed-fomc-calendar"]);
  assert.equal(result.eligibleSources.length, 12);
  assert.ok(resultFor(result, "us-fed-fomc-calendar").failedChecks.includes("ambiguity_zero"));
});

test("F8 stale prior generation is rejected without invalidating fresh sources", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F8));
  assert.deepEqual(result.invalidSources, ["jp-jpx-market-holidays"]);
  assert.equal(result.eligibleSources.length, 12);
  assert.equal(resultFor(result, "jp-jpx-market-holidays").reason, "acquisition_generation_stale");
});

test("F9 identical same-source duplicate is deterministically rejected without cross-source effect", async () => {
  const f = await Fixture.scenarios(), one = await Contract.evaluateAcquisitionGeneration(input(f.F9)),
    two = await Contract.evaluateAcquisitionGeneration(input(structuredClone(f.F9)));
  assert.deepEqual(one, two);
  assert.deepEqual(one.invalidSources, ["us-census-calendar"]);
  assert.equal(one.eligibleSources.length, 12);
  assert.ok(resultFor(one, "us-census-calendar").failedChecks.includes("duplicates_zero"));
});

test("F10 cross-source eventKey collision rejects both owners and never merges identities", async () => {
  const f = await Fixture.scenarios(), result = await Contract.evaluateAcquisitionGeneration(input(f.F10));
  assert.deepEqual(result.invalidSources, ["jp-esri-sna-calendar", "us-census-calendar"]);
  assert.equal(result.eligibleSources.length, 11);
  for (const sourceId of result.invalidSources)
    assert.equal(resultFor(result, sourceId).reason, "cross_source_event_key_collision");
});

test("PB4 duplicate and malformed acquisition envelopes cannot produce full coverage", async () => {
  const values = await Fixture.allSuccess(), duplicated = [...values, structuredClone(values[0])],
    duplicateResult = await Contract.evaluateAcquisitionGeneration(input(duplicated));
  assert.equal(duplicateResult.fullCoverageCandidate, false);
  assert.ok(duplicateResult.invalidSources.includes(values[0].sourceId));
  assert.equal(resultFor(duplicateResult, values[0].sourceId).reason, "duplicate_source_outcome");
  const malformedResult = await Contract.evaluateAcquisitionGeneration(input([...values, null]));
  assert.equal(malformedResult.fullCoverageCandidate, false);
  assert.deepEqual(malformedResult.inputErrors, ["source_result_invalid"]);
});

test("PB5 source evaluator rejects every fail-closed contract boundary", async () => {
  const base = await Fixture.validSource("us-fed-fomc-calendar"), cases = [
    ["route", value => { value.routeIdentity = "0".repeat(64); }, "production_route_identity"],
    ["generation", value => { value.generationIdentity = Fixture.STALE_GENERATION; }, "acquisition_generation_current"],
    ["roles", value => { value.documentHealth = []; }, "required_document_roles_complete"],
    ["transport", value => { value.documentHealth[0].fetchOutcome = "failure"; }, "document_transport_success"],
    ["parser", value => { value.parserStatus = "failure"; }, "parser_success"],
    ["structure", value => { value.structureGuardStatus = "failed"; }, "structure_guard_pass"],
    ["availability", value => { value.candidateStatus = "unavailable"; }, "candidate_available"],
    ["canonicalization", value => { value.canonicalizationStatus = "failure"; }, "canonicalization_success"],
    ["empty", value => { value.canonicalRecords = []; }, "non_empty_canonical_records"],
    ["failed role", value => { value.failedRoles = ["primary"]; }, "failed_roles_zero"],
    ["ambiguity", value => { value.ambiguityCount = 1; }, "ambiguity_zero"],
    ["collision state", value => { value.identityCollisionCount = 1; }, "identity_collisions_zero"],
    ["candidate identity", value => { value.candidateIdentity = "invalid"; }, "candidate_identity_valid"],
    ["canonical identity", value => { value.canonicalRecords[0].canonicalContentHash = "0".repeat(64); }, "canonical_identities_valid"],
    ["revision key", value => { value.canonicalRecords[0].revisionKey = "invalid"; }, "revision_keys_valid"],
    ["evidence hash", value => { value.canonicalRecords[0].acquisitionEvidenceHash = "0".repeat(64); }, "evidence_hashes_valid"],
    ["provenance", value => { delete value.canonicalRecords[0].acquisitionEvidence.parserId; }, "required_provenance_present"]
  ];
  for (const [label, mutate, check] of cases) {
    const value = structuredClone(base); mutate(value);
    const result = await Contract.evaluateSourceEligibility({ sourceResult: value,
      acceptedAt: Fixture.ACCEPTED_AT, generationIdentity: Fixture.GENERATION });
    assert.equal(result.eligible, false, label);
    assert.ok(result.failedChecks.includes(check), `${label}:${result.failedChecks.join(",")}`);
  }
  const insecure = structuredClone(base);
  insecure.canonicalRecords[0] = await rehashEvidence(insecure.canonicalRecords[0],
    { sourceUrl: "http://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" });
  let result = await Contract.evaluateSourceEligibility({ sourceResult: insecure,
    acceptedAt: Fixture.ACCEPTED_AT, generationIdentity: Fixture.GENERATION });
  assert.ok(result.failedChecks.includes("https_security_valid"));
  const invalidDate = structuredClone(base);
  invalidDate.canonicalRecords[0] = await rehashEvidence(invalidDate.canonicalRecords[0],
    { fetchedAt: "not-a-date" });
  result = await Contract.evaluateSourceEligibility({ sourceResult: invalidDate,
    acceptedAt: Fixture.ACCEPTED_AT, generationIdentity: Fixture.GENERATION });
  assert.ok(result.failedChecks.includes("fetched_at_valid"));
  const future = structuredClone(base);
  future.canonicalRecords[0] = await rehashEvidence(future.canonicalRecords[0],
    { fetchedAt: "2026-10-03T00:00:00.000Z" });
  result = await Contract.evaluateSourceEligibility({ sourceResult: future,
    acceptedAt: Fixture.ACCEPTED_AT, generationIdentity: Fixture.GENERATION });
  assert.ok(result.failedChecks.includes("fetched_at_not_future"));
});

test("PB6 special BOJ, BLS, MOF, JPX and FOMC candidates retain route and group guards", async () => {
  for (const sourceId of ["jp-boj-calendar", "us-bls-calendar", "jp-mof-jgb-auction-calendar",
    "jp-jpx-derivatives-calendar", "jp-jpx-market-holidays", "us-fed-fomc-calendar"]) {
    const result = await Contract.evaluateSourceEligibility({ sourceResult: await Fixture.validSource(sourceId),
      acceptedAt: Fixture.ACCEPTED_AT, generationIdentity: Fixture.GENERATION });
    assert.equal(result.eligible, true, `${sourceId}:${result.reason}`);
    assert.deepEqual(result.diagnostics.specialGuards, Contract.SOURCES[sourceId].specialGuards);
  }
});

test("PB7 partial coverage projection keeps Formal and Runtime State authorities separate", () => {
  const persisted = EXPECTED.filter(sourceId => sourceId !== "us-bls-calendar"),
    projection = Coverage.projectPartialCoverage({ formalSnapshot: Fixture.formalSnapshot(persisted),
      runtimeStates: [{ sourceId: "us-bls-calendar", lastOutcome: "failure",
        lastDiagnosticClass: "parser_structure_change", lastAttemptAt: Fixture.ACCEPTED_AT }] }),
    bls = projection.sources.find(value => value.sourceId === "us-bls-calendar");
  assert.equal(projection.coverageCount, 12);
  assert.equal(projection.expectedCount, 13);
  assert.equal(projection.completeness, "partial");
  assert.equal(projection.formalAvailability, "available");
  assert.deepEqual(projection.absentSourceIds, ["us-bls-calendar"]);
  assert.equal(bls.formalState, "formal_absent");
  assert.equal(bls.formal.authority, "formal_history");
  assert.equal(bls.runtimeState, "runtime_failed");
  assert.equal(bls.runtime.authority, "runtime_state");
  assert.equal(bls.runtime.reason, "parser_structure_change");
});

test("PB8 coverage projection is deterministic for full, absent and invalid states", () => {
  const fullSnapshot = Fixture.formalSnapshot(EXPECTED), full = Coverage.projectPartialCoverage({
    formalSnapshot: fullSnapshot, runtimeStates: [...EXPECTED].reverse().map(sourceId =>
      ({ sourceId, lastOutcome: "success", lastAttemptAt: Fixture.ACCEPTED_AT })) }),
    reordered = Coverage.projectPartialCoverage({ formalSnapshot: Object.fromEntries(Object.entries(
      fullSnapshot).map(([key, values]) => [key, [...values].reverse()])), runtimeStates: EXPECTED.map(sourceId =>
      ({ sourceId, lastOutcome: "success", lastAttemptAt: Fixture.ACCEPTED_AT })) });
  assert.deepEqual(full, reordered);
  assert.equal(full.completeness, "complete");
  assert.equal(full.coverageCount, 13);
  const absent = Coverage.projectPartialCoverage({ formalSnapshot: Fixture.formalSnapshot([]),
    runtimeStates: EXPECTED.map(sourceId => ({ sourceId, acquisitionStatus: "not_attempted" })) });
  assert.equal(absent.completeness, "none");
  assert.equal(absent.formalAvailability, "absent");
  assert.equal(absent.sources.every(value => value.runtimeState === "runtime_not_attempted"), true);
  const broken = Fixture.formalSnapshot([EXPECTED[0]]); broken.runs = [];
  const invalid = Coverage.projectPartialCoverage({ formalSnapshot: broken });
  assert.equal(invalid.completeness, "invalid");
  assert.deepEqual(invalid.invalidSourceIds, [EXPECTED[0]]);
  assert.deepEqual(Coverage.STATES, ["formal_present", "formal_absent", "formal_invalid",
    "runtime_success", "runtime_failed", "runtime_not_attempted", "runtime_unknown"]);
});

test("PB9 schema v1, production writer authority and exact13 bootstrap remain unchanged", async () => {
  assert.equal(Schema.DATABASE_NAME, "optionMapMarketCalendarHistory");
  assert.equal(Schema.VERSION, 1);
  assert.equal(Schema.EXPECTED_FINGERPRINT,
    "85248c8ec61ad4b554d77ee38e96088bc9b7fc0c3fc885e3af5332e7e02c2cbc");
  assert.equal(WriterAuthority.PRODUCTION_AUTHORITY.entries.every(value => value.state === "disabled"), true);
  const incomplete = Contract.EXPECTED_SOURCE_IDS.slice(0, 12).map(sourceId => ({ sourceId })),
    result = await Bootstrap.prepare({ sourceResults: incomplete, checkedAt: Fixture.ACCEPTED_AT });
  assert.deepEqual(result, { status: "rejected", reason: "bootstrap_source_set_incomplete" });
  assert.equal(Bootstrap.SOURCE_IDS.length, 13);
});

test("PB10 contract layer has no DB/writer/IPC and is not wired to bootstrap, UI or exports", () => {
  const root = path.join(__dirname, ".."), contractSource = fs.readFileSync(path.join(root,
    "js/marketCalendarHistory/calendarPartialBootstrapContract.js"), "utf8"), coverageSource =
    fs.readFileSync(path.join(root, "js/marketCalendarHistory/calendarPartialCoverage.js"), "utf8");
  for (const source of [contractSource, coverageSource]) {
    assert.doesNotMatch(source, /indexedDB|ipcMain|ipcRenderer|executeBootstrap|readwrite/);
    assert.doesNotMatch(source, /require\([^)]*(?:Writer|Executor|main\.js|preload\.js)/i);
  }
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js", "js/marketCalendarMvp.js",
    "js/fullExportCollector.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /calendarPartialBootstrapContract|calendarPartialCoverage/, file);
  }
});
