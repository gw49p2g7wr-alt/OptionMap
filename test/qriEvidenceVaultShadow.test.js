"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Raw = require("../js/qriRawTransportShadow.js");
const QriEvidence = require("../js/qriEvidenceVaultShadow.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Parser = require("../js/qriOptions.js");
const { rawQriBytes } = require("./fixtures/qri/rawQriPageFixture.js");

const ROOT = path.join(__dirname, "..");
const NOW = "2026-11-10T00:30:00.000Z";
const SECRET = "qri-main-evidence-fixture-secret-32-bytes-minimum";

function authority() {
  return Qri.createMainAuthority({ keyId: "qri-main-evidence-v1", secret: SECRET });
}

function response(bytes = rawQriBytes) {
  return { kind: "response", statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8",
      "content-length": String(bytes.byteLength) }, body: bytes };
}

function rawTransport(main, bytes = rawQriBytes, calls = []) {
  const requestClient = { async requestOnce(options) { calls.push(options); return response(bytes); } };
  return Raw.createDefaultQriRawTransportShadow({ authority: main, requestClient,
    warmupSession: async () => ({ accepted: true, reason: null }), now: () => NOW });
}

function activeInput(changes = {}) {
  return { intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
    authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
    runId: "q3-run-1", requestId: "q3-request-1", ...changes };
}

function isolatedVault(t, crashAt = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-qri-q3-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault: Vault.createIsolatedVault({ root,
    targetEnvironment: "isolated_test", crashAt }) };
}

function harness(t, options = {}) {
  const main = options.authority || authority();
  const isolated = options.vault ? { root: null, vault: options.vault } :
    isolatedVault(t, options.crashAt || null);
  const calls = [];
  const raw = options.rawTransport || rawTransport(main, options.bytes || rawQriBytes, calls);
  return { main, calls, raw, ...isolated,
    shadow: QriEvidence.createQriEvidenceVaultShadow({ rawTransportShadow: raw,
      vault: isolated.vault, authority: main }) };
}

function occurrence(h, result) {
  return h.vault.readOccurrence(result.receipt.evidenceStatus.occurrenceId);
}

async function active(h, changes = {}) {
  return h.shadow.acquire(activeInput(changes));
}

async function childContext(h, role) {
  const parent = await active(h);
  assert.equal(parent.status, "available");
  const manifest = Qri.createParentManifest({ parentReceipt: parent.receipt, entries: [
    { contractIdentity: Qri.createContractIdentity("2026-12"),
      canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1", allowedRoles: ["major_sq", "next"] }
  ] }, h.main);
  const entry = manifest.entries[0];
  return { parent, manifest, entry, input: {
    intent: Qri.createAcquisitionIntent({ requestKind: "listed_reference", role,
      parentAcquisitionId: parent.receipt.acquisitionId,
      listedContractId: entry.listedContractId }),
    authorityContext: { parentManifest: manifest, parentReceipt: parent.receipt,
      authority: h.main }, runId: `q3-${role}-run`, requestId: `q3-${role}-request` } };
}

test("Q3-1 normal active acquisition stores raw bytes and issues Evidence-bound receipt", async t => {
  const h = harness(t), result = await active(h), saved = occurrence(h, result);
  assert.equal(result.status, "available");
  assert.equal(result.receipt.contractVersion, Qri.RECEIPT_V3_VERSION);
  assert.equal(result.receipt.evidenceStatus.state, "available");
  assert.deepEqual(h.vault.readRawBytes(result.receipt.evidenceStatus.contentSha256), rawQriBytes);
  assert.equal(QriEvidence.validateOccurrenceAgainstReceipt(result.receipt, saved, h.main), true);
  assert.deepEqual([h.calls.length, result.diagnostics.contentWriteCount,
    result.diagnostics.occurrenceWriteCount], [1, 1, 1]);
});

test("Q3-2 restart preserves and verifies content plus occurrence", async t => {
  const h = harness(t), result = await active(h), reopened = Vault.createIsolatedVault({
    root: h.root, targetEnvironment: "isolated_test", crashAt: null });
  assert.equal(reopened.verifyContent(result.receipt.evidenceStatus.contentSha256).status, "valid");
  assert.equal(reopened.verifyOccurrence(result.receipt.evidenceStatus.occurrenceId).status, "valid");
  assert.equal(QriEvidence.validateOccurrenceAgainstReceipt(result.receipt,
    reopened.readOccurrence(result.receipt.evidenceStatus.occurrenceId), h.main), true);
});

test("Q3-3 receipt, transport and Vault SHA agree exactly", async t => {
  const h = harness(t), result = await active(h), sha = Raw.sha256Bytes(rawQriBytes);
  assert.deepEqual([result.receipt.evidenceStatus.contentSha256,
    result.receipt.transportIdentity.contentSha256,
    result.receipt.parserInputIdentity.rawContentSha256,
    h.vault.readContentMetadata(sha).contentObject.sha256], [sha, sha, sha, sha]);
});

test("Q3-4 byte length agrees across transport, occurrence, metadata and raw readback", async t => {
  const h = harness(t), result = await active(h), saved = occurrence(h, result),
    sha = result.receipt.evidenceStatus.contentSha256;
  assert.deepEqual([result.receipt.transportIdentity.byteLength, saved.byteLength,
    h.vault.readContentMetadata(sha).contentObject.byteLength,
    h.vault.readRawBytes(sha).byteLength], Array(4).fill(rawQriBytes.byteLength));
});

test("Q3-5 same bytes dedupe content and different acquisition creates occurrence", async t => {
  const h = harness(t), first = await active(h), second = await active(h,
    { requestId: "q3-request-2" });
  assert.equal(first.receipt.evidenceStatus.contentSha256,
    second.receipt.evidenceStatus.contentSha256);
  assert.notEqual(first.receipt.evidenceStatus.occurrenceId,
    second.receipt.evidenceStatus.occurrenceId);
  assert.equal(second.diagnostics.contentClassification, "verified_reuse");
  assert.equal(h.vault.occurrencesByContentSha256(
    first.receipt.evidenceStatus.contentSha256).length, 2);
});

test("Q3-6 exact occurrence duplicate is write0", async t => {
  const h = harness(t), first = await active(h), second = await active(h);
  assert.equal(second.receipt.evidenceStatus.occurrenceId,
    first.receipt.evidenceStatus.occurrenceId);
  assert.deepEqual([second.diagnostics.occurrenceClassification,
    second.diagnostics.contentWriteCount, second.diagnostics.occurrenceWriteCount],
  ["exact_duplicate", 0, 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
});

test("Q3-7 active occurrence binds role, contract context and Q1 acquisition", async t => {
  const h = harness(t), result = await active(h), saved = occurrence(h, result);
  assert.deepEqual([saved.requestRole, saved.runId, saved.sourceDocumentRole,
    result.receipt.contractIdentity.contract, result.receipt.contractIdentity.gengetsu],
  ["active", result.receipt.acquisitionId, result.receipt.evidenceStatus.contextIdentity,
    "2026-11", "202611"]);
  assert.deepEqual([result.receipt.evidenceStatus.parentManifestId,
    result.receipt.evidenceStatus.listedContractId], [null, null]);
});

test("Q3 redirect evidence is retained in the immutable occurrence", async t => {
  const main = authority(), calls = [], responses = [
    { kind: "redirect", statusCode: 301, redirectUrl: "https://svc.qri.jp/jpx/nkopm" },
    response()
  ];
  const requestClient = { async requestOnce(options) {
    calls.push(options);
    return responses.shift();
  } };
  const raw = Raw.createDefaultQriRawTransportShadow({ authority: main, requestClient,
    warmupSession: async () => ({ accepted: true, reason: null }), now: () => NOW });
  const h = harness(t, { authority: main, rawTransport: raw }), result = await active(h),
    saved = occurrence(h, result);
  assert.equal(calls.length, 2);
  assert.deepEqual(saved.redirectHops,
    [{ status: 301, url: "https://svc.qri.jp/jpx/nkopm" }]);
  assert.deepEqual(result.receipt.transportIdentity.redirectHops, [{ status: 301,
    fromUrl: Qri.ACTIVE_URL, toUrl: "https://svc.qri.jp/jpx/nkopm" }]);
  assert.equal(QriEvidence.validateOccurrenceAgainstReceipt(result.receipt, saved, main), true);
});

test("Q3-8 next child preserves parent manifest, listed contract and acquisition lineage", async t => {
  const h = harness(t), child = await childContext(h, "next"),
    result = await h.shadow.acquire(child.input), saved = occurrence(h, result);
  assert.equal(result.status, "available");
  assert.deepEqual([result.receipt.role, result.receipt.parentAcquisitionId,
    result.receipt.evidenceStatus.parentManifestId,
    result.receipt.evidenceStatus.listedContractId, saved.requestRole],
  ["next", child.parent.receipt.acquisitionId, child.manifest.manifestId,
    child.entry.listedContractId, "next"]);
});

test("Q3-9 Major SQ child uses the same bounded parent lineage contract", async t => {
  const h = harness(t), child = await childContext(h, "major_sq"),
    result = await h.shadow.acquire(child.input), saved = occurrence(h, result);
  assert.equal(result.status, "available");
  assert.deepEqual([result.receipt.role, result.receipt.contractIdentity.contract,
    saved.requestRole, saved.sourceDocumentRole],
  ["major_sq", "2026-12", "major_sq", result.receipt.evidenceStatus.contextIdentity]);
});

test("Q3-10 forged parent rejects before any Vault write", async t => {
  const h = harness(t), child = await childContext(h, "next"), before = h.vault.vaultStatus(),
    tampered = structuredClone(child.manifest);
  tampered.entries[0].canonicalUrl = "https://svc.qri.jp/jpx/nkopm/2";
  child.input.authorityContext.parentManifest = tampered;
  const result = await h.shadow.acquire(child.input);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(h.vault.vaultStatus(), before);
});

test("Q3-11 forged contract or role receipt rejects before Vault write", async t => {
  const h = harness(t), original = await h.raw.acquire(activeInput());
  const forgedReceipt = field => {
    const receipt = structuredClone(original.receipt);
    if (field === "role") receipt.role = "next";
    else receipt.contractIdentity = Qri.createContractIdentity("2026-12");
    return { ...original, receipt };
  };
  for (const field of ["role", "contract"]) {
    const shadow = QriEvidence.createQriEvidenceVaultShadow({
      rawTransportShadow: { acquire: async () => forgedReceipt(field) },
      vault: h.vault, authority: h.main });
    assert.equal((await shadow.acquire(activeInput())).status, "unavailable");
  }
  assert.equal(h.vault.vaultStatus().status, "absent");
});

test("Q3-12 content Vault failure returns no receipt or parser input and does not refetch", async t => {
  const main = authority(), calls = [], raw = rawTransport(main, rawQriBytes, calls), vault = {
    storeAcceptedEvidence() { throw new Error("object_write_failed"); },
    verifyContent() {}, verifyOccurrence() {}, readRawBytes() {}, readOccurrence() {}
  }, h = harness(t, { authority: main, rawTransport: raw, vault }), result = await active(h);
  assert.deepEqual([result.reason, result.receipt, result.parserInput, calls.length],
    ["evidence_content_persistence_failed", null, null, 1]);
});

test("Q3-13 occurrence persistence failure issues no Evidence receipt", async t => {
  const h = harness(t, { crashAt: "before_occurrence_persistence" }), result = await active(h);
  assert.deepEqual([result.reason, result.receipt, result.parserInput],
    ["evidence_occurrence_persistence_failed", null, null]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 0);
  assert.equal(h.vault.listOrphanContentObjects().length, 1);
});

test("Q3-14 signed receipt rejects Evidence occurrence, SHA and role tampering", async t => {
  const h = harness(t), result = await active(h);
  for (const mutate of [
    value => { value.evidenceStatus.occurrenceId = `source-occurrence-v1|sha256:${"f".repeat(64)}`; },
    value => { value.evidenceStatus.contentSha256 = "f".repeat(64); },
    value => { value.evidenceStatus.role = "next"; }
  ]) {
    const forged = structuredClone(result.receipt); mutate(forged);
    assert.equal(Qri.validateAcquisitionReceipt(forged, h.main), false);
  }
});

test("Q3-15 parser-input substitution fails receipt binding", async t => {
  const h = harness(t), result = await active(h);
  assert.equal(Qri.validateDecodedParserInputAgainstReceipt(result.receipt,
    result.parserInput, h.main), true);
  assert.equal(Qri.validateDecodedParserInputAgainstReceipt(result.receipt,
    `${result.parserInput}<!-- substituted -->`, h.main), false);
});

test("Q3-16 renderer-facing result has no raw bytes, path or write capability", async t => {
  const h = harness(t), result = await active(h), serialized = JSON.stringify(result);
  assert.equal(Object.hasOwn(result, "copyRawBytesForMainShadow"), false);
  assert.equal(Object.hasOwn(result, "rawFacts"), false);
  assert.doesNotMatch(serialized, /vaultPath|tempPath|rawBytes|cookie|set-cookie/i);
  assert.equal(result.diagnostics.rawPayloadExposed, false);
  assert.equal(result.diagnostics.storageLocationExposed, false);
});

test("Q3-17 IV inherits one QRI occurrence without creating an IV occurrence", async t => {
  const h = harness(t), result = await active(h), before = h.vault.vaultStatus().occurrenceCount,
    inherited = Qri.createIvReceiptInheritanceV2(result.receipt, {
      source: Qri.IV_SOURCE_ID, sourceUrl: result.receipt.acceptedFinalUrl,
      contract: "2026-11", tradingDate: "2026-11-10" }, h.main);
  assert.equal(inherited.accepted, true);
  assert.deepEqual([inherited.inheritance.parentAcquisitionId,
    inherited.inheritance.occurrenceId, inherited.inheritance.rawContentSha256,
    inherited.inheritance.parserInputIdentity],
  [result.receipt.acquisitionId, result.receipt.evidenceStatus.occurrenceId,
    result.receipt.evidenceStatus.contentSha256, result.receipt.parserInputIdentity]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, before);
});

test("Q3-18 QRI Options Evidence never acquires Futures source authority", async t => {
  const h = harness(t), result = await active(h), saved = occurrence(h, result),
    serialized = JSON.stringify({ receipt: result.receipt, occurrence: saved });
  assert.equal(result.receipt.sourceId, Qri.SOURCE_ID);
  assert.equal(saved.sourceId, Qri.SOURCE_ID);
  assert.equal(serialized.includes(Qri.FUTURES_SOURCE_ID), false);
});

test("Q3-19 later parser rejection retains valid orphan shadow Evidence and Formal0", async t => {
  const invalidPage = Buffer.from("<html><head><meta charset=utf-8></head><body>no table</body></html>"),
    h = harness(t, { bytes: invalidPage }), result = await active(h);
  assert.equal(result.status, "available");
  assert.throws(() => Parser.parseQriOptionsPage(result.parserInput, Qri.ACTIVE_URL),
    /qri_metadata_invalid/);
  assert.equal(h.vault.verifyOccurrence(result.receipt.evidenceStatus.occurrenceId).status, "valid");
  assert.equal(result.diagnostics.formalWriteCount, 0);
});

test("Q3-20 production QRI activates Vault while UI and export remain raw-free", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.match(main, /require\("\.\/js\/qriEvidenceVaultShadow\.js"\)/);
  for (const file of ["index.html", "js/qriOptions.js", "js/qriOptionsHistory.js",
    "js/fullExportCollector.js"]) assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, file), "utf8"), /readRawBytes|rawBytes|sourceEvidenceVault/);
  const shadow = fs.readFileSync(path.join(ROOT, "js/qriEvidenceVaultShadow.js"), "utf8");
  assert.doesNotMatch(shadow, /indexedDB|localStorage|ipcMain|ipcRenderer|BrowserWindow|FullExport/);
});
