"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/calendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Route = require("../js/marketCalendarIsolated/blsFixedRoute.js");
const Assessment = require("../js/marketCalendarIsolated/blsFixedAssessment.js");
const Pilot = require("../js/marketCalendarIsolated/blsCalendarEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const BlsFixture = require("./fixtures/marketCalendar/blsFixedFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const GENERATION = "b".repeat(64);
const ACCEPTED_AT = "2026-10-02T01:00:00.000Z";
const INPUT = Object.freeze({ assessmentDateJst: "2026-09-26", acceptedAt: ACCEPTED_AT,
  generationIdentity: GENERATION, acquisitionContext: "live_original_acquisition" });
const clone = value => structuredClone(value);
function completeAcquisition(value = BlsFixture.acquisition(), patch = {}) {
  return { ...clone(value), outcome: "complete", ...patch };
}
function acquisitionSequence(values) {
  let count = 0;
  return { acquire: async request => {
    assert.deepEqual(request, { sourceId: Route.SOURCE_ID });
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
      const plan = await Preparation.prepareCalendarFormalSourceMutation({
        sourceId: Route.SOURCE_ID, acquisition: sourceResult,
        formalSnapshot: await descriptor(indexedDB), acceptedAt, generation: generationIdentity,
        authority: clone(Preparation.AUTHORITY) });
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
    "optionmap-bls-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
    values = options.acquisitions || [completeAcquisition()], acquisition = acquisitionSequence(values),
    vault = options.vault || Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
      crashAt: options.vaultCrashAt || null }), formal = options.formal ||
      formalAdapter(indexedDB, options.formalTestHooks || null), runtime =
      Pilot.createPilotRuntime({ acquisition, vault, formal });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, indexedDB, acquisition, vault, formal, runtime };
}
function objectPath(root, sha256) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    Vault.DIRECTORY_NAMES.objects, sha256.slice(0, 2), sha256);
}
function changedRawSameEvents(fetchedAt = "2026-09-26T01:00:00.000Z") {
  const value = completeAcquisition(); value.fetchedAt = fetchedAt;
  value.documents[0] = BlsFixture.document("cpi", `${BlsFixture.html("cpi")}\n<!-- formatting -->`);
  return value;
}
function changedEvent(fetchedAt = "2026-09-26T02:00:00.000Z") {
  const value = completeAcquisition(); value.fetchedAt = fetchedAt;
  const rows = clone(BlsFixture.rows.ppi); rows[2][1] = "Nov. 14, 2026";
  value.documents[1] = BlsFixture.document("ppi", BlsFixture.html("ppi", rows));
  return value;
}
async function acceptedSet() {
  const acquisition = completeAcquisition(), generated = Pilot.createEvidenceInputs(acquisition,
    "live_original_acquisition"), documents = generated.inputs.map((input, index) => ({
      role: Route.ROLES[index].role, sourceUrl: Route.ROLES[index].url,
      byteLength: input.contentObject.byteLength, mediaType: input.contentObject.mediaType,
      encoding: input.contentObject.encoding, evidenceRef: Evidence.createSourceEvidenceRef({
        state: "available", occurrence: input.occurrence, policy: input.policy }) }));
  return EvidenceSet.createSourceEvidenceSet({ acquisitionRunId: generated.acquisitionRunId,
    documents });
}

test("R7-1 one BLS acquisition stores four role-bound occurrences before one Formal commit", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([result.status, result.evidenceTransactionCount,
    result.formalTransactionCount, h.acquisition.count()], ["committed", 4, 1, 1]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 4);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(snapshot.runs[0].sourceEvidenceSet.documents.map(value => value.role),
    Route.ROLES.map(value => value.role));
});

test("R7-2 restart resolves every BLS revision through run, set, occurrence and raw", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restartedFormal =
    formalAdapter(h.indexedDB), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([completeAcquisition()]), vault: restartedVault,
      formal: restartedFormal }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.parserLineage.length],
      ["available", "valid", 1]);
    const document = resolved.documents.find(value => value.role === resolved.documentRole);
    assert.equal(restartedVault.readRawBytes(document.evidenceRef.contentSha256).byteLength,
      document.byteLength);
  }
});

test("R7-3 CPI PPI Employment and JOLTS remain four distinct evidence roles", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), documents =
    result.sourceEvidenceSet.documents;
  assert.equal(new Set(documents.map(value => value.evidenceRef.occurrenceId)).size, 4);
  assert.deepEqual(documents.map(value => value.sourceUrl), Route.ROLES.map(value => value.url));
  for (const document of documents)
    assert.equal(h.vault.readOccurrence(document.evidenceRef.occurrenceId).requestRole, document.role);
});

test("R7-4 identical four documents dedupe content and retain separate acquisitions", async t => {
  const second = completeAcquisition(BlsFixture.acquisition(), {
    fetchedAt: "2026-09-26T01:00:00.000Z" }), h = fixture(t, {
    acquisitions: [completeAcquisition(), second] });
  const first = await h.runtime.acquireAndCommit(INPUT), again = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-02T02:00:00.000Z" });
  assert.deepEqual([again.status, again.diagnostic, again.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 8);
  for (const [index, document] of first.sourceEvidenceSet.documents.entries()) {
    assert.equal(document.evidenceRef.contentSha256,
      again.sourceEvidenceSet.documents[index].evidenceRef.contentSha256);
    assert.equal(h.vault.occurrencesByContentSha256(document.evidenceRef.contentSha256).length, 2);
  }
});

test("R7-5 changed raw with identical events preserves Formal revisions", async t => {
  const h = fixture(t, { acquisitions: [completeAcquisition(), changedRawSameEvents()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-02T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R7-6 changed schedule creates immutable revision and binds new raw evidence", async t => {
  const h = fixture(t, { acquisitions: [completeAcquisition(), changedEvent()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-02T03:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["committed", 1]);
  assert.equal(after.revisions.length, before.revisions.length + 1);
  const newest = after.revisions.find(value => value.validFrom === "2026-10-02T03:00:00.000Z"),
    resolved = await h.runtime.resolveRevisionEvidence(newest.revisionKey);
  assert.deepEqual([resolved.status, resolved.documentRole], ["available", "ppi"]);
  assert.equal(resolved.documents.find(value => value.role === "ppi").evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
});

test("R7-7 vault failure blocks the entire BLS Formal source transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R7-8 BLS evidence failure leaves the other twelve partial-bootstrap sources eligible", async () => {
  const sources = await AcquisitionFixture.allSuccess(), index = sources.findIndex(value =>
    value.sourceId === Route.SOURCE_ID);
  sources[index] = AcquisitionFixture.transportFailure(sources[index]);
  sources[index].evidenceDiagnostic = "source_evidence_write_failed";
  const result = await Contract.evaluateAcquisitionGeneration({ sourceResults: sources,
    acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  assert.equal(result.eligibleSources.length, 12);
  assert.deepEqual(result.failedSources, [Route.SOURCE_ID]);
});

test("R7-9 Formal abort after vault promotion leaves four durable orphan occurrences", async t => {
  const h = fixture(t, { formalTestHooks: { firstSourceFailureAfter: "revisions" } }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "formal_write_aborted", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 4);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R7-10 pre-activation BLS history remains valid and explicitly unavailable", async t => {
  const h = fixture(t), sourceResult = await AcquisitionFixture.validSource(Route.SOURCE_ID);
  await h.formal.commit({ sourceResult, acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  const before = (await h.runtime.readSnapshot()).snapshot, resolved =
    EvidenceSet.resolveRevisionEvidence({ snapshot: before, vault: h.vault,
      revisionKey: before.revisions[0].revisionKey }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
  assert.deepEqual(after, before);
});

test("R7-11 historical archive context is retained independently on all four occurrences", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" });
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(h.vault.readOccurrence(document.evidenceRef.occurrenceId).acquisitionContext,
      "historical_archive_fetch");
});

test("R7-12 one tampered BLS object invalidates the atomic evidence set without Formal rewrite", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[2],
    target = objectPath(h.root, document.evidenceRef.contentSha256), bytes = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(bytes.length, 0x78));
  const resolved = EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }), after =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R7-13 forged role or source identity cannot bind into the BLS source run", async () => {
  const set = clone(await acceptedSet()), wrongRole = clone(set), wrongSource = clone(set);
  wrongRole.documents[0].role = "ppi";
  wrongRole.setSha256 = Evidence.sha256Canonical({ contractVersion: wrongRole.contractVersion,
    sourceId: wrongRole.sourceId, acquisitionRunId: wrongRole.acquisitionRunId,
    documents: wrongRole.documents });
  wrongSource.documents[0].evidenceRef.sourceId = "us-bls-cpi-values";
  wrongSource.setSha256 = Evidence.sha256Canonical({ contractVersion: wrongSource.contractVersion,
    sourceId: wrongSource.sourceId, acquisitionRunId: wrongSource.acquisitionRunId,
    documents: wrongSource.documents });
  assert.equal(EvidenceSet.validateSourceEvidenceSet(wrongRole), false);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(wrongSource), false);
});

test("R7-14 as-known-at preserves old and new schedule truth", async t => {
  const h = fixture(t, { acquisitions: [completeAcquisition(), changedEvent()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.acquisitionEvidence.sourceUrl === Route.ROLES[1].url &&
      value.logical.referencePeriod === "2026-10");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-10-02T03:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot, current = after.revisions.find(value =>
    value.eventKey === old.eventKey && value.validTo === null), oldView = await History.queryAsKnownAt(after,
      { calendarDate: old.calendarDateStart, knowledgeAt: "2026-10-02T02:00:00.000Z" }),
    newView = await History.queryAsKnownAt(after, { calendarDate: current.calendarDateStart,
      knowledgeAt: "2026-10-02T04:00:00.000Z" });
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});

test("R7-15 pilot has no Runtime State write or authority dependency", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/blsCalendarEvidencePilot.js"), "utf8");
  assert.doesNotMatch(source, /RuntimeState|runtimeState|indexedDB|manualReset/);
});

test("R7-16 Calendar export projects Formal metadata without raw bytes or vault references", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-02T04:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available",
        persistedSourceIds: [Route.SOURCE_ID], absentSourceIds:
          Contract.EXPECTED_SOURCE_IDS.filter(value => value !== Route.SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact);
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|rawBody|rawHtml/);
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
});

test("R7-17 Calendar pilot is isolated from R3-R6 Economic Values pilots", () => {
  const files = ["blsCpiEvidencePilot.js", "blsEmploymentEvidencePilot.js",
    "jpCpiEvidencePilot.js", "beaPceEvidencePilot.js"], calendar = fs.readFileSync(path.join(
    __dirname, "../js/marketCalendarIsolated/blsCalendarEvidencePilot.js"), "utf8");
  assert.doesNotMatch(calendar, /economicValues/);
  for (const file of files) assert.equal(fs.readFileSync(path.join(__dirname,
    `../js/economicValues/${file}`), "utf8").includes("calendarSourceEvidenceSet"), false);
});
