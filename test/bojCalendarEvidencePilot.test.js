"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/bojCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Coverage = require("../js/marketCalendarRuntime/bojCoverageAcquisition.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Pilot = require("../js/marketCalendarIsolated/bojCalendarEvidencePilot.js");
const JpxEvidenceSet = require("../js/marketCalendarHistory/jpxDerivativesCalendarSourceEvidenceSet.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Economic = require("../js/economicValues/beaPceFormal.js");
const BojFixture = require("./fixtures/marketCalendar/bojCoverageFixture.js");
const ShouldFixture = require("./fixtures/marketCalendar/bojShouldFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID, GENERATION = "4".repeat(64);
const ACCEPTED_AT = "2026-10-14T02:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const routes = Network.BOJ_COVERAGE_V3.documents;
const URLS = Object.freeze(Object.fromEntries(routes.map(route => [route.role, route.url])));
const clone = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function response(body, contentType, status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(bytes, { status, headers: { "content-type": contentType,
    "content-length": String(bytes.byteLength) } });
}
function bodies(options = {}) {
  return { primary: options.primary || BojFixture.primary,
    speeches: options.speeches || BojFixture.speeches(),
    tankan: options.tankan || ShouldFixture.workbook(),
    meeting_publications: options.meetingPublications || ShouldFixture.meetings() };
}
async function acquire(options = {}) {
  const content = bodies(options), calls = [], mime = options.mime || {}, status = options.status || {},
    byUrl = new Map([[URLS.primary, [content.primary, mime.primary || "text/html; charset=utf-8"]],
      [URLS.speeches, [content.speeches, mime.speeches || "text/html; charset=utf-8"]],
      [URLS.tankan, [content.tankan, mime.tankan ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
      [URLS.meeting_publications, [content.meeting_publications,
        mime.meeting_publications || "text/html; charset=utf-8"]]]), runtime =
    Coverage.createShould({ now: () => options.fetchedAt || "2026-10-14T01:00:00.000Z",
      fetchImpl: async url => {
        calls.push(url); const role = routes.find(route => route.url === url)?.role,
          selected = byUrl.get(url);
        if (!selected) throw new Error("boj_fixture_url_unexpected");
        return response(selected[0], selected[1], status[role] || 200);
      } }), result = await runtime.acquireForEvidence({ sourceId: SOURCE_ID,
      operation: Network.OPERATION });
  return { result, calls, bodies: content, runtime };
}
function acquisitionSequence(values) {
  let count = 0;
  return { acquireForEvidence: async request => {
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
async function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-boj-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
    values = options.acquisitions || [(await acquire()).result],
    transport = options.acquisition || acquisitionSequence(values), vault = options.vault ||
    Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
      crashAt: options.vaultCrashAt || null }), formal = options.formal ||
    formalAdapter(indexedDB, options.formalTestHooks || null), runtime =
    Pilot.createPilotRuntime({ acquisition: transport, vault, formal });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, indexedDB, acquisition: transport, vault, formal, runtime };
}
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}
function rawFor(acquisition, role) {
  const document = acquisition.documents.find(value => value.role === role);
  return document.evidenceInput || document.parserInput;
}

test("R17-1 normal fixed four-role BOJ acquisition retains all raw documents", async t => {
  const live = await acquire(), h = await fixture(t, { acquisitions: [live.result] }), result =
    await h.runtime.acquireAndCommit(INPUT), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([live.calls.length, h.acquisition.count(), result.status,
    result.evidenceTransactionCount, result.formalTransactionCount], [4, 1, "committed", 4, 1]);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(value => value.role),
    ["primary", "speeches", "tankan", "meeting_publications"]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  for (const document of result.sourceEvidenceSet.documents)
    assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256),
      Buffer.from(rawFor(live.result, document.role)));
});

test("R17-2 restart preserves revision to run set and four-content lineage", async t => {
  const h = await fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([(await acquire()).result]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documents.length],
      ["available", "valid", 4]);
    assert.equal(resolved.parserLineage.length, 1);
  }
});

test("R17-3 evidence role order is fixed and deterministic", async t => {
  const base = (await acquire()).result, acquired = { ...base,
    documents: [...base.documents].reverse() };
  const h = await fixture(t, { acquisitions: [acquired] }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(value => value.role),
    routes.map(value => value.role));
});

test("R17-4 three HTML roles and one XLSX role retain explicit contracts", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), documents =
    result.sourceEvidenceSet.documents;
  assert.deepEqual(documents.map(value => value.mediaType), ["text/html", "text/html",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/html"]);
  assert.deepEqual(documents.map(value => value.encoding), ["utf-8", "utf-8", null, "utf-8"]);
});

test("R17-5 Vault Tankan identity equals original XLSX response bytes", async t => {
  const acquired = (await acquire()).result, original = rawFor(acquired, "tankan"),
    h = await fixture(t, { acquisitions: [acquired] }), result =
      await h.runtime.acquireAndCommit(INPUT), document = result.sourceEvidenceSet.documents[2];
  assert.deepEqual([document.evidenceRef.contentSha256, document.byteLength],
    [digest(original), original.byteLength]);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256), Buffer.from(original));
});

test("R17-6 duplicate four-role acquisition dedupes content and retains occurrences", async t => {
  const firstAcquisition = (await acquire()).result, secondAcquisition =
    (await acquire({ fetchedAt: "2026-10-14T03:00:00.000Z" })).result,
    h = await fixture(t, { acquisitions: [firstAcquisition, secondAcquisition] }), first =
      await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
        ...INPUT, acceptedAt: "2026-10-14T04:00:00.000Z" });
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  for (const document of first.sourceEvidenceSet.documents)
    assert.equal(h.vault.occurrencesByContentSha256(document.evidenceRef.contentSha256).length, 2);
});

test("R17-7 one HTML raw-only change creates evidence and semantic write0", async t => {
  const firstAcquisition = (await acquire()).result, secondAcquisition = (await acquire({
    speeches: `${BojFixture.speeches()}<!-- presentation only -->`,
    fetchedAt: "2026-10-14T03:00:00.000Z" })).result, h = await fixture(t,
      { acquisitions: [firstAcquisition, secondAcquisition] }), first =
      await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-14T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R17-8 Tankan raw-only change creates evidence and semantic write0", async t => {
  const changed = ShouldFixture.workbook(book => {
    book.Sheets["統計データ"].P300 = { t: "s", v: "presentation-only" };
  }), firstAcquisition = (await acquire()).result, secondAcquisition = (await acquire({
    tankan: changed, fetchedAt: "2026-10-14T03:00:00.000Z" })).result,
    h = await fixture(t, { acquisitions: [firstAcquisition, secondAcquisition] }), first =
      await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-14T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[2].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[2].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R17-9 semantic BOJ event change appends immutable revisions", async t => {
  const changed = BojFixture.primary.replace("29日（木）、30日（金）", "28日（水）、29日（木）")
    .replace("30日（金）15:30", "29日（木）15:30"), firstAcquisition =
    (await acquire()).result, secondAcquisition = (await acquire({ primary: changed,
      fetchedAt: "2026-10-14T03:00:00.000Z" })).result, h = await fixture(t,
      { acquisitions: [firstAcquisition, secondAcquisition] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-14T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.equal(before.revisions.every(old => after.revisions.some(value =>
    value.revisionKey === old.revisionKey)), true);
  assert.equal(after.revisions.length > before.revisions.length, true);
});

for (const [id, role] of [["R17-10", "primary"], ["R17-11", "speeches"],
  ["R17-12", "tankan"], ["R17-13", "meeting_publications"]])
  test(`${id} missing ${role} rejects the complete BOJ source run`, async t => {
    const missing = (await acquire()).result;
    missing.documents = missing.documents.filter(value => value.role !== role);
    const h = await fixture(t, { acquisitions: [missing] }), result =
      await h.runtime.acquireAndCommit(INPUT);
    assert.deepEqual([result.status, result.diagnostic, result.evidenceTransactionCount,
      result.formalTransactionCount], ["failed", "source_evidence_set_invalid", 0, 0]);
  });

test("R17-14 role-specific parser/workbook failures never promote Formal state", async t => {
  const badPrimary = (await acquire({ primary: "<meta charset=\"utf-8\"><p>broken</p>" })).result,
    primaryHarness = await fixture(t, { acquisitions: [badPrimary] }), primaryResult =
      await primaryHarness.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([primaryResult.status, primaryResult.diagnostic,
    primaryResult.formalTransactionCount], ["failed", "primary_parser_rejected", 0]);
  const badSpeech = (await acquire({ speeches: BojFixture.speeches().replace("開催日", "日付") })).result,
    h = await fixture(t, { acquisitions: [badSpeech] }), speechResult =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([speechResult.status, speechResult.diagnostic,
    speechResult.formalTransactionCount], ["failed", "speeches_parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 4);
  const badWorkbook = ShouldFixture.workbook(book => {
    delete book.Sheets["統計データ"].D237;
  }), workbookAcquisition = (await acquire({ tankan: badWorkbook })).result,
    workbookHarness = await fixture(t, { acquisitions: [workbookAcquisition] }), workbookResult =
      await workbookHarness.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([workbookResult.status, workbookResult.diagnostic,
    workbookResult.formalTransactionCount], ["failed", "tankan_workbook_rejected", 0]);
  const badMeeting = (await acquire({ meetingPublications: ShouldFixture.meetings()
    .replace("各資料の公表日", "公表日") })).result, meetingHarness =
      await fixture(t, { acquisitions: [badMeeting] }), meetingResult =
      await meetingHarness.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([meetingResult.status, meetingResult.diagnostic,
    meetingResult.formalTransactionCount], ["failed", "meeting_publications_parser_rejected", 0]);
  const badTankan = await acquire({ mime: { tankan: "text/html" } }), tankanHarness =
    await fixture(t, { acquisition: badTankan.runtime }), tankanResult =
      await tankanHarness.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([tankanResult.status, tankanResult.diagnostic,
    tankanResult.formalTransactionCount], ["failed", "tankan_transport_rejected", 0]);
});

test("R17-15 Vault failure remains BOJ-local with Formal transaction0", async t => {
  const h = await fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R17-16 BOJ evidence failure leaves the other twelve sources eligible", async () => {
  const sources = await AcquisitionFixture.allSuccess(), index = sources.findIndex(value =>
    value.sourceId === SOURCE_ID);
  sources[index] = AcquisitionFixture.transportFailure(sources[index]);
  sources[index].evidenceDiagnostic = "source_evidence_write_failed";
  const result = await Contract.evaluateAcquisitionGeneration({ sourceResults: sources,
    acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  assert.equal(result.eligibleSources.length, 12); assert.deepEqual(result.failedSources, [SOURCE_ID]);
});

test("R17-17 pre-activation BOJ history remains valid with unavailable evidence", async t => {
  const h = await fixture(t), sourceResult = await AcquisitionFixture.validSource(SOURCE_ID);
  await h.formal.commit({ sourceResult, acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  const before = (await h.runtime.readSnapshot()).snapshot, resolved =
    EvidenceSet.resolveRevisionEvidence({ snapshot: before, vault: h.vault,
      revisionKey: before.revisions[0].revisionKey }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R17-18 old blocked Runtime State remains byte-for-byte caller-owned", async t => {
  const blocked = Object.freeze({ sourceId: SOURCE_ID, state: "blocked",
    reason: "security_violation", retryAfter: null }), before = JSON.stringify(blocked),
    h = await fixture(t);
  await h.runtime.acquireAndCommit(INPUT);
  assert.equal(JSON.stringify(blocked), before);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/bojCalendarEvidencePilot.js"), "utf8"),
  /RuntimeState|runtimeState|manualReset|retryAfter/);
});

test("R17-19 evidence activation adds no retry or recovery behavior", async t => {
  const failed = await acquire({ status: { primary: 503 } }), callsBefore = failed.calls.length,
    h = await fixture(t,
    { acquisition: failed.runtime }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([failed.calls.length - callsBefore, result.status, result.evidenceTransactionCount,
    result.formalTransactionCount], [1, "failed", 0, 0]);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/bojCalendarEvidencePilot.js"), "utf8"),
  /friend|Windows|recovery|retryLoop|manualReset/);
});

test("R17-20 tamper in any evidence role invalidates the full set", async t => {
  for (let index = 0; index < routes.length; index += 1) {
    const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
      (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[index],
      target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
    const resolved = EvidenceSet.resolveRunEvidence({ run: snapshot.runs[0], vault: h.vault });
    assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  }
});

test("R17-21 BOJ as-known-at preserves old and new semantic truths", async t => {
  const changed = BojFixture.primary.replace("29日（木）、30日（金）", "28日（水）、29日（木）")
    .replace("30日（金）15:30", "29日（木）15:30"), h = await fixture(t,
      { acquisitions: [(await acquire()).result, (await acquire({ primary: changed,
        fetchedAt: "2026-10-14T03:00:00.000Z" })).result] });
  await h.runtime.acquireAndCommit(INPUT); await h.runtime.acquireAndCommit({ ...INPUT,
    acceptedAt: "2026-10-14T04:00:00.000Z" });
  const snapshot = (await h.runtime.readSnapshot()).snapshot, oldView =
    await History.queryAsKnownAt(snapshot, { calendarDate: "2026-10-30",
      knowledgeAt: "2026-10-14T03:00:00.000Z" }), newView =
    await History.queryAsKnownAt(snapshot, { calendarDate: "2026-10-29",
      knowledgeAt: "2026-10-14T05:00:00.000Z" });
  assert.equal(oldView.events.length > 0, true); assert.equal(newView.events.length > 0, true);
});

test("R17-22 Calendar Export contains neither BOJ raw bytes nor Evidence refs", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-14T05:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available", persistedSourceIds: [SOURCE_ID],
        absentSourceIds: Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact);
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|evidenceInput|rawBody/);
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
});

test("R17-23 prior Calendar evidence remains active without MOF or Fed activation", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), true);
  assert.equal(JpxEvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), false);
  for (const id of ["us-bls-calendar", "us-nyse-market-holidays", "jp-esri-sna-calendar",
    "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
    "us-census-calendar", "jp-jpx-market-holidays", "us-bea-calendar",
    "jp-jpx-derivatives-calendar", SOURCE_ID, "jp-mof-jgb-auction-calendar"])
    assert.equal(preparation.includes(`"${id}":`), true);
  for (const id of ["us-fed-fomc-calendar"])
    assert.equal(preparation.includes(`"${id}":`), false);
});

test("R17-24 Economic evidence schema startup and Runtime State remain isolated", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/bojCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(Economic.SOURCE_ID, "us-bea-pce-values");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC/);
  assert.doesNotMatch(preparation, /economicValues/);
  assert.equal(Evidence.ACQUISITION_CONTEXTS.includes("historical_archive_fetch"), true);
});
