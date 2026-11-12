"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Contract = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");

const bytes = value => Buffer.from(value, "utf8");
const policy = (patch = {}) => Contract.createSourcePolicy({
  sourceFamily: "economic_values", sourceId: "us-bls-cpi-values",
  allowedMediaTypes: ["text/html"], allowedEncodings: ["utf-8"], maxBytes: 1_000_000,
  ...patch
});
const content = (raw, sourcePolicy = policy(), patch = {}) => Contract.createContentObject({
  bytes: raw, mediaType: "text/html", encoding: "utf-8", policy: sourcePolicy, ...patch
});
const occurrence = (contentObject, sourcePolicy = policy(), patch = {}) =>
  Contract.createAcquisitionOccurrence({
    sourceFamily: sourcePolicy.sourceFamily, sourceId: sourcePolicy.sourceId,
    initialUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    sourceUrl: "https://www.bls.gov/news.release/cpi.nr0.htm",
    fetchedAt: "2026-11-05T00:00:00.000Z", httpStatus: 200, contentObject,
    transportVersion: "bls-fixed-transport-v1", publishedAt: "2026-11-05T00:00:00.000Z",
    requestRole: "official_release", redirectHops: [], sourceDocumentRole: "official_release",
    runId: "run-2026-11-05", acquisitionContext: "live_original_acquisition", ...patch
  }, sourcePolicy);

function bundle(value = "<html>exact\r\nbytes</html>", patch = {}) {
  const raw = Buffer.isBuffer(value) ? value : bytes(value), sourcePolicy = patch.policy || policy(),
    contentObject = patch.contentObject || content(raw, sourcePolicy), acquired = patch.occurrence ||
      occurrence(contentObject, sourcePolicy, patch.occurrencePatch || {});
  return { bytes: raw, contentObject, occurrence: acquired, policy: sourcePolicy };
}

function fixture(t, crashAt = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-evidence-vault-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault: Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt }) };
}

function vaultPath(root, ...parts) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, ...parts);
}

function objectPath(root, sha256) {
  return vaultPath(root, Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

function metadataPath(root, sha256) {
  return vaultPath(root, Vault.DIRECTORY_NAMES.metadata, sha256.slice(0, 2), `${sha256}.json`);
}

function occurrencePath(root, occurrenceId) {
  return vaultPath(root, Vault.DIRECTORY_NAMES.occurrences,
    `${occurrenceId.slice(occurrenceId.lastIndexOf(":") + 1)}.json`);
}

test("R2-1 first exact text object and occurrence survive a fresh restart", t => {
  const { root, vault } = fixture(t), input = bundle();
  const saved = vault.storeAcceptedEvidence(input);
  assert.deepEqual([saved.classification, saved.contentWriteCount, saved.occurrenceWriteCount],
    ["new_occurrence", 1, 1]);
  const restarted = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null });
  assert.deepEqual(restarted.readRawBytes(input.contentObject.sha256), input.bytes);
  assert.equal(restarted.verifyEvidence(input.occurrence.occurrenceId).status, "valid");
  assert.equal(restarted.vaultStatus().status, "active");
});

test("metadata-only verification validates occurrence lineage without returning raw bytes", t => {
  const { vault } = fixture(t), input = bundle();
  vault.storeAcceptedEvidence(input);
  const contentStatus = vault.verifyContentMetadata(input.contentObject.sha256),
    occurrenceStatus = vault.verifyOccurrenceMetadata(input.occurrence.occurrenceId);
  assert.deepEqual([contentStatus.status, contentStatus.verificationScope,
    occurrenceStatus.status, occurrenceStatus.verificationScope],
  ["valid", "metadata_and_file_size", "valid", "metadata_and_file_size"]);
  assert.equal(JSON.stringify({ contentStatus, occurrenceStatus }).includes("exact\r\nbytes"), false);
});

test("R2-2 exact binary object survives restart without decoding", t => {
  const { root, vault } = fixture(t), binary = Buffer.from([0x50, 0x4b, 0, 1, 255]),
    sourcePolicy = policy({ allowedMediaTypes:
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      allowedEncodings: [], maxBytes: 4096 }), contentObject = Contract.createContentObject({
      bytes: binary, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      encoding: null, policy: sourcePolicy }), acquired = occurrence(contentObject, sourcePolicy);
  vault.storeAcceptedEvidence({ bytes: binary, contentObject, occurrence: acquired, policy: sourcePolicy });
  const restarted = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null });
  assert.deepEqual(restarted.readRawBytes(contentObject.sha256), binary);
});

test("R2-3 same bytes dedupe to one object while retaining multiple occurrences", t => {
  const { vault } = fixture(t), first = bundle("same bytes"), secondOccurrence =
    occurrence(first.contentObject, first.policy, { fetchedAt: "2026-11-05T01:00:00.000Z",
      publishedAt: "2026-11-05T01:00:00.000Z", runId: "run-2026-11-05-2" });
  const left = vault.storeAcceptedEvidence(first), right = vault.storeAcceptedEvidence({ ...first,
    occurrence: secondOccurrence });
  assert.deepEqual([left.contentWriteCount, right.contentWriteCount, right.contentClassification],
    [1, 0, "verified_reuse"]);
  assert.equal(vault.occurrencesByContentSha256(first.contentObject.sha256).length, 2);
});

test("R2 content identity remains byte-addressed when later accepted MIME metadata differs", t => {
  const { vault } = fixture(t), raw = bytes("same exact bytes"), first = bundle(raw), secondPolicy =
    policy({ allowedMediaTypes: ["application/octet-stream"], allowedEncodings: [] }),
    secondContent = Contract.createContentObject({ bytes: raw, mediaType: "application/octet-stream",
      encoding: null, policy: secondPolicy }), secondOccurrence = occurrence(secondContent, secondPolicy, {
      fetchedAt: "2026-11-05T01:00:00.000Z", publishedAt: "2026-11-05T01:00:00.000Z",
      runId: "run-alternate-metadata" });
  vault.storeAcceptedEvidence(first);
  const saved = vault.storeAcceptedEvidence({ bytes: raw, contentObject: secondContent,
    occurrence: secondOccurrence, policy: secondPolicy });
  assert.equal(first.contentObject.sha256, secondContent.sha256);
  assert.equal(saved.contentClassification, "verified_reuse");
  assert.equal(vault.verifyOccurrence(secondOccurrence.occurrenceId).status, "valid");
});

test("R2-4 deterministic duplicate occurrence is exact write0", t => {
  const { vault } = fixture(t), input = bundle(); vault.storeAcceptedEvidence(input);
  const duplicate = vault.storeAcceptedEvidence(input);
  assert.deepEqual([duplicate.classification, duplicate.contentWriteCount,
    duplicate.metadataWriteCount, duplicate.occurrenceWriteCount, duplicate.committed],
  ["exact_duplicate", 0, 0, 0, false]);
});

test("R2-5 same URL with changed bytes retains two immutable objects", t => {
  const { root, vault } = fixture(t), first = bundle("raw A"), second = bundle("raw B", {
    occurrencePatch: { fetchedAt: "2026-11-05T01:00:00.000Z",
      publishedAt: "2026-11-05T01:00:00.000Z", runId: "run-b" } });
  vault.storeAcceptedEvidence(first); vault.storeAcceptedEvidence(second);
  assert.notEqual(first.contentObject.sha256, second.contentObject.sha256);
  assert.deepEqual(fs.readFileSync(objectPath(root, first.contentObject.sha256)), first.bytes);
  assert.deepEqual(fs.readFileSync(objectPath(root, second.contentObject.sha256)), second.bytes);
});

test("R2-6 existing valid object is verified and reused without rewrite", t => {
  const { root, vault } = fixture(t), input = bundle(); vault.storeAcceptedEvidence(input);
  const target = objectPath(root, input.contentObject.sha256), before = fs.statSync(target).mtimeMs,
    later = occurrence(input.contentObject, input.policy, { fetchedAt: "2026-11-05T02:00:00.000Z",
      publishedAt: "2026-11-05T02:00:00.000Z", runId: "run-later" });
  const result = vault.storeAcceptedEvidence({ ...input, occurrence: later });
  assert.equal(result.contentClassification, "verified_reuse");
  assert.equal(fs.statSync(target).mtimeMs, before);
});

test("R2-7 existing corrupted object fails closed and is never overwritten", t => {
  const { root, vault } = fixture(t), input = bundle("original"); vault.storeAcceptedEvidence(input);
  const target = objectPath(root, input.contentObject.sha256), tampered = Buffer.alloc(input.bytes.length, 0x78);
  fs.writeFileSync(target, tampered); const later = occurrence(input.contentObject, input.policy, {
    fetchedAt: "2026-11-05T03:00:00.000Z", publishedAt: "2026-11-05T03:00:00.000Z",
    runId: "run-later" });
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, occurrence: later }),
    /existing_content_integrity_failure/);
  assert.deepEqual(fs.readFileSync(target), tampered);
});

test("R2-8 hash mismatch input rejects before vault initialization", t => {
  const { vault } = fixture(t), input = bundle("accepted");
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, bytes: bytes("tampered") }),
    /content_input_integrity_invalid/);
  assert.equal(vault.vaultStatus().status, "absent");
});

test("R2-9 declared byte-length mismatch rejects", t => {
  const { vault } = fixture(t), input = bundle("length"), contentObject =
    { ...input.contentObject, byteLength: input.contentObject.byteLength + 1 }, acquired =
    occurrence(contentObject, input.policy);
  assert.equal(Contract.validateContentObject(contentObject), true);
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, contentObject, occurrence: acquired }),
    /content_input_integrity_invalid/);
});

test("R2-10 MIME mismatch rejects under the supplied source policy", t => {
  const { vault } = fixture(t), input = bundle(), mismatched = policy({
    allowedMediaTypes: ["application/json"] });
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, policy: mismatched }),
    /vault_store_contract_invalid/);
});

test("R2-11 oversize input rejects under source-specific maxBytes", t => {
  const { vault } = fixture(t), input = bundle("oversize"), tiny = policy({ maxBytes: 2 });
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, policy: tiny }),
    /vault_store_contract_invalid/);
});

test("R2-12 unknown future vault schema fails closed for content and occurrence", t => {
  const { root, vault } = fixture(t), input = bundle(); vault.storeAcceptedEvidence(input);
  const contentFile = metadataPath(root, input.contentObject.sha256), contentRecord =
    JSON.parse(fs.readFileSync(contentFile, "utf8")); contentRecord.vaultSchemaVersion = 2;
  fs.writeFileSync(contentFile, JSON.stringify(contentRecord));
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "unsupported_version");
  const occurrenceFile = occurrencePath(root, input.occurrence.occurrenceId), occurrenceRecord =
    JSON.parse(fs.readFileSync(occurrenceFile, "utf8")); occurrenceRecord.vaultSchemaVersion = 2;
  fs.writeFileSync(occurrenceFile, JSON.stringify(occurrenceRecord));
  assert.equal(vault.verifyOccurrence(input.occurrence.occurrenceId).status, "unsupported_version");
});

test("R2-13 symlink, hardlink, traversal and Windows separator injection fail closed", t => {
  const { root, vault } = fixture(t), outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-evidence-outside-")); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, Vault.VAULT_DIRECTORY));
  assert.throws(() => vault.storeAcceptedEvidence(bundle()), /vault_path_unsafe/);
  assert.throws(() => Vault.contentAddressParts("../"), /content_sha256_invalid/);
  const sha = "a".repeat(64), windowsRoot = "C:\\Users\\natsu\\OptionMap\\source-evidence-vault\\v1",
    windowsTarget = path.win32.join(windowsRoot, "objects", ...Vault.contentAddressParts(sha));
  assert.equal(Filesystem.contains(windowsRoot, windowsTarget, "win32"), true);
  assert.equal(Vault.contentAddressParts(sha).some(part => /[\\/:]/.test(part)), false);
});

test("R2-14 arbitrary destination injection is impossible through exact writer input", t => {
  const { vault } = fixture(t), input = { ...bundle(), destination: "/tmp/attacker" };
  assert.throws(() => vault.storeAcceptedEvidence(input), /vault_store_input_invalid/);
});

test("R2-15 secret headers, secret query and local path metadata are rejected", t => {
  const { vault } = fixture(t), input = bundle();
  assert.throws(() => vault.storeAcceptedEvidence({ ...input, headers: { Authorization: "secret" } }),
    /vault_store_input_invalid/);
  assert.equal(Contract.canonicalHttpsUrl("https://example.test/data?token=secret"), null);
  assert.equal(Contract.canonicalHttpsUrl("file:///Users/natsu/private"), null);
});

test("R2-16 crash before object rename leaves no accepted object, occurrence or temp", t => {
  const { root, vault } = fixture(t, "before_object_rename"), input = bundle();
  assert.throws(() => vault.storeAcceptedEvidence(input), /vault_transaction_aborted/);
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "missing");
  assert.equal(vault.verifyOccurrence(input.occurrence.occurrenceId).status, "missing");
  assert.deepEqual(fs.readdirSync(vaultPath(root, Vault.DIRECTORY_NAMES.temporary)), []);
  assert.deepEqual(vault.vaultStatus(), { status: "empty", occurrenceCount: 0 });
});

test("R2-17 promoted object with occurrence failure remains a visible harmless orphan", t => {
  const { root, vault } = fixture(t, "before_occurrence_persistence"), input = bundle();
  assert.throws(() => vault.storeAcceptedEvidence(input), /vault_transaction_aborted/);
  const restarted = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null });
  assert.equal(restarted.verifyContent(input.contentObject.sha256).status, "valid");
  assert.equal(restarted.verifyOccurrence(input.occurrence.occurrenceId).status, "missing");
  assert.deepEqual(restarted.listOrphanContentObjects(), [{ sha256: input.contentObject.sha256,
    integrityStatus: "valid" }]);
  assert.equal(restarted.vaultStatus().status, "empty");
});

test("R2-18 restart readers return exact metadata, occurrence and reference index", t => {
  const { root, vault } = fixture(t), input = bundle(); vault.storeAcceptedEvidence(input);
  const restarted = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null });
  assert.equal(restarted.readContentMetadata(input.contentObject.sha256).contentObject.sha256,
    input.contentObject.sha256);
  assert.deepEqual(restarted.readOccurrence(input.occurrence.occurrenceId), input.occurrence);
  assert.deepEqual(restarted.occurrencesByContentSha256(input.contentObject.sha256), [input.occurrence]);
});

test("R2-19 external length, byte and metadata tamper are detected without repair", t => {
  const { root, vault } = fixture(t), input = bundle("tamper me"); vault.storeAcceptedEvidence(input);
  const raw = objectPath(root, input.contentObject.sha256), original = fs.readFileSync(raw);
  fs.writeFileSync(raw, Buffer.concat([original, Buffer.from([0])]));
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "length_mismatch");
  fs.writeFileSync(raw, Buffer.alloc(original.length, 0x7a));
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "hash_mismatch");
  assert.throws(() => vault.readRawBytes(input.contentObject.sha256), /evidence_integrity_invalid/);
  assert.deepEqual(fs.readFileSync(raw), Buffer.alloc(original.length, 0x7a));
  fs.writeFileSync(raw, original);
  const metadata = metadataPath(root, input.contentObject.sha256), record =
    JSON.parse(fs.readFileSync(metadata, "utf8")); record.integrityStatus = "tampered";
  fs.writeFileSync(metadata, JSON.stringify(record));
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "metadata_mismatch");
});

test("R2-20 vault remains absent from export/preload/domain surfaces and main use is QRI-bounded", () => {
  const files = ["../js/fullExportCollector.js", "../js/calendarExportV1.js", "../preload.js",
    "../js/economicValues/economicValueFormalStore.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.equal(source.includes("sourceEvidenceVault"), false, file);
  }
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /const sourceEvidenceVault = require\("\.\/js\/sourceEvidence\/sourceEvidenceVault\.js"\)/);
  assert.match(main, /sourceEvidenceVault\.createProductionVault/);
  assert.doesNotMatch(main, /readRawBytes|rawBytes/);
});

test("R2 hardlinked object and symlinked metadata are never trusted", t => {
  const { root, vault } = fixture(t), input = bundle(); vault.storeAcceptedEvidence(input);
  const raw = objectPath(root, input.contentObject.sha256), linked = `${raw}.link`;
  fs.linkSync(raw, linked);
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "path_unsafe");
  fs.unlinkSync(linked);
  const metadata = metadataPath(root, input.contentObject.sha256), target = `${metadata}.target`;
  fs.renameSync(metadata, target); fs.symlinkSync(target, metadata);
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "path_unsafe");
});

test("R2 occurrence temp failure leaves valid content orphaned and cleans temp", t => {
  const { root, vault } = fixture(t, "after_occurrence_temp"), input = bundle();
  assert.throws(() => vault.storeAcceptedEvidence(input), /vault_transaction_aborted/);
  assert.equal(vault.verifyContent(input.contentObject.sha256).status, "valid");
  assert.equal(vault.verifyOccurrence(input.occurrence.occurrenceId).status, "missing");
  assert.deepEqual(fs.readdirSync(vaultPath(root, Vault.DIRECTORY_NAMES.temporary)), []);
});

test("R2 production factory resolves only the fixed application-controlled vault root", t => {
  const { root } = fixture(t), production = Vault.createProductionVault({ getUserDataPath: () => root });
  assert.equal(production.vaultStatus().status, "absent");
  assert.equal(fs.existsSync(vaultPath(root)), false);
  assert.throws(() => Vault.createProductionVault({ getUserDataPath: () => root,
    destination: "/tmp/attacker" }), /production_vault_authority_invalid/);
});
