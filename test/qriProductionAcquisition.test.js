"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { indexedDB } = require("fake-indexeddb");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Raw = require("../js/qriRawTransportShadow.js");
const Evidence = require("../js/qriEvidenceVaultShadow.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Formal = require("../js/qriFormalEvidenceBinding.js");
const Production = require("../js/qriProductionAcquisition.js");
const AuthorityStore = require("../js/qriProductionAuthority.js");
const Parser = require("../js/qriOptions.js");
const Iv = require("../js/qriOptionIv.js");
const HistoryStore = require("../js/storage/qriOptionsHistoryStore.js");
const { rawQriHtml, rawQriBytes } = require("./fixtures/qri/rawQriPageFixture.js");

const ROOT = path.join(__dirname, "..");
const SECRET = "qri-production-cutover-test-secret-32-bytes";
let databaseSequence = 0;
const authority = () => Qri.createMainAuthority({ keyId: "qri-production-test-v1", secret: SECRET });
const response = bytes => ({ kind: "response", statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8",
    "content-length": String(bytes.byteLength) }, body: bytes });

function referenceHtml(contract = "2026-12", value = "1,234") {
  const month = Number(contract.slice(5));
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <dl><dt>最終更新時刻</dt><dd>2026/11/10 08:31</dd><dt>取引日</dt><dd>2026/11/10</dd>
  <dt>取引最終日</dt><dd>2026/12/11</dd></dl><div id="futuresContractTab"><ul>
  <li class="active"><a href="/jpx/nkopm/1?gengetsu=${contract.replace("-", "")}">${month}月限</a></li>
  </ul></div><table><tr class="row-num"><td>x</td><td>${value}</td><td></td><td></td><td></td>
  <td></td><td></td><td></td><td>45,000</td><td></td><td></td><td></td><td></td><td></td>
  <td></td><td>2,345</td><td>x</td></tr></table></body></html>`;
}

function isolatedVault(t, crashAt = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-qri-q6-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault: Vault.createIsolatedVault({ root,
    targetEnvironment: "isolated_test", crashAt }) };
}

function harness(t, options = {}) {
  const main = options.authority || authority();
  const isolated = options.vault ? { root: null, vault: options.vault } : isolatedVault(t);
  const calls = [];
  const activeQueue = [...(options.activeBytes || [rawQriBytes])];
  const referenceBytes = Buffer.from(options.referenceHtml || referenceHtml(), "utf8");
  const requestClient = { async requestOnce(request) {
    calls.push(request);
    if (request.url === Qri.ACTIVE_URL) return response(activeQueue.shift() || rawQriBytes);
    return response(referenceBytes);
  } };
  let sequence = 0;
  const raw = Raw.createDefaultQriRawTransportShadow({ authority: main, requestClient,
    warmupSession: async () => ({ accepted: true }),
    now: () => `2026-11-10T00:${String(++sequence).padStart(2, "0")}:00.000Z`,
    resolveActiveContractIdentity: Production.activeContractIdentityFromParserInput });
  const evidence = Evidence.createQriEvidenceVaultShadow({ rawTransportShadow: raw,
    vault: isolated.vault, authority: main });
  const formal = Formal.createQriFormalEvidenceBinding({ authority: main, vault: isolated.vault,
    historyStore: { persistCandidate: async () => { throw new Error("unexpected_write"); } } });
  let identity = 0;
  const service = Production.createQriProductionAcquisition({ authority: main,
    evidenceAcquirer: evidence, formalBinding: formal,
    parseCanonical: (html, sourceUrl) => Parser.parseQriOptionsPage(html, sourceUrl),
    validateCanonical: canonical => Parser.validateCanonical(canonical,
      { allowUnresolvedContracts: true }),
    createRunId: () => `q6-run-${++identity}`,
    createRequestId: () => `q6-request-${identity}` });
  return { main, calls, raw, evidence, formal, service, ...isolated };
}

async function acquireActive(h) {
  const acquired = await h.service.acquire({ requestKind: "active" });
  assert.equal(acquired.success, true);
  const canonical = Parser.parseQriOptionsPage(acquired.parserInput,
    acquired.receipt.acceptedFinalUrl);
  const cache = await Parser.createCacheV2(canonical, acquired.receipt.fetchedAt);
  const ivCanonical = Iv.parseQriOptionIvPage(acquired.parserInput,
    acquired.receipt.acceptedFinalUrl);
  return { acquired, canonical, cache, ivCanonical };
}

async function finalize(h, active, cache = active.cache) {
  return h.service.finalize({ acquisitionId: active.acquired.receipt.acquisitionId,
    canonical: active.canonical, cache, ivCanonical: active.ivCanonical });
}

test("Q6-1 active production acquisition uses main-owned Evidence path", async t => {
  const h = harness(t), active = await acquireActive(h);
  assert.deepEqual([active.acquired.receipt.contractVersion,
    active.acquired.diagnostics.evidence, h.calls[0].url],
  [Qri.RECEIPT_V3_VERSION, "verified", Qri.ACTIVE_URL]);
});

test("Q6-2 renderer URL authority is rejected", async t => {
  const h = harness(t), result = await h.service.acquire({ requestKind: "active",
    url: Qri.ACTIVE_URL });
  assert.deepEqual([result.success, result.reason, h.calls.length], [false, "intent_rejected", 0]);
});

test("Q6-3 active canonical is byte-for-byte semantically equal to the old parser path", async t => {
  const active = await acquireActive(harness(t));
  assert.deepEqual(active.canonical, Parser.parseQriOptionsPage(rawQriHtml, Qri.ACTIVE_URL));
});

async function acquireReference(h, role) {
  const active = await acquireActive(h), manifest = active.acquired.parentManifest;
  const entry = manifest.entries.find(item => item.allowedRoles.includes(role));
  assert.ok(entry);
  const acquired = await h.service.acquire({ requestKind: "listed_reference", role,
    parentAcquisitionId: manifest.parentAcquisitionId,
    listedContractId: entry.listedContractId });
  assert.equal(acquired.success, true);
  return { active, manifest, entry, acquired,
    canonical: Parser.parseQriOptionsPage(acquired.parserInput,
      acquired.receipt.acceptedFinalUrl) };
}

test("Q6-4 next contract canonical parity is preserved", async t => {
  const child = await acquireReference(harness(t), "next");
  assert.deepEqual(child.canonical, Parser.parseQriOptionsPage(referenceHtml(),
    "https://svc.qri.jp/jpx/nkopm/1"));
});

test("Q6-5 Major SQ contract canonical parity is preserved", async t => {
  const child = await acquireReference(harness(t), "major_sq");
  assert.deepEqual([child.canonical.contract, child.acquired.receipt.role],
    ["2026-12", "major_sq"]);
});

test("Q6-6 parent manifest is signed and binds the listed target", async t => {
  const h = harness(t), active = await acquireActive(h), manifest = active.acquired.parentManifest;
  assert.equal(Qri.validateParentManifest(manifest, active.acquired.receipt, h.main), true);
  assert.deepEqual(manifest.entries[0].allowedRoles, ["major_sq", "next"]);
});

test("Q6-7 forged listed intent rejects before transport", async t => {
  const h = harness(t), active = await acquireActive(h), before = h.calls.length;
  const result = await h.service.acquire({ requestKind: "listed_reference", role: "next",
    parentAcquisitionId: active.acquired.receipt.acquisitionId,
    listedContractId: `qri-listed-contract-v1|sha256:${"a".repeat(64)}` });
  assert.deepEqual([result.success, result.reason, h.calls.length],
    [false, "listed_contract_unknown", before]);
});

test("Q6-8 Evidence-backed revision has complete restart lineage", async t => {
  const h = harness(t), active = await acquireActive(h), accepted = await finalize(h, active);
  assert.equal(accepted.success, true);
  const store = HistoryStore.createQriOptionsHistoryStore({ indexedDB,
    databaseName: `q6-evidence-${++databaseSequence}` });
  assert.equal((await store.persistCandidate(accepted.formalCandidate,
    { confirmedAt: "2026-11-10T01:00:00.000Z" })).saved, true);
  store.closeHistoryStore();
  const reopened = HistoryStore.createQriOptionsHistoryStore({ indexedDB,
    databaseName: `q6-evidence-${databaseSequence}` });
  const revision = (await reopened.loadHistory()).history.entries[0].revisions[0];
  const audit = h.formal.resolveRevisionEvidence(revision);
  assert.deepEqual([audit.status, audit.receipt.receiptId,
    audit.occurrence.occurrenceId, crypto.createHash("sha256").update(audit.rawBytes).digest("hex")],
  ["available", revision.sourceEvidence.receipt.receiptId,
    revision.sourceEvidence.receipt.evidenceStatus.occurrenceId,
    revision.sourceEvidence.receipt.evidenceStatus.contentSha256]);
});

test("Q6-9 raw-only change stores Evidence and produces semantic write0", async t => {
  const changedRaw = Buffer.from(`${rawQriHtml}\n<!-- transport-only -->`, "utf8");
  const h = harness(t, { activeBytes: [rawQriBytes, changedRaw] });
  const store = HistoryStore.createQriOptionsHistoryStore({ indexedDB,
    databaseName: `q6-raw-${++databaseSequence}` });
  const first = await acquireActive(h), firstAccepted = await finalize(h, first);
  assert.equal((await store.persistCandidate(firstAccepted.formalCandidate,
    { confirmedAt: "2026-11-10T01:00:00.000Z" })).saved, true);
  const second = await acquireActive(h), secondAccepted = await finalize(h, second);
  const stored = await store.persistCandidate(secondAccepted.formalCandidate,
    { confirmedAt: "2026-11-10T02:00:00.000Z" });
  assert.deepEqual([stored.saved, stored.outcome, h.vault.vaultStatus().occurrenceCount],
    [false, "same_version", 2]);
});

test("Q6-10 canonical change creates immutable Evidence-backed revision", async t => {
  const changed = Buffer.from(rawQriHtml.replace("1,234", "1,235"), "utf8");
  const h = harness(t, { activeBytes: [rawQriBytes, changed] });
  const store = HistoryStore.createQriOptionsHistoryStore({ indexedDB,
    databaseName: `q6-change-${++databaseSequence}` });
  for (const [index, confirmedAt] of ["2026-11-10T01:00:00.000Z",
    "2026-11-10T02:00:00.000Z"].entries()) {
    const active = await acquireActive(h), accepted = await finalize(h, active);
    assert.equal((await store.persistCandidate(accepted.formalCandidate,
      { confirmedAt })).saved, true, String(index));
  }
  const revisions = (await store.loadHistory()).history.entries[0].revisions;
  assert.deepEqual([revisions.length, revisions[0].replacedAt, revisions[1].replacedAt,
    revisions.every(item => item.sourceEvidence.status === "available")],
  [2, "2026-11-10T02:00:00.000Z", null, true]);
});

test("Q6-11 parser failure retains Evidence and creates Formal0", async t => {
  const bytes = Buffer.from(`<html><head><meta charset=utf-8></head><body>
    <a href="/jpx/nkopm/?gengetsu=202611">11月限</a><p>bad table</p></body></html>`);
  const h = harness(t, { activeBytes: [bytes] }), result = await h.service.acquire({ requestKind: "active" });
  assert.deepEqual([result.success, result.reason, h.vault.vaultStatus().occurrenceCount,
    h.service.diagnostics().pendingAcquisitionCount], [false, "main_parser_rejected", 1, 0]);
});

test("Q6-12 Vault failure is fail-closed with no old transport fallback", async t => {
  const isolated = isolatedVault(t), original = isolated.vault;
  const vault = { ...original, storeAcceptedEvidence() { throw new Error("injected_vault_failure"); } };
  const h = harness(t, { vault }), result = await h.service.acquire({ requestKind: "active" });
  assert.deepEqual([result.success, result.reason,
    h.service.diagnostics().oldTransportFallbackCount],
  [false, "evidence_content_persistence_failed", 0]);
});

test("Q6-13 IV inherits the exact parent Evidence occurrence", async t => {
  const h = harness(t), active = await acquireActive(h), accepted = await finalize(h, active);
  assert.deepEqual([accepted.ivInheritance.parentReceiptId,
    accepted.ivInheritance.occurrenceId, accepted.ivInheritance.rawContentSha256],
  [active.acquired.receipt.receiptId, active.acquired.receipt.evidenceStatus.occurrenceId,
    active.acquired.receipt.evidenceStatus.contentSha256]);
});

test("Q6-14 Futures source authority remains separate", async t => {
  const active = await acquireActive(harness(t));
  assert.equal(JSON.stringify(active.acquired).includes(Qri.FUTURES_SOURCE_ID), false);
});

test("Q6-15 P17 trading-date semantics are unchanged", async t => {
  const active = await acquireActive(harness(t)), direct = Parser.parseQriOptionsPage(
    rawQriHtml, Qri.ACTIVE_URL);
  assert.deepEqual([active.canonical.tradingDate, active.canonical.pageUpdatedAt,
    active.canonical.dateContext], [direct.tradingDate, direct.pageUpdatedAt, direct.dateContext]);
});

test("Q6-16 current/previous production comparison remains disconnected", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/qriOptionsHistoryComparison.js"), "utf8");
  assert.doesNotMatch(source, /qriProductionAcquisition|qriEvidenceVaultShadow/);
});

test("Q6-17 Overall consumes the same canonical QRI semantics", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/overallJudgmentV2.js"), "utf8");
  assert.doesNotMatch(source, /qriProductionAcquisition|sourceEvidence|occurrenceId/);
});

test("Q6-18 Morning remains unchanged by the cutover", () => {
  for (const file of ["js/morningV5FormalAuthority.js", "js/morningV5MainAuthorityBinding.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), "utf8"),
      /qriProductionAcquisition|sourceEvidence|occurrenceId/);
  }
});

test("Q6-19 Full Export contains no raw HTML, Vault path or Evidence payload", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/fullExportCollector.js"), "utf8");
  assert.doesNotMatch(source, /qriProductionAcquisition|rawBytes|sourceEvidenceVault|occurrenceId/);
});

test("Q6-20 old renderer URL IPC has zero production call sites", () => {
  const sources = ["main.js", "preload.js", "index.html"].map(file =>
    fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(sources,
    /optionMapBridge\.fetchQriOptionPage|ipcMain\.handle\("fetch-option-page"|ipcRenderer\.invoke\("fetch-option-page"/);
  assert.match(sources, /legacyFetchQriOptionPage/);
});

test("Q6-21 renderer bytes, SHA, source and Vault path injection are impossible", async t => {
  const h = harness(t);
  for (const extra of [{ bytes: "x" }, { sha256: "a".repeat(64) },
    { sourceId: Qri.SOURCE_ID }, { vaultPath: "/tmp/x" }]) {
    assert.equal((await h.service.acquire({ requestKind: "active", ...extra })).reason,
      "intent_rejected");
  }
  const active = await acquireActive(h);
  const forged = structuredClone(active.canonical);
  forged.records[0].openInterest += 1;
  const rejected = await h.service.finalize({
    acquisitionId: active.acquired.receipt.acquisitionId,
    canonical: forged, cache: null, ivCanonical: null
  });
  assert.deepEqual([rejected.success, rejected.reason,
    rejected.diagnostics.formalWriteCount],
  [false, "main_parser_canonical_mismatch", 0]);
});

test("Q6-22 production authority and Evidence identity survive reopen", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-qri-authority-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protector = { protect: bytes => Buffer.from(bytes).reverse(),
    unprotect: bytes => Buffer.from(bytes).reverse() };
  const create = () => AuthorityStore.createProductionAuthority({ getUserDataPath: () => root,
    protector, randomBytes: size => Buffer.alloc(size, 7) });
  const first = create(), second = create(), integrity = "b".repeat(64);
  const signature = first.authority.sign("restart", integrity);
  assert.deepEqual([first.keyId, second.keyId,
    second.authority.verify("restart", integrity, signature),
    fs.existsSync(path.join(root, AuthorityStore.FILE_NAME))],
  [AuthorityStore.KEY_ID, AuthorityStore.KEY_ID, true, true]);
});
