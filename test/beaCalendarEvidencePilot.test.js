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
const EvidenceSet = require("../js/marketCalendarHistory/beaCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Pilot = require("../js/marketCalendarIsolated/beaCalendarEvidencePilot.js");
const BlsEvidenceSet = require("../js/marketCalendarHistory/calendarSourceEvidenceSet.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const PceFormal = require("../js/economicValues/beaPceFormal.js");
const BeaFixture = require("./fixtures/marketCalendar/beaCalendarFixtures.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID;
const GENERATION = "2".repeat(64);
const ACCEPTED_AT = "2026-10-09T01:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const source = Registry.getSource(SOURCE_ID), routes = Network.getPolicy(SOURCE_ID).documents;
const clone = value => structuredClone(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function document(route, body) {
  const raw = new TextEncoder().encode(body), hash = digest(raw);
  return { role: route.role, originalOfficialUrl: route.url, finalUrl: route.url,
    redirects: [], httpStatus: 200, mime: route.kind === "json" ? "application/json" : "text/html",
    encoding: { encoding: "utf-8", evidence: route.kind === "json" ? {
      mediaType: "application/json", resolvedEncoding: "utf-8", resolutionPolicyVersion: 1
    } : { httpCharset: "utf-8", bom: null, html5MetaCharset: "UTF-8",
      legacyMetaCharset: null, resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 },
    warnings: [] }, workbook: null, byteCount: raw.byteLength, contentSha256: hash,
    parserInputSha256: hash, parserInput: raw };
}
function acquisition(json = BeaFixture.json, html = BeaFixture.html,
  fetchedAt = "2026-10-08T23:30:00.000Z", reverse = false) {
  const documents = [document(routes[0], json), document(routes[1], html)];
  return { success: true, reason: null, retryable: false, sourceId: SOURCE_ID,
    operation: Network.OPERATION, requestedAt: "2026-10-08T23:29:59.000Z", fetchedAt,
    documents: reverse ? documents.reverse() : documents, diagnostics: [] };
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
    "optionmap-bea-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
    values = options.acquisitions || [acquisition()], transport = acquisitionSequence(values),
    vault = options.vault || Vault.createIsolatedVault({ root,
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
function rawJson(fetchedAt = "2026-10-09T00:30:00.000Z") {
  return acquisition(`${BeaFixture.json}\n`, BeaFixture.html, fetchedAt);
}
function rawHtml(fetchedAt = "2026-10-09T00:30:00.000Z") {
  return acquisition(BeaFixture.json,
    `${BeaFixture.html}\n<!-- presentation-only BEA markup -->`, fetchedAt);
}
function rawBoth(fetchedAt = "2026-10-09T00:30:00.000Z") {
  return acquisition(`${BeaFixture.json}\n`,
    `${BeaFixture.html}\n<!-- presentation-only BEA markup -->`, fetchedAt);
}
function scheduleChange(fetchedAt = "2026-10-09T01:30:00.000Z") {
  return acquisition(BeaFixture.json.replaceAll("2026-10-29T12:30:00+00:00",
    "2026-10-30T12:30:00+00:00"), BeaFixture.html.replaceAll("October 29", "October 30"),
  fetchedAt);
}
function inconsistent(fetchedAt = "2026-10-09T01:30:00.000Z") {
  return acquisition(BeaFixture.json.replace("2026-10-29T12:30:00+00:00",
    "2026-10-30T12:30:00+00:00"), BeaFixture.html, fetchedAt);
}
async function acceptedSet() {
  const generated = Pilot.createEvidenceInputs(acquisition(), "live_original_acquisition"),
    documents = generated.inputs.map((input, index) => ({ role: routes[index].role,
      sourceUrl: routes[index].url, byteLength: input.contentObject.byteLength,
      mediaType: input.contentObject.mediaType, encoding: input.contentObject.encoding,
      evidenceRef: Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: input.occurrence, policy: input.policy }) }));
  return EvidenceSet.createSourceEvidenceSet({ acquisitionRunId: generated.acquisitionRunId,
    documents });
}

test("R15-1 normal BEA acquisition retains both exact documents in one source run", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.evidenceTransactionCount,
    result.formalTransactionCount, h.acquisition.count()], ["committed", 2, 1, 1]);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(value => value.role),
    ["scheduleAuthority", "releaseSemantics"]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(h.vault.readRawBytes(result.sourceEvidenceSet.documents[0]
    .evidenceRef.contentSha256), Buffer.from(new TextEncoder().encode(BeaFixture.json)));
  assert.deepEqual(h.vault.readRawBytes(result.sourceEvidenceSet.documents[1]
    .evidenceRef.contentSha256), Buffer.from(new TextEncoder().encode(BeaFixture.html)));
});

test("R15-2 restart retains revision through set to both occurrences and contents", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([acquisition()]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documents.length,
      resolved.documentRole], ["available", "valid", 2, "scheduleAuthority"]);
    for (const document of resolved.documents)
      assert.equal(restartedVault.readRawBytes(document.evidenceRef.contentSha256).byteLength,
        document.byteLength);
  }
});

test("R15-3 JSON and HTML roles stay deterministic across fetch completion order", () => {
  const generated = Pilot.createEvidenceInputs(acquisition(BeaFixture.json, BeaFixture.html,
    "2026-10-08T23:30:00.000Z", true), "live_original_acquisition");
  assert.deepEqual(generated.inputs.map(value => value.occurrence.requestRole),
    ["scheduleAuthority", "releaseSemantics"]);
  assert.deepEqual(generated.inputs.map(value => value.contentObject.mediaType),
    ["application/json", "text/html"]);
  assert.notEqual(generated.inputs[0].contentObject.sha256, generated.inputs[1].contentObject.sha256);
});

test("R15-4 identical two-document reacquisition dedupes content and adds occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition(BeaFixture.json,
    BeaFixture.html, "2026-10-09T00:30:00.000Z")] });
  const first = await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-09T02:00:00.000Z" });
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  for (const document of first.sourceEvidenceSet.documents)
    assert.equal(h.vault.occurrencesByContentSha256(document.evidenceRef.contentSha256).length, 2);
});

test("R15-5 JSON raw-only change updates only JSON content and writes semantic0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawJson()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-09T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.equal(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R15-6 HTML raw-only change updates only HTML content and writes semantic0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawHtml()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-09T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.equal(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.notEqual(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R15-7 both raw documents may change while semantic revisions remain identical", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawBoth()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-09T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.equal(first.sourceEvidenceSet.documents.every((document, index) =>
    document.evidenceRef.contentSha256 !== second.sourceEvidenceSet.documents[index]
      .evidenceRef.contentSha256), true);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R15-8 schedule timestamp correction creates immutable same-event revisions", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), scheduleChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.eventType === "US_GDP" &&
      value.logical.referencePeriod === "2026-Q3" && value.logical.edition === "advance_estimate"),
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-09T03:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot, current = after.revisions.find(value =>
      value.eventKey === old.eventKey && value.validTo === null);
  assert.equal(second.status, "committed");
  assert.notEqual(current.revisionKey, old.revisionKey);
  assert.equal(after.revisions.some(value => value.revisionKey === old.revisionKey), true);
  const oldView = await History.queryAsKnownAt(after, { calendarDate: old.calendarDateStart,
    knowledgeAt: "2026-10-09T02:00:00.000Z" }), newView = await History.queryAsKnownAt(after,
    { calendarDate: current.calendarDateStart, knowledgeAt: "2026-10-09T04:00:00.000Z" });
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});

for (const [id, role] of [["R15-9", "scheduleAuthority"],
  ["R15-10", "releaseSemantics"]]) test(`${id} missing ${role} fails the BEA source closed`,
  async t => {
    const missing = acquisition(); missing.documents = missing.documents.filter(value =>
      value.role !== role);
    const h = fixture(t, { acquisitions: [missing] }), result =
      await h.runtime.acquireAndCommit(INPUT);
    assert.deepEqual([result.status, result.diagnostic, result.evidenceTransactionCount,
      result.formalTransactionCount], ["failed", "evidence_invalid", 0, 0]);
    assert.deepEqual(await h.indexedDB.databases(), []);
  });

test("R15-11 parser failure is distinct and performs no Formal promotion", async t => {
  const malformed = acquisition(BeaFixture.json, "<html><body></body></html>"), h = fixture(t,
    { acquisitions: [malformed] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 2);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R15-12 Vault failure remains an evidence-specific BEA failure", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R15-13 JSON HTML schedule inconsistency has a distinct reconciliation diagnostic", async t => {
  const h = fixture(t, { acquisitions: [inconsistent()] }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "reconciliation_rejected", 0]);
  assert.match(result.reason, /bea_json_html_schedule_mismatch|cross_document_inconsistent/);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 2);
});

test("R15-14 BEA evidence failure leaves the other twelve sources eligible", async () => {
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

test("R15-15 pre-activation BEA history stays valid with unavailable evidence", async t => {
  const h = fixture(t), sourceResult = await AcquisitionFixture.validSource(SOURCE_ID);
  await h.formal.commit({ sourceResult, acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  const before = (await h.runtime.readSnapshot()).snapshot,
    resolved = EvidenceSet.resolveRevisionEvidence({ snapshot: before, vault: h.vault,
      revisionKey: before.revisions[0].revisionKey }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R15-16 historical later fetch marks both occurrences as archive context", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" });
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(h.vault.readOccurrence(document.evidenceRef.occurrenceId).acquisitionContext,
      "historical_archive_fetch");
});

test("R15-17 tampering one role invalidates the complete BEA evidence set", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, html = result.sourceEvidenceSet.documents[1],
    target = objectPath(h.root, html.evidenceRef.contentSha256), raw = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }), after =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R15-18 BEA Calendar and PCE Economic Values remain separate domains", async () => {
  const set = await acceptedSet();
  assert.equal(set.sourceId, "us-bea-calendar");
  assert.equal(PceFormal.SOURCE_ID, "us-bea-pce-values");
  assert.notEqual(set.sourceId, PceFormal.SOURCE_ID);
  assert.equal(set.documents.every(value => value.evidenceRef.sourceFamily === "market_calendar"),
    true);
});

test("R15-19 Calendar Export leaks neither BEA raw document nor evidence references", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-09T05:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available",
        persistedSourceIds: [SOURCE_ID], absentSourceIds:
          Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact);
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|rawBody|rawHtml/);
  assert.equal(serialized.includes("release-schedule-table"), false);
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
});

test("R15-20 BLS and prior Calendar evidence contracts remain independently valid", async () => {
  const set = await acceptedSet(), preparation = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(set), true);
  assert.equal(BlsEvidenceSet.validateSourceEvidenceSet(set), false);
  for (const id of ["us-bls-calendar", "us-nyse-market-holidays", "jp-esri-sna-calendar",
    "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
    "us-census-calendar", "jp-jpx-market-holidays", SOURCE_ID,
    "jp-jpx-derivatives-calendar", "jp-boj-calendar", "jp-mof-jgb-auction-calendar"])
    assert.equal(preparation.includes(`"${id}":`), true);
  for (const id of ["jp-mof-jgb-calendar", "us-fed-calendar"])
    assert.equal(preparation.includes(`"${id}":`), false);
});

test("R15-21 Economic Evidence Runtime State and exports remain outside BEA activation", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/beaCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC/);
  assert.doesNotMatch(preparation, /economicValues/);
});
