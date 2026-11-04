"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/blsEmploymentAcquisition.js");
const Employment = require("../js/economicValues/blsEmploymentFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Pilot = require("../js/economicValues/blsEmploymentEvidencePilot.js");
const CpiAcquisition = require("../js/economicValues/blsCpiAcquisition.js");
const CpiPilot = require("../js/economicValues/blsCpiEvidencePilot.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Fixture = require("./fixtures/economicValues/blsEmploymentReleaseFixture.js");
const CpiFixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-employment-evidence-pilot-"))), indexedDB = new IDBFactory(), htmls = options.htmls ||
    [Fixture.html()], fetchedAts = options.fetchedAts || ["2026-10-02T12:31:00.000Z"];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCount = 0;
  const acquisition = Acquisition.createBlsEmploymentAcquisition({ fetchImpl: async () => {
    const html = htmls[Math.min(fetchCount, htmls.length - 1)]; fetchCount += 1;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, now: () => new Date(fetchedAts[Math.min(fetchCount - 1, fetchedAts.length - 1)]) });
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
    crashAt: options.vaultCrashAt || null }), runtime = Pilot.createPilotRuntime({ acquisition, vault,
    indexedDB, formalFaultAt: options.formalFaultAt || null });
  return { root, indexedDB, acquisition, vault, runtime, fetchCount: () => fetchCount };
}

const runInput = (patch = {}) => ({ releaseDate: "2026-10-02",
  acceptedAt: "2026-10-02T12:32:00.000Z", calendarEventKey: null,
  acquisitionContext: "live_original_acquisition", ...patch });
const payrollKey = period => `${Employment.SERIES[0].seriesDefinitionKey}|${period}`;
const unemploymentKey = period => `${Employment.SERIES[1].seriesDefinitionKey}|${period}`;
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("R4-1 normal Employment release saves one raw occurrence for both current values", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = snapshot.documents[0];
  assert.deepEqual([result.status, result.semanticWrites, result.formalTransactionCount, h.fetchCount()],
    ["committed", 2, 1, 1]);
  assert.equal(document.sourceEvidence.occurrenceId, result.occurrenceId);
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
});

test("R4-2 current and one prior payroll revision share the same release evidence", async t => {
  const html = Fixture.html({ revisions: [{ month: "AUGUST", from: "+162,000", to: "+133,000" }] }),
    h = fixture(t, { htmls: [html] }), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.equal(snapshot.revisions.length, 3);
  assert.equal(new Set(snapshot.evidence.map(value => value.sourceEvidence.occurrenceId)).size, 1);
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
});

test("R4-3 two prior payroll revisions and both current values share one source document", async t => {
  const html = Fixture.html({ revisions: [
    { month: "JULY", from: "+21,000", to: "-10,000" },
    { month: "AUGUST", from: "+162,000", to: "+133,000" }
  ] }), h = fixture(t, { htmls: [html] }), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([snapshot.revisions.length, snapshot.links.length, snapshot.evidence.length], [4, 4, 4]);
  assert.equal(snapshot.evidence.every(value => value.sourceDocumentKey === result.sourceDocumentKey), true);
  assert.equal(snapshot.links.filter(value => value.role === "released_prior_period_revision").length, 2);
});

test("R4-4 restart resolves every multi-period revision to the persisted raw occurrence", async t => {
  const html = Fixture.html({ revisions: [
    { month: "JULY", from: "+21,000", to: "-10,000" },
    { month: "AUGUST", from: "+162,000", to: "+133,000" }
  ] }), h = fixture(t, { htmls: [html] }), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, restarted = Vault.createIsolatedVault({ root: h.root,
      targetEnvironment: "isolated_test", crashAt: null });
  for (const revision of snapshot.revisions) {
    const resolved = Pilot.resolveEmploymentRevision({ snapshot, vault: restarted,
      revisionKey: revision.revisionKey });
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.occurrence.occurrenceId],
      ["available", "valid", result.occurrenceId]);
  }
  assert.equal(restarted.readRawBytes(result.contentSha256).toString("utf8"), html);
});

test("R4-5 duplicate raw acquisition dedupes content, adds occurrence and performs Formal write0", async t => {
  const html = Fixture.html(), h = fixture(t, { htmls: [html, html], fetchedAts:
    ["2026-10-02T12:31:00.000Z", "2026-10-02T13:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-02T13:32:00.000Z" }));
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount, second.semanticWrites],
    ["unchanged", "evidence_duplicate_content", 0, 0]);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  assert.equal(h.vault.occurrencesByContentSha256(first.contentSha256).length, 2);
});

test("R4-6 changed raw with same facts retains evidence and performs Formal write0", async t => {
  const firstHtml = Fixture.html(), changed = `${firstHtml}\n<!-- official formatting change -->`,
    h = fixture(t, { htmls: [firstHtml, changed], fetchedAts:
      ["2026-10-02T12:31:00.000Z", "2026-10-02T13:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-02T13:32:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_saved", 0]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.deepEqual([snapshot.documents.length, snapshot.runs.length], [1, 1]);
  assert.equal(h.vault.verifyOccurrence(second.occurrenceId).status, "valid");
});

test("R4-7 changed raw and changed facts append immutable revisions", async t => {
  const h = fixture(t, { htmls: [Fixture.html(), Fixture.html({ payroll: "+35,000",
    unemployment: "4.3" })], fetchedAts:
      ["2026-10-02T12:31:00.000Z", "2026-10-02T13:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-02T13:32:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.semanticWrites, second.formalTransactionCount], ["committed", 2, 1]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.deepEqual([snapshot.releases.length, snapshot.documents.length, snapshot.revisions.length], [1, 2, 4]);
});

test("same raw bytes and parser identity cannot produce different canonical revisions", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire({ releaseDate: "2026-10-02" }), candidate =
    Employment.createAcceptedCandidate({ acquisition: acquired, acceptedAt: "2026-10-02T12:32:00.000Z" }),
    snapshot = { documents: [candidate.document], evidence: candidate.values.map(value => ({
      sourceDocumentKey: candidate.document.sourceDocumentKey, revisionKey: value.revisionKey })) },
    inconsistent = structuredClone(candidate);
  inconsistent.values[0].revisionKey = `${inconsistent.values[0].valueKey}|sha256:${"f".repeat(64)}`;
  assert.equal(Pilot.sameRawIsConsistent(snapshot, candidate), true);
  assert.equal(Pilot.sameRawIsConsistent(snapshot, inconsistent), false);
});

test("R4-8 vault failure blocks every Employment Formal write", async t => {
  const h = fixture(t, { vaultCrashAt: "before_object_rename" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R4-9 Formal abort leaves valid orphan evidence and no Employment binding", async t => {
  const h = fixture(t, { formalFaultAt: "before_open" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "formal_write_aborted", 0]);
  assert.equal(h.vault.verifyOccurrence(result.occurrenceId).status, "valid");
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R4-10 pre-activation Employment remains valid and explicitly unavailable", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire({ releaseDate: "2026-10-02" }), candidate =
    Employment.createAcceptedCandidate({ acquisition: acquired, acceptedAt: "2026-10-02T12:32:00.000Z" }),
    formal = Store.createFormalRuntime({ indexedDB: h.indexedDB }), ticket =
    await formal.registerAcceptedRelease(candidate); await formal.commitAcceptedRelease(ticket);
  const before = (await formal.readSnapshot()).snapshot, resolved = Pilot.resolveEmploymentEvidence({
    snapshot: before, vault: h.vault, sourceDocumentKey: candidate.document.sourceDocumentKey }), after =
    (await formal.readSnapshot()).snapshot, revisionResolved = Pilot.resolveEmploymentRevision({
      snapshot: before, vault: h.vault, revisionKey: before.revisions[0].revisionKey });
  assert.deepEqual([resolved.status, resolved.diagnostic, resolved.evidenceRef.reason],
    ["unavailable", "evidence_unavailable_pre_activation", "pre_activation"]);
  assert.deepEqual([revisionResolved.status, revisionResolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R4-11 intentional older archive acquisition retains historical_archive_fetch context", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput({
    acquisitionContext: "historical_archive_fetch" }));
  assert.equal(h.vault.readOccurrence(result.occurrenceId).acquisitionContext, "historical_archive_fetch");
});

test("R4-12 official correction revisions bind the correction occurrence, not initial evidence", async t => {
  const initialHtml = Fixture.html(), correctionHtml = Fixture.html({ corrected: true,
    payroll: "+31,000", revisions: [{ month: "AUGUST", from: "+162,000", to: "+135,000" }] }),
    h = fixture(t, { htmls: [initialHtml, correctionHtml], fetchedAts:
      ["2026-10-02T12:31:00.000Z", "2026-10-02T13:01:00.000Z"] }),
    initial = await h.runtime.acquireAndCommit(runInput()), correction = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-02T13:02:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot,
    revision = snapshot.revisions.find(value => value.valueKey === payrollKey("2026-09") &&
      value.validTo === null), resolved = Pilot.resolveEmploymentRevision({ snapshot, vault: h.vault,
      revisionKey: revision.revisionKey });
  assert.notEqual(initial.occurrenceId, correction.occurrenceId);
  assert.equal(snapshot.releases.length, 2);
  assert.equal(resolved.release.occurrenceType, "correction");
  assert.equal(resolved.occurrence.occurrenceId, correction.occurrenceId);
});

test("R4-13 tampered Employment raw object is invalid without rewriting Formal state", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), before =
    (await h.runtime.readSnapshot()).snapshot, target = objectPath(h.root, result.contentSha256), raw =
    fs.readFileSync(target); fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = Pilot.resolveEmploymentEvidence({ snapshot: before, vault: h.vault,
    sourceDocumentKey: result.sourceDocumentKey }), after = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R4-14 CPI and Employment share content vault infrastructure without occurrence collision", async t => {
  const h = fixture(t), cpiHtml = CpiFixture.html(), cpiAcquisition =
    CpiAcquisition.createBlsCpiAcquisition({ fetchImpl: async () => new Response(cpiHtml, {
      headers: { "content-type": "text/html" } }),
    now: () => new Date("2026-10-14T13:31:00.000Z") }), cpiRuntime = CpiPilot.createPilotRuntime({
      acquisition: cpiAcquisition, vault: h.vault, indexedDB: h.indexedDB }), employment =
    await h.runtime.acquireAndCommit(runInput()), cpi = await cpiRuntime.acquireAndCommit({
      releaseDate: "2026-10-14", acceptedAt: "2026-10-14T13:32:00.000Z", calendarEventKey: null,
      acquisitionContext: "live_original_acquisition" }), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.notEqual(employment.occurrenceId, cpi.occurrenceId);
  assert.deepEqual(new Set(snapshot.documents.map(value => value.sourceId)),
    new Set([Employment.SOURCE_ID, "us-bls-cpi-values"]));
  assert.equal(snapshot.documents.every(value => value.sourceEvidence.sourceId === value.sourceId), true);
});

test("R4-15 evidence activation does not synthesize prior unemployment revisions", async t => {
  const html = Fixture.html({ revisions: [
    { month: "JULY", from: "+21,000", to: "-10,000" },
    { month: "AUGUST", from: "+162,000", to: "+133,000" }
  ] }), h = fixture(t, { htmls: [html] }); await h.runtime.acquireAndCommit(runInput());
  const snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual(snapshot.revisions.filter(value => value.valueKey.startsWith(Employment.SERIES[1]
    .seriesDefinitionKey)).map(value => value.valueKey), [unemploymentKey("2026-09")]);
});

test("R4-16 Employment raw bytes and evidence references do not leak into exports", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshotResult =
    await h.runtime.readSnapshot(), exported = Export.create({ appVersion: "1.1.0-beta.16",
      generatedAt: "2026-10-02T14:00:00.000Z", snapshotResult }), serialized = Export.serialize(exported);
  assert.doesNotMatch(serialized, /parserInput|rawBody|rawHtml|sourceEvidence|occurrenceId/);
  assert.equal(serialized.includes(Fixture.html()), false);
  assert.equal(h.vault.readRawBytes(result.contentSha256).byteLength > 0, true);
});
