"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

const P1 = require("../js/participantAcquisitionAuthorityContract.js");
const P2 = require("../js/participantRawTransportShadow.js");
const P3 = require("../js/participantEvidenceVaultShadow.js");
const Binding = require("../js/participantFormalEvidenceBinding.js");
const Archive = require("../js/storage/participantFormalEvidenceArchiveShadow.js");
const SetStore = require("../js/storage/participantEvidenceSetStore.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const ReadStore = require("../js/storage/participantFormalArchiveStore.js");

const REPO = path.join(__dirname, "..");
const DATE = "2026-11-10";
const NOW = new Date("2026-11-10T09:30:00.000Z");
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
  tx.onabort = () => reject(tx.error); tx.onerror = () => undefined; });

function authority() {
  return P1.createMainAuthority({ keyId: "participants-p4-main",
    secret: Buffer.alloc(32, 80) });
}

function workbook(role, { volume = 100, marker = "a" } = {}) {
  const book = XLSX.utils.book_new(), index = P1.ROLE_ORDER.indexOf(role);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["手口上位一覧"], [null, "取引日 Trading Date :", DATE.replaceAll("-", "")],
    ["NK225F", "161090018", `${role} CONTRACT`, 1, `00${index + 1}`,
      `${role}証券`, `${role} Securities`, volume + index], ["raw-marker", marker]
  ]), "Sheet1");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function chain(main, requestId) {
  const intent = P1.createAcquisitionIntent({ requestKind: "explicit_source_date", targetDate: DATE }),
    sourceUrls = Object.fromEntries(P1.ROLE_ORDER.map(role =>
      [role, P1.canonicalWorkbookUrl(role, DATE)])), discovery = P1.createOfficialDiscovery({ intent,
      discoveryKind: "official_monthly_listing", discoveryRequestId: `p4-discovery-${requestId}`,
      officialUrl: P1.monthlyListingUrl(DATE), sourceDate: DATE, sourceUrls,
      fallbackAttempt: null }), manifest = P1.createAcquisitionManifest({ intent, discovery,
      requestId }, main);
  return { manifest, acquisitions: P1.createWorkbookAcquisitions(manifest, main) };
}

function transport(main, values) {
  return P2.createParticipantsRawTransportShadow({ authority: main, now: () => NOW,
    fetchImpl: async url => {
      const role = P1.ROLE_ORDER.find(item => P1.canonicalWorkbookUrl(item, DATE) === url),
        bytes = workbook(role, values);
      return new Response(bytes, { status: 200, headers: { "content-type": P2.MIME,
        "content-length": String(bytes.byteLength) } });
    } });
}

function harness(t) {
  const main = authority(), root = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), "optionmap-p4-"))), vault = Vault.createIsolatedVault({ root,
      targetEnvironment: "isolated_test", crashAt: null }), setStore =
      SetStore.createIsolatedParticipantEvidenceSetStore({ root, targetEnvironment: "isolated_test" }),
    databaseName = `optionmap-participants-p4-${Date.now()}-${Math.random()}`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const createArchive = (store = setStore) => Archive.createIsolatedParticipantFormalEvidenceArchive({
    indexedDB, IDBKeyRange, databaseName, targetEnvironment: "isolated_test", authority: main,
    vault, setStore: store });
  return { main, root, vault, setStore, databaseName, createArchive, archive: createArchive() };
}

async function bundle(h, { requestId = "p4-request-1", volume = 100, marker = "a",
    rejectParserRole = null } = {}) {
  const authority = chain(h.main, requestId), raw = transport(h.main, { volume, marker }),
    shadow = P3.createParticipantsEvidenceVaultShadow({ transportShadow: raw, vault: h.vault,
      setStore: h.setStore, authority: h.main,
      testHooks: rejectParserRole ? { rejectParserRole } : null }),
    captured = await shadow.capture(authority.manifest), transportSet =
      await raw.acquireManifest(authority.manifest), completeSet = transportSet.success ?
      await Binding.expectedCompleteSet(transportSet, DATE, transportSet.results[0].fetchedAt) : null;
  return { ...authority, raw, captured, transportSet, completeSet };
}

async function accept(h, value, confirmedAt = "2026-11-10T10:00:00.000Z") {
  return h.archive.accept({ completeSet: value.completeSet,
    evidenceSetId: value.evidenceSetId || value.captured.evidenceSet?.evidenceSetId ||
      "participants-evidence-set-v1|sha256:" + "0".repeat(64), manifest: value.manifest,
    transportSet: value.transportSet, acquisitions: value.acquisitions, confirmedAt });
}

async function accepted(t) {
  const h = harness(t), value = await bundle(h), result = await accept(h, value);
  assert.deepEqual([value.captured.status, result.status, result.classification],
    ["available", "accepted", "new_revision"]);
  return { h, value, result };
}

function evidenceSetFile(h, evidenceSetId) {
  return path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    SetStore.DIRECTORY_NAME, `${SetStore.setDigest(evidenceSetId)}.json`);
}

test("P4-1 evidence-backed new Formal revision is accepted", async t => {
  const { result } = await accepted(t);
  assert.equal(result.revision.sourceEvidence.state, "available");
  assert.equal(result.revision.sourceEvidence.parserLineage.parserVersion,
    P1.PARSER_AUTHORITY.parserVersion);
  assert.equal(Object.hasOwn(result.revision.completeSet, "sourceEvidence"), false);
  assert.equal(result.revisionWriteCount, 1);
});

test("P4-2 revision resolves its set and four role-bound occurrences", async t => {
  const { h, result } = await accepted(t), resolved = await h.archive.resolveRevision(
    result.revision.revisionKey);
  assert.deepEqual([resolved.status, resolved.evidence.roles.length,
    ...resolved.evidence.roles.map(item => item.role)], ["available", 4, ...P1.ROLE_ORDER]);
});

test("P4-3 revision resolution returns original content metadata without raw bytes", async t => {
  const { h, result } = await accepted(t), resolved = await h.archive.resolveRevision(
    result.revision.revisionKey);
  assert.ok(resolved.evidence.roles.every(item => item.contentMetadata.contentObject.byteLength > 0));
  assert.equal(JSON.stringify(resolved).includes("bytes"), false);
});

test("P4-4 missing Evidence Set rejects a new revision", async t => {
  const h = harness(t), value = await bundle(h);
  value.evidenceSetId = "participants-evidence-set-v1|sha256:" + "0".repeat(64);
  assert.deepEqual([(await accept(h, value)).reason,
    (await h.archive.readEntryRevisions(DATE)).length], ["evidence_set_missing", 0]);
});

for (const [number, field] of [[5, "sourceDate"], [6, "sourceId"], [7, "runId"]]) {
  test(`P4-${number} wrong ${field} Evidence Set rejects`, async t => {
    const h = harness(t), value = await bundle(h), forged = structuredClone(value.captured.evidenceSet);
    forged[field] = field === "sourceDate" ? "2026-11-09" : field === "sourceId" ?
      "jpx-daily-derivatives-open-interest" : "participants-run-v1|sha256:" + "f".repeat(64);
    const store = { read: () => forged }, archive = h.createArchive(store), result = await archive.accept({
      completeSet: value.completeSet, evidenceSetId: forged.evidenceSetId, manifest: value.manifest,
      transportSet: value.transportSet, acquisitions: value.acquisitions,
      confirmedAt: "2026-11-10T10:00:00.000Z" });
    assert.deepEqual([result.reason, result.revisionWriteCount], ["evidence_binding_invalid", 0]);
  });
}

test("P4-8 tampered persisted set hash rejects", async t => {
  const { h, result } = await accepted(t), file = evidenceSetFile(h,
    result.revision.sourceEvidence.evidenceSetId), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.setHash = "0".repeat(64); fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  assert.deepEqual([(await h.archive.resolveRevision(result.revision.revisionKey)).status,
    (await h.archive.readEntryRevisions(DATE)).length], ["invalid", 1]);
});

test("P4-9 tampered revision Evidence ref fails verification", async t => {
  const { h, result } = await accepted(t), forged = structuredClone(result.revision),
    evidenceSet = h.setStore.read(result.revision.sourceEvidence.evidenceSetId, h.main);
  forged.sourceEvidence.evidenceSetId = "participants-evidence-set-v1|sha256:" + "0".repeat(64);
  assert.equal(Binding.validateRevisionBinding(forged, evidenceSet,
    h.vault, h.main), false);
});

test("P4-10 changed raw bytes with unchanged canonical set are Formal write0", async t => {
  const { h } = await accepted(t), later = await bundle(h,
    { requestId: "p4-request-raw-change", marker: "different-raw" }), result = await accept(h, later,
    "2026-11-10T11:00:00.000Z");
  assert.deepEqual([result.classification, result.revisionWriteCount,
    (await h.archive.readEntryRevisions(DATE)).length, h.vault.vaultStatus().occurrenceCount],
  ["semantic_duplicate", 0, 1, 8]);
});

test("P4-11 same raw reacquisition is Formal write0", async t => {
  const { h } = await accepted(t), later = await bundle(h, { requestId: "p4-request-repeat" }),
    result = await accept(h, later, "2026-11-10T11:00:00.000Z");
  assert.deepEqual([result.classification, result.revisionWriteCount,
    h.vault.vaultStatus().occurrenceCount], ["semantic_duplicate", 0, 8]);
});

test("P4-12 same-date semantic correction creates an immutable revision", async t => {
  const { h } = await accepted(t), correction = await bundle(h,
    { requestId: "p4-request-correction", volume: 200 }), result = await accept(h, correction,
    "2026-11-10T12:00:00.000Z"), revisions = await h.archive.readEntryRevisions(DATE);
  assert.deepEqual([result.classification, revisions.length, revisions[0].revisionState,
    revisions[0].replacedAt, revisions[1].revisionState],
  ["same_date_correction", 2, "replaced", "2026-11-10T12:00:00.000Z", "active"]);
});

test("P4-13 old corrected revision remains queryable", async t => {
  const { h, result: first } = await accepted(t), correction = await bundle(h,
    { requestId: "p4-request-correction", volume: 200 });
  await accept(h, correction, "2026-11-10T12:00:00.000Z");
  assert.equal((await h.archive.resolveRevision(first.revision.revisionKey)).status, "available");
});

test("P4-14 active revision updates to the correction", async t => {
  const { h } = await accepted(t), correction = await bundle(h,
    { requestId: "p4-request-correction", volume: 200 }), latest = await accept(h, correction,
    "2026-11-10T12:00:00.000Z"), reader = ReadStore.createParticipantFormalArchiveStore({
      indexedDB, IDBKeyRange, databaseName: h.databaseName });
  assert.equal((await reader.readActiveRevision(DATE)).revision.revisionKey,
    latest.revision.revisionKey); reader.closeArchive();
});

async function seedPreActivation(h, completeSet) {
  const reader = ReadStore.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
    databaseName: h.databaseName }), db = await reader.openArchive(), entryKey =
    Schema.entryKeyFor(DATE), revisionKey = `${entryKey}|${completeSet.versionKey}`,
    at = "2026-11-10T08:00:00.000Z", tx = db.transaction([Schema.META_STORE,
      Schema.ENTRY_STORE, Schema.REVISION_STORE], "readwrite");
  tx.objectStore(Schema.META_STORE).put({ id: Schema.META_KEY, archiveSchemaVersion: 1,
    dataset: "participant", authorityClass: "formal", retentionPolicy: "preserve_formal_revisions",
    createdAt: at, updatedAt: at, integrityAlgorithm: "sha256", entryCount: 1, revisionCount: 1 });
  tx.objectStore(Schema.ENTRY_STORE).put({ entryKey, sourceDate: DATE,
    activeRevisionKey: revisionKey, firstSeenAt: at, lastSeenAt: at });
  tx.objectStore(Schema.REVISION_STORE).put({ revisionKey, entryKey, sourceDate: DATE,
    versionKey: completeSet.versionKey, contentSignature: completeSet.signature,
    signatureAlgorithm: "sha256", signature: completeSet.signature, confirmedAt: at,
    replacedAt: null, revisionState: "active", completeSet: structuredClone(completeSet) });
  await done(tx); reader.closeArchive(); return revisionKey;
}

test("P4-15 pre-activation revision stays valid with unavailable/pre_activation", async t => {
  const h = harness(t), value = await bundle(h), key = await seedPreActivation(h, value.completeSet),
    resolved = await h.archive.resolveRevision(key);
  assert.deepEqual(resolved.evidence, { state: "unavailable", reason: "pre_activation" });
});

test("P4-16 pre-activation resolution fabricates no backfill", async t => {
  const h = harness(t), value = await bundle(h), key = await seedPreActivation(h, value.completeSet),
    before = JSON.stringify((await h.archive.resolveRevision(key)).revision);
  await h.archive.resolveRevision(key);
  assert.equal(JSON.stringify((await h.archive.resolveRevision(key)).revision), before);
});

test("P4-17 parser rejection retains Evidence occurrences and writes Formal0", async t => {
  const h = harness(t), value = await bundle(h, { rejectParserRole: "nightJnet" }),
    result = await accept(h, value);
  assert.deepEqual([value.captured.reason, h.vault.vaultStatus().occurrenceCount,
    result.revisionWriteCount], ["parser_binding_rejected", 4, 0]);
});

test("P4-18 incomplete set cannot support a Formal revision", async t => {
  const h = harness(t), value = await bundle(h);
  value.evidenceSetId = "participants-evidence-set-v1|sha256:" + "0".repeat(64);
  assert.equal((await accept(h, value)).revisionWriteCount, 0);
});

test("P4-19 cross-domain Evidence binding rejects", async t => {
  const { h, result } = await accepted(t), foreign = structuredClone(result.revision);
  foreign.sourceEvidence.sourceId = "jpx-daily-derivatives-open-interest";
  assert.equal(Binding.validateBinding(foreign.sourceEvidence, h.main), false);
});

test("P4-20 restart preserves revision-to-set lineage", async t => {
  const { h, result } = await accepted(t); h.archive.close();
  const restarted = h.createArchive(), resolved = await restarted.resolveRevision(
    result.revision.revisionKey);
  assert.deepEqual([resolved.status, resolved.evidence.evidenceSet.evidenceSetId,
    resolved.evidence.roles.length], ["available",
    result.revision.sourceEvidence.evidenceSetId, 4]);
});

test("P4-21 as-known-at retains correction intervals", async t => {
  const { h, result: first } = await accepted(t), correction = await bundle(h,
    { requestId: "p4-request-correction", volume: 200 }), second = await accept(h, correction,
    "2026-11-10T12:00:00.000Z");
  assert.deepEqual([(await h.archive.readAsKnownAt(DATE,
    "2026-11-10T11:00:00.000Z")).revisionKey,
  (await h.archive.readAsKnownAt(DATE, "2026-11-10T12:30:00.000Z")).revisionKey],
  [first.revision.revisionKey, second.revision.revisionKey]);
});

test("P4-22 normal Full Export contains no raw bytes, paths, or secrets", () => {
  const source = fs.readFileSync(path.join(REPO, "js/fullExportSourceFaithfulCanonical.js"), "utf8");
  assert.doesNotMatch(source, /participantFormalEvidenceBinding|participantFormalEvidenceArchiveShadow/);
});

test("P4-23 legacy Participants history behavior remains unwired", () => {
  const source = fs.readFileSync(path.join(REPO, "js/participantHistory.js"), "utf8");
  assert.doesNotMatch(source, /sourceEvidence|EvidenceSet|EvidenceVault/);
});

test("P4-24 production acquisition and renderer IPC remain unchanged", () => {
  const source = ["main.js", "preload.js", "index.html"].map(file =>
    fs.readFileSync(path.join(REPO, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /participantFormalEvidenceBinding|participantFormalEvidenceArchiveShadow/);
});
