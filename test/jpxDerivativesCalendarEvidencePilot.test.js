"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/jpxDerivativesCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const WorkbookSafety = require("../js/marketCalendarRuntime/workbookSafety.js");
const Pilot = require("../js/marketCalendarIsolated/jpxDerivativesCalendarEvidencePilot.js");
const BeaEvidenceSet = require("../js/marketCalendarHistory/beaCalendarSourceEvidenceSet.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const OiSource = require("../js/jpxDerivativesOpenInterest/sourceContract.js");
const PceFormal = require("../js/economicValues/beaPceFormal.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID, GENERATION = "3".repeat(64);
const ACCEPTED_AT = "2026-10-10T01:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const source = Registry.getSource(SOURCE_ID), routes = Network.getPolicy(SOURCE_ID).documents;
const LANDING_URL = source.canonicalUrl;
const WORKBOOK_URL = "https://www.jpx.co.jp/derivatives/rules/last-trading-day/abc-att/" +
  "2026_indexfutures_options_1_j.xlsx";
const SECOND_WORKBOOK_URL = "https://www.jpx.co.jp/derivatives/rules/last-trading-day/def-att/" +
  "2026_indexfutures_options_1_j.xlsx";
const clone = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function workbookBytes({ last = "2026/09/10", sq = "2026/09/11",
  target = "https://external.example/source.xlsx", row = true } = {}) {
  const workbook = XLSX.utils.book_new(), rows = [
    ["商品", "限月取引", "9桁コード", "限月コード", "取引最終日", "権利行使日"]];
  if (row) rows.push(["日経225オプション", "2026年9月限月", "-", "-", last, sq]);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "2026");
  const base = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    container = XLSX.CFB.read(base, { type: "buffer" });
  XLSX.CFB.utils.cfb_add(container, "_rels/optionmap-external.rels", Buffer.from(
    `<Relationship TargetMode="External" Target="${target}"/>`));
  return new Uint8Array(XLSX.CFB.write(container, { type: "buffer", fileType: "zip" }));
}
function parts(options = {}) {
  const original = workbookBytes(options), sanitized = WorkbookSafety.sanitizeValueOnly(
    original, XLSX, { ...WorkbookSafety.LIMITS, maxCompressedBytes: routes[1].maxBytes });
  assert.deepEqual([sanitized.valid, sanitized.sanitized,
    sanitized.originalReason], [true, true, "external_relationship_forbidden"]);
  return { original, parser: new Uint8Array(sanitized.bytes), metadata: {
    valid: true, sanitized: true, originalReason: sanitized.originalReason,
    inspection: sanitized.inspection } };
}
function landingHtml(workbookUrl = WORKBOOK_URL, suffix = "") {
  return `<meta charset="utf-8"><a href="${workbookUrl}">Excel</a>${suffix}`;
}
function encoding() { return { encoding: "utf-8", evidence: { httpCharset: "utf-8",
  bom: null, html5MetaCharset: "utf-8", legacyMetaCharset: null,
  resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 }, warnings: [] }; }
function acquisition(options = {}) {
  const fetchedAt = options.fetchedAt || "2026-10-09T23:30:00.000Z",
    workbookUrl = options.workbookUrl || WORKBOOK_URL,
    landing = new TextEncoder().encode(options.html || landingHtml(workbookUrl)),
    workbook = parts(options.workbook || {}), documents = [{ role: "landing",
      originalOfficialUrl: LANDING_URL, finalUrl: LANDING_URL, redirects: [], httpStatus: 200,
      mime: "text/html", encoding: encoding(), workbook: null, byteCount: landing.byteLength,
      contentSha256: digest(landing), parserInputSha256: digest(landing), parserInput: landing },
    { role: "workbook", originalOfficialUrl: workbookUrl, finalUrl: workbookUrl, redirects: [],
      httpStatus: 200, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      encoding: null, workbook: workbook.metadata, byteCount: workbook.original.byteLength,
      contentSha256: digest(workbook.original), parserInputSha256: digest(workbook.parser),
      parserInput: workbook.parser, evidenceInput: workbook.original }];
  return { success: true, reason: null, retryable: false, sourceId: SOURCE_ID,
    operation: Network.OPERATION, requestedAt: "2026-10-09T23:29:59.000Z", fetchedAt,
    documents: options.reverse ? documents.reverse() : documents, diagnostics: [] };
}
function response(bytes, type) {
  return new Response(bytes, { status: 200, headers: { "content-type": type,
    "content-length": String(bytes.byteLength) } });
}
async function acquiredThroughAcceptedTransport() {
  const original = workbookBytes(), html = new TextEncoder().encode(landingHtml()), calls = [];
  const service = Acquisition.createCalendarAcquisitionService({ maxRetries: 0,
    now: () => new Date("2026-10-09T23:30:00.000Z"), fetchImpl: async url => {
      calls.push(url);
      return url === LANDING_URL ? response(html, "text/html; charset=utf-8") :
        response(original, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } }), result = await service.acquire({ sourceId: SOURCE_ID, operation: Network.OPERATION });
  return { result, original, html, calls };
}
function acquisitionSequence(values) {
  let count = 0;
  return { acquire: async request => {
    assert.deepEqual(request, { sourceId: SOURCE_ID, operation: Network.OPERATION });
    const selected = values[Math.min(count, values.length - 1)]; count += 1;
    return clone(selected);
  }, count: () => count };
}
async function descriptor(indexedDB) {
  const snapshot = await FormalFixture.read(indexedDB);
  return snapshot ? FormalFixture.SourceFixture.descriptor(snapshot) :
    FormalFixture.SourceFixture.absentDescriptor();
}
function formalAdapter(indexedDB, testHooks = null) {
  const h = FormalFixture.harness(indexedDB, testHooks);
  return Object.freeze({
    async readSnapshot() {
      const snapshot = await FormalFixture.read(indexedDB);
      return { status: snapshot ? "available" : "absent", snapshot: snapshot ||
        FormalFixture.SourceFixture.empty() };
    },
    async commit({ sourceResult, acceptedAt, generationIdentity }) {
      const plan = await Preparation.prepareCalendarFormalSourceMutation({ sourceId: SOURCE_ID,
        acquisition: sourceResult, formalSnapshot: await descriptor(indexedDB), acceptedAt,
        generation: generationIdentity, authority: clone(Preparation.AUTHORITY) });
      if (["rejected", "ineligible", "invalid_snapshot", "collision"].includes(plan.status))
        throw new Error(plan.reason || plan.status);
      const grant = await FormalFixture.grant(h.authority, plan), outcome =
        await h.executor.executeCalendarFormalSourceMutation({ plan, grant });
      if (!["committed", "no_semantic_change", "already_committed"].includes(outcome.status))
        throw new Error(outcome.reason || outcome.status);
      return { status: outcome.status === "no_semantic_change" ? "unchanged" : outcome.status,
        reason: null, transactionCount: outcome.committed ? 1 : 0,
        semanticWrites: outcome.mutationCounts.semanticRevisionCreate || 0 };
    }, diagnostics: h.executor.diagnostics
  });
}
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-jpx-derivatives-calendar-evidence-"))), indexedDB =
    options.indexedDB || new IDBFactory(), values = options.acquisitions || [acquisition()],
    transport = acquisitionSequence(values), vault = options.vault ||
    Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
      crashAt: options.vaultCrashAt || null }), formal = options.formal ||
      formalAdapter(indexedDB, options.formalTestHooks || null), runtime =
      Pilot.createPilotRuntime({ acquisition: transport, vault, formal,
        ...(options.builder ? { builder: options.builder } : {}) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, indexedDB, acquisition: transport, vault, formal, runtime };
}
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}

test("R16-1 normal landing and original XLSX are retained in one source run", async t => {
  const live = await acquiredThroughAcceptedTransport(), h = fixture(t,
    { acquisitions: [live.result] }), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([live.calls.length, h.acquisition.count(), result.status,
    result.evidenceTransactionCount, result.formalTransactionCount], [2, 1, "committed", 2, 1]);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(value => value.role),
    ["landing", "workbook"]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(document =>
    h.vault.readOccurrence(document.evidenceRef.occurrenceId).transportVersion),
  [Pilot.ROLE_TRANSPORT_VERSIONS.landing, Pilot.ROLE_TRANSPORT_VERSIONS.workbook]);
  assert.deepEqual(h.vault.readRawBytes(result.sourceEvidenceSet.documents[0]
    .evidenceRef.contentSha256), Buffer.from(live.html));
  assert.deepEqual(h.vault.readRawBytes(result.sourceEvidenceSet.documents[1]
    .evidenceRef.contentSha256), Buffer.from(live.original));
});

test("R16-2 restart resolves revision through run set and both raw contents", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([acquisition()]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documents.length,
      resolved.documentRole], ["available", "valid", 2, "workbook"]);
    for (const document of resolved.documents)
      assert.equal(restartedVault.readRawBytes(document.evidenceRef.contentSha256).byteLength,
        document.byteLength);
  }
});

test("R16-3 Vault workbook identity equals the original response identity", async t => {
  const acquired = acquisition(), original = acquired.documents[1].evidenceInput,
    h = fixture(t, { acquisitions: [acquired] }), result = await h.runtime.acquireAndCommit(INPUT),
    document = result.sourceEvidenceSet.documents[1];
  assert.deepEqual([document.evidenceRef.contentSha256, document.byteLength],
    [digest(original), original.byteLength]);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256), Buffer.from(original));
});

test("R16-4 sanitized parser workbook never becomes raw evidence", async t => {
  const acquired = acquisition(), workbook = acquired.documents[1];
  assert.notEqual(workbook.contentSha256, workbook.parserInputSha256);
  const h = fixture(t, { acquisitions: [acquired] }), result = await h.runtime.acquireAndCommit(INPUT),
    raw = h.vault.readRawBytes(result.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(raw, Buffer.from(workbook.evidenceInput));
  assert.notDeepEqual(raw, Buffer.from(workbook.parserInput));
  assert.equal(h.vault.readContentMetadata(workbook.parserInputSha256), null);
});

test("R16-5 duplicate documents dedupe content while retaining occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition({
    fetchedAt: "2026-10-10T00:30:00.000Z" })] });
  const first = await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-10T02:00:00.000Z" });
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  for (const document of first.sourceEvidenceSet.documents)
    assert.equal(h.vault.occurrencesByContentSha256(document.evidenceRef.contentSha256).length, 2);
});

test("R16-6 landing raw-only change creates evidence and semantic write0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition({
    html: landingHtml(WORKBOOK_URL, "<!-- presentation only -->"),
    fetchedAt: "2026-10-10T00:30:00.000Z" })] }), first =
    await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-10T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.equal(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R16-7 workbook raw-only change creates evidence and semantic write0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition({ workbook: {
    target: "https://external.example/changed.xlsx" },
    fetchedAt: "2026-10-10T00:30:00.000Z" })] }), first =
    await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-10T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R16-8 semantic schedule change appends immutable revisions", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition({ workbook: {
    last: "2026/09/09", sq: "2026/09/10" }, fetchedAt: "2026-10-10T00:30:00.000Z" })] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-10T03:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.equal(before.revisions.every(old => after.revisions.some(value =>
    value.revisionKey === old.revisionKey)), true);
  assert.equal(after.revisions.length > before.revisions.length, true);
  const oldView = await History.queryAsKnownAt(after, { calendarDate: "2026-09-11",
    knowledgeAt: "2026-10-10T02:00:00.000Z" }), newView = await History.queryAsKnownAt(after,
    { calendarDate: "2026-09-10", knowledgeAt: "2026-10-10T04:00:00.000Z" });
  assert.equal(oldView.events.length > 0, true); assert.equal(newView.events.length > 0, true);
});

test("R16-9 changed valid discovered URL creates a new evidence set only", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition({
    workbookUrl: SECOND_WORKBOOK_URL, fetchedAt: "2026-10-10T00:30:00.000Z" })] }), first =
    await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-10T02:00:00.000Z" });
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.setSha256, second.sourceEvidenceSet.setSha256);
  assert.equal(second.sourceEvidenceSet.documents[1].sourceUrl, SECOND_WORKBOOK_URL);
});

test("R16-10 external discovered workbook URL is rejected before Vault write", async t => {
  const url = "https://evil.example/2026_indexfutures_options_1_j.xlsx",
    h = fixture(t, { acquisitions: [acquisition({ workbookUrl: url })] }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.evidenceTransactionCount,
    result.formalTransactionCount], ["failed", "landing_discovery_rejected", 0, 0]);
});

test("R16-11 ambiguous workbook discovery is rejected", async t => {
  const h = fixture(t, { acquisitions: [acquisition({ html: `${landingHtml(WORKBOOK_URL)}${
    landingHtml(SECOND_WORKBOOK_URL)}` })] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.reason],
    ["failed", "landing_discovery_rejected", "workbook_discovery_ambiguous"]);
});

for (const [id, role] of [["R16-12", "landing"], ["R16-13", "workbook"]])
  test(`${id} missing ${role} rejects the complete source run`, async t => {
    const missing = acquisition(); missing.documents = missing.documents.filter(value =>
      value.role !== role);
    const h = fixture(t, { acquisitions: [missing] }), result =
      await h.runtime.acquireAndCommit(INPUT);
    assert.deepEqual([result.status, result.diagnostic, result.evidenceTransactionCount,
      result.formalTransactionCount], ["failed", "source_run_consistency_rejected", 0, 0]);
  });

test("R16-14 workbook MIME mismatch is a transport rejection", async t => {
  const invalid = acquisition(); invalid.documents[1].mime = "text/html";
  const h = fixture(t, { acquisitions: [invalid] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "workbook_transport_rejected", 0]);
});

test("R16-15 safe workbook with no accepted rows retains evidence but no Formal promotion", async t => {
  const invalid = acquisition({ workbook: { row: false } }), h = fixture(t,
    { acquisitions: [invalid] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 2);
});

test("R16-16 Vault failure remains source-local and writes no Formal state", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R16-17 JPX Derivatives evidence failure leaves the other twelve sources eligible", async () => {
  const sources = await AcquisitionFixture.allSuccess(), index = sources.findIndex(value =>
    value.sourceId === SOURCE_ID);
  sources[index] = AcquisitionFixture.transportFailure(sources[index]);
  sources[index].evidenceDiagnostic = "source_evidence_write_failed";
  const result = await Contract.evaluateAcquisitionGeneration({ sourceResults: sources,
    acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  assert.equal(result.eligibleSources.length, 12); assert.deepEqual(result.failedSources, [SOURCE_ID]);
});

test("R16-18 pre-activation history stays valid with unavailable evidence", async t => {
  const h = fixture(t), sourceResult = await AcquisitionFixture.validSource(SOURCE_ID);
  await h.formal.commit({ sourceResult, acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  const before = (await h.runtime.readSnapshot()).snapshot, resolved =
    EvidenceSet.resolveRevisionEvidence({ snapshot: before, vault: h.vault,
      revisionKey: before.revisions[0].revisionKey }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

for (const [id, index] of [["R16-19", 0], ["R16-20", 1]])
  test(`${id} tampering either evidence role invalidates the complete set`, async t => {
    const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
      (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[index],
      target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
    const resolved = EvidenceSet.resolveRunEvidence({ run: snapshot.runs[0], vault: h.vault });
    assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  });

test("R16-21 JPX Calendar Holidays Daily OI Weekly and Participants stay separate", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT);
  assert.equal(result.sourceEvidenceSet.sourceId, SOURCE_ID);
  assert.equal(OiSource.SOURCE_ID, "jp-jpx-derivatives-open-interest-daily");
  assert.notEqual(result.sourceEvidenceSet.sourceId, "jp-jpx-market-holidays");
  assert.notEqual(result.sourceEvidenceSet.sourceId, OiSource.SOURCE_ID);
  assert.equal(result.sourceEvidenceSet.documents.every(value =>
    value.evidenceRef.sourceFamily === "market_calendar"), true);
});

test("R16-22 Calendar Export contains neither raw workbook nor Evidence references", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-10T05:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available",
        persistedSourceIds: [SOURCE_ID], absentSourceIds:
          Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact);
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|evidenceInput|rawBody/);
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
});

test("R16-23 prior Calendar evidence contracts remain active without BOJ MOF or Fed", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), true);
  assert.equal(BeaEvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), false);
  for (const id of ["us-bls-calendar", "us-nyse-market-holidays", "jp-esri-sna-calendar",
    "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
    "us-census-calendar", "jp-jpx-market-holidays", "us-bea-calendar", SOURCE_ID,
    "jp-boj-calendar"])
    assert.equal(preparation.includes(`"${id}":`), true);
  for (const id of ["jp-mof-jgb-auction-calendar", "us-fed-fomc-calendar"])
    assert.equal(preparation.includes(`"${id}":`), false);
});

test("R16-24 Economic evidence Runtime State and startup remain outside activation", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/jpxDerivativesCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(PceFormal.SOURCE_ID, "us-bea-pce-values");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC/);
  assert.doesNotMatch(preparation, /economicValues/);
});
