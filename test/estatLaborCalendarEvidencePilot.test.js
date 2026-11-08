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
const EvidenceSet = require("../js/marketCalendarHistory/estatLaborCalendarSourceEvidenceSet.js");
const CpiEvidenceSet = require("../js/marketCalendarHistory/estatCpiCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Core = require("../js/marketCalendarIsolated/calendarSingleDocumentEvidencePilot.js");
const EstatCore = require("../js/marketCalendarIsolated/estatCalendarEvidencePilotCore.js");
const Estat = require("../js/marketCalendarIsolated/estatRoute.js");
const EstatParser = require("../js/marketCalendarIsolated/estatParser.js");
const CpiPilot = require("../js/marketCalendarIsolated/estatCpiCalendarEvidencePilot.js");
const NysePilot = require("../js/marketCalendarIsolated/nyseCalendarEvidencePilot.js");
const SnaPilot = require("../js/marketCalendarIsolated/esriSnaCalendarEvidencePilot.js");
const MachineryPilot = require("../js/marketCalendarIsolated/esriMachineryCalendarEvidencePilot.js");
const Pilot = require("../js/marketCalendarIsolated/estatLaborCalendarEvidencePilot.js");
const EconomicEmployment = require("../js/economicValues/blsEmploymentEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Html = require("./fixtures/marketCalendar/estatHtmlFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID, CPI = CpiPilot.SOURCE_ID, GENERATION = "f".repeat(64);
const ACCEPTED_AT = "2026-10-06T01:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const route = Estat.ROUTES[SOURCE_ID];
const clone = value => structuredClone(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function rows() {
  return ["2026-11", "2026-12", "2027-01"].map((month, index) =>
    Html.monthly(SOURCE_ID, "basic", month,
      ["2026-12-01", "2027-01-01", "2027-02-01"][index]));
}
function acquisition(html = Html.page(SOURCE_ID, rows()), fetchedAt =
  "2026-10-06T00:00:00.000Z", sourceId = SOURCE_ID) {
  const parserInput = new TextEncoder().encode(html), activeRoute = Estat.ROUTES[sourceId];
  return { success: true, sourceId, fetchedAt, document: { finalUrl: activeRoute.url,
    httpStatus: 200, redirects: [], mime: "text/html",
    contentType: "text/html; charset=UTF-8", encodingEvidence: {
      httpCharset: "UTF-8", bom: null, html5MetaCharset: "UTF-8",
      legacyMetaCharset: null, resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 },
    byteCount: parserInput.byteLength, contentSha256: digest(parserInput), parserInput } };
}
function acquisitionSequence(values) {
  let count = 0;
  return { acquire: async request => {
    assert.deepEqual(request, { sourceId: SOURCE_ID });
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
      return { status: snapshot ? "available" : "absent",
        snapshot: snapshot || FormalFixture.SourceFixture.empty() };
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
    }
  });
}
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-estat-labor-calendar-evidence-"))), indexedDB = options.indexedDB ||
    new IDBFactory(), values = options.acquisitions || [acquisition()], transport =
    acquisitionSequence(values), vault = options.vault || Vault.createIsolatedVault({ root,
      targetEnvironment: "isolated_test", crashAt: options.vaultCrashAt || null }), formal =
    options.formal || formalAdapter(indexedDB, options.formalTestHooks || null), runtime =
    Pilot.createPilotRuntime({ acquisition: transport, vault, formal,
      ...(options.builder ? { builder: options.builder } : {}) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, indexedDB, acquisition: transport, vault, formal, runtime };
}
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}
function rawOnly(fetchedAt = "2026-10-06T02:00:00.000Z") {
  return acquisition(`${Html.page(SOURCE_ID, rows())}\n<!-- presentation only -->`, fetchedAt);
}
function semanticChange(fetchedAt = "2026-10-06T03:00:00.000Z") {
  const changed = rows(); changed[0] = { ...changed[0], date: "2026-12-02" };
  return acquisition(Html.page(SOURCE_ID, changed), fetchedAt);
}

test("R12-1 normal Labor acquisition retains exact UTF-8 HTML and binds one source run", async t => {
  const acquired = acquisition(), h = fixture(t, { acquisitions: [acquired] }), result =
    await h.runtime.acquireAndCommit(INPUT), snapshot = (await h.runtime.readSnapshot()).snapshot,
    document = result.sourceEvidenceSet.documents[0];
  assert.deepEqual([result.status, result.evidenceTransactionCount, result.formalTransactionCount,
    h.acquisition.count(), snapshot.runs.length], ["committed", 1, 1, 1, 1]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256),
    Buffer.from(acquired.document.parserInput));
});

test("R12-2 exact-byte identity is computed before UTF-8 decode", async t => {
  const acquired = acquisition(), h = fixture(t, { acquisitions: [acquired] }), result =
    await h.runtime.acquireAndCommit(INPUT), occurrence = h.vault.readOccurrence(
      result.sourceEvidenceSet.documents[0].evidenceRef.occurrenceId);
  assert.deepEqual([occurrence.contentSha256, occurrence.byteLength, occurrence.encoding],
    [digest(acquired.document.parserInput), acquired.document.parserInput.byteLength, "utf-8"]);
});

test("R12-3 restart preserves revision to run to occurrence to content lineage", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([acquisition()]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documentRole,
      resolved.parserLineage[0].parserVersion], ["available", "valid", "primary", 2]);
  }
});

test("R12-4 Labor, CPI, NYSE, SNA and Machinery reuse generic P1 core", () => {
  assert.deepEqual([Pilot.CORE_VERSION, CpiPilot.CORE_VERSION, NysePilot.CORE_VERSION,
    SnaPilot.CORE_VERSION, MachineryPilot.CORE_VERSION], Array(5).fill(Core.CORE_VERSION));
  assert.deepEqual([Pilot.ADAPTER_VERSION, CpiPilot.ADAPTER_VERSION],
    [EstatCore.ADAPTER_VERSION, EstatCore.ADAPTER_VERSION]);
});

test("R12-5 CPI and Labor retain separate source, route, run and occurrence identities", () => {
  const labor = Pilot.createEvidenceInput(Pilot.normalizeAcquisition(acquisition()),
    "live_original_acquisition"), cpiRows = ["national", "tokyo"].flatMap(lane =>
      [Html.monthly(CPI, lane, "2026-11", "2026-12-01")]), cpiAcquired = acquisition(
      Html.page(CPI, cpiRows), "2026-10-06T00:00:00.000Z", CPI), cpi =
      CpiPilot.createEvidenceInput(CpiPilot.normalizeAcquisition(cpiAcquired),
        "live_original_acquisition");
  assert.notEqual(labor.acquisitionRunId, cpi.acquisitionRunId);
  assert.notEqual(labor.input.occurrence.occurrenceId, cpi.input.occurrence.occurrenceId);
  assert.deepEqual([labor.input.occurrence.sourceId, cpi.input.occurrence.sourceId],
    [SOURCE_ID, CPI]);
  assert.notEqual(Estat.ROUTES[SOURCE_ID].url, Estat.ROUTES[CPI].url);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(CpiEvidenceSet.createSourceEvidenceSet({
    acquisitionRunId: cpi.acquisitionRunId, documents: [{ role: "primary",
      sourceUrl: Estat.ROUTES[CPI].url, byteLength: cpi.input.contentObject.byteLength,
      mediaType: cpi.input.contentObject.mediaType, encoding: cpi.input.contentObject.encoding,
      evidenceRef: Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: cpi.input.occurrence, policy: cpi.input.policy }) }] })), false);
});

test("R12-6 duplicate bytes dedupe content and retain distinct occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition(undefined,
    "2026-10-06T04:00:00.000Z")] });
  const first = await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-06T05:00:00.000Z" }), sha =
    first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256;
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(sha, second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.equal(h.vault.occurrencesByContentSha256(sha).length, 2);
});

test("R12-7 raw-only markup change stores evidence and performs semantic write0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawOnly()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-06T06:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R12-8 schedule change creates immutable revision and correct as-known-at", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), semanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.referencePeriod === "2026-11");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-10-06T07:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot, current = after.revisions.find(value =>
    value.eventKey === old.eventKey && value.validTo === null), oldView =
    await History.queryAsKnownAt(after, { calendarDate: old.calendarDateStart,
      knowledgeAt: "2026-10-06T06:30:00.000Z" }), newView = await History.queryAsKnownAt(after,
      { calendarDate: current.calendarDateStart, knowledgeAt: "2026-10-06T08:00:00.000Z" });
  assert.notEqual(current.revisionKey, old.revisionKey);
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});

test("R12-9 invalid UTF-8 fails closed before evidence persistence", async t => {
  const acquirer = Estat.createAcquirer({ fetchImpl: async () => new Response(
    new Uint8Array([0xff]), { headers: { "content-type": "text/html; charset=UTF-8" } }) }),
    failure = await acquirer.acquire({ sourceId: SOURCE_ID }), h = fixture(t, {
      acquisitions: [{ success: false, sourceId: SOURCE_ID, reason: failure.reason }] }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.reason, h.vault.vaultStatus().occurrenceCount],
    ["failed", "utf8_evidence_required", 0]);
});

test("R12-10 active parser generation mismatch rejects Formal promotion", async t => {
  const builder = { async buildCandidate(input) {
    const candidate = await EstatParser.buildCandidate(input);
    return { ...candidate, parserVersion: 1 };
  } }, h = fixture(t, { builder }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
});

test("R12-11 parser failure retains evidence and performs no Formal promotion", async t => {
  const h = fixture(t, { acquisitions: [acquisition("<!doctype html><meta charset=\"UTF-8\"><p>changed</p>")] }),
    result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R12-12 Vault failure is source-local and commits no Calendar transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R12-13 Labor evidence failure leaves the other twelve sources eligible", async () => {
  const sources = await AcquisitionFixture.allSuccess(), index = sources.findIndex(value =>
    value.sourceId === SOURCE_ID);
  sources[index] = AcquisitionFixture.transportFailure(sources[index]);
  sources[index].evidenceDiagnostic = "source_evidence_write_failed";
  const result = await Contract.evaluateAcquisitionGeneration({ sourceResults: sources,
    acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  assert.equal(result.eligibleSources.length, 12);
  assert.deepEqual(result.failedSources, [SOURCE_ID]);
});

test("R12-14 pre-activation Labor history remains valid and evidence unavailable", async t => {
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

test("R12-15 later historical fetch retains archive acquisition context", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" }), occurrence = h.vault.readOccurrence(
      result.sourceEvidenceSet.documents[0].evidenceRef.occurrenceId);
  assert.equal(occurrence.acquisitionContext, "historical_archive_fetch");
});

test("R12-16 tampered raw object is invalid without Calendar rewrite", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0],
    lineage = EvidenceSet.resolveRevisionEvidence({ snapshot: before, vault: h.vault,
      revisionKey: before.revisions[0].revisionKey });
  assert.deepEqual([lineage.status, lineage.parserLineage[0].parserVersion], ["available", 2]);
  for (const mutate of [value => { value.documents[0].role = "schedule"; },
    value => { value.documents[0].sourceUrl = Estat.ROUTES[CPI].url; },
    value => { value.documents[0].encoding = "shift_jis"; },
    value => { value.documents[0].byteLength += 1; },
    value => { value.documents[0].evidenceRef.sourceId = CPI; }]) {
    const forged = clone(result.sourceEvidenceSet); mutate(forged);
    forged.setSha256 = Evidence.sha256Canonical({ contractVersion: forged.contractVersion,
      sourceId: forged.sourceId, acquisitionRunId: forged.acquisitionRunId,
      documents: forged.documents });
    const validSetShape = EvidenceSet.validateSourceEvidenceSet(forged);
    if (validSetShape) assert.equal(EvidenceSet.resolveRunEvidence({ run: { sourceId: SOURCE_ID,
      sourceEvidenceSet: forged }, vault: h.vault }).status, "invalid");
    else assert.equal(validSetShape, false);
  }
  const target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }),
    after = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R12-17 Economic Employment and Calendar Labor authorities remain separate", () => {
  const calendarPolicy = Pilot.createEstatLaborCalendarEvidencePolicy(), economicPolicy =
    EconomicEmployment.createEmploymentEvidencePolicy();
  assert.deepEqual([calendarPolicy.sourceFamily, calendarPolicy.sourceId,
    calendarPolicy.allowedEncodings], ["market_calendar", SOURCE_ID, ["utf-8"]]);
  assert.deepEqual([economicPolicy.sourceFamily, economicPolicy.sourceId],
    ["economic_values", "us-bls-employment-situation-values"]);
  assert.notEqual(calendarPolicy.sourceId, economicPolicy.sourceId);
});

test("R12-18 Calendar Export leaks neither raw Labor HTML nor evidence references", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-06T09:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available", persistedSourceIds: [SOURCE_ID],
        absentSourceIds: Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact), document = result.sourceEvidenceSet.documents[0];
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|rawBody|rawHtml/);
  assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
  assert.equal(serialized.includes("政府統計名に関連する公表予定一覧"), false);
});

test("R12-19 Labor activation is isolated from other sources and Runtime State", () => {
  const labor = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/estatLaborCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.doesNotMatch(labor, /jp-stat-cpi|economicValues|RuntimeState|runtimeState|manualReset/);
  assert.equal(preparation.includes('"jp-stat-cpi":'), true);
  assert.equal(preparation.includes('"jp-stat-labor":'), true);
  for (const sourceId of Contract.EXPECTED_SOURCE_IDS.filter(value => ![
    SOURCE_ID, CPI, "us-bls-calendar", "us-nyse-market-holidays",
    "jp-esri-sna-calendar", "jp-esri-machinery-orders-calendar",
    "us-census-calendar", "jp-jpx-market-holidays", "us-bea-calendar",
    "jp-jpx-derivatives-calendar", "jp-boj-calendar",
    "jp-mof-jgb-auction-calendar", "us-fed-fomc-calendar"].includes(value)))
    assert.equal(preparation.includes(`"${sourceId}":`), false);
});
