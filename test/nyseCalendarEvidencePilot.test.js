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
const EvidenceSet = require("../js/marketCalendarHistory/nyseCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Pilot = require("../js/marketCalendarIsolated/nyseCalendarEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const NyseFixture = require("./fixtures/marketCalendar/nyseMarketHolidaysFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID;
const GENERATION = "b".repeat(64);
const ACCEPTED_AT = "2026-10-02T01:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const source = Registry.getSource(SOURCE_ID);
const clone = value => structuredClone(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function acquisition(html = NyseFixture.html, fetchedAt = "2026-09-26T00:00:00.000Z") {
  const raw = new TextEncoder().encode(html), hash = digest(raw);
  return { success: true, reason: null, retryable: false, sourceId: SOURCE_ID,
    operation: Network.OPERATION, requestedAt: "2026-09-25T23:59:59.000Z", fetchedAt,
    documents: [{ role: "primary", originalOfficialUrl: source.canonicalUrl,
      finalUrl: source.canonicalUrl, redirects: [], httpStatus: 200, mime: "text/html",
      encoding: { encoding: "utf-8", evidence: { httpCharset: "utf-8", bom: null,
        html5MetaCharset: "utf-8", legacyMetaCharset: null, resolvedEncoding: "utf-8",
        resolutionPolicyVersion: 1 }, warnings: [] }, workbook: null,
      byteCount: raw.byteLength, contentSha256: hash, parserInputSha256: hash,
      parserInput: raw }], diagnostics: [] };
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
    "optionmap-nyse-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
    values = options.acquisitions || [acquisition()], transport = acquisitionSequence(values),
    vault = options.vault || Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
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
function rawOnly(fetchedAt = "2026-09-26T01:00:00.000Z") {
  return acquisition(`${NyseFixture.html}\n<!-- explanatory formatting only -->`, fetchedAt);
}
function holidaySemanticChange(fetchedAt = "2026-09-26T02:00:00.000Z") {
  return acquisition(NyseFixture.html.replaceAll("Independence Day</th>",
    "Independence Day Holiday</th>"), fetchedAt);
}
function earlyCloseSemanticChange(fetchedAt = "2026-09-26T03:00:00.000Z") {
  return acquisition(NyseFixture.html.replace("Friday, November 27, 2026",
    "Monday, November 30, 2026"), fetchedAt);
}
async function acceptedSet() {
  const generated = Pilot.createEvidenceInput(acquisition(), "live_original_acquisition"),
    evidenceRef = Evidence.createSourceEvidenceRef({ state: "available",
      occurrence: generated.input.occurrence, policy: generated.input.policy });
  return EvidenceSet.createSourceEvidenceSet({ acquisitionRunId: generated.acquisitionRunId,
    documents: [{ role: "primary", sourceUrl: source.canonicalUrl,
      byteLength: generated.input.contentObject.byteLength,
      mediaType: generated.input.contentObject.mediaType,
      encoding: generated.input.contentObject.encoding, evidenceRef }] });
}

test("R8-1 normal NYSE acquisition stores exact raw HTML and binds one source run", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0];
  assert.deepEqual([result.status, result.evidenceTransactionCount,
    result.formalTransactionCount, h.acquisition.count()], ["committed", 1, 1, 1]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256),
    Buffer.from(NyseFixture.bytes));
});

test("R8-2 restart retains revision to run to occurrence to content lineage", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([acquisition()]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documentRole,
      resolved.parserLineage.length], ["available", "valid", "primary", 1]);
    assert.equal(restartedVault.readRawBytes(resolved.documents[0].evidenceRef.contentSha256)
      .byteLength, resolved.documents[0].byteLength);
  }
});

test("R8-3 holidays and early closes share the one primary evidence occurrence", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, occurrenceId =
      result.sourceEvidenceSet.documents[0].evidenceRef.occurrenceId;
  assert.equal(snapshot.revisions.some(value => value.logical.eventType ===
    "US_NYSE_MARKET_HOLIDAY"), true);
  assert.equal(snapshot.revisions.some(value => value.logical.eventType ===
    "US_NYSE_EARLY_CLOSE"), true);
  for (const revision of snapshot.revisions)
    assert.equal((await h.runtime.resolveRevisionEvidence(revision.revisionKey))
      .documents[0].evidenceRef.occurrenceId, occurrenceId);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
});

test("R8-4 duplicate bytes dedupe content and retain distinct occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(),
    acquisition(NyseFixture.html, "2026-09-26T01:00:00.000Z")] });
  const first = await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-02T02:00:00.000Z" });
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.equal(h.vault.occurrencesByContentSha256(first.sourceEvidenceSet.documents[0]
    .evidenceRef.contentSha256).length, 2);
});

test("R8-5 raw-only change creates evidence and no semantic revision", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawOnly()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-02T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R8-6 holiday semantic change creates immutable revisions", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), holidaySemanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-02T03:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.ok(after.revisions.length > before.revisions.length);
  assert.equal(before.revisions.every(old => after.revisions.some(value =>
    value.revisionKey === old.revisionKey)), true);
  const changed = after.revisions.find(value => value.validFrom === "2026-10-02T03:00:00.000Z" &&
    value.logical.eventType === "US_NYSE_MARKET_HOLIDAY");
  assert.equal((await h.runtime.resolveRevisionEvidence(changed.revisionKey)).status, "available");
});

test("R8-7 early-close semantic change creates a new immutable revision", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), earlyCloseSemanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-02T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  const fresh = after.revisions.find(value => value.validFrom === "2026-10-02T04:00:00.000Z" &&
    value.logical.eventType === "US_NYSE_EARLY_CLOSE");
  assert.ok(fresh); assert.equal(before.revisions.some(value =>
    value.revisionKey === fresh.revisionKey), false);
  assert.equal((await h.runtime.resolveRevisionEvidence(fresh.revisionKey)).status, "available");
});

test("R8-8 parser structure failure retains evidence but performs no Formal promotion", async t => {
  const malformed = acquisition("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>changed</body></html>"),
    h = fixture(t, { acquisitions: [malformed] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R8-9 evidence failure blocks only the NYSE Formal transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R8-10 NYSE evidence failure leaves the other twelve sources eligible", async () => {
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

test("R8-11 pre-activation NYSE history remains valid and unavailable", async t => {
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

test("R8-12 replaced NYSE endpoint cannot enter the evidence contract", async () => {
  const old = "https://www.nyse.com/markets/hours-calendars", value = acquisition();
  value.documents[0].originalOfficialUrl = old; value.documents[0].finalUrl = old;
  assert.equal(Pilot.acceptedAcquisition(value), false);
  assert.equal(Network.validateUrl(SOURCE_ID, Network.getPolicy(SOURCE_ID).documents[0], old).valid,
    false);
  assert.equal(source.endpointHistory[0].status, "replaced");
});

test("R8-13 tampered NYSE raw object fails integrity without rewriting Calendar", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0],
    target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }), after =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R8-14 forged source or role cannot bind to the NYSE run", async () => {
  const set = clone(await acceptedSet()), role = clone(set), foreign = clone(set);
  role.documents[0].role = "holiday";
  role.setSha256 = Evidence.sha256Canonical({ contractVersion: role.contractVersion,
    sourceId: role.sourceId, acquisitionRunId: role.acquisitionRunId, documents: role.documents });
  foreign.documents[0].evidenceRef.sourceId = "us-bls-calendar";
  foreign.setSha256 = Evidence.sha256Canonical({ contractVersion: foreign.contractVersion,
    sourceId: foreign.sourceId, acquisitionRunId: foreign.acquisitionRunId,
    documents: foreign.documents });
  assert.equal(EvidenceSet.validateSourceEvidenceSet(role), false);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(foreign), false);
});

test("R8-15 Calendar Export remains backward compatible and leaks no raw or refs", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-02T05:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available",
        persistedSourceIds: [SOURCE_ID], absentSourceIds:
          Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact), document = result.sourceEvidenceSet.documents[0];
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|rawBody|rawHtml/);
  assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
  assert.equal(serialized.includes(NyseFixture.html), false);
});

test("R8-16 NYSE activation remains isolated from Economic Values and other Calendar sources", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/nyseCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset/);
  for (const sourceId of Contract.EXPECTED_SOURCE_IDS.filter(value =>
    ![SOURCE_ID, "us-bls-calendar", "jp-esri-sna-calendar",
      "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
      "us-census-calendar", "jp-jpx-market-holidays", "us-bea-calendar",
      "jp-jpx-derivatives-calendar", "jp-boj-calendar",
      "jp-mof-jgb-auction-calendar", "us-fed-fomc-calendar"].includes(value)))
    assert.equal(preparation.includes(`\"${sourceId}\":`), false);
});

test("R8 as-known-at retains both accepted NYSE semantic truths", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), holidaySemanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.eventType === "US_NYSE_MARKET_HOLIDAY" &&
      value.logical.referencePeriod === "2026-07-03");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-10-02T03:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot,
    current = after.revisions.find(value => value.eventKey === old.eventKey && value.validTo === null),
    oldView = await History.queryAsKnownAt(after, { calendarDate: old.calendarDateStart,
      knowledgeAt: "2026-10-02T02:00:00.000Z" }), newView = await History.queryAsKnownAt(after,
      { calendarDate: current.calendarDateStart, knowledgeAt: "2026-10-02T04:00:00.000Z" });
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});

test("R8 historical archive context is retained without claiming original history", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" }), occurrence = h.vault.readOccurrence(
      result.sourceEvidenceSet.documents[0].evidenceRef.occurrenceId);
  assert.equal(occurrence.acquisitionContext, "historical_archive_fetch");
});
