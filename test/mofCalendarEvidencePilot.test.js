"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/mofCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Source = require("../js/marketCalendarIsolated/mofJgbSource.js");
const Normal = require("../js/marketCalendarRuntime/mofNormalAcquisition.js");
const Contracts = require("../js/marketCalendarRuntime/normalAcquisitionContract.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Pilot = require("../js/marketCalendarIsolated/mofCalendarEvidencePilot.js");
const BojEvidenceSet = require("../js/marketCalendarHistory/bojCalendarSourceEvidenceSet.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Economic = require("../js/economicValues/beaPceFormal.js");
const MofFixture = require("./fixtures/marketCalendar/mofJgbFixture.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID, GENERATION = "5".repeat(64);
const ACCEPTED_AT = "2026-12-01T00:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: "live_original_acquisition" });
const clone = value => structuredClone(value);
const url = code => `https://www.mof.go.jp/jgbs/auction/calendar/${code}.htm`;
function december() {
  return MofFixture.month("2612", [MofFixture.row("12月3日（木）", "10年利付国債"),
    MofFixture.row("12月10日（木）", "5年利付国債")]);
}
function response(urlValue, body, status = 200, contentType = "text/html; charset=UTF-8") {
  const bytes = new TextEncoder().encode(body), value = new Response(bytes, { status,
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength) } });
  Object.defineProperty(value, "url", { value: urlValue }); return value;
}
async function acquire(options = {}) {
  const codes = options.codes || ["2610", "2611"], documents = {
    [Source.INDEX_URL]: options.index || MofFixture.index(codes),
    [url("2610")]: options.current || MofFixture.current,
    [url("2611")]: options.future || MofFixture.future,
    [url("2612")]: options.december || december(), ...(options.documents || {}) }, calls = [],
    runtime = Normal.create({ acquisitionContract: Contracts.NORMAL13,
      now: () => options.requestedAt || "2026-10-07T00:00:00.000Z",
      fetchImpl: async requestedUrl => {
        calls.push(requestedUrl); const value = documents[requestedUrl];
        if (typeof value === "function") return value(requestedUrl);
        if (value === undefined) throw new Error("mof_fixture_url_unexpected");
        return response(requestedUrl, value);
      } }), result = await runtime.acquireForEvidence({ sourceId: SOURCE_ID,
      operation: Network.OPERATION });
  if (options.fetchedAt) result.fetchedAt = options.fetchedAt;
  return { result, calls, runtime, documents };
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
    "optionmap-mof-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
    values = options.acquisitions || [(await acquire()).result], transport =
    options.acquisition || acquisitionSequence(values), vault = options.vault ||
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

test("R18-1 normal index and multiple month pages retain all exact raw documents", async t => {
  const live = await acquire(), h = await fixture(t, { acquisitions: [live.result] }), result =
    await h.runtime.acquireAndCommit(INPUT), snapshot = (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([live.calls.length, h.acquisition.count(), result.status,
    result.evidenceTransactionCount, result.formalTransactionCount], [3, 1, "committed", 3, 1]);
  assert.deepEqual(result.sourceEvidenceSet.documents.map(value => value.role),
    ["index", "month:2026-10", "month:2026-11"]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  for (const document of result.sourceEvidenceSet.documents) {
    const sourceDocument = live.result.documents.find(value => value.requestedUrl === document.sourceUrl);
    assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256),
      Buffer.from(sourceDocument.evidenceInput));
  }
});

test("R18-2 restart preserves revision through manifest month occurrence and content", async t => {
  const h = await fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([(await acquire()).result]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus,
      resolved.manifest.documentCount], ["available", "valid", 3]);
    assert.match(resolved.documentRole, /^month:2026-(?:10|11)$/);
  }
});

test("R18-3 role ordering and manifest identity ignore document completion order", async () => {
  const first = (await acquire()).result, second = clone(first);
  second.documents = [second.documents[0], ...second.documents.slice(1).reverse()];
  const one = Pilot.createEvidenceInputs(first, "live_original_acquisition"), two =
    Pilot.createEvidenceInputs(second, "live_original_acquisition");
  assert.deepEqual(one.manifest, two.manifest);
  assert.deepEqual(one.roles,
    ["index", "month:2026-10", "month:2026-11"]);
});

test("R18-4 discovery exceeding 36 month roles fails closed", async t => {
  const codes = Array.from({ length: 37 }, (_, index) => {
    const offset = index + 9, year = 26 + Math.floor(offset / 12), month = offset % 12 + 1;
    return `${year}${String(month).padStart(2, "0")}`;
  }), failed = await acquire({ codes }), h = await fixture(t, { acquisition: failed.runtime }),
    result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.reason,
    result.formalTransactionCount], ["failed", "discovery_manifest_rejected",
    "index_month_limit_exceeded", 0]);
});

test("R18-5 invalid external discovered URL is rejected", async t => {
  const failed = await acquire({ index: '<meta charset="UTF-8"><h1>入札カレンダー</h1>' +
    '<a href="https://evil.example/2610.htm">10月</a>' }), h = await fixture(t,
      { acquisition: failed.runtime }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "discovery_manifest_rejected", 0]);
});

test("R18-6 duplicate month role is rejected", async t => {
  const failed = await acquire({ index: MofFixture.index(["2610", "2610"]) }), h =
    await fixture(t, { acquisition: failed.runtime }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.reason],
    ["failed", "discovery_manifest_rejected", "duplicate_month_document"]);
});

test("R18-7 raw-only index change creates evidence and semantic write0", async t => {
  const firstAcquisition = (await acquire({ fetchedAt: "2026-11-09T01:00:00.000Z" })).result,
    secondAcquisition = (await acquire({ index: `${MofFixture.index(["2610", "2611"])}<!--raw-->`,
      fetchedAt: "2026-11-09T02:00:00.000Z" })).result, h = await fixture(t,
      { acquisitions: [firstAcquisition, secondAcquisition] }), first =
      await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-12-02T00:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R18-8 raw-only month markup change creates evidence and semantic write0", async t => {
  const firstAcquisition = (await acquire({ fetchedAt: "2026-11-09T01:00:00.000Z" })).result,
    secondAcquisition = (await acquire({ current: `${MofFixture.current}<!--raw-->`,
      fetchedAt: "2026-11-09T02:00:00.000Z" })).result, h = await fixture(t,
      { acquisitions: [firstAcquisition, secondAcquisition] }), first =
      await h.runtime.acquireAndCommit(INPUT), before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-12-02T00:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[1].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[1].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R18-9 semantic auction change creates an immutable revision", async t => {
  const changed = MofFixture.current.replace("10月8日（木）", "10月9日（金）"), h =
    await fixture(t, { acquisitions: [(await acquire({ fetchedAt:
      "2026-11-09T01:00:00.000Z" })).result, (await acquire({ current: changed,
      fetchedAt: "2026-11-09T02:00:00.000Z" })).result] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-12-02T00:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.equal(before.revisions.every(old => after.revisions.some(value =>
    value.revisionKey === old.revisionKey)), true);
  assert.equal(after.revisions.length > before.revisions.length, true);
});

test("R18-10 newly discovered future month creates a new manifest and accepted events", async t => {
  const h = await fixture(t, { acquisitions: [(await acquire({ codes: ["2610"],
    fetchedAt: "2026-11-09T01:00:00.000Z" })).result, (await acquire({
      codes: ["2610", "2611"], fetchedAt: "2026-11-09T02:00:00.000Z" })).result] }), first =
    await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-12-02T00:00:00.000Z" }), snapshot =
      (await h.runtime.readSnapshot()).snapshot;
  assert.equal(second.status, "committed");
  assert.notEqual(first.sourceEvidenceSet.manifest.manifestSha256,
    second.sourceEvidenceSet.manifest.manifestSha256);
  assert.equal(snapshot.revisions.some(value => value.calendarDateStart
    .startsWith("2026-11")), true);
});

test("R18-11 removed month with absenceAuthority none creates no false delete or cancel", async t => {
  const h = await fixture(t, { acquisitions: [(await acquire({
    fetchedAt: "2026-11-09T01:00:00.000Z" })).result, (await acquire({ codes: ["2610"],
    fetchedAt: "2026-11-09T02:00:00.000Z" })).result] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    novemberKeys = before.revisions.filter(value => value.calendarDateStart
      .startsWith("2026-11")).map(value => value.eventKey);
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-12-02T00:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot;
  assert.equal(novemberKeys.length > 0, true);
  for (const key of novemberKeys) {
    const entry = after.entries.find(value => value.eventKey === key), revision =
      after.revisions.find(value => value.revisionKey === entry.activeRevisionKey);
    assert.equal(revision.validTo, null);
  }
});

test("R18-12 missing required month page produces MOF transaction0", async t => {
  const failed = await acquire({ documents: { [url("2611")]: requestedUrl =>
    response(requestedUrl, "failed", 503) } }), h = await fixture(t,
      { acquisition: failed.runtime }), result = await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "month_page_transport_rejected", 0]);
});

test("R18-13 index parser failure performs no Formal promotion", async t => {
  const failed = await acquire({ index: '<meta charset="UTF-8"><h1>broken</h1>' }), h =
    await fixture(t, { acquisition: failed.runtime }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "index_parser_rejected", 0]);
});

test("R18-14 month parser failure retains evidence but performs no Formal promotion", async t => {
  const failed = (await acquire({ current: MofFixture.current.replace("入札予定日", "公表日") })).result,
    h = await fixture(t, { acquisitions: [failed] }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "month_page_parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 3);
});

test("R18-15 Vault failure remains MOF-local with Formal transaction0", async t => {
  const h = await fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R18-16 MOF evidence failure leaves the other twelve sources eligible", async () => {
  const sources = await AcquisitionFixture.allSuccess(), index = sources.findIndex(value =>
    value.sourceId === SOURCE_ID);
  sources[index] = AcquisitionFixture.transportFailure(sources[index]);
  sources[index].evidenceDiagnostic = "source_evidence_write_failed";
  const result = await Contract.evaluateAcquisitionGeneration({ sourceResults: sources,
    acceptedAt: AcquisitionFixture.ACCEPTED_AT,
    generationIdentity: AcquisitionFixture.GENERATION });
  assert.equal(result.eligibleSources.length, 12); assert.deepEqual(result.failedSources, [SOURCE_ID]);
});

test("R18-17 pre-activation MOF history stays valid and unavailable", async t => {
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

test("R18-18 historical later fetch retains archive acquisition context", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit({ ...INPUT,
    acquisitionContext: "historical_archive_fetch" });
  const resolved = h.runtime.resolveRunEvidence({ sourceId: SOURCE_ID,
    sourceEvidenceSet: result.sourceEvidenceSet });
  assert.equal(resolved.status, "available");
  assert.equal(resolved.documents.every(value =>
    value.acquisitionContext === "historical_archive_fetch"), true);
});

for (const [id, index] of [["R18-19", 0], ["R18-20", 1]])
  test(`${id} tamper in required evidence invalidates the whole MOF set`, async t => {
    const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
      (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[index],
      target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
    const resolved = EvidenceSet.resolveRunEvidence({ run: snapshot.runs[0], vault: h.vault });
    assert.deepEqual([resolved.status, resolved.reason], ["invalid", "hash_mismatch"]);
  });

test("R18-21 manifest tamper is rejected before evidence resolution", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, run = clone(snapshot.runs[0]);
  run.sourceEvidenceSet.manifest.documents[1].role = "month:2026-12";
  assert.equal(EvidenceSet.validateSourceEvidenceSet(run.sourceEvidenceSet), false);
  const resolved = EvidenceSet.resolveRunEvidence({ run, vault: h.vault });
  assert.deepEqual([resolved.status, resolved.reason], ["invalid", "source_evidence_set_invalid"]);
});

test("R18-22 Calendar Export leaks neither raw MOF body nor Evidence references", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-12-01T01:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available", persistedSourceIds: [SOURCE_ID],
        absentSourceIds: Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact);
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|evidenceInput|rawBody|rawHtml/);
  for (const document of result.sourceEvidenceSet.documents)
    assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
});

test("R18-23 prior Calendar evidence remains active without Fed activation", async t => {
  const h = await fixture(t), result = await h.runtime.acquireAndCommit(INPUT), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), true);
  assert.equal(BojEvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), false);
  for (const id of ["us-bls-calendar", "us-nyse-market-holidays", "jp-esri-sna-calendar",
    "jp-esri-machinery-orders-calendar", "jp-stat-cpi", "jp-stat-labor",
    "us-census-calendar", "jp-jpx-market-holidays", "us-bea-calendar",
    "jp-jpx-derivatives-calendar", "jp-boj-calendar", SOURCE_ID])
    assert.equal(preparation.includes(`"${id}":`), true);
  assert.equal(preparation.includes('"us-fed-fomc-calendar":'), false);
});

test("R18-24 Economic evidence Runtime State and exports remain isolated", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/mofCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(Economic.SOURCE_ID, "us-bea-pce-values");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC/);
  assert.doesNotMatch(preparation, /economicValues/);
});

test("R18-25 known MOF startup native fixture remains outside the Evidence activation", () => {
  const pilot = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarIsolated/mofCalendarEvidencePilot.js"), "utf8"), normal =
    fs.readFileSync(path.join(__dirname,
      "../js/marketCalendarRuntime/mofNormalAcquisition.js"), "utf8");
  assert.doesNotMatch(pilot, /mofStartup|StartupWiring|HiddenRenderer|startupCanary/);
  assert.doesNotMatch(normal, /mofStartup|StartupWiring|HiddenRenderer|startupCanary/);
});
