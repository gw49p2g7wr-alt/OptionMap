"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");
const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
const { IDBKeyRange } = require("fake-indexeddb");

const Reader = require("../js/participantKnowledgeAtReader.js");
const Store = require("../js/storage/participantFormalArchiveStore.js");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const P1 = require("../js/participantAcquisitionAuthorityContract.js");
const P2 = require("../js/participantRawTransportShadow.js");
const P3 = require("../js/participantEvidenceVaultShadow.js");
const Binding = require("../js/participantFormalEvidenceBinding.js");
const Archive = require("../js/storage/participantFormalEvidenceArchiveShadow.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const SetStore = require("../js/storage/participantEvidenceSetStore.js");

const REPO = path.join(__dirname, "..");
const D1 = "2026-11-10", D2 = "2026-11-11";
const T1 = "2026-11-10T10:00:00.000Z", T2 = "2026-11-10T12:00:00.000Z";
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
  transaction.onerror = () => undefined;
});

function revision(sourceDate, label, confirmedAt, replacedAt = null, sourceEvidence = undefined) {
  const versionKey = `participant-set-v4|sha256:${label.repeat(64).slice(0, 64)}`,
    entryKey = Schema.entryKeyFor(sourceDate), signature = label.repeat(64).slice(0, 64),
    value = { revisionKey: `${entryKey}|${versionKey}`, entryKey, sourceDate, versionKey,
      contentSignature: signature, signatureAlgorithm: "sha256", signature, confirmedAt,
      replacedAt, revisionState: replacedAt === null ? "active" : "replaced",
      completeSet: { sourceDate, label } };
  if (sourceEvidence !== undefined) value.sourceEvidence = sourceEvidence;
  return value;
}

function memoryArchive(revisions) {
  const byDate = new Map();
  for (const value of revisions) {
    if (!byDate.has(value.sourceDate)) byDate.set(value.sourceDate, []);
    byDate.get(value.sourceDate).push(structuredClone(value));
  }
  return { async readRange({ from, to, limit, afterSourceDate }) {
    const dates = [...byDate.keys()].filter(date => date >= from && date <= to &&
      (!afterSourceDate || date > afterSourceDate)).sort().slice(0, limit);
    return { status: dates.length ? "available" : "empty",
      entries: dates.map(sourceDate => ({ sourceDate })),
      nextCursor: dates.length === limit ? dates.at(-1) : null };
  }, async readEntryRevisions(sourceDate) {
    const values = byDate.get(sourceDate) || [];
    return { status: values.length ? "available" : "empty",
      revisions: structuredClone(values) };
  } };
}

function reader(revisions, verifier = { verifyRevision: async () => ({ verified: true,
  roleCount: 4, verificationScope: "metadata_and_file_size" }) }) {
  return Reader.createParticipantKnowledgeAtReader({ archiveReader: memoryArchive(revisions),
    evidenceVerifier: verifier });
}

function exact(sourceDate, knowledgeAt) {
  return { mode: "exact_source_date", knowledgeAt, sourceDate };
}

test("P5B-1 before first confirmedAt returns no known revision", async () => {
  const result = await reader([revision(D1, "a", T1)]).read(exact(D1,
    "2026-11-10T09:59:59.999Z"));
  assert.deepEqual([result.status, result.reason], ["unavailable", "no_revision_known_at_time"]);
});

test("P5B-2 exact confirmedAt makes the revision visible", async () => {
  const result = await reader([revision(D1, "a", T1)]).read(exact(D1, T1));
  assert.deepEqual([result.status, result.records[0].confirmedAt], ["available", T1]);
});

test("P5B-3 one millisecond before replacedAt retains the old revision", async () => {
  const old = revision(D1, "a", T1, T2), current = revision(D1, "b", T2);
  const result = await reader([current, old]).read(exact(D1, "2026-11-10T11:59:59.999Z"));
  assert.equal(result.records[0].versionKey, old.versionKey);
});

test("P5B-4 exact replacedAt boundary belongs to the new revision", async () => {
  const old = revision(D1, "a", T1, T2), current = revision(D1, "b", T2);
  const result = await reader([old, current]).read(exact(D1, T2));
  assert.equal(result.records[0].versionKey, current.versionKey);
});

test("P5B-5 same-date correction reconstructs both temporal states exactly", async () => {
  const old = revision(D1, "a", T1, T2), current = revision(D1, "b", T2), service =
    reader([old, current]), before = await service.read(exact(D1, "2026-11-10T11:00:00.000Z")),
    after = await service.read(exact(D1, "2026-11-10T13:00:00.000Z"));
  assert.deepEqual([before.records[0].completeSet.label, after.records[0].completeSet.label],
    ["a", "b"]);
});

test("P5B-6 raw-only reacquisition creates no knowledgeAt semantic change", async () => {
  const only = revision(D1, "a", T1), service = reader([only]), first = await service.read(
    exact(D1, T1)), later = await service.read(exact(D1, "2026-11-10T15:00:00.000Z"));
  assert.deepEqual([first.records[0].revisionKey, later.records[0].revisionKey],
    [only.revisionKey, only.revisionKey]);
});

test("P5B-7 latest_known chooses the greatest sourceDate known at T", async () => {
  const result = await reader([revision(D1, "a", T1), revision(D2, "b",
    "2026-11-11T10:00:00.000Z")]).read({ mode: "latest_known",
    knowledgeAt: "2026-11-11T10:00:00.000Z" });
  assert.deepEqual(result.records.map(value => value.sourceDate), [D2]);
});

test("P5B-8 exact_source_date never collapses to the latest sourceDate", async () => {
  const result = await reader([revision(D1, "a", T1), revision(D2, "b",
    "2026-11-11T10:00:00.000Z")]).read(exact(D1, "2026-11-12T00:00:00.000Z"));
  assert.deepEqual(result.records.map(value => value.sourceDate), [D1]);
});

test("P5B-9 range returns one known revision per sourceDate in ascending order", async () => {
  const result = await reader([revision(D2, "b", "2026-11-11T10:00:00.000Z"),
    revision(D1, "a", T1)]).read({ mode: "range", knowledgeAt: "2026-11-12T00:00:00.000Z",
    fromSourceDate: D1, toSourceDate: D2 });
  assert.deepEqual([result.order, ...result.records.map(value => value.sourceDate)],
    ["source_date_ascending", D1, D2]);
});

test("P5B-10 pre-activation revision remains valid with explicit Evidence state", async () => {
  const result = await reader([revision(D1, "a", T1)]).read(exact(D1, T1));
  assert.deepEqual(result.records[0].sourceEvidence, { state: "unavailable",
    reason: "pre_activation", evidenceSetId: null, verification: "not_applicable" });
});

function workbook(role) {
  const book = XLSX.utils.book_new(), index = P1.ROLE_ORDER.indexOf(role);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["手口上位一覧"], [null, "取引日 Trading Date :", D1.replaceAll("-", "")],
    ["NK225F", "161090018", `${role} CONTRACT`, 1, `00${index + 1}`,
      `${role}証券`, `${role} Securities`, 100 + index]
  ]), "Sheet1");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

async function evidenceHarness(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-p5b-"))), authority = P1.createMainAuthority({ keyId: "participants-p5b-main",
      secret: Buffer.alloc(32, 91) }), intent = P1.createAcquisitionIntent({
      requestKind: "explicit_source_date", targetDate: D1 }), sourceUrls = Object.fromEntries(
        P1.ROLE_ORDER.map(role => [role, P1.canonicalWorkbookUrl(role, D1)])), discovery =
      P1.createOfficialDiscovery({ intent, discoveryKind: "official_monthly_listing",
        discoveryRequestId: "p5b-discovery", officialUrl: P1.monthlyListingUrl(D1),
        sourceDate: D1, sourceUrls, fallbackAttempt: null }), manifest =
      P1.createAcquisitionManifest({ intent, discovery, requestId: "p5b-request" }, authority),
      acquisitions = P1.createWorkbookAcquisitions(manifest, authority), transport =
      P2.createParticipantsRawTransportShadow({ authority,
        now: () => new Date("2026-11-10T09:30:00.000Z"), fetchImpl: async url => {
          const role = P1.ROLE_ORDER.find(value => P1.canonicalWorkbookUrl(value, D1) === url),
            bytes = workbook(role); return new Response(bytes, { status: 200, headers: {
              "content-type": P2.MIME, "content-length": String(bytes.byteLength) } });
        } }), vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
        crashAt: null }), setStore = SetStore.createIsolatedParticipantEvidenceSetStore({ root,
        targetEnvironment: "isolated_test" }), shadow = P3.createParticipantsEvidenceVaultShadow({
        transportShadow: transport, vault, setStore, authority, testHooks: null }), captured =
      await shadow.capture(manifest), transportSet = await transport.acquireManifest(manifest),
      completeSet = await Binding.expectedCompleteSet(transportSet, D1,
        transportSet.results[0].fetchedAt), indexedDB = new FDBFactory(), databaseName =
      `optionmap-participants-p4-p5b-${Date.now()}-${Math.random()}`, archive =
      Archive.createIsolatedParticipantFormalEvidenceArchive({ indexedDB, IDBKeyRange, databaseName,
        targetEnvironment: "isolated_test", authority, vault, setStore }), accepted =
      await archive.accept({ completeSet, evidenceSetId: captured.evidenceSet.evidenceSetId,
        manifest, transportSet, acquisitions, confirmedAt: T1 });
  t.after(() => { archive.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const archiveReader = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
    databaseName }), evidenceVerifier = Reader.createMetadataEvidenceVerifier({ setStore,
    vault: { verifyOccurrenceMetadata: id => vault.verifyOccurrenceMetadata(id) }, authority }),
    service = Reader.createParticipantKnowledgeAtReader({ archiveReader, evidenceVerifier });
  return { root, authority, vault, setStore, archiveReader, service, accepted };
}

test("P5B-11 post-activation Evidence is verified without loading raw XLSX", async t => {
  const h = await evidenceHarness(t), result = await h.service.read(exact(D1, T1));
  assert.deepEqual([result.status, result.records[0].sourceEvidence.verification,
    result.records[0].sourceEvidence.roleCount], ["available", "metadata_verified", 4]);
  assert.doesNotMatch(JSON.stringify(result), /rawBytes|vaultPath|occurrenceId/);
});

test("P5B-12 tampered post-activation Evidence fails closed", async t => {
  const h = await evidenceHarness(t), id = h.accepted.revision.sourceEvidence.evidenceSetId,
    file = path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
      SetStore.DIRECTORY_NAME, `${SetStore.setDigest(id)}.json`), value =
      JSON.parse(fs.readFileSync(file, "utf8"));
  value.setHash = "0".repeat(64); fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  const result = await h.service.read(exact(D1, T1));
  assert.deepEqual([result.status, result.reason], ["invalid", "evidence_verification_failed"]);
});

test("P5B-13 overlapping revision intervals reject instead of choosing arbitrarily", async () => {
  const result = await reader([revision(D1, "a", T1, "2026-11-10T13:00:00.000Z"),
    revision(D1, "b", T2)]).read(exact(D1, "2026-11-10T12:30:00.000Z"));
  assert.deepEqual([result.status, result.reason], ["invalid", "overlapping_revision_interval"]);
});

test("P5B-14 interval gaps are not interpolated", async () => {
  const result = await reader([revision(D1, "a", T1, "2026-11-10T11:00:00.000Z"),
    revision(D1, "b", T2)]).read(exact(D1, "2026-11-10T11:30:00.000Z"));
  assert.deepEqual([result.status, result.reason], ["unavailable", "no_revision_known_at_time"]);
});

test("P5B-15 invalid and ambiguous timestamps reject", async () => {
  const service = reader([revision(D1, "a", T1)]);
  for (const knowledgeAt of ["invalid", "2026-11-10", "2026-11-10T10:00:00+09:00",
    "2026-11-10T10:00:00Z"])
    assert.equal((await service.read(exact(D1, knowledgeAt))).reason, "invalid_timestamp");
});

async function seed(indexedDB, databaseName, values) {
  const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange, databaseName }),
    db = await store.openArchive(), tx = db.transaction([Schema.META_STORE, Schema.ENTRY_STORE,
      Schema.REVISION_STORE], "readwrite"), dates = [...new Set(values.map(value => value.sourceDate))];
  for (const date of dates) {
    const own = values.filter(value => value.sourceDate === date), active = own.find(value =>
      value.replacedAt === null);
    tx.objectStore(Schema.ENTRY_STORE).put({ entryKey: Schema.entryKeyFor(date), sourceDate: date,
      activeRevisionKey: active.revisionKey, firstSeenAt: own[0].confirmedAt,
      lastSeenAt: active.confirmedAt });
  }
  for (const value of values) tx.objectStore(Schema.REVISION_STORE).put(value);
  tx.objectStore(Schema.META_STORE).put({ id: Schema.META_KEY, archiveSchemaVersion: 1,
    dataset: "participant", authorityClass: "formal", retentionPolicy: "preserve_formal_revisions",
    createdAt: values[0].confirmedAt, updatedAt: values.at(-1).confirmedAt,
    integrityAlgorithm: "sha256", entryCount: dates.length, revisionCount: values.length });
  await done(tx); store.closeArchive();
}

test("P5B-16 restart reopens the Formal archive and returns the identical result", async () => {
  const indexedDB = new FDBFactory(), databaseName = `optionmap-p5b-restart-${Date.now()}`,
    values = [revision(D1, "a", T1)];
  await seed(indexedDB, databaseName, values);
  const create = () => { const archiveReader = Store.createParticipantFormalArchiveStore({
    indexedDB, IDBKeyRange, databaseName }); return { archiveReader, service:
      Reader.createParticipantKnowledgeAtReader({ archiveReader, evidenceVerifier: {
        verifyRevision: async () => ({ verified: true }) } }) }; }, first = create(),
    before = await first.service.read(exact(D1, T1));
  first.archiveReader.closeArchive();
  const second = create(), after = await second.service.read(exact(D1, T1));
  assert.deepEqual(after, before); second.archiveReader.closeArchive();
});

test("P5B-17 legacy localStorage is never a knowledgeAt authority", () => {
  const source = fs.readFileSync(path.join(REPO, "js/participantKnowledgeAtReader.js"), "utf8");
  assert.doesNotMatch(source, /localStorage|participantHistory|legacyReader/);
});

test("P5B-18 dedicated reader performs no acquisition or write", async () => {
  const source = fs.readFileSync(path.join(REPO, "js/participantKnowledgeAtReader.js"), "utf8"),
    counters = { range: 0, revisions: 0, evidence: 0 }, service =
    Reader.createParticipantKnowledgeAtReader({ archiveReader: {
      async readRange() { counters.range += 1; return { status: "empty", entries: [] }; },
      async readEntryRevisions() { counters.revisions += 1; return { status: "empty", revisions: [] }; }
    }, evidenceVerifier: { async verifyRevision() { counters.evidence += 1;
      return { verified: true }; } } });
  await service.read({ mode: "latest_known", knowledgeAt: T1 });
  assert.deepEqual(counters, { range: 1, revisions: 0, evidence: 0 });
  assert.doesNotMatch(source, /fetch\(|\.put\(|\.add\(|readwrite|localStorage/);
});

test("P5B-19 malformed revision interval fails closed", async () => {
  const result = await reader([revision(D1, "a", T2, T1)]).read(exact(D1, T2));
  assert.deepEqual([result.status, result.reason], ["invalid", "malformed_revision_interval"]);
});
