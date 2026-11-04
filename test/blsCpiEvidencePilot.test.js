"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/blsCpiAcquisition.js");
const Cpi = require("../js/economicValues/blsCpiFormal.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Pilot = require("../js/economicValues/blsCpiEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Fixture = require("./fixtures/economicValues/blsCpiReleaseFixture.js");

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-cpi-evidence-pilot-"))), indexedDB = new IDBFactory(), htmls = options.htmls ||
    [Fixture.html()], fetchedAts = options.fetchedAts || ["2026-10-14T13:31:00.000Z"];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCount = 0;
  const acquisition = Acquisition.createBlsCpiAcquisition({ fetchImpl: async () => {
    const html = htmls[Math.min(fetchCount, htmls.length - 1)]; fetchCount += 1;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }, now: () => new Date(fetchedAts[Math.min(fetchCount - 1, fetchedAts.length - 1)]) });
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
    crashAt: options.vaultCrashAt || null }), runtime = Pilot.createPilotRuntime({ acquisition, vault,
    indexedDB, formalFaultAt: options.formalFaultAt || null });
  return { root, indexedDB, acquisition, vault, runtime, fetchCount: () => fetchCount };
}

const runInput = (patch = {}) => ({ releaseDate: "2026-10-14",
  acceptedAt: "2026-10-14T13:32:00.000Z", calendarEventKey: null,
  acquisitionContext: "live_original_acquisition", ...patch });

async function directAcquire(acquisition) {
  return acquisition.acquire({ releaseDate: "2026-10-14" });
}

function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("R3-1 new CPI uses one accepted fetch and persists raw evidence before Formal", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = snapshot.documents[0];
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount,
    result.semanticWrites, h.fetchCount()], ["committed", "evidence_saved", 1, 4, 1]);
  assert.equal(document.sourceEvidence.state, "available");
  assert.equal(document.sourceEvidence.occurrenceId, result.occurrenceId);
  assert.equal(snapshot.revisions.length, 4);
});

test("R3-2 restart preserves revision to document to occurrence to exact raw bytes", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, restarted = Vault.createIsolatedVault({ root: h.root,
      targetEnvironment: "isolated_test", crashAt: null }), resolved = Pilot.resolveCpiEvidence({
      snapshot, vault: restarted, sourceDocumentKey: result.sourceDocumentKey });
  assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.parserLineage.length],
    ["available", "valid", 4]);
  assert.equal(restarted.readRawBytes(result.contentSha256).toString("utf8"), Fixture.html());
  assert.equal(resolved.parserLineage.every(value => value.evidenceRef.occurrenceId ===
    result.occurrenceId), true);
});

test("R3-3/R3-4 vault SHA and length exactly agree with existing source document", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = snapshot.documents[0], metadata =
    h.vault.readContentMetadata(result.contentSha256);
  assert.equal(metadata.contentObject.sha256, document.rawContentHash);
  assert.equal(metadata.contentObject.byteLength, document.byteCount);
  assert.equal(result.contentSha256, document.sourceEvidence.contentSha256);
});

test("R3-5 identical reacquisition dedupes content, adds occurrence and performs semantic write0", async t => {
  const h = fixture(t, { htmls: [Fixture.html(), Fixture.html()], fetchedAts:
    ["2026-10-14T13:31:00.000Z", "2026-10-14T14:31:00.000Z"] });
  const first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(
    runInput({ acceptedAt: "2026-10-14T14:32:00.000Z" })), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount,
    second.semanticWrites], ["unchanged", "evidence_duplicate_content", 0, 0]);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  assert.equal(h.vault.occurrencesByContentSha256(first.contentSha256).length, 2);
  assert.deepEqual([snapshot.runs.length, snapshot.documents.length], [1, 1]);
});

test("R3-6 changed raw and changed canonical values create a new document and immutable revisions", async t => {
  const changed = Fixture.html({ headlineMom: "0.4", headlineYoy: "3.5",
    coreMom: "0.2", coreYoy: "2.5" }), h = fixture(t, {
    htmls: [Fixture.html(), changed], fetchedAts:
      ["2026-10-14T13:31:00.000Z", "2026-10-14T14:31:00.000Z"] });
  const first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(
    runInput({ acceptedAt: "2026-10-14T14:32:00.000Z" })), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.semanticWrites, second.formalTransactionCount],
    ["committed", 4, 1], JSON.stringify(second));
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.deepEqual([snapshot.releases.length, snapshot.documents.length, snapshot.runs.length], [1, 2, 2]);
  assert.equal(snapshot.documents.every(value => value.releaseOccurrenceKey ===
    snapshot.releases[0].releaseOccurrenceKey), true);
});

test("R3-7 changed raw with same canonical facts records evidence but performs Formal write0", async t => {
  const changed = `${Fixture.html()}\n<!-- official formatting change -->`, h = fixture(t, {
    htmls: [Fixture.html(), changed], fetchedAts:
      ["2026-10-14T13:31:00.000Z", "2026-10-14T14:31:00.000Z"] });
  const first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(
    runInput({ acceptedAt: "2026-10-14T14:32:00.000Z" })), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_saved", 0]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.deepEqual([snapshot.documents.length, snapshot.runs.length], [1, 1]);
  assert.equal(h.vault.verifyOccurrence(second.occurrenceId).status, "valid");
});

test("R3-8 vault failure blocks pilot Formal acceptance", async t => {
  const h = fixture(t, { vaultCrashAt: "before_object_rename" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R3-9 Formal failure after vault promotion leaves no CPI binding", async t => {
  const h = fixture(t, { formalFaultAt: "before_open" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "formal_write_aborted", 0]);
  assert.equal(h.vault.verifyOccurrence(result.occurrenceId).status, "valid");
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R3-10 pre-activation CPI remains valid and resolves as explicitly unavailable", async t => {
  const h = fixture(t), acquired = await directAcquire(h.acquisition), candidate =
    Cpi.createAcceptedCandidate({ acquisition: acquired, acceptedAt: "2026-10-14T13:32:00.000Z" }),
    formal = Store.createFormalRuntime({ indexedDB: h.indexedDB }), ticket =
    await formal.registerAcceptedRelease(candidate); await formal.commitAcceptedRelease(ticket);
  const before = (await formal.readSnapshot()).snapshot, resolved = Pilot.resolveCpiEvidence({
    snapshot: before, vault: h.vault, sourceDocumentKey: candidate.document.sourceDocumentKey }),
    after = (await formal.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.diagnostic, resolved.evidenceRef.reason],
    ["unavailable", "evidence_unavailable_pre_activation", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R3-11 later intentional archive acquisition retains historical_archive_fetch context", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput({
    acquisitionContext: "historical_archive_fetch" })), occurrence =
    h.vault.readOccurrence(result.occurrenceId);
  assert.equal(occurrence.acquisitionContext, "historical_archive_fetch");
});

test("R3-12 tampered raw object makes evidence invalid without rewriting CPI", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), before =
    (await h.runtime.readSnapshot()).snapshot, target = objectPath(h.root, result.contentSha256), raw =
    fs.readFileSync(target); fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = Pilot.resolveCpiEvidence({ snapshot: before, vault: h.vault,
    sourceDocumentKey: result.sourceDocumentKey }), after = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.diagnostic, resolved.reason],
    ["invalid", "evidence_invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R3-13 forged evidence reference is rejected", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    structuredClone((await h.runtime.readSnapshot()).snapshot), document = snapshot.documents.find(value =>
      value.sourceDocumentKey === result.sourceDocumentKey);
  document.sourceEvidence.occurrenceId = `source-occurrence-v1|sha256:${"f".repeat(64)}`;
  const resolved = Pilot.resolveCpiEvidence({ snapshot, vault: h.vault,
    sourceDocumentKey: result.sourceDocumentKey });
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "missing"]);
});

test("R3-14 source identity mismatch cannot bind to CPI candidate", async t => {
  const h = fixture(t), acquired = await directAcquire(h.acquisition), candidate =
    Cpi.createAcceptedCandidate({ acquisition: acquired, acceptedAt: "2026-10-14T13:32:00.000Z" }),
    evidenceInput = Pilot.createEvidenceInput(acquired, candidate, "live_original_acquisition");
  h.vault.storeAcceptedEvidence(evidenceInput);
  const reference = structuredClone(Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: evidenceInput.occurrence, policy: evidenceInput.policy }));
  reference.sourceId = "us-bls-employment-situation-values";
  assert.throws(() => Cpi.bindSourceEvidence(candidate, reference), /source_evidence_invalid/);
});

test("R3-15 one raw object supports separate parser lineage generations", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, resolved = Pilot.resolveCpiEvidence({ snapshot,
      vault: h.vault, sourceDocumentKey: result.sourceDocumentKey }), first = resolved.parserLineage[0],
    second = Evidence.createParserLineage({ evidenceRef: first.evidenceRef,
      parserId: first.parserId, parserVersion: 2, canonicalIdentity: first.canonicalIdentity });
  assert.equal(first.evidenceRef.contentSha256, second.evidenceRef.contentSha256);
  assert.notEqual(first.parserVersion, second.parserVersion);
  assert.equal(h.vault.occurrencesByContentSha256(result.contentSha256).length, 1);
});

test("R3-16 Economic Values and Full Export paths never include raw CPI bytes", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshotResult =
    await h.runtime.readSnapshot(), exported = Export.create({ appVersion: "1.1.0-beta.16",
      generatedAt: "2026-10-14T14:00:00.000Z", snapshotResult }), serialized = Export.serialize(exported);
  assert.doesNotMatch(serialized, /parserInput|rawBody|rawHtml|sourceEvidence|occurrenceId/);
  assert.equal(serialized.includes(Fixture.html()), false);
  const fullExport = fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8");
  assert.equal(fullExport.includes("readRawBytes"), false);
  assert.equal(h.vault.readRawBytes(result.contentSha256).byteLength > 0, true);
});
