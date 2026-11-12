"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");

const P1 = require("../js/participantAcquisitionAuthorityContract.js");
const P2 = require("../js/participantRawTransportShadow.js");
const Contract = require("../js/participantEvidenceSetContract.js");
const Shadow = require("../js/participantEvidenceVaultShadow.js");
const SetStore = require("../js/storage/participantEvidenceSetStore.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");

const REPO = path.join(__dirname, "..");
const DATE = "2026-11-10";
const NOW = new Date("2026-11-10T09:30:00.000Z");

function authority(suffix = "a") {
  return P1.createMainAuthority({ keyId: `participants-p3-${suffix}`,
    secret: Buffer.alloc(32, suffix.charCodeAt(0)) });
}

function workbook(role, date = DATE) {
  const book = XLSX.utils.book_new(), index = P1.ROLE_ORDER.indexOf(role);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["手口上位一覧"],
    [null, "取引日 Trading Date :", date.replaceAll("-", "")],
    ["NK225F", "161090018", `${role} CONTRACT`, 1, `00${index + 1}`,
      `${role}証券`, `${role} Securities`, 100 + index]
  ]), "Sheet1");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function response(bytes, mime = P2.MIME) {
  return new Response(bytes, { status: 200, headers: {
    "content-type": mime, "content-length": String(bytes.byteLength) } });
}

function chain({ date = DATE, suffix = "a", requestId = "participants-p3-request-1" } = {}) {
  const main = authority(suffix), intent = P1.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: date }),
    routes = Object.fromEntries(P1.ROLE_ORDER.map(role =>
      [role, P1.canonicalWorkbookUrl(role, date)])),
    discovery = P1.createOfficialDiscovery({ intent,
      discoveryKind: "official_monthly_listing",
      discoveryRequestId: `participants-p3-discovery-${suffix}`,
      officialUrl: P1.monthlyListingUrl(date), sourceDate: date,
      sourceUrls: routes, fallbackAttempt: null }),
    manifest = P1.createAcquisitionManifest({ intent, discovery, requestId }, main);
  return { main, manifest, acquisitions: P1.createWorkbookAcquisitions(manifest, main) };
}

function transport(main, date = DATE, mime = P2.MIME) {
  return P2.createParticipantsRawTransportShadow({ authority: main, now: () => NOW,
    fetchImpl: async url => {
      const role = P1.ROLE_ORDER.find(item => P1.canonicalWorkbookUrl(item, date) === url);
      return role ? response(workbook(role, date), mime) : new Response(null, { status: 404 });
    } });
}

function harness(t, options = {}) {
  const value = chain(options), root = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), "optionmap-p3-"))),
    vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null }),
    setStore = SetStore.createIsolatedParticipantEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }),
    transportShadow = transport(value.main, value.manifest.sourceDate),
    shadow = Shadow.createParticipantsEvidenceVaultShadow({ transportShadow, vault, setStore,
      authority: value.main, testHooks: options.testHooks || null });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...value, root, vault, setStore, transportShadow, shadow };
}

async function captured(t, options = {}) {
  const h = harness(t, options), result = await h.shadow.capture(h.manifest);
  assert.equal(result.status, "available");
  return { ...h, result };
}

function occurrenceFile(root, occurrenceId) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, "occurrences",
    `${occurrenceId.split(":").at(-1)}.json`);
}

function objectFile(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, "objects",
    sha256.slice(0, 2), sha256);
}

function setFile(root, evidenceSetId) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    SetStore.DIRECTORY_NAME, `${SetStore.setDigest(evidenceSetId)}.json`);
}

async function inputs(h) {
  const transportSet = await h.transportShadow.acquireManifest(h.manifest),
    occurrences = transportSet.results.map(result => {
      const acquisition = h.acquisitions.find(item => item.role === result.role),
        contentObject = Evidence.createContentObject({ bytes: result.bytes, mediaType: result.mime,
          encoding: null, policy: Contract.POLICY });
      return Contract.createOccurrence({ transportResult: result, acquisition, contentObject });
    });
  return { manifest: h.manifest, transportSet, acquisitions: h.acquisitions, occurrences };
}

test("P3-1 fixed-four capture persists one accepted set", async t => {
  const h = await captured(t);
  assert.deepEqual(h.result.evidenceSet.roles.map(item => item.role), P1.ROLE_ORDER);
  assert.deepEqual([h.vault.vaultStatus().occurrenceCount,
    h.result.diagnostics.evidenceSetWriteCount], [4, 1]);
});

test("P3-2 exact original XLSX bytes are recoverable for every role", async t => {
  const h = await captured(t), resolved = h.shadow.resolve(h.result.evidenceSet.evidenceSetId);
  assert.equal(resolved.status, "available");
  for (const document of resolved.documents)
    assert.deepEqual(new Uint8Array(document.bytes), workbook(document.role));
});

test("P3-3 identical content deduplicates across acquisitions", async t => {
  const h = await captured(t), second = chain({ requestId: "participants-p3-request-2" }),
    shadow = Shadow.createParticipantsEvidenceVaultShadow({ transportShadow: transport(h.main),
      vault: h.vault, setStore: h.setStore, authority: h.main, testHooks: null }),
    result = await shadow.capture(second.manifest);
  assert.deepEqual([result.status, result.diagnostics.contentWriteCount,
    result.diagnostics.occurrenceWriteCount], ["available", 0, 4]);
});

test("P3-4 repeated source bytes retain distinct acquisition occurrences", async t => {
  const h = await captured(t), second = chain({ requestId: "participants-p3-request-2" });
  const secondTransport = transport(h.main), secondShadow = Shadow.createParticipantsEvidenceVaultShadow({
    transportShadow: secondTransport, vault: h.vault, setStore: h.setStore,
    authority: h.main, testHooks: null });
  const result = await secondShadow.capture(second.manifest);
  assert.equal(result.status, "available");
  const sha = h.result.evidenceSet.roles[0].contentSha256;
  assert.equal(h.vault.occurrencesByContentSha256(sha).length, 2);
});

test("P3-5 exact duplicate capture is write-zero", async t => {
  const h = await captured(t), duplicate = await h.shadow.capture(h.manifest);
  assert.deepEqual([duplicate.diagnostics.contentWriteCount,
    duplicate.diagnostics.occurrenceWriteCount, duplicate.diagnostics.evidenceSetWriteCount], [0, 0, 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 4);
});

test("P3-6 set identity is deterministic under occurrence input order", async t => {
  const h = await captured(t), value = await inputs(h), reordered = Contract.createEvidenceSet({
    ...value, occurrences: [...value.occurrences].reverse() }, h.main);
  assert.equal(reordered.evidenceSetId, h.result.evidenceSet.evidenceSetId);
});

test("P3-7 a missing role cannot create a set", async t => {
  const h = harness(t), value = await inputs(h);
  assert.throws(() => Contract.createEvidenceSet({ ...value,
    occurrences: value.occurrences.slice(0, 3) }, h.main), /input_invalid/);
});

test("P3-8 a duplicate role cannot create a set", async t => {
  const h = harness(t), value = await inputs(h), duplicated = [...value.occurrences];
  duplicated[3] = duplicated[0];
  assert.throws(() => Contract.createEvidenceSet({ ...value, occurrences: duplicated }, h.main),
    /roles_invalid/);
});

test("P3-9 mixed source-date evidence is rejected", async t => {
  const h = harness(t), value = await inputs(h), mixed = structuredClone(value.occurrences);
  mixed[0].runId = chain({ date: "2026-11-09", requestId: "participants-p3-old" }).manifest.runId;
  assert.throws(() => Contract.createEvidenceSet({ ...value, occurrences: mixed }, h.main),
    /binding_invalid/);
});

test("P3-10 mixed run evidence is rejected", async t => {
  const h = harness(t), value = await inputs(h), mixed = structuredClone(value.occurrences);
  mixed[0].runId = chain({ requestId: "participants-p3-other" }).manifest.runId;
  assert.throws(() => Contract.createEvidenceSet({ ...value, occurrences: mixed }, h.main),
    /binding_invalid/);
});

test("P3-11 wrong role or URL occurrence binding is rejected", async t => {
  const h = harness(t), value = await inputs(h), wrong = structuredClone(value.occurrences[0]);
  wrong.sourceUrl = value.occurrences[1].sourceUrl;
  assert.equal(Contract.validateOccurrenceBinding(wrong, value.transportSet.results[0],
    value.acquisitions[0]), false);
  const forged = structuredClone(value.transportSet);
  forged.authoritySignature = "0".repeat(64);
  assert.throws(() => Contract.createEvidenceSet({ ...value, transportSet: forged }, h.main),
    /input_invalid/);
});

test("P3-12 raw object tampering fails closed", async t => {
  const h = await captured(t), entry = h.result.evidenceSet.roles[0], file = objectFile(h.root,
    entry.contentSha256), bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.equal(h.shadow.resolve(h.result.evidenceSet.evidenceSetId).reason,
    "evidence_set_integrity_invalid");
});

test("P3-13 occurrence tampering fails closed", async t => {
  const h = await captured(t), id = h.result.evidenceSet.roles[0].occurrenceId,
    file = occurrenceFile(h.root, id), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.occurrence.httpStatus = 201; fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  assert.equal(h.shadow.resolve(h.result.evidenceSet.evidenceSetId).reason,
    "evidence_set_integrity_invalid");
});

test("P3-14 evidence-set hash tampering fails closed", async t => {
  const h = await captured(t), id = h.result.evidenceSet.evidenceSetId, file = setFile(h.root, id),
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.setHash = "0".repeat(64); fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  assert.equal(h.shadow.resolve(id).reason, "evidence_set_integrity_invalid");
});

test("P3-15 parser rejection retains raw evidence but writes no accepted set", async t => {
  const h = harness(t, { testHooks: { rejectParserRole: "nightJnet" } }),
    result = await h.shadow.capture(h.manifest), setDirectory = path.join(h.root,
      Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, SetStore.DIRECTORY_NAME);
  assert.deepEqual([result.reason, result.diagnostics.retainedOccurrenceCount,
    h.vault.vaultStatus().occurrenceCount, fs.existsSync(setDirectory)],
  ["parser_binding_rejected", 4, 4, false]);
});

test("P3-16 restart read verifies set, occurrences and bytes", async t => {
  const h = await captured(t), reopenedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }),
    reopenedStore = SetStore.createIsolatedParticipantEvidenceSetStore({ root: h.root,
      targetEnvironment: "isolated_test" }), reopened = Shadow.createParticipantsEvidenceVaultShadow({
      transportShadow: h.transportShadow, vault: reopenedVault, setStore: reopenedStore,
      authority: h.main, testHooks: null }), result = reopened.resolve(h.result.evidenceSet.evidenceSetId);
  assert.deepEqual([result.status, result.documents.length], ["available", 4]);
  for (const document of result.documents)
    assert.equal(crypto.createHash("sha256").update(document.bytes).digest("hex"),
      document.occurrence.contentSha256);
});

test("P3-17 cross-domain source evidence cannot validate as Participants", async t => {
  const h = await captured(t), foreign = structuredClone(h.result.evidenceSet);
  foreign.sourceId = "bls-cpi";
  assert.equal(Contract.validateEvidenceSet(foreign, h.main), false);
});

test("P3-18 renderer cannot supply bytes, paths, or arbitrary records", () => {
  const source = fs.readFileSync(path.join(REPO, "js/participantEvidenceVaultShadow.js"), "utf8");
  assert.doesNotMatch(source, /ipcMain|ipcRenderer|webContents|storagePath|rendererRecord/);
  assert.match(source, /transportShadow\.acquireManifest\(manifest\)/);
});

test("P3-19 production activation keeps Evidence separate from legacy renderer history", () => {
  const files = ["main.js", "preload.js", "index.html"].map(file =>
    fs.readFileSync(path.join(REPO, file), "utf8")).join("\n");
  assert.match(files, /participantEvidenceVaultShadow/);
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "js/participantEvidenceVaultShadow.js"), "utf8"),
    /participantHistory|formalParticipant|saveParticipant/);
});

test("P3-20 production activation is main-owned behind a bounded Participants IPC", () => {
  const production = ["main.js", "preload.js", "index.html", "js/participantData.js",
    "js/participantHistory.js"].map(file => fs.readFileSync(path.join(REPO, file), "utf8")).join("\n");
  assert.match(production, /participantEvidenceVaultShadow|participantEvidenceSetStore/);
  assert.match(production, /acquire-participants/);
  assert.doesNotMatch(production, /fetch-jpx-participant-json|fetchParticipantListing/);
});

test("MIME-11 actual JPX binary MIME is retained in all four Evidence occurrences", async t => {
  const value = chain({ suffix: "m", requestId: "participants-p3-binary" }), root =
    fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-p3-mime-"))),
    vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null }),
    setStore = SetStore.createIsolatedParticipantEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }), transportShadow = transport(value.main,
      value.manifest.sourceDate, P2.BINARY_MIME), shadow =
      Shadow.createParticipantsEvidenceVaultShadow({ transportShadow, vault, setStore,
        authority: value.main, testHooks: null });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captured = await shadow.capture(value.manifest);
  assert.equal(captured.status, "available");
  const resolved = shadow.resolve(captured.evidenceSet.evidenceSetId);
  assert.equal(resolved.status, "available");
  assert.deepEqual(resolved.documents.map(document => document.occurrence.mediaType),
    P1.ROLE_ORDER.map(() => P2.BINARY_MIME));
  assert.ok(captured.evidenceSet.roles.every(entry =>
    vault.readContentMetadata(entry.contentSha256).contentObject.mediaType === P2.BINARY_MIME));
});
