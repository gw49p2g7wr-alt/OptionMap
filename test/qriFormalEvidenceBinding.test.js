"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Raw = require("../js/qriRawTransportShadow.js");
const Q3 = require("../js/qriEvidenceVaultShadow.js");
const Q4 = require("../js/qriFormalEvidenceBinding.js");
const Parser = require("../js/qriOptions.js");
const History = require("../js/qriOptionsHistory.js");
const Store = require("../js/storage/qriOptionsHistoryStore.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const { rawQriHtml } = require("./fixtures/qri/rawQriPageFixture.js");

const ROOT = path.join(__dirname, "..");
const SECRET = "qri-formal-evidence-fixture-secret-32-bytes-minimum";
const NOW = "2026-11-10T00:30:00.000Z";
let databaseSequence = 0;

function authority() {
  return Qri.createMainAuthority({ keyId: "qri-main-formal-evidence-v1", secret: SECRET });
}

function response(bytes) {
  return { kind: "response", statusCode: 200, headers: {
    "content-type": "text/html; charset=utf-8", "content-length": String(bytes.byteLength)
  }, body: bytes };
}

function referenceHtml(value = "1,234") {
  return rawQriHtml.replace(/<li class="active">[\s\S]*?<\/li>\s*<li>[\s\S]*?<\/li>/,
    '<li class="active"><a href="/jpx/nkopm/1?gengetsu=202612">12月限</a></li>')
    .replace("1,234", value);
}

function harness(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-qri-q4-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = authority();
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null });
  const databaseName = `${Store.DATABASE_NAME}-q4-${++databaseSequence}`;
  const store = Store.createQriOptionsHistoryStore({ indexedDB, databaseName });
  const binding = Q4.createQriFormalEvidenceBinding({ authority: main, vault, historyStore: store });
  return { root, main, vault, databaseName, store, binding };
}

function rawShadow(main, bytes, calls, fetchedAt = NOW) {
  const requestClient = { async requestOnce(options) { calls.push(options); return response(bytes); } };
  return Raw.createDefaultQriRawTransportShadow({ authority: main, requestClient,
    warmupSession: async () => ({ accepted: true, reason: null }), now: () => fetchedAt });
}

async function capture(h, { bytes = Buffer.from(rawQriHtml), input, fetchedAt = NOW } = {}) {
  const calls = [], raw = rawShadow(h.main, bytes, calls, fetchedAt);
  const shadow = Q3.createQriEvidenceVaultShadow({ rawTransportShadow: raw,
    vault: h.vault, authority: h.main });
  const result = await shadow.acquire(input || {
    intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
    authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
    runId: "q4-active-run", requestId: "q4-active-request"
  });
  assert.equal(result.status, "available");
  const canonical = Parser.parseQriOptionsPage(result.parserInput,
    result.receipt.acceptedFinalUrl);
  const cache = await Parser.createCacheV2(canonical, result.receipt.fetchedAt);
  const parserResult = { canonical, acquisitionBinding: {
    acquisitionId: result.receipt.acquisitionId, role: result.receipt.role,
    parentAcquisitionId: result.receipt.parentAcquisitionId
  } };
  return { ...result, cache, canonical, parserResult, calls };
}

async function captureReference(h, role) {
  const parent = await capture(h);
  const manifest = Qri.createParentManifest({ parentReceipt: parent.receipt, entries: [{
    contractIdentity: Qri.createContractIdentity("2026-12"),
    canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1", allowedRoles: ["next", "major_sq"]
  }] }, h.main);
  const entry = manifest.entries[0];
  const input = { intent: Qri.createAcquisitionIntent({ requestKind: "listed_reference", role,
    parentAcquisitionId: parent.receipt.acquisitionId, listedContractId: entry.listedContractId }),
  authorityContext: { parentManifest: manifest, parentReceipt: parent.receipt, authority: h.main },
  runId: `q4-${role}-run`, requestId: `q4-${role}-request` };
  return { parent, manifest, entry, child: await capture(h,
    { bytes: Buffer.from(referenceHtml()), input, fetchedAt: "2026-11-10T00:31:00.000Z" }) };
}

function persistenceInput(captured, confirmedAt = "2026-11-10T00:32:00.000Z") {
  return { cache: captured.cache, receipt: captured.receipt,
    parserInput: captured.parserInput, parserResult: captured.parserResult, confirmedAt };
}

function objectPath(h, sha256) {
  return path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("Q4-1 new revision persists one valid receipt-bound Evidence field", async t => {
  const h = harness(t), acquired = await capture(h), result = await h.binding
    .persistFormalCandidate(persistenceInput(acquired));
  assert.deepEqual([result.status, result.outcome, result.diagnostics.formalWriteCount],
    ["saved", "added", 1]);
  const revision = (await h.store.loadHistory()).history.entries[0].revisions[0];
  assert.equal(revision.sourceEvidence.receipt.receiptId, acquired.receipt.receiptId);
  assert.equal(History.validateFormalEvidenceBinding(revision.sourceEvidence, revision), true);
});

test("Q4-2 restart resolves revision through receipt, occurrence and exact raw HTML", async t => {
  const h = harness(t), acquired = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(acquired));
  h.store.closeHistoryStore();
  const reopenedStore = Store.createQriOptionsHistoryStore({ indexedDB, databaseName: h.databaseName });
  const reopenedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null });
  const reopened = Q4.createQriFormalEvidenceBinding({ authority: h.main,
    vault: reopenedVault, historyStore: reopenedStore });
  const revision = (await reopenedStore.loadHistory()).history.entries[0].revisions[0],
    resolved = reopened.resolveRevisionEvidence(revision);
  assert.deepEqual([resolved.status, resolved.receipt.receiptId,
    resolved.occurrence.occurrenceId, resolved.parserInput],
  ["available", acquired.receipt.receiptId, acquired.receipt.evidenceStatus.occurrenceId,
    acquired.parserInput]);
  assert.deepEqual(resolved.rawBytes, Buffer.from(rawQriHtml));
});

test("Q4-3 pre-activation revision remains valid and resolves unavailable", async t => {
  const h = harness(t), acquired = await capture(h), built = await History
    .createHistoryCandidate(acquired.cache);
  assert.equal((await h.store.persistCandidate(built.candidate,
    { confirmedAt: "2026-11-10T00:32:00.000Z" })).saved, true);
  const revision = (await h.store.loadHistory()).history.entries[0].revisions[0];
  assert.equal(Object.hasOwn(revision, "sourceEvidence"), false);
  assert.deepEqual(h.binding.resolveRevisionEvidence(revision), {
    status: "unavailable", reason: "pre_activation", receipt: null,
    occurrence: null, rawBytes: null, parserInput: null
  });
});

test("Q4-4 valid active acquisition binds exact active contract and role", async t => {
  const h = harness(t), acquired = await capture(h), prepared = await h.binding
    .prepareFormalCandidate({ cache: acquired.cache, receipt: acquired.receipt,
      parserInput: acquired.parserInput, parserResult: acquired.parserResult });
  assert.deepEqual([prepared.accepted, prepared.candidate.contract,
    prepared.candidate.sourceEvidence.receipt.role], [true, "2026-11", "active"]);
});

test("Q4-5 next reference revision preserves signed parent lineage", async t => {
  const h = harness(t), x = await captureReference(h, "next"), result = await h.binding
    .persistFormalCandidate(persistenceInput(x.child));
  const receipt = result.candidate.sourceEvidence.receipt;
  assert.deepEqual([receipt.role, receipt.parentAcquisitionId,
    receipt.evidenceStatus.parentManifestId, receipt.evidenceStatus.listedContractId],
  ["next", x.parent.receipt.acquisitionId, x.manifest.manifestId, x.entry.listedContractId]);
});

test("Q4-6 Major SQ revision preserves the same bounded parent lineage", async t => {
  const h = harness(t), x = await captureReference(h, "major_sq"), prepared = await h.binding
    .prepareFormalCandidate({ cache: x.child.cache, receipt: x.child.receipt,
      parserInput: x.child.parserInput, parserResult: x.child.parserResult });
  assert.deepEqual([prepared.accepted, prepared.candidate.contract,
    prepared.candidate.sourceEvidence.receipt.role], [true, "2026-12", "major_sq"]);
});

test("Q4-7 wrong contract receipt rejects with Formal0", async t => {
  const h = harness(t), acquired = await capture(h), forged = structuredClone(acquired.receipt);
  forged.contractIdentity.contract = "2026-12";
  const result = await h.binding.persistFormalCandidate({ ...persistenceInput(acquired), receipt: forged });
  assert.deepEqual([result.accepted, result.reason, result.diagnostics.formalTransactionCount],
    [false, "receipt_invalid", 0]);
  assert.equal((await h.store.loadHistory()).status, "empty");
});

test("Q4-8 wrong role receipt rejects with Formal0", async t => {
  const h = harness(t), acquired = await capture(h), forged = structuredClone(acquired.receipt);
  forged.role = "next";
  const result = await h.binding.persistFormalCandidate({ ...persistenceInput(acquired), receipt: forged });
  assert.deepEqual([result.accepted, result.reason], [false, "receipt_invalid"]);
  assert.equal((await h.store.loadHistory()).status, "empty");
});

test("Q4-9 parser-input substitution rejects with Formal0", async t => {
  const h = harness(t), acquired = await capture(h), result = await h.binding
    .persistFormalCandidate({ ...persistenceInput(acquired),
      parserInput: `${acquired.parserInput}<!-- different -->` });
  assert.deepEqual([result.accepted, result.reason], [false, "parser_input_mismatch"]);
  assert.equal((await h.store.loadHistory()).status, "empty");
});

test("Q4-10 tampered receipt and malformed future binding reject", async t => {
  const h = harness(t), acquired = await capture(h);
  for (const mutate of [
    value => { value.authoritySignature = "0".repeat(64); },
    value => { value.evidenceStatus.occurrenceId = `source-occurrence-v1|sha256:${"0".repeat(64)}`; },
    value => { value.evidenceStatus.contentSha256 = "0".repeat(64); },
    value => { value.sourceId = "qri-forged"; },
    value => { value.parserInputIdentity.sha256 = "0".repeat(64); }
  ]) {
    const forged = structuredClone(acquired.receipt); mutate(forged);
    assert.equal((await h.binding.persistFormalCandidate({ ...persistenceInput(acquired),
      receipt: forged })).reason, "receipt_invalid");
  }
  const binding = Q4.createBinding(acquired.receipt), future = structuredClone(binding);
  future.contractVersion = "qri-formal-revision-evidence-v2";
  assert.equal(History.validateFormalEvidenceBinding(future,
    (await History.createHistoryCandidate(acquired.cache)).candidate), false);
  const extra = structuredClone(binding); extra.receipt.evidenceStatus.extra = true;
  assert.equal(History.validateFormalEvidenceBinding(extra,
    (await History.createHistoryCandidate(acquired.cache)).candidate), false);
});

test("Q4-11 missing Vault occurrence rejects before Formal transaction", async t => {
  const h = harness(t), acquired = await capture(h), missingVault = {
    verifyContent: h.vault.verifyContent, verifyOccurrence: () => ({ status: "missing" }),
    readOccurrence: h.vault.readOccurrence, readRawBytes: h.vault.readRawBytes
  }, binding = Q4.createQriFormalEvidenceBinding({ authority: h.main,
    vault: missingVault, historyStore: h.store });
  const result = await binding.persistFormalCandidate(persistenceInput(acquired));
  assert.deepEqual([result.reason, result.diagnostics.formalTransactionCount],
    ["vault_evidence_invalid", 0]);
  assert.equal((await h.store.loadHistory()).status, "empty");
});

test("Q4-12 tampered Vault content rejects before Formal transaction", async t => {
  const h = harness(t), acquired = await capture(h), sha = acquired.receipt.evidenceStatus.contentSha256;
  fs.writeFileSync(objectPath(h, sha), Buffer.alloc(acquired.receipt.transportIdentity.byteLength, 0x78));
  const result = await h.binding.persistFormalCandidate(persistenceInput(acquired));
  assert.deepEqual([result.reason, result.diagnostics.formalTransactionCount],
    ["vault_evidence_invalid", 0]);
  assert.equal((await h.store.loadHistory()).status, "empty");
});

test("Q4-13 raw change with canonical equality retains Evidence and writes semantic0", async t => {
  const h = harness(t), first = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(first));
  const changed = await capture(h, { bytes: Buffer.from(`${rawQriHtml}<!-- raw-only -->`),
    input: { intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
      authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
      runId: "q4-raw-change-run", requestId: "q4-raw-change-request" } });
  const result = await h.binding.persistFormalCandidate(persistenceInput(changed,
    "2026-11-10T00:33:00.000Z"));
  assert.deepEqual([result.status, result.outcome, result.diagnostics.formalWriteCount],
    ["unchanged", "same_version", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 2);
  assert.equal((await h.store.loadHistory()).history.entries[0].revisions.length, 1);
});

test("Q4-14 same raw with a new acquisition creates occurrence but semantic write0", async t => {
  const h = harness(t), first = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(first));
  const second = await capture(h, { input: {
    intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
    authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
    runId: "q4-second-run", requestId: "q4-second-request" } });
  const result = await h.binding.persistFormalCandidate(persistenceInput(second,
    "2026-11-10T00:33:00.000Z"));
  assert.deepEqual([result.status, result.diagnostics.formalWriteCount,
    first.receipt.evidenceStatus.contentSha256 === second.receipt.evidenceStatus.contentSha256,
    h.vault.vaultStatus().occurrenceCount], ["unchanged", 0, true, 2]);
});

test("Q4-15 canonical change appends an immutable Evidence-bound revision", async t => {
  const h = harness(t), first = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(first));
  const second = await capture(h, { bytes: Buffer.from(rawQriHtml.replace("1,234", "1,999")),
    input: { intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
      authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
      runId: "q4-correction-run", requestId: "q4-correction-request" },
    fetchedAt: "2026-11-10T00:34:00.000Z" });
  const result = await h.binding.persistFormalCandidate(persistenceInput(second,
    "2026-11-10T00:35:00.000Z"));
  assert.deepEqual([result.status, result.outcome], ["saved", "revision_added"]);
  assert.equal((await h.store.loadHistory()).history.entries[0].revisions.length, 2);
});

test("Q4-16 same-day correction preserves old and new Evidence independently", async t => {
  const h = harness(t), first = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(first));
  const second = await capture(h, { bytes: Buffer.from(rawQriHtml.replace("2,345", "2,999")),
    input: { intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
      authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
      runId: "q4-correction-2-run", requestId: "q4-correction-2-request" },
    fetchedAt: "2026-11-10T00:34:00.000Z" });
  await h.binding.persistFormalCandidate(persistenceInput(second, "2026-11-10T00:35:00.000Z"));
  const revisions = (await h.store.loadHistory()).history.entries[0].revisions;
  assert.notEqual(revisions[0].sourceEvidence.receipt.receiptId,
    revisions[1].sourceEvidence.receipt.receiptId);
  assert.equal(revisions[0].replacedAt, "2026-11-10T00:35:00.000Z");
  assert.equal(revisions[1].replacedAt, null);
  assert.equal(h.binding.resolveRevisionEvidence(revisions[0]).status, "available");
  assert.equal(h.binding.resolveRevisionEvidence(revisions[1]).status, "available");
});

test("Q4-17 duplicate semantic revision is exact write0", async t => {
  const h = harness(t), acquired = await capture(h);
  await h.binding.persistFormalCandidate(persistenceInput(acquired));
  const duplicate = await h.binding.persistFormalCandidate(persistenceInput(acquired,
    "2026-11-10T00:34:00.000Z"));
  assert.deepEqual([duplicate.status, duplicate.outcome, duplicate.diagnostics.formalWriteCount],
    ["unchanged", "same_version", 0]);
});

test("Q4-18 IV inheritance reuses parent Evidence and creates no raw occurrence", async t => {
  const h = harness(t), acquired = await capture(h), before = h.vault.vaultStatus().occurrenceCount,
    inherited = Qri.createIvReceiptInheritanceV2(acquired.receipt, {
      source: Qri.IV_SOURCE_ID, sourceUrl: acquired.receipt.acceptedFinalUrl,
      contract: acquired.canonical.contract, tradingDate: acquired.canonical.tradingDate
    }, h.main);
  assert.deepEqual([inherited.accepted, inherited.inheritance.occurrenceId,
    h.vault.vaultStatus().occurrenceCount],
  [true, acquired.receipt.evidenceStatus.occurrenceId, before]);
});

test("Q4-19 P17 trading-date and page metadata remain unchanged", async t => {
  const h = harness(t), acquired = await capture(h), result = await h.binding
    .persistFormalCandidate(persistenceInput(acquired));
  const revision = (await h.store.loadHistory()).history.entries[0].revisions[0];
  assert.deepEqual([revision.tradingDate, revision.pageUpdatedAt,
    revision.canonical.tradingDate, revision.canonical.pageUpdatedAt],
  [acquired.canonical.tradingDate, acquired.canonical.pageUpdatedAt,
    acquired.canonical.tradingDate, acquired.canonical.pageUpdatedAt]);
  assert.equal(result.candidate.canonical.dateContext, acquired.canonical.dateContext);
});

test("Q4-20 Full Export and Time Travel expose no QRI raw HTML or Evidence ref", () => {
  for (const file of ["js/fullExportCollector.js", "js/qriTimeTravelProjection.js", "index.html"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /qriFormalEvidenceBinding|sourceEvidence.*qri/i);
  }
});

test("Q4-21 production acquisition, preload and IPC remain disconnected", () => {
  for (const file of ["main.js", "preload.js", "index.html", "js/qriOptionsHistoryPersistence.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /qriFormalEvidenceBinding|qriEvidenceVaultShadow/);
  }
});
