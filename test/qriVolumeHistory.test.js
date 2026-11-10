"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Raw = require("../js/qriRawTransportShadow.js");
const Evidence = require("../js/qriEvidenceVaultShadow.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Formal = require("../js/qriFormalEvidenceBinding.js");
const Production = require("../js/qriProductionAcquisition.js");
const Oi = require("../js/qriOptions.js");
const Volume = require("../js/qriVolumeHistory.js");
const VolumeStore = require("../js/storage/qriVolumeHistoryStore.js");
const VolumePersistence = require("../js/qriVolumeHistoryPersistence.js");

const ROOT = path.join(__dirname, "..");
let databaseSequence = 0;

function qriHtml({ callOi = "1,234", callVolume = "100", putVolume = "200",
    putOi = "2,345", strike = "45,000", contract = "2026-11",
    updated = "2026/11/10 08:30" } = {}) {
  const cells = ["call-price", callOi, callVolume, "", "", "", "", "", strike,
    "", "", "", "", "", putVolume, putOi, "put-price"];
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <dl><dt>最終更新時刻</dt><dd>${updated}</dd><dt>取引日</dt><dd>2026/11/10</dd>
  <dt>取引最終日</dt><dd>2026/11/13</dd></dl>
  <div id="futuresContractTab"><ul><li class="active"><a href="/jpx/nkopm/?gengetsu=${contract.replace("-", "")}">11月限</a></li>
  <li><a href="/jpx/nkopm/1?gengetsu=202612">12月限</a></li></ul></div>
  <table><tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr></table>
  </body></html>`;
}

function harness(t, pages) {
  const authority = Qri.createMainAuthority({ keyId: "qri-volume-test-v1",
    secret: "qri-volume-history-test-secret-32-bytes" });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-qri-volume-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
    crashAt: null });
  const queue = pages.map(page => Buffer.from(page, "utf8")); let sequence = 0;
  const raw = Raw.createDefaultQriRawTransportShadow({ authority,
    requestClient: { async requestOnce() { const body = queue.shift(); return {
      kind: "response", statusCode: 200, headers: { "content-type": "text/html; charset=utf-8",
        "content-length": String(body.byteLength) }, body }; } },
    warmupSession: async () => ({ accepted: true }),
    now: () => `2026-11-10T00:${String(++sequence).padStart(2, "0")}:00.000Z`,
    resolveActiveContractIdentity: Production.activeContractIdentityFromParserInput });
  const evidence = Evidence.createQriEvidenceVaultShadow({ rawTransportShadow: raw, vault, authority });
  const formal = Formal.createQriFormalEvidenceBinding({ authority, vault,
    historyStore: { persistCandidate: async () => { throw new Error("unexpected_write"); } } });
  const service = Production.createQriProductionAcquisition({ authority,
    evidenceAcquirer: evidence, formalBinding: formal,
    parseCanonical: (html, url) => Oi.parseQriOptionsPage(html, url),
    validateCanonical: canonical => Oi.validateCanonical(canonical,
      { allowUnresolvedContracts: true }),
    createVolumeCandidate: input => Volume.createEvidenceCandidate(input),
    createRunId: () => `volume-run-${sequence + 1}`,
    createRequestId: () => `volume-request-${sequence + 1}` });
  return { authority, vault, service };
}

async function acquireAndFinalize(h) {
  const acquired = await h.service.acquire({ requestKind: "active" });
  assert.equal(acquired.success, true);
  const canonical = Oi.parseQriOptionsPage(acquired.parserInput, acquired.receipt.acceptedFinalUrl);
  const cache = await Oi.createCacheV2(canonical, acquired.receipt.fetchedAt);
  const finalized = await h.service.finalize({ acquisitionId: acquired.receipt.acquisitionId,
    canonical, cache, ivCanonical: null });
  assert.equal(finalized.success, true);
  return { acquired, canonical, cache, finalized };
}

function store(name) {
  return VolumeStore.createQriVolumeHistoryStore({ indexedDB,
    databaseName: `${name}-${++databaseSequence}` });
}

test("G3-1 normal CALL/PUT Volume acquisition creates evidence-backed candidate", async t => {
  const result = await acquireAndFinalize(harness(t, [qriHtml()]));
  const record = result.finalized.volumeCandidate.canonical.records[0];
  assert.deepEqual([record.strike, record.call.value, record.put.value,
    result.finalized.volumeCandidate.sourceEvidence.status], [45000, 100, 200, "available"]);
});

test("G3-2 missing Volume remains unpublished instead of zero", async () => {
  const canonical = Volume.parseVolumeCanonical(qriHtml({ callVolume: "—" }),
    Oi.parseQriOptionsPage(qriHtml({ callVolume: "—" }), Qri.ACTIVE_URL));
  assert.deepEqual(canonical.records[0].call, { published: false, value: null });
});

test("G3-3 actual numeric zero remains published zero", async () => {
  const html = qriHtml({ callVolume: "0" });
  const canonical = Volume.parseVolumeCanonical(html, Oi.parseQriOptionsPage(html, Qri.ACTIVE_URL));
  assert.deepEqual(canonical.records[0].call, { published: true, value: 0 });
});

test("G3-4 duplicate semantic Volume is write0", async t => {
  const h = harness(t, [qriHtml(), qriHtml()]), target = store("volume-dedupe");
  const first = await acquireAndFinalize(h), second = await acquireAndFinalize(h);
  assert.equal((await target.persistCandidate(first.finalized.volumeCandidate,
    { confirmedAt: "2026-11-10T01:00:00.000Z" })).saved, true);
  assert.deepEqual(await target.persistCandidate(second.finalized.volumeCandidate,
    { confirmedAt: "2026-11-10T02:00:00.000Z" }),
  { saved: false, outcome: "same_semantic_volume" });
});

test("G3-5 Volume-only change appends while OI versionKey is unchanged", async t => {
  const h = harness(t, [qriHtml(), qriHtml({ callVolume: "101" })]);
  const first = await acquireAndFinalize(h), second = await acquireAndFinalize(h);
  assert.equal(first.finalized.formalCandidate.versionKey, second.finalized.formalCandidate.versionKey);
  assert.notEqual(first.finalized.volumeCandidate.semanticSignature,
    second.finalized.volumeCandidate.semanticSignature);
});

test("G3-6 OI-only change leaves Volume semantic identity unchanged", async t => {
  const h = harness(t, [qriHtml(), qriHtml({ callOi: "1,235" })]);
  const first = await acquireAndFinalize(h), second = await acquireAndFinalize(h);
  assert.notEqual(first.finalized.formalCandidate.versionKey, second.finalized.formalCandidate.versionKey);
  assert.equal(first.finalized.volumeCandidate.semanticSignature,
    second.finalized.volumeCandidate.semanticSignature);
});

test("G3-7 simultaneous OI and Volume changes remain independent", async t => {
  const h = harness(t, [qriHtml(), qriHtml({ callOi: "1,235", putVolume: "201" })]);
  const first = await acquireAndFinalize(h), second = await acquireAndFinalize(h);
  assert.notEqual(first.finalized.formalCandidate.versionKey, second.finalized.formalCandidate.versionKey);
  assert.notEqual(first.finalized.volumeCandidate.semanticSignature,
    second.finalized.volumeCandidate.semanticSignature);
  assert.equal(first.finalized.volumeCandidate.acquisitionId,
    first.finalized.formalCandidate.sourceEvidence.receipt.acquisitionId);
});

test("G3-8 contract and trading-date entries are isolated", async t => {
  const h = harness(t, [qriHtml()]), result = await acquireAndFinalize(h), target = store("isolation");
  await target.persistCandidate(result.finalized.volumeCandidate,
    { confirmedAt: "2026-11-10T01:00:00.000Z" });
  assert.equal((await target.loadEntry("2026-11", "2026-11-10")).status, "available");
  assert.equal((await target.loadEntry("2026-12", "2026-11-10")).status, "unavailable");
});

test("G3-9 duplicate or malformed Strike identity fails closed", () => {
  const duplicate = qriHtml().replace("</table>", qriHtml().match(/<tr class="row-num">[\s\S]*?<\/tr>/)[0] + "</table>");
  const canonical = Oi.parseQriOptionsPage(qriHtml(), Qri.ACTIVE_URL);
  assert.throws(() => Volume.parseVolumeCanonical(duplicate, canonical), /duplicate_strike/);
  assert.throws(() => Volume.parsePublishedCell("not-a-number"), /invalid_volume_cell/);
});

test("G3-10 valid signed receipt and occurrence binding are retained", async t => {
  const result = await acquireAndFinalize(harness(t, [qriHtml()]));
  const candidate = result.finalized.volumeCandidate;
  assert.deepEqual([candidate.acquisitionId, candidate.occurrenceId],
    [candidate.sourceEvidence.receipt.acquisitionId,
      candidate.sourceEvidence.receipt.evidenceStatus.occurrenceId]);
  assert.equal(await Volume.validateCandidate(candidate), true);
});

test("G3-11 forged Evidence is rejected", async t => {
  const candidate = structuredClone((await acquireAndFinalize(harness(t, [qriHtml()])))
    .finalized.volumeCandidate);
  candidate.sourceEvidence.receipt.evidenceStatus.contentSha256 = "a".repeat(64);
  assert.equal(await Volume.validateCandidate(candidate), false);
  const future = structuredClone((await acquireAndFinalize(harness(t, [qriHtml()])))
    .finalized.volumeCandidate);
  future.parserVersion = 2;
  assert.equal(await Volume.validateCandidate(future), false);
  const unknown = structuredClone((await acquireAndFinalize(harness(t, [qriHtml()])))
    .finalized.volumeCandidate);
  unknown.futureAuthority = true;
  assert.equal(await Volume.validateCandidate(unknown), false);
});

test("G3-12 renderer parser-result mismatch is rejected before Volume candidate", async t => {
  const h = harness(t, [qriHtml()]);
  const acquired = await h.service.acquire({ requestKind: "active" });
  const canonical = Oi.parseQriOptionsPage(acquired.parserInput, acquired.receipt.acceptedFinalUrl);
  canonical.records[0].value += 1;
  const result = await h.service.finalize({ acquisitionId: acquired.receipt.acquisitionId,
    canonical, cache: null, ivCanonical: null });
  assert.deepEqual([result.success, result.reason], [false, "main_parser_canonical_mismatch"]);
});

test("G3-13 dedicated IndexedDB survives close and reopen", async t => {
  const candidate = (await acquireAndFinalize(harness(t, [qriHtml()])))
    .finalized.volumeCandidate;
  const name = `volume-restart-${++databaseSequence}`;
  const first = VolumeStore.createQriVolumeHistoryStore({ indexedDB, databaseName: name });
  await first.persistCandidate(candidate, { confirmedAt: "2026-11-10T01:00:00.000Z" });
  first.closeHistoryStore();
  const second = VolumeStore.createQriVolumeHistoryStore({ indexedDB, databaseName: name });
  const loaded = await second.loadHistory();
  assert.deepEqual([loaded.status, loaded.history.entries[0].observations[0].observationId],
    ["ready", candidate.observationId]);
});

test("G3-14 pre-activation date is explicitly unavailable", () => {
  assert.deepEqual(Volume.getAvailability(Volume.createEmptyHistory(), "2026-11", "2026-11-09"),
    { status: "unavailable", reason: "pre_activation_or_not_recorded", entry: null });
});

test("G3-15 no legacy snapshot promotion path exists", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/qriVolumeHistoryPersistence.js"), "utf8");
  assert.doesNotMatch(source, /localStorage|lastValid|legacy|savedSnapshot/);
});

test("G3-16 no raw Evidence replay or backfill path exists", () => {
  const sources = ["js/qriVolumeHistory.js", "js/qriVolumeHistoryPersistence.js",
    "js/storage/qriVolumeHistoryStore.js"].map(file => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /resolveRevisionEvidence|rawBytes|backfill|replay/);
});

test("G3-17 OI formal signature excludes Volume", async () => {
  const first = Oi.parseQriOptionsPage(qriHtml(), Qri.ACTIVE_URL);
  const second = Oi.parseQriOptionsPage(qriHtml({ callVolume: "999" }), Qri.ACTIVE_URL);
  assert.equal(await Oi.createSignature(first), await Oi.createSignature(second));
});

test("G3-18 current graph keeps legacy live Volume mapping", () => {
  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(source, /callVolume:\s*sortedRows\.map\(item => item\.callVolume\)/);
  assert.match(source, /putVolume:\s*sortedRows\.map\(item => item\.putVolume\)/);
});

test("G3-19 historical Volume UI remains disabled", () => {
  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(source, /id="historyVolumeButton"[^>]*disabled/);
});

test("G3-20 Volume history and raw Evidence are absent from export surfaces", () => {
  const sources = ["js/fullExportCollector.js", "js/fullExportV2.js",
    "js/calendarExportContract.js"].filter(file => fs.existsSync(path.join(ROOT, file)))
    .map(file => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /qriVolumeHistory|qri-volume-v1|rawBytes/);
});

test("G3 Volume candidate remains available when OI cache is intentionally absent", async t => {
  const h = harness(t, [qriHtml({ callOi: "—", putOi: "—" })]);
  const acquired = await h.service.acquire({ requestKind: "active" });
  const canonical = Oi.parseQriOptionsPage(acquired.parserInput, acquired.receipt.acceptedFinalUrl);
  const result = await h.service.finalize({ acquisitionId: acquired.receipt.acquisitionId,
    canonical, cache: null, ivCanonical: null });
  assert.deepEqual([result.success, result.formalCandidate,
    result.volumeCandidate.canonical.records[0].call.value], [true, null, 100]);
});

test("G3 additive persistence failure never mutates or blocks OI candidate", async t => {
  const result = await acquireAndFinalize(harness(t, [qriHtml()]));
  const persistence = VolumePersistence.createQriVolumeHistoryPersistence({
    store: { openHistoryStore: async () => {}, loadHistory: async () => ({ status: "empty" }),
      persistCandidate: async () => { throw new Error("injected_failure"); } },
    now: () => "2026-11-10T01:00:00.000Z" });
  const before = structuredClone(result.finalized.formalCandidate);
  const failed = await persistence.persistEvidenceCandidate(result.finalized.volumeCandidate,
    { mode: "auto", isCurrentRequest: () => true });
  assert.deepEqual([failed.status, failed.reason, result.finalized.formalCandidate],
    ["failed", "transaction_failure", before]);
});
