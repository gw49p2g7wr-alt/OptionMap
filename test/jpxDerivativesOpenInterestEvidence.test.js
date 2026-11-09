"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");
const { IDBFactory } = require("fake-indexeddb");
const acquisition = require("../js/jpxDerivativesOpenInterest/acquisitionCoordinator.js");
const evidence = require("../js/jpxDerivativesOpenInterest/sourceEvidence.js");
const source = require("../js/jpxDerivativesOpenInterest/sourceContract.js");
const parser = require("../js/jpxDerivativesOpenInterest/workbookParser.js");
const history = require("../js/jpxDerivativesOpenInterest/historyContract.js");
const identity = require("../js/jpxDerivativesOpenInterest/identity.js");
const writerApi = require("../js/jpxDerivativesOpenInterest/controlledWriter.js");
const readerApi = require("../js/jpxDerivativesOpenInterest/readOnlyConsumer.js");
const vaultApi = require("../js/sourceEvidence/sourceEvidenceVault.js");
const evidenceContract = require("../js/sourceEvidence/sourceEvidenceContract.js");
const faithful = require("../js/fullExportSourceFaithfulCanonical.js");

const fixture = path.join(__dirname,
  "fixtures/jpx-derivatives-open-interest/20260918open_interest.xlsx");
const original = fs.readFileSync(fixture);
const workbookUrl = "https://www.jpx.co.jp/markets/derivatives/trading-volume/" +
  "tvdivq00000014nn-att/20260918open_interest.xlsx";
const AT = "2026-09-18T10:26:39.000Z";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function isolatedVault(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-r21-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault: vaultApi.createIsolatedVault({ root,
    targetEnvironment: "isolated_test", crashAt: null }) };
}
async function acquire({ vault, bytes = original, fetchedAt = AT, declaredSha = digest(bytes),
    contentLength = bytes.byteLength, context = "live_original_acquisition", xlsx = XLSX } = {}) {
  let listingCalls = 0, workbookCalls = 0;
  const runner = acquisition.createEvidenceBound({ XLSX: xlsx, evidenceVault: vault,
    acquisitionContext: context,
    fetchListing: async () => { listingCalls++; return { text:
      `<a href="${workbookUrl}">Excel</a>` }; },
    fetchWorkbook: async url => { workbookCalls++; return { bytes, fetchedAt,
      sha256: declaredSha, finalUrl: url, httpMetadata: { status: 200,
        contentType: MIME, contentLength } }; } });
  return { result: await runner.run(), listingCalls, workbookCalls };
}
async function plan(result, snapshot = history.snapshotEmpty()) {
  return history.makePlan(snapshot, { canonical: result.canonical, evidence: result.evidence }, {
    runId: result.acquisitionRunId, acceptedAt: result.evidence.acquiredAt });
}
function changedCanonicalWorkbook() {
  const book = XLSX.read(original, { type: "buffer", cellStyles: true, cellNF: true,
    cellText: true }), cell = book.Sheets[source.SHEET_NAME].C30;
  cell.v += 1; cell.w = String(cell.v);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", cellStyles: true });
}
function legacyCandidate() {
  const sha = digest(original);
  return parser.parse({ XLSX, bytes: original, listingDate: "2026-09-18", workbookUrl,
    listingUrl: source.LISTING_URL, fetchedAt: AT, workbookSha256: sha,
    httpMetadata: { status: 200, contentType: MIME, contentLength: original.byteLength } });
}

test("R21-1 normal Daily OI XLSXはoriginal bytesをretainしてrevisionへbind", async t => {
  const { vault } = isolatedVault(t), run = await acquire({ vault });
  assert.equal(run.result.accepted, true); assert.equal(run.listingCalls, 1);
  assert.equal(run.workbookCalls, 1); assert.equal(run.result.evidence.sourceEvidence.state, "available");
  assert.equal(Buffer.compare(vault.readRawBytes(run.result.evidence.workbookSha256),
    Buffer.from(original)), 0);
  const first = await plan(run.result);
  assert.deepEqual(first.appendEvidence.evidence.sourceEvidence,
    run.result.evidence.sourceEvidence);
});

test("R21-2 restart後もrevisionからoccurrenceとraw workbookを解決", async t => {
  const { root, vault } = isolatedVault(t), run = await acquire({ vault }), first = await plan(run.result);
  const indexedDB = new IDBFactory(), databaseName = `r21-restart-${Date.now()}`;
  const writer = writerApi.create({ indexedDB, databaseName, enabled: true,
    authorizationToken: "fixture-only", allowCreate: true });
  const saved = await writer.write({ authorization: "fixture-only", plan: first,
    expectedPreconditionIdentity: await identity.preconditionIdentity(history.snapshotEmpty()) });
  assert.equal(saved.saved, true);
  const reopenedHistory = await readerApi.create({ indexedDB, databaseName }).readSnapshot();
  const reopenedVault = vaultApi.createIsolatedVault({ root,
    targetEnvironment: "isolated_test", crashAt: null });
  const resolved = evidence.resolveAcquisitionEvidence({ snapshot: reopenedHistory.snapshot,
    vault: reopenedVault, evidenceKey: first.appendEvidence.evidenceKey });
  assert.equal(resolved.status, "available");
  assert.equal(resolved.parserLineage.canonicalIdentity.value, first.appendEvidence.revisionKey);
  assert.equal(Buffer.compare(Buffer.from(resolved.rawBytes), Buffer.from(original)), 0);
});

test("R21-3 Vault SHAは既存workbookSha256とexact一致し不一致を拒否", async t => {
  const { vault } = isolatedVault(t), accepted = await acquire({ vault });
  assert.equal(accepted.result.evidence.sourceEvidence.contentSha256, digest(original));
  const rejected = await acquire({ vault, declaredSha: "0".repeat(64),
    fetchedAt: "2026-09-18T10:27:39.000Z" });
  assert.equal(rejected.result.accepted, false);
  assert.equal(rejected.result.diagnostics[0].code, "workbook_sha256_mismatch");
});

test("R21-4 exact byte lengthをbindしtransport metadata mismatchを拒否", async t => {
  const { vault } = isolatedVault(t), accepted = await acquire({ vault });
  assert.equal(accepted.result.evidence.workbookByteLength, original.byteLength);
  const rejected = await acquire({ vault, contentLength: original.byteLength + 1,
    fetchedAt: "2026-09-18T10:28:39.000Z" });
  assert.equal(rejected.result.accepted, false);
  assert.equal(rejected.result.diagnostics[0].reason,
    "jpx_daily_oi_evidence_byte_length_mismatch");
});

test("R21-5 duplicate bytesはcontent dedupeしacquisition facts別occurrence", async t => {
  const { vault } = isolatedVault(t), first = await acquire({ vault }), second = await acquire({
    vault, fetchedAt: "2026-09-18T11:26:39.000Z" });
  assert.equal(second.result.sourceEvidenceResult.contentClassification, "verified_reuse");
  assert.notEqual(first.result.evidence.sourceEvidence.occurrenceId,
    second.result.evidence.sourceEvidence.occurrenceId);
  assert.equal(vault.occurrencesByContentSha256(digest(original)).length, 2);
});

test("R21-6 changed raw / same canonicalはnew evidence・semantic write0", async t => {
  const { vault } = isolatedVault(t), first = await acquire({ vault }), snapshot =
    history.simulate(history.snapshotEmpty(), await plan(first.result));
  const changedRaw = Buffer.concat([original, Buffer.from([0])]), second = await acquire({
    vault, bytes: changedRaw, fetchedAt: "2026-09-18T11:26:39.000Z" });
  const secondPlan = await plan(second.result, snapshot);
  assert.notEqual(first.result.evidence.workbookSha256, second.result.evidence.workbookSha256);
  assert.equal(secondPlan.outcome, "semantic_unchanged");
  assert.equal(secondPlan.appendRevision, null);
});

test("R21-7 changed raw / changed canonicalはimmutable semantic revision", async t => {
  const { vault } = isolatedVault(t), first = await acquire({ vault }), snapshot =
    history.simulate(history.snapshotEmpty(), await plan(first.result));
  const bytes = changedCanonicalWorkbook(), second = await acquire({ vault, bytes,
    fetchedAt: "2026-09-18T12:26:39.000Z" }), secondPlan = await plan(second.result, snapshot),
    after = history.simulate(snapshot, secondPlan);
  assert.equal(secondPlan.outcome, "semantic_revision");
  assert.equal(after.revisions.length, 2);
  assert.equal(after.revisions.filter(value => value.closedAt === null).length, 1);
});

test("R21-8 parserはVaultに保存したoriginal bytesと同じbytesだけを受領", async t => {
  const { vault } = isolatedVault(t); let parserBytes = null;
  const observedXlsx = Object.create(XLSX);
  observedXlsx.read = (value, options) => { parserBytes = Buffer.from(value);
    return XLSX.read(value, options); };
  const run = await acquire({ vault, xlsx: observedXlsx });
  assert.equal(run.result.accepted, true);
  assert.equal(Buffer.compare(parserBytes, Buffer.from(original)), 0);
  assert.equal(Buffer.compare(vault.readRawBytes(run.result.evidence.workbookSha256),
    Buffer.from(original)), 0);
});

test("R21-9 workbook safety failureはEvidenceをFormalへpromotionしない", async t => {
  const { vault } = isolatedVault(t), unsafe = Buffer.concat([original,
    Buffer.from("vbaProject.bin")]), run = await acquire({ vault, bytes: unsafe });
  assert.equal(run.result.accepted, false);
  assert.ok(run.result.diagnostics.some(value => value.code === "unsafe_workbook_relationship"));
  assert.equal(vault.vaultStatus().occurrenceCount, 1);
  assert.equal(run.result.identities, undefined);
});

test("R21-10 Vault failureはparser/Formal前にtransaction0", async () => {
  let parserReads = 0; const observedXlsx = Object.create(XLSX);
  observedXlsx.read = (...args) => { parserReads++; return XLSX.read(...args); };
  const vault = { storeAcceptedEvidence: () => { throw new Error("fixture_vault_failure"); },
    verifyOccurrence: () => ({ status: "missing" }) };
  const run = await acquire({ vault, xlsx: observedXlsx });
  assert.equal(run.result.accepted, false); assert.equal(parserReads, 0);
  assert.deepEqual({ formal: run.result.formalTransactionCount,
    semantic: run.result.semanticWrites }, { formal: 0, semantic: 0 });
});

test("R21-11 pre-activation historyは有効でEvidence unavailable", async t => {
  const { vault } = isolatedVault(t), candidate = legacyCandidate(), first = await history.makePlan(
    history.snapshotEmpty(), candidate, { runId: "legacy-run", acceptedAt: AT }), snapshot =
    history.simulate(history.snapshotEmpty(), first), resolved = evidence.resolveAcquisitionEvidence({
      snapshot, vault, evidenceKey: first.appendEvidence.evidenceKey });
  assert.equal(resolved.status, "unavailable"); assert.equal(resolved.reason, "pre_activation");
});

test("R21-12 trusted historical route未承認のためarchive contextをfail-closed", async t => {
  const { vault } = isolatedVault(t), run = await acquire({ vault,
    context: "historical_archive_fetch" });
  assert.equal(run.result.accepted, false);
  assert.equal(run.result.diagnostics[0].reason,
    "jpx_daily_oi_historical_route_not_approved");
  assert.equal(vault.vaultStatus().status, "absent");
});

test("R21-13 tampered raw contentはrestart resolverが検出", async t => {
  const { root, vault } = isolatedVault(t), run = await acquire({ vault }), first = await plan(run.result),
    snapshot = history.simulate(history.snapshotEmpty(), first), sha = run.result.evidence.workbookSha256,
    rawPath = path.join(root, vaultApi.VAULT_DIRECTORY, vaultApi.VAULT_VERSION_DIRECTORY,
      vaultApi.DIRECTORY_NAMES.objects, sha.slice(0, 2), sha);
  const tampered = Buffer.from(original); tampered[0] ^= 0xff; fs.writeFileSync(rawPath, tampered);
  const resolved = evidence.resolveAcquisitionEvidence({ snapshot, vault,
    evidenceKey: first.appendEvidence.evidenceKey });
  assert.equal(resolved.status, "invalid");
});

test("R21-14 forged Evidence refはsource/occurrence bindingでreject", async t => {
  const { vault } = isolatedVault(t), run = await acquire({ vault }), first = await plan(run.result),
    snapshot = history.simulate(history.snapshotEmpty(), first), policy =
      evidenceContract.createSourcePolicy({ sourceFamily: "market_calendar",
        sourceId: "jp-jpx-derivatives-calendar", allowedMediaTypes: [MIME],
        allowedEncodings: [], maxBytes: original.byteLength }), contentObject =
      evidenceContract.createContentObject({ bytes: original, mediaType: MIME,
        encoding: null, policy }), other = evidenceContract.createAcquisitionOccurrence({
        sourceFamily: "market_calendar", sourceId: "jp-jpx-derivatives-calendar",
        initialUrl: workbookUrl, sourceUrl: workbookUrl, fetchedAt: AT, httpStatus: 200,
        contentObject, transportVersion: "fixture-v1", publishedAt: null,
        requestRole: "workbook", redirectHops: [], sourceDocumentRole: "workbook",
        runId: "fixture-run", acquisitionContext: "live_original_acquisition" }, policy);
  vault.storeAcceptedEvidence({ bytes: original, contentObject, occurrence: other, policy });
  const forged = structuredClone(snapshot);
  forged.evidence[0].evidence.sourceEvidence.occurrenceId = other.occurrenceId;
  const resolved = evidence.resolveAcquisitionEvidence({ snapshot: forged, vault,
    evidenceKey: first.appendEvidence.evidenceKey });
  assert.equal(resolved.status, "invalid");
  const parserForged = structuredClone(snapshot);
  parserForged.evidence[0].evidence.parserVersion = "2";
  assert.equal(evidence.resolveAcquisitionEvidence({ snapshot: parserForged, vault,
    evidenceKey: first.appendEvidence.evidenceKey }).status, "invalid");
});

test("R21-15 JPX CalendarとDaily OIはcontent dedupeしてもoccurrence分離", async t => {
  const { vault } = isolatedVault(t), daily = await acquire({ vault }), policy =
    evidenceContract.createSourcePolicy({ sourceFamily: "market_calendar",
      sourceId: "jp-jpx-derivatives-calendar", allowedMediaTypes: [MIME],
      allowedEncodings: [], maxBytes: original.byteLength }), contentObject =
    evidenceContract.createContentObject({ bytes: original, mediaType: MIME,
      encoding: null, policy }), calendar = evidenceContract.createAcquisitionOccurrence({
      sourceFamily: "market_calendar", sourceId: "jp-jpx-derivatives-calendar",
      initialUrl: workbookUrl, sourceUrl: workbookUrl, fetchedAt: AT, httpStatus: 200,
      contentObject, transportVersion: "fixture-v1", publishedAt: null,
      requestRole: "workbook", redirectHops: [], sourceDocumentRole: "workbook",
      runId: "calendar-fixture", acquisitionContext: "live_original_acquisition" }, policy), stored =
    vault.storeAcceptedEvidence({ bytes: original, contentObject, occurrence: calendar, policy });
  assert.equal(stored.contentClassification, "verified_reuse");
  assert.notEqual(calendar.occurrenceId, daily.result.evidence.sourceEvidence.occurrenceId);
  assert.equal(vault.occurrencesByContentSha256(digest(original)).length, 2);
});

test("R21-16 Full Exportはraw workbook bytesを含めない", async t => {
  const { vault } = isolatedVault(t), run = await acquire({ vault }), first = await plan(run.result),
    snapshot = history.simulate(history.snapshotEmpty(), first), active = {
      status: "available", revision: snapshot.revisions[0], evidence: snapshot.evidence[0] },
    projected = faithful.jpxDerivativesOpenInterest(active), serialized = JSON.stringify(projected);
  assert.equal(projected.selectionPolicy.rawExcelIncluded, false);
  assert.equal(serialized.includes("rawBytes"), false);
  assert.equal(serialized.includes(original.toString("base64").slice(0, 64)), false);
});

test("R21-17 activated planはacquisition run binding不一致を拒否", async t => {
  const { vault } = isolatedVault(t), run = await acquire({ vault });
  await assert.rejects(() => history.makePlan(history.snapshotEmpty(), {
    canonical: run.result.canonical, evidence: run.result.evidence }, {
    runId: "forged-run", acceptedAt: AT }), /source_evidence_run_binding_invalid/);
});
