"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const TradingDateAuthority = require("../js/fullExportFormalTradingDateAuthority.js");
const QriDateContext = require("../js/qriTradingDateContext.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/jpxHolidaysCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Core = require("../js/marketCalendarIsolated/calendarSingleDocumentEvidencePilot.js");
const NysePilot = require("../js/marketCalendarIsolated/nyseCalendarEvidencePilot.js");
const SnaPilot = require("../js/marketCalendarIsolated/esriSnaCalendarEvidencePilot.js");
const MachineryPilot = require("../js/marketCalendarIsolated/esriMachineryCalendarEvidencePilot.js");
const CpiPilot = require("../js/marketCalendarIsolated/estatCpiCalendarEvidencePilot.js");
const LaborPilot = require("../js/marketCalendarIsolated/estatLaborCalendarEvidencePilot.js");
const CensusPilot = require("../js/marketCalendarIsolated/censusCalendarEvidencePilot.js");
const Pilot = require("../js/marketCalendarIsolated/jpxHolidaysCalendarEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const JpxFixture = require("./fixtures/marketCalendar/jpxMarketHolidaysFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID;
const GENERATION = "1".repeat(64);
const ACCEPTED_AT = "2026-10-08T01:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const source = Registry.getSource(SOURCE_ID);
const route = Network.getPolicy(SOURCE_ID).documents[0];
const clone = value => structuredClone(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function acquisition(html = JpxFixture.html, fetchedAt = "2026-10-07T23:30:00.000Z") {
  const raw = new TextEncoder().encode(html), hash = digest(raw);
  return { success: true, reason: null, retryable: false, sourceId: SOURCE_ID,
    operation: Network.OPERATION, requestedAt: "2026-10-07T23:29:59.000Z", fetchedAt,
    documents: [{ role: "primary", originalOfficialUrl: source.canonicalUrl,
      finalUrl: source.canonicalUrl, redirects: [], httpStatus: 200, mime: "text/html",
      encoding: { encoding: "utf-8", evidence: { httpCharset: "utf-8", bom: null,
        html5MetaCharset: "UTF-8", legacyMetaCharset: null, resolvedEncoding: "utf-8",
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
    "optionmap-jpx-holidays-calendar-evidence-"))), indexedDB =
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
function rawOnly(fetchedAt = "2026-10-08T00:30:00.000Z") {
  return acquisition(`${JpxFixture.html}\n<!-- presentation-only JPX markup -->`, fetchedAt);
}
function semanticChange(fetchedAt = "2026-10-08T01:30:00.000Z") {
  return acquisition(JpxFixture.html.replace("休日※</td>", "休日（祝日法）</td>"), fetchedAt);
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
function holiday(date, overrides = {}) {
  return { sourceId: SOURCE_ID, validTo: null, calendarDateStart: date, calendarDateEnd: date,
    logical: { eventType: "JPX_MARKET_HOLIDAY", scope: "JPX_cash_markets",
      referencePeriod: date }, ...overrides };
}
const calendar = (...events) => ({ status: "available", events });

test("R14-1 normal JPX Holidays acquisition retains exact HTML and binds one source run", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0];
  assert.deepEqual([result.status, result.evidenceTransactionCount,
    result.formalTransactionCount, h.acquisition.count()], ["committed", 1, 1, 1]);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].sourceEvidenceSet.documents.length, 1);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256),
    Buffer.from(JpxFixture.bytes));
});

test("R14-2 restart retains holiday revision to run to occurrence to content lineage", async t => {
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

test("R14-3 JPX Holidays reuses generic P1 with its existing fixed route policy", () => {
  assert.deepEqual([Pilot.CORE_VERSION, NysePilot.CORE_VERSION, SnaPilot.CORE_VERSION,
    MachineryPilot.CORE_VERSION, CpiPilot.CORE_VERSION, LaborPilot.CORE_VERSION,
    CensusPilot.CORE_VERSION], Array(7).fill(Core.CORE_VERSION));
  assert.deepEqual([source.canonicalUrl, route.url, route.maxBytes, route.role],
    ["https://www.jpx.co.jp/corporate/about-jpx/calendar/",
      "https://www.jpx.co.jp/corporate/about-jpx/calendar/", 2_000_000, "primary"]);
});

test("R14-4 duplicate bytes dedupe content and retain distinct occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(),
    acquisition(JpxFixture.html, "2026-10-08T00:30:00.000Z")] });
  const first = await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({
    ...INPUT, acceptedAt: "2026-10-08T02:00:00.000Z" });
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.equal(h.vault.occurrencesByContentSha256(first.sourceEvidenceSet.documents[0]
    .evidenceRef.contentSha256).length, 2);
});

test("R14-5 raw-only JPX markup change creates evidence and semantic write0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), rawOnly()] });
  const first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({
      ...INPUT, acceptedAt: "2026-10-08T02:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R14-6 official holiday semantic change creates an immutable revision", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), semanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-10-08T03:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.ok(after.revisions.length > before.revisions.length);
  assert.equal(before.revisions.every(old => after.revisions.some(value =>
    value.revisionKey === old.revisionKey)), true);
  const changed = after.revisions.find(value => value.validFrom === "2026-10-08T03:00:00.000Z" &&
    value.logical.referencePeriod === "2026-09-22");
  assert.equal((await h.runtime.resolveRevisionEvidence(changed.revisionKey)).status, "available");
});

test("R14-7 parser structure failure retains evidence but performs no Formal promotion", async t => {
  const malformed = acquisition("<!doctype html><html><head><meta charset=\"utf-8\"></head>" +
    "<body><h2 id=\"new-holiday-heading\"></h2></body></html>"),
    h = fixture(t, { acquisitions: [malformed] }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R14-8 Vault failure blocks only the JPX Holidays Formal transaction", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R14-9 JPX Holidays failure leaves the other twelve sources eligible", async () => {
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

test("R14-10 missing holiday authority keeps dependent date consumers fail-closed", () => {
  const date = TradingDateAuthority.resolveFromCalendar({
    observedAt: "2026-10-15T07:46:11+09:00", calendarResult: calendar() });
  const qri = QriDateContext.resolve({ observedAt: "2026-10-15T19:00:00+09:00",
    payloadTradingDate: "2026-10-16", calendarAuthority: date });
  assert.deepEqual([date.status, date.reason, qri.valid, qri.relation],
    ["unavailable", "jpx_holiday_authority_unavailable", false, "date_context_unresolved"]);
});

test("R14-11 pre-activation JPX Holidays history stays valid and evidence unavailable", async t => {
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

test("R14-12 historical later fetch retains archive acquisition context", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" }), occurrence = h.vault.readOccurrence(
      result.sourceEvidenceSet.documents[0].evidenceRef.occurrenceId);
  assert.equal(occurrence.acquisitionContext, "historical_archive_fetch");
});

test("R14-13 tampered JPX raw object fails integrity without Calendar rewrite", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0],
    target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  const resolved = EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }), after =
    (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  assert.deepEqual(after, before);
});

test("R14-14 JPX Holidays remains isolated from JPX derivatives domains", async () => {
  const set = clone(await acceptedSet()), forged = clone(set), derivatives =
    Registry.getSource("jp-jpx-derivatives-calendar");
  forged.documents[0].evidenceRef.sourceId = derivatives.sourceId;
  forged.setSha256 = Evidence.sha256Canonical({ contractVersion: forged.contractVersion,
    sourceId: forged.sourceId, acquisitionRunId: forged.acquisitionRunId,
    documents: forged.documents });
  assert.equal(EvidenceSet.validateSourceEvidenceSet(forged), false);
  assert.notEqual(source.canonicalUrl, derivatives.canonicalUrl);
  assert.notEqual(source.parserId, derivatives.parserId);
});

test("R14-15 normal to holiday to normal trading-date sequence is unchanged", () => {
  const events = calendar(holiday("2026-10-14")), values = [
    ["2026-10-13T12:00:00+09:00", "2026-10-13", "2026-10-15"],
    ["2026-10-14T12:00:00+09:00", "2026-10-13", "2026-10-15"],
    ["2026-10-15T12:00:00+09:00", "2026-10-15", "2026-10-16"]];
  for (const [observedAt, formal, next] of values) {
    const value = TradingDateAuthority.resolveFromCalendar({ observedAt, calendarResult: events });
    assert.deepEqual([value.status, value.formalTradingDate, value.nextValidTradingDate],
      ["available", formal, next]);
  }
});

test("R14-16 cash-market holiday does not prove holiday-night derivatives authority", () => {
  const date = TradingDateAuthority.resolveFromCalendar({ observedAt: "2026-11-03T18:00:00+09:00",
    calendarResult: calendar(holiday("2026-11-03")) }), qri = QriDateContext.resolve({
      observedAt: "2026-11-03T18:00:00+09:00", payloadTradingDate: "2026-11-04",
      calendarAuthority: date });
  assert.deepEqual([date.status, date.calendarStatus, date.formalTradingDate,
    qri.valid, qri.relation],
  ["available", "jpx_holiday", "2026-11-02", false, "date_context_unresolved"]);
});

test("R14-17 Calendar Export leaks neither JPX raw HTML nor evidence refs", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-10-08T05:00:00.000Z",
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
  assert.equal(serialized.includes('<h2 id="heading_7">'), false);
});

test("R14-18 prior Calendar evidence adapters remain active through the same core", async () => {
  const set = await acceptedSet(), preparation = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(set), true);
  for (const id of ["us-bls-calendar", "us-nyse-market-holidays", "jp-esri-sna-calendar",
    "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
    "us-census-calendar", SOURCE_ID]) assert.equal(preparation.includes(`"${id}":`), true);
  for (const id of ["us-bea-calendar", "jp-jpx-derivatives-calendar", "jp-boj-calendar",
    "jp-mof-jgb-calendar", "us-fed-calendar"])
    assert.equal(preparation.includes(`"${id}":`), false);
});

test("R14-19 Economic Values Runtime State and session authority stay outside activation", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/jpxHolidaysCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.doesNotMatch(pilot,
    /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC|derivatives|session/i);
  assert.doesNotMatch(preparation, /economicValues/);
});

test("R14 as-known-at retains both accepted JPX holiday semantic truths", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), semanticChange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.referencePeriod === "2026-09-22");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-10-08T03:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot,
    current = after.revisions.find(value => value.eventKey === old.eventKey && value.validTo === null),
    oldView = await History.queryAsKnownAt(after, { calendarDate: old.calendarDateStart,
      knowledgeAt: "2026-10-08T02:00:00.000Z" }), newView = await History.queryAsKnownAt(after,
      { calendarDate: current.calendarDateStart, knowledgeAt: "2026-10-08T04:00:00.000Z" });
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});
