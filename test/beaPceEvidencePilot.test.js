"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/beaPceAcquisition.js");
const Pce = require("../js/economicValues/beaPceFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Pilot = require("../js/economicValues/beaPceEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Fixture = require("./fixtures/economicValues/beaPceReleaseFixture.js");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-bea-pce-evidence-pilot-"))), indexedDB = new IDBFactory(), htmls = options.htmls ||
    [Fixture.html()], fetchedAts = options.fetchedAts || ["2026-10-29T12:31:00.000Z"];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCount = 0;
  const acquisition = Acquisition.createBeaPceAcquisition({ fetchImpl: async () => {
    const html = htmls[Math.min(fetchCount, htmls.length - 1)]; fetchCount += 1;
    return new Response(html, { status: 200,
      headers: { "content-type": "text/html; charset=utf-8" } });
  }, now: () => new Date(fetchedAts[Math.min(fetchCount - 1, fetchedAts.length - 1)]) });
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
    crashAt: options.vaultCrashAt || null }), runtime = Pilot.createPilotRuntime({ acquisition, vault,
    indexedDB, formalFaultAt: options.formalFaultAt || null });
  return { root, indexedDB, acquisition, vault, runtime, fetchCount: () => fetchCount };
}

const runInput = (patch = {}) => ({ referencePeriod: "2026-09", releaseDate: "2026-10-29",
  acceptedAt: "2026-10-29T12:32:00.000Z", calendarEventKey: null,
  acquisitionContext: "live_original_acquisition", ...patch });
const valueKey = (variant, measure, period) => `${Pce.SERIES.find(value => value.variant === variant &&
  value.measure === measure).seriesDefinitionKey}|${period}`;
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("R6-1 normal PCE release retains exact HTML and binds all six Formal facts", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.semanticWrites, result.formalTransactionCount, h.fetchCount()],
    ["committed", 6, 1, 1]);
  assert.equal(snapshot.revisions.filter(value => value.referencePeriod === "2026-09").length, 4);
  assert.equal(snapshot.revisions.length, 6);
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
  assert.equal(h.vault.readRawBytes(result.contentSha256).toString("utf8"), Fixture.html());
});

test("R6-2 restart resolves every PCE revision to its persisted release bytes", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, restarted = Vault.createIsolatedVault({ root: h.root,
      targetEnvironment: "isolated_test", crashAt: null });
  for (const revision of snapshot.revisions) {
    const resolved = Pilot.resolvePceRevision({ snapshot, vault: restarted,
      revisionKey: revision.revisionKey });
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.occurrence.occurrenceId],
      ["available", "valid", result.occurrenceId]);
  }
  assert.equal(restarted.readRawBytes(result.contentSha256).toString("utf8"), Fixture.html());
});

test("R6-3 four current series and two prior-period facts share one release occurrence", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([snapshot.definitions.length, snapshot.revisions.length, snapshot.evidence.length], [4, 6, 6]);
  assert.equal(new Set(snapshot.evidence.map(value => value.sourceEvidence.occurrenceId)).size, 1);
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
});

test("R6-4 prior-period revision resolves to the later release that caused it", async t => {
  const july = Fixture.html({ referencePeriod: "2026-07", releaseDate: "2026-08-26",
    releaseNumber: "26–39", headlineMom: "0.2", headlineYoy: "3.7", coreMom: "0.2", coreYoy: "3.3",
    priorHeadlineMom: "-0.1", priorCoreMom: "0.1", coreAlso: true }), august = Fixture.html({
    referencePeriod: "2026-08", releaseDate: "2026-09-30", releaseNumber: "26–43",
    headlineMom: "0.3", headlineYoy: "3.4", coreMom: "0.2", coreYoy: "3.0",
    priorHeadlineMom: "0.1", priorCoreMom: "0.1" }), h = fixture(t, { htmls: [july, august],
    fetchedAts: ["2026-08-26T12:31:00.000Z", "2026-09-30T12:31:00.000Z"] });
  await h.runtime.acquireAndCommit(runInput({ referencePeriod: "2026-07", releaseDate: "2026-08-26",
    acceptedAt: "2026-08-26T12:32:00.000Z" }));
  const later = await h.runtime.acquireAndCommit(runInput({ referencePeriod: "2026-08",
    releaseDate: "2026-09-30", acceptedAt: "2026-09-30T12:32:00.000Z" })), snapshot =
    (await h.runtime.readSnapshot()).snapshot, active = snapshot.revisions.find(value =>
      value.valueKey === valueKey("headline", "month_over_month", "2026-07") && value.validTo === null),
    resolved = Pilot.resolvePceRevision({ snapshot, vault: h.vault, revisionKey: active.revisionKey });
  assert.equal(active.decimalValue, "0.1");
  assert.equal(resolved.occurrence.occurrenceId, later.occurrenceId);
  assert.equal(resolved.release.referencePeriod, "2026-08");
});

test("R6-5 one later PCE release binds all current and multi-period facts to one document", async t => {
  const h = fixture(t, { htmls: [Fixture.html({ referencePeriod: "2026-08", releaseDate: "2026-09-30",
    releaseNumber: "26–43", headlineMom: "0.3", headlineYoy: "3.4", coreMom: "0.2", coreYoy: "3.0",
    priorHeadlineMom: "0.1", priorCoreMom: "0.1" })],
  fetchedAts: ["2026-09-30T12:31:00.000Z"] }), result = await h.runtime.acquireAndCommit(runInput({
    referencePeriod: "2026-08", releaseDate: "2026-09-30", acceptedAt: "2026-09-30T12:32:00.000Z" })),
    snapshot = (await h.runtime.readSnapshot()).snapshot, own = snapshot.evidence.filter(value =>
      value.sourceDocumentKey === result.sourceDocumentKey);
  assert.equal(own.length, 6);
  assert.equal(own.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
  assert.equal(snapshot.links.filter(value => value.role === "released_prior_period_revision").length, 2);
});

test("R6-6 duplicate HTML dedupes content, adds occurrence and writes Formal0", async t => {
  const html = Fixture.html(), h = fixture(t, { htmls: [html, html], fetchedAts:
    ["2026-10-29T12:31:00.000Z", "2026-10-29T13:31:00.000Z"] }), first =
    await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-29T13:32:00.000Z" }));
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount, second.semanticWrites],
    ["unchanged", "evidence_duplicate_content", 0, 0]);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  assert.equal(h.vault.occurrencesByContentSha256(first.contentSha256).length, 2);
});

test("R6-7 changed HTML with the same facts retains evidence and writes Formal0", async t => {
  const original = Fixture.html(), changed = `${original}\n<!-- official formatting change -->`, h = fixture(t, {
    htmls: [original, changed], fetchedAts:
      ["2026-10-29T12:31:00.000Z", "2026-10-29T13:31:00.000Z"] }), first =
    await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-29T13:32:00.000Z" }));
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_saved", 0]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.equal(h.vault.verifyOccurrence(second.occurrenceId).status, "valid");
});

test("R6-8 changed official value creates an immutable PCE revision and source document", async t => {
  const h = fixture(t, { htmls: [Fixture.html(), Fixture.html({ headlineMom: "0.6",
    tableCurrentHeadline: "0.6" })], fetchedAts:
      ["2026-10-29T12:31:00.000Z", "2026-10-29T13:31:00.000Z"] });
  const first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
    acceptedAt: "2026-10-29T13:32:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.semanticWrites, snapshot.documents.length], ["committed", 1, 2]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.equal(snapshot.revisions.filter(value => value.valueKey ===
    valueKey("headline", "month_over_month", "2026-09")).length, 2);
});

test("R6-9 vault publication failure blocks the complete PCE Formal transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_object_rename" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R6-10 Formal abort leaves valid orphan evidence and no PCE binding", async t => {
  const h = fixture(t, { formalFaultAt: "before_open" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "formal_write_aborted", 0]);
  assert.equal(h.vault.verifyOccurrence(result.occurrenceId).status, "valid");
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R6-11 pre-activation PCE remains valid with explicit unavailable evidence", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire({ referencePeriod: "2026-09",
    releaseDate: "2026-10-29" }), candidate = Pce.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-29T12:32:00.000Z" }), formal = Store.createFormalRuntime({ indexedDB: h.indexedDB }),
    ticket = await formal.registerAcceptedRelease(candidate); await formal.commitAcceptedRelease(ticket);
  const before = (await formal.readSnapshot()).snapshot, resolved = Pilot.resolvePceRevision({ snapshot: before,
    vault: h.vault, revisionKey: before.revisions[0].revisionKey }), after = (await formal.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R6-12 intentional PCE archive acquisition records historical_archive_fetch", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput({
    acquisitionContext: "historical_archive_fetch" }));
  assert.equal(h.vault.readOccurrence(result.occurrenceId).acquisitionContext, "historical_archive_fetch");
});

test("R6-13 official correction revision resolves to corrected release evidence", async t => {
  const h = fixture(t, { htmls: [Fixture.html(), Fixture.html({ corrected: true, headlineMom: "0.6",
    tableCurrentHeadline: "0.6" })], fetchedAts:
      ["2026-10-29T12:31:00.000Z", "2026-10-29T13:01:00.000Z"] }), initial =
    await h.runtime.acquireAndCommit(runInput()), correction = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-29T13:02:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot,
    active = snapshot.revisions.find(value => value.valueKey ===
      valueKey("headline", "month_over_month", "2026-09") && value.validTo === null), resolved =
    Pilot.resolvePceRevision({ snapshot, vault: h.vault, revisionKey: active.revisionKey });
  assert.notEqual(initial.occurrenceId, correction.occurrenceId);
  assert.equal(resolved.release.occurrenceType, "correction");
  assert.equal(resolved.occurrence.occurrenceId, correction.occurrenceId);
});

test("R6-14 release-specific BEA archive is the sole mutable-table-independent authority", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = snapshot.documents[0], occurrence =
    h.vault.readOccurrence(result.occurrenceId);
  assert.equal(occurrence.sourceUrl, Acquisition.urlFor("2026-09", "2026-10-29"));
  assert.match(document.sourceUrl, /\/news\/2026\/personal-income-and-outlays-september-2026$/);
  assert.equal(Acquisition.validateUrl("https://apps.bea.gov/iTable/?reqid=19", "2026-09", "2026-10-29"), null);
});

test("R6-15 supplemental PDF XLSX and archive URLs are metadata only, never extra evidence fetches", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, metadata = snapshot.documents[0].httpMetadata;
  assert.deepEqual([h.fetchCount(), h.vault.vaultStatus().occurrenceCount], [1, 1]);
  assert.match(metadata.releasePdfUrl, /\.pdf$/);
  assert.match(metadata.historicalComparisonsUrl, /-hist\.xlsx$/);
  assert.match(metadata.dataArchiveUrl, /^https:\/\/apps\.bea\.gov\/histdatacore\//);
  assert.equal(h.vault.readOccurrence(result.occurrenceId).requestRole, "official_release");
});

test("R6-16 tampered PCE raw object is invalid without rewriting Formal state", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), before =
    (await h.runtime.readSnapshot()).snapshot, target = objectPath(h.root, result.contentSha256), raw =
    fs.readFileSync(target); fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = Pilot.resolvePceEvidence({ snapshot: before, vault: h.vault,
    sourceDocumentKey: result.sourceDocumentKey }), after = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R6-17 PCE evidence source identity is isolated from the other three Formal sources", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire({ referencePeriod: "2026-09",
    releaseDate: "2026-10-29" }), candidate = Pce.createAcceptedCandidate({ acquisition: acquired,
    acceptedAt: "2026-10-29T12:32:00.000Z" }), evidenceInput =
    Pilot.createEvidenceInput(acquired, candidate, "live_original_acquisition");
  h.vault.storeAcceptedEvidence(evidenceInput);
  const reference = structuredClone(Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: evidenceInput.occurrence, policy: evidenceInput.policy }));
  assert.deepEqual(new Set(["us-bls-cpi-values", "us-bls-employment-values",
    "jp-statistics-bureau-cpi-values", Pce.SOURCE_ID]).size, 4);
  reference.sourceId = "us-bls-cpi-values";
  assert.throws(() => Pce.bindSourceEvidence(candidate, reference), /source_evidence_invalid/);
});

test("R6-18 PCE raw bytes and evidence references remain absent from normal exports", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), artifact = Export.create({
    appVersion: "1.1.0-beta.16", generatedAt: "2026-10-29T14:00:00.000Z",
    snapshotResult: await h.runtime.readSnapshot() }), serialized = Export.serialize(artifact);
  assert.doesNotMatch(serialized, /parserInput|rawBody|rawHtml|sourceEvidence|occurrenceId/);
  assert.equal(serialized.includes(Fixture.html()), false);
  assert.equal(fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8")
    .includes("readRawBytes"), false);
  assert.equal(fs.readFileSync(path.join(__dirname, "../js/fullExportAiSummary.js"), "utf8")
    .includes("readRawBytes"), false);
  assert.equal(h.vault.readRawBytes(result.contentSha256).byteLength > 0, true);
});
