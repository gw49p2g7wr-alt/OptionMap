"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Acquisition = require("../js/economicValues/jpCpiAcquisition.js");
const JapanCpi = require("../js/economicValues/jpCpiFormal.js");
const Encoding = require("../js/economicValues/jpCpiEncoding.js");
const Store = require("../js/economicValues/economicValueFormalStore.js");
const Export = require("../js/economicValues/economicValuesExportV1.js");
const Pilot = require("../js/economicValues/jpCpiEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Fixture = require("./fixtures/economicValues/jpCpiReleaseFixture.js");

const SHIFT_JIS_INITIAL = "PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0iamEiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9IlNoaWZ0X0pJUyI+PHRpdGxlPo/BlO+O0pWoib+Od5CUKENQSSmMi4nKPC90aXRsZT48L2hlYWQ+CiAgICA8Ym9keT48bWFpbj48aDE+j8GU747SlaiJv453kJQoQ1BJKYyLico8L2gxPjxoMj4yMDI1lE6K7o+AII/BlO+O0pWoib+Od5CUIJFTjZEgMjAyNpROKJffmGE4lE4pOYyOlaooMjAyNpROMTCMjjIzk/qM9pVcKTwvaDI+CiAgICAKICAgIDxwPigxKSCRjY2HjneQlILNMjAyNZROgvAxMDCCxoK1gsQxMDIuMiCRT5ROk6+MjpTkgs0yLjElgsyP44+4PC9wPgo8cD4oMikgkLaRTpBIlWmC8I+cgq2RjY2HjneQlILNMTAyLjMgkU+UTpOvjI6U5ILNMi4xJYLMj+OPuDwvcD4KPHA+KDMpIJC2kU6QSJVpi3mC0YNHg2yDi4NNgVuC8I+cgq2RjY2HjneQlILNMTAyLjggkU+UTpOvjI6U5ILNMi40JYLMj+OPuDwvcD48L21haW4+PC9ib2R5PjwvaHRtbD4=";
const SHIFT_JIS_CORRECTION = "PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0iamEiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9IlNoaWZ0X0pJUyI+PHRpdGxlPo/BlO+O0pWoib+Od5CUKENQSSmMi4nKPC90aXRsZT48L2hlYWQ+CiAgICA8Ym9keT48bWFpbj48aDE+j8GU747SlaiJv453kJQoQ1BJKYyLico8L2gxPjxoMj4yMDI1lE6K7o+AII/BlO+O0pWoib+Od5CUIJFTjZEgMjAyNpROKJffmGE4lE4pOYyOlaooMjAyNpROMTCMjjIzk/qM9pVcKSCBeZL5kLOUxYF6PC9oMj4KICAgIDxwPpL5kLOM9pVcOiAyMDI2lE4xMIyOMjOT+iAxMI6eMDCVqjwvcD4KICAgIDxwPigxKSCRjY2HjneQlILNMjAyNZROgvAxMDCCxoK1gsQxMDIuMyCRT5ROk6+MjpTkgs0yLjElgsyP44+4PC9wPgo8cD4oMikgkLaRTpBIlWmC8I+cgq2RjY2HjneQlILNMTAyLjMgkU+UTpOvjI6U5ILNMi4xJYLMj+OPuDwvcD4KPHA+KDMpIJC2kU6QSJVpi3mC0YNHg2yDi4NNgVuC8I+cgq2RjY2HjneQlILNMTAyLjggkU+UTpOvjI6U5ILNMi40JYLMj+OPuDwvcD48L21haW4+PC9ib2R5PjwvaHRtbD4=";
const initialBytes = () => Buffer.from(SHIFT_JIS_INITIAL, "base64");
const correctionBytes = () => Buffer.from(SHIFT_JIS_CORRECTION, "base64");
function replaceAscii(bytes, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const copy = Buffer.from(bytes), index = copy.indexOf(from, 0, "ascii");
  assert.notEqual(index, -1); copy.write(to, index, "ascii"); return copy;
}

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-jp-cpi-evidence-pilot-"))), indexedDB = new IDBFactory(), bodies = options.bodies ||
    [initialBytes()], fetchedAts = options.fetchedAts || ["2026-10-23T00:01:00.000Z"];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fetchCount = 0;
  const acquisition = Acquisition.createJapanCpiAcquisition({ fetchImpl: async () => {
    const body = bodies[Math.min(fetchCount, bodies.length - 1)]; fetchCount += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }, now: () => new Date(fetchedAts[Math.min(fetchCount - 1, fetchedAts.length - 1)]) });
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
    crashAt: options.vaultCrashAt || null }), runtime = Pilot.createPilotRuntime({ acquisition, vault,
    indexedDB, formalFaultAt: options.formalFaultAt || null });
  return { root, indexedDB, acquisition, vault, runtime, fetchCount: () => fetchCount };
}
const runInput = (patch = {}) => ({ acceptedAt: "2026-10-23T00:02:00.000Z",
  calendarEventKey: null, acquisitionContext: "live_original_acquisition", ...patch });
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("R5-1 normal Shift_JIS Japan CPI retains raw evidence and binds six Formal values", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.semanticWrites, result.formalTransactionCount, h.fetchCount()],
    ["committed", 6, 1, 1]);
  assert.equal(snapshot.documents[0].httpMetadata.encoding, "shift_jis");
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
});

test("R5-2 content identity hashes raw Shift_JIS bytes before decode or UTF-8 re-encode", async () => {
  const bytes = initialBytes(), acquired = await Acquisition.createJapanCpiAcquisition({ fetchImpl: async () =>
    new Response(bytes, { headers: { "content-type": "text/html" } }),
  now: () => new Date("2026-10-23T00:01:00.000Z") }).acquire(), identity =
    Pilot.createRawContentIdentity(acquired),
    rawHash = crypto.createHash("sha256").update(bytes).digest("hex"), decodedHash = crypto.createHash("sha256")
      .update(Buffer.from(Encoding.decode(bytes), "utf8")).digest("hex");
  assert.equal(identity.contentObject.sha256, rawHash);
  assert.notEqual(rawHash, decodedHash);
  assert.deepEqual([identity.contentObject.encoding, identity.contentObject.byteLength],
    ["shift_jis", bytes.byteLength]);
});

test("R5-3 restart preserves revision to release to occurrence to exact Shift_JIS bytes", async t => {
  const bytes = initialBytes(), h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot, restarted = Vault.createIsolatedVault({ root: h.root,
      targetEnvironment: "isolated_test", crashAt: null });
  for (const revision of snapshot.revisions) {
    const resolved = Pilot.resolveJapanCpiRevision({ snapshot, vault: restarted,
      revisionKey: revision.revisionKey });
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.occurrence.occurrenceId],
      ["available", "valid", result.occurrenceId]);
  }
  assert.deepEqual(restarted.readRawBytes(result.contentSha256), bytes);
});

test("R5-4 all three official series and six facts share one source evidence occurrence", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([snapshot.definitions.length, snapshot.revisions.length, snapshot.evidence.length], [6, 6, 6]);
  assert.equal(new Set(snapshot.evidence.map(value => value.sourceEvidence.occurrenceId)).size, 1);
  assert.equal(snapshot.evidence.every(value => value.sourceEvidence.occurrenceId === result.occurrenceId), true);
});

test("R5-5 duplicate Shift_JIS acquisition dedupes content, adds occurrence and writes Formal0", async t => {
  const bytes = initialBytes(), h = fixture(t, { bodies: [bytes, bytes], fetchedAts:
    ["2026-10-23T00:01:00.000Z", "2026-10-23T00:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-23T00:32:00.000Z" }));
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  assert.equal(h.vault.occurrencesByContentSha256(first.contentSha256).length, 2);
});

test("R5-6 changed Shift_JIS markup with same facts saves evidence and writes Formal0", async t => {
  const firstBytes = initialBytes(), changed = Buffer.concat([firstBytes, Buffer.from("\n<!-- changed -->", "ascii")]),
    h = fixture(t, { bodies: [firstBytes, changed], fetchedAts:
      ["2026-10-23T00:01:00.000Z", "2026-10-23T00:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-23T00:32:00.000Z" }));
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_saved", 0]);
  assert.notEqual(first.contentSha256, second.contentSha256);
});

test("R5-7 changed official value creates a new immutable revision and evidence document", async t => {
  const firstBytes = initialBytes(), changed = replaceAscii(firstBytes, "102.2", "102.4"), h = fixture(t, {
    bodies: [firstBytes, changed], fetchedAts:
      ["2026-10-23T00:01:00.000Z", "2026-10-23T00:31:00.000Z"] }),
    first = await h.runtime.acquireAndCommit(runInput()), second = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-23T00:32:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.semanticWrites, snapshot.documents.length], ["committed", 1, 2]);
  assert.notEqual(first.contentSha256, second.contentSha256);
  assert.equal(snapshot.revisions.filter(value => value.valueKey.includes("|0001|INDEX|")).length, 2);
});

test("R5-8 base-year change creates new definitions, never revisions of the old base", async t => {
  const old = Buffer.from(Fixture.html({ baseYear: "2020", referencePeriod: "2021-09",
    releaseDate: "2021-10-22" }), "utf8"), h = fixture(t, { bodies: [old, initialBytes()], fetchedAts:
      ["2021-10-22T00:01:00.000Z", "2026-10-23T00:01:00.000Z"] });
  await h.runtime.acquireAndCommit(runInput({ acceptedAt: "2021-10-22T00:02:00.000Z" }));
  await h.runtime.acquireAndCommit(runInput());
  const snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.equal(snapshot.definitions.length, 12);
  assert.equal(snapshot.revisions.filter(value => value.seriesDefinitionKey.endsWith("|2020")).length, 6);
  assert.equal(snapshot.revisions.filter(value => value.seriesDefinitionKey.endsWith("|2025")).length, 6);
});

test("R5-9 vault failure blocks the complete Japan CPI Formal transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_object_rename" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R5-10 Formal abort leaves valid orphan evidence without Japan CPI binding", async t => {
  const h = fixture(t, { formalFaultAt: "before_open" }), result =
    await h.runtime.acquireAndCommit(runInput());
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "formal_write_aborted", 0]);
  assert.equal(h.vault.verifyOccurrence(result.occurrenceId).status, "valid");
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R5-11 pre-activation Japan CPI remains valid with explicit unavailable evidence", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire(), candidate = JapanCpi.createAcceptedCandidate({
    acquisition: acquired, acceptedAt: "2026-10-23T00:02:00.000Z" }), formal =
    Store.createFormalRuntime({ indexedDB: h.indexedDB }), ticket = await formal.registerAcceptedRelease(candidate);
  await formal.commitAcceptedRelease(ticket);
  const before = (await formal.readSnapshot()).snapshot, resolved = Pilot.resolveJapanCpiRevision({ snapshot: before,
    vault: h.vault, revisionKey: before.revisions[0].revisionKey }), after = (await formal.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R5-12 intentional archive acquisition records historical_archive_fetch", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput({
    acquisitionContext: "historical_archive_fetch" }));
  assert.equal(h.vault.readOccurrence(result.occurrenceId).acquisitionContext, "historical_archive_fetch");
});

test("R5-13 official correction revision resolves to corrected Shift_JIS evidence", async t => {
  const h = fixture(t, { bodies: [initialBytes(), correctionBytes()], fetchedAts:
    ["2026-10-23T00:01:00.000Z", "2026-10-23T01:01:00.000Z"] }),
    initial = await h.runtime.acquireAndCommit(runInput()), correction = await h.runtime.acquireAndCommit(runInput({
      acceptedAt: "2026-10-23T01:02:00.000Z" })), snapshot = (await h.runtime.readSnapshot()).snapshot,
    revision = snapshot.revisions.find(value => value.valueKey.includes("|0001|INDEX|") && value.validTo === null),
    resolved = Pilot.resolveJapanCpiRevision({ snapshot, vault: h.vault, revisionKey: revision.revisionKey });
  assert.notEqual(initial.occurrenceId, correction.occurrenceId);
  assert.equal(resolved.release.occurrenceType, "correction");
  assert.equal(resolved.occurrence.occurrenceId, correction.occurrenceId);
});

test("R5-14 tampered raw content is invalid and does not rewrite Japan CPI", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), before =
    (await h.runtime.readSnapshot()).snapshot, target = objectPath(h.root, result.contentSha256), raw =
    fs.readFileSync(target); fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = Pilot.resolveJapanCpiEvidence({ snapshot: before, vault: h.vault,
    sourceDocumentKey: result.sourceDocumentKey }), after = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R5-15 source identity and Tokyo geography cannot bind to nationwide Japan CPI", async t => {
  const h = fixture(t), acquired = await h.acquisition.acquire(), candidate = JapanCpi.createAcceptedCandidate({
    acquisition: acquired, acceptedAt: "2026-10-23T00:02:00.000Z" }), evidenceInput =
    Pilot.createEvidenceInput(acquired, candidate, "live_original_acquisition");
  h.vault.storeAcceptedEvidence(evidenceInput);
  const reference = structuredClone(Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: evidenceInput.occurrence, policy: evidenceInput.policy }));
  reference.sourceId = "us-bls-cpi-values";
  assert.throws(() => JapanCpi.bindSourceEvidence(candidate, reference), /source_evidence_invalid/);
  const tokyoAcquisition = await Acquisition.createJapanCpiAcquisition({ fetchImpl: async () =>
    new Response(Fixture.html({ geography: "東京都区部" }), { headers: { "content-type": "text/html" } }),
  now: () => new Date("2026-10-23T00:01:00.000Z") }).acquire();
  assert.throws(() => JapanCpi.createAcceptedCandidate({ acquisition: tokyoAcquisition,
    acceptedAt: "2026-10-23T00:02:00.000Z" }), /structure_change/);
});

test("R5-16 raw bytes and sourceEvidence remain absent from normal exports", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(runInput()), snapshotResult =
    await h.runtime.readSnapshot(), artifact = Export.create({ appVersion: "1.1.0-beta.16",
      generatedAt: "2026-10-23T02:00:00.000Z", snapshotResult }), serialized = Export.serialize(artifact);
  assert.doesNotMatch(serialized, /parserInput|rawBody|rawHtml|sourceEvidence|occurrenceId/);
  assert.equal(serialized.includes(Encoding.decode(initialBytes())), false);
  assert.equal(h.vault.readRawBytes(result.contentSha256).byteLength, initialBytes().byteLength);
});
