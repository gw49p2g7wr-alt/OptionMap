"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const CalendarExport = require("../js/calendarExportV1.js");
const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const RuntimeState = require("../js/marketCalendarRuntime/sourceUpdateState.js");
const UpdatePolicy = require("../js/marketCalendarRuntime/updatePolicy.js");
const Contract = require("../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const EvidenceSet = require("../js/marketCalendarHistory/fedCalendarSourceEvidenceSet.js");
const History = require("../js/marketCalendarHistory/historyIntegrity.js");
const Preparation = require("../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Transition = require("../js/marketCalendarHistory/transitionPlanner.js");
const Authorization = require("../js/marketCalendarHistory/planAuthorization.js");
const Boundary = require("../js/marketCalendarHistory/firstProductionWriteBoundary.js").fomc;
const GenericPilot = require("../js/marketCalendarIsolated/calendarSingleDocumentEvidencePilot.js");
const Pilot = require("../js/marketCalendarIsolated/fedCalendarEvidencePilot.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const AcquisitionFixture = require("./fixtures/marketCalendar/partialBootstrapFixture.js");
const FormalFixture = require("./fixtures/marketCalendar/partialSourceExecutorFixture.js");

const SOURCE_ID = Pilot.SOURCE_ID, source = Registry.getSource(SOURCE_ID);
const GENERATION = "b".repeat(64), ACCEPTED_AT = "2026-11-09T02:00:00.000Z";
const INPUT = Object.freeze({ acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION,
  acquisitionContext: Pilot.LIVE_CONTEXT });
const HTML = `<meta charset="utf-8"><h3>2026 FOMC Meetings</h3>
<div class="fomc-meeting__month"><strong>September</strong></div>
<div class="fomc-meeting__date">15-16*</div>
<div class="fomc-meeting__month"><strong>October</strong></div>
<div class="fomc-meeting__date">27-28</div><div class="panel-footer">end</div>`;
const GATE_D_HTML = `<h3>2026 FOMC Meetings</h3><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">27-28</div>
<div class="fomc-meeting__month"><strong>March</strong></div><div class="fomc-meeting__date">17-18*</div>
<div class="fomc-meeting__month"><strong>April</strong></div><div class="fomc-meeting__date">28-29</div>
<div class="fomc-meeting__month"><strong>June</strong></div><div class="fomc-meeting__date">16-17*</div>
<div class="fomc-meeting__month"><strong>July</strong></div><div class="fomc-meeting__date">28-29</div>
<div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div>
<div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div>
<div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div><div class="panel-footer"></div>`;
const clone = value => structuredClone(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalFunctionSource = value => value.toString().replace(/\r\n?/g, "\n");
const functionDigest = value => digest(Buffer.from(canonicalFunctionSource(value), "utf8"));

function acquisition(html = HTML, fetchedAt = "2026-11-09T01:00:00.000Z") {
  const raw = new TextEncoder().encode(html), hash = digest(raw);
  return { success: true, reason: null, retryable: false, sourceId: SOURCE_ID,
    operation: Network.OPERATION, requestedAt: "2026-11-09T00:59:59.000Z", fetchedAt,
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
    "optionmap-fed-calendar-evidence-"))), indexedDB = options.indexedDB || new IDBFactory(),
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
function changedRange(fetchedAt = "2026-11-09T03:00:00.000Z") {
  return acquisition(HTML.replace("15-16*", "15-17*"), fetchedAt);
}
async function acceptedSet() {
  const generated = Pilot.createEvidenceInput(acquisition(), Pilot.LIVE_CONTEXT), evidenceRef =
    Evidence.createSourceEvidenceRef({ state: "available", occurrence: generated.input.occurrence,
      policy: generated.input.policy });
  return EvidenceSet.createSourceEvidenceSet({ acquisitionRunId: generated.acquisitionRunId,
    documents: [{ role: "primary", sourceUrl: source.canonicalUrl,
      byteLength: generated.input.contentObject.byteLength,
      mediaType: generated.input.contentObject.mediaType,
      encoding: generated.input.contentObject.encoding, evidenceRef }] });
}

test("R19-1 normal Fed acquisition retains exact HTML and binds one source run", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0];
  assert.deepEqual([result.status, result.evidenceTransactionCount,
    result.formalTransactionCount, h.acquisition.count()], ["committed", 1, 1, 1]);
  assert.equal(EvidenceSet.validateSourceEvidenceSet(snapshot.runs[0].sourceEvidenceSet), true);
  assert.deepEqual(h.vault.readRawBytes(document.evidenceRef.contentSha256), Buffer.from(HTML));
});

test("R19-2 restart preserves revision-run-occurrence-content lineage", async t => {
  const h = fixture(t); await h.runtime.acquireAndCommit(INPUT);
  const restartedVault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }), restarted = Pilot.createPilotRuntime({
      acquisition: acquisitionSequence([acquisition()]), vault: restartedVault,
      formal: formalAdapter(h.indexedDB) }), snapshot = (await restarted.readSnapshot()).snapshot;
  for (const revision of snapshot.revisions) {
    const resolved = await restarted.resolveRevisionEvidence(revision.revisionKey);
    assert.deepEqual([resolved.status, resolved.integrityStatus, resolved.documentRole,
      resolved.parserLineage.length], ["available", "valid", "primary", 1]);
  }
});

test("R19-3 Fed thin wrapper reuses the generic P1 core", () => {
  const sourceText = fs.readFileSync(require.resolve(
    "../js/marketCalendarIsolated/fedCalendarEvidencePilot.js"), "utf8");
  assert.equal(Pilot.CORE_VERSION, GenericPilot.CORE_VERSION);
  assert.match(sourceText, /calendarSingleDocumentEvidencePilot\.js/);
  assert.doesNotMatch(sourceText, /storeAcceptedEvidence|createAcquisitionOccurrence/);
});

test("R19-4 duplicate bytes reuse content but retain distinct occurrences", async t => {
  const h = fixture(t, { acquisitions: [acquisition(),
    acquisition(HTML, "2026-11-09T02:00:00.000Z")] }), first =
    await h.runtime.acquireAndCommit(INPUT), second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-11-09T04:00:00.000Z" }), hash =
      first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256;
  assert.deepEqual([second.status, second.diagnostic, second.formalTransactionCount],
    ["unchanged", "evidence_duplicate_content", 0]);
  assert.equal(second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256, hash);
  assert.equal(h.vault.occurrencesByContentSha256(hash).length, 2);
});

test("R19-5 raw-only markup change creates evidence and semantic write0", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition(`${HTML}<!--raw-only-->`,
    "2026-11-09T02:00:00.000Z")] }), first = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-11-09T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot;
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.notEqual(first.sourceEvidenceSet.documents[0].evidenceRef.contentSha256,
    second.sourceEvidenceSet.documents[0].evidenceRef.contentSha256);
  assert.deepEqual(after.revisions, before.revisions);
});

test("R19-6 meeting range change creates immutable revisions and preserves as-known-at", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), changedRange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.eventType === "US_FOMC_MEETING" &&
      value.logical.referencePeriod === "2026-09-meeting");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-11-09T05:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot, current = after.revisions.find(value =>
    value.eventKey === old.eventKey && value.validTo === null), oldView =
    await History.queryAsKnownAt(after, { calendarDate: old.calendarDateStart,
      knowledgeAt: "2026-11-09T03:00:00.000Z" }), newView =
    await History.queryAsKnownAt(after, { calendarDate: current.calendarDateEnd,
      knowledgeAt: "2026-11-09T06:00:00.000Z" });
  assert.notEqual(current.revisionKey, old.revisionKey);
  assert.equal(oldView.events.some(value => value.revision.revisionKey === old.revisionKey), true);
  assert.equal(newView.events.some(value => value.revision.revisionKey === current.revisionKey), true);
});

test("R19-7 policy decision remains fixed at 14:00 and changes only through existing schedule semantics", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), changedRange()] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    old = before.revisions.find(value => value.logical.eventType === "US_FOMC_POLICY_DECISION" &&
      value.logical.referencePeriod === "2026-09-meeting");
  await h.runtime.acquireAndCommit({ ...INPUT, acceptedAt: "2026-11-09T05:00:00.000Z" });
  const after = (await h.runtime.readSnapshot()).snapshot, current = after.revisions.find(value =>
    value.eventKey === old.eventKey && value.validTo === null);
  assert.notEqual(current.revisionKey, old.revisionKey);
  assert.equal(current.schedule.sourceLocal.startTime, "14:00");
  assert.equal(old.validTo, null);
  assert.equal(after.revisions.find(value => value.revisionKey === old.revisionKey).validTo,
    "2026-11-09T05:00:00.000Z");
});

test("R19-8 press-conference marker treatment and fixed 14:30 semantics remain unchanged", async t => {
  const h = fixture(t, { acquisitions: [acquisition(), acquisition(HTML.replace("15-16*", "15-16"),
    "2026-11-09T02:00:00.000Z")] });
  await h.runtime.acquireAndCommit(INPUT); const before = (await h.runtime.readSnapshot()).snapshot,
    second = await h.runtime.acquireAndCommit({ ...INPUT,
      acceptedAt: "2026-11-09T04:00:00.000Z" }), after =
      (await h.runtime.readSnapshot()).snapshot, conferences = after.revisions.filter(value =>
        value.logical.eventType === "US_FED_CHAIR_PRESS_CONFERENCE" && value.validTo === null);
  assert.deepEqual([second.status, second.formalTransactionCount], ["unchanged", 0]);
  assert.deepEqual(after.revisions, before.revisions);
  assert.equal(conferences.every(value => value.schedule.sourceLocal.startTime === "14:30"), true);
});

test("R19-9 parser drift retains raw evidence and performs Formal0", async t => {
  const malformed = acquisition('<meta charset="utf-8"><h3>Changed FOMC structure</h3>'),
    h = fixture(t, { acquisitions: [malformed] }), result =
      await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "parser_rejected", 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R19-10 Vault failure is Fed-local and Formal transaction0", async t => {
  const h = fixture(t, { vaultCrashAt: "before_occurrence_rename" }), result =
    await h.runtime.acquireAndCommit(INPUT);
  assert.deepEqual([result.status, result.diagnostic, result.formalTransactionCount],
    ["failed", "source_evidence_write_failed", 0]);
  assert.deepEqual(await h.indexedDB.databases(), []);
});

test("R19-11 Fed evidence failure leaves the other twelve sources eligible", async () => {
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

test("R19-12 FOMC atomic group and family identity guard remain exact", () => {
  assert.deepEqual(Contract.SOURCES[SOURCE_ID].sameSourceDocumentGroup,
    { atomic: true, mode: "exact", requiredRoles: ["primary"],
      discoveredRolePrefix: null, minimumDiscoveredRoles: 0 });
  assert.deepEqual(Contract.SOURCES[SOURCE_ID].specialGuards, ["fomc_family_identity"]);
});

test("R19-13 pre-activation Fed history remains valid and unavailable", async t => {
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

test("R19-14 raw and binding tamper are rejected without Calendar repair", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), before =
    (await h.runtime.readSnapshot()).snapshot, document = result.sourceEvidenceSet.documents[0],
    target = objectPath(h.root, document.evidenceRef.contentSha256), raw = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.alloc(raw.length, 0x78));
  assert.deepEqual([EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }).status,
    EvidenceSet.resolveRunEvidence({ run: before.runs[0], vault: h.vault }).reason],
  ["invalid", "hash_mismatch"]);
  const forged = clone(await acceptedSet()); forged.documents[0].role = "artifact";
  assert.equal(EvidenceSet.validateSourceEvidenceSet(forged), false);
  assert.deepEqual((await h.runtime.readSnapshot()).snapshot, before);
});

test("R19-15 historical Gate D artifact, parser and route identities remain unchanged", async () => {
  const PRECONDITION = { productionSnapshotFingerprint:
    "9d48ac8aab78f92d88ec4bdbc9cb9f9526bc629bf0bd536e3ab1b271f39b7ad6",
    storeCounts: { marketCalendarSourceRuns: 8, marketCalendarEventEntries: 102,
      marketCalendarSemanticRevisions: 102, marketCalendarAcquisitionEvidence: 204,
      marketCalendarEventObservations: 204, marketCalendarSourceCursors: 4 },
    schemaFingerprint: "85248c8ec61ad4b554d77ee38e96088bc9b7fc0c3fc885e3af5332e7e02c2cbc",
    sourceCursor: null }, context = { sourceId: SOURCE_ID, sourceUrl: source.canonicalUrl,
      fetchedAt: "2026-09-17T20:24:11.615Z", parserId: source.parserId,
      parserVersion: source.parserVersion,
      rawContentHash: "6bdf84a0fb3052944c3df33f218b7f2bfcb9e3c289fa59734054571190cbfeaa",
      requestId: "872400fe-3d4b-4b4c-81f0-4b4646002f96",
      runId: "e47d7e52-4b66-45ac-a7db-603915aad0d6",
      httpMetadata: { httpStatus: 200, finalUrl: source.canonicalUrl,
        contentType: "text/html", redirects: [] } }, parsed = Parsers.parseFed(GATE_D_HTML, context),
    events = [];
  for (const record of parsed.records) events.push((await Canonical.canonicalize(record)).event);
  const run = { sourceId: SOURCE_ID, runId: context.runId,
    acceptedAt: "2026-09-17T20:24:11.644Z", fetchedAt: [context.fetchedAt], status: "accepted",
    semanticSetHash: await Canonical.sha256(events.map(value => value.revisionKey).sort()) }, planned =
    Transition.planTransition({ snapshot: Transition.emptySnapshot(), run, canonicalSet: events,
      coverage: { confirmed: true, eventKeys: events.map(value => value.eventKey) } }), artifact =
    await Authorization.createV2(planned.plan, PRECONDITION);
  assert.equal(events.length, 24);
  assert.equal(await Authorization.artifactDigest(artifact),
    "1074ae4926e90771e3bcdfb2f95ad3e2ffd3cc18b911d72db7c7874129ec7351");
  assert.equal(functionDigest(Parsers.parseFed),
    "55b65068da162423ba55b5c8a8df504c1eb242ab0f968eafcd0c2900e2ad660b");
  assert.equal(Contract.expectedRouteIdentity(SOURCE_ID),
    "4c469e38231822771a31a9bb85d0677a26374ed9882467b623f62750e9b17085");
  assert.equal(Boundary.SOURCE_ID, SOURCE_ID);
  assert.deepEqual(Boundary.MUTATION_CEILING, { appendEntries: 0, updateEntries: 24,
    closeRevisions: 0, appendRevisions: 0, appendEvidence: 24,
    appendObservations: 24, appendRuns: 1, updateCursors: 1 });
});

test("R5F-1/R5F-2 Fed parser identity normalizes only source line endings", () => {
  const checkoutSource = Parsers.parseFed.toString(), lf = canonicalFunctionSource({
    toString: () => checkoutSource }), crlf = lf.replace(/\n/g, "\r\n"),
    legacyCr = lf.replace(/\n/g, "\r"), expected =
      "55b65068da162423ba55b5c8a8df504c1eb242ab0f968eafcd0c2900e2ad660b";
  assert.equal(crlf.includes("\r\r\n"), false);
  const regeneratedCrlf = canonicalFunctionSource({ toString: () => crlf }).replace(/\n/g, "\r\n");
  assert.equal(regeneratedCrlf.includes("\r\r\n"), false);
  assert.equal(regeneratedCrlf, crlf);
  for (const source of [lf, crlf, legacyCr]) assert.equal(digest(Buffer.from(
    canonicalFunctionSource({ toString: () => source }), "utf8")), expected);
});

test("R19-16 Gate D scripts remain excluded and have no runtime import edge", () => {
  const metadata = require("../package.json"), names = [
    "marketCalendarFedGateDAcceptance.browser.js", "marketCalendarFedGateDApprovedArtifact.js",
    "marketCalendarFedGateDControlledProduction.browser.js", "marketCalendarFedGateDPreflight.js"],
    runtimeFiles = ["main.js", "preload.js", "js/marketCalendarIsolated/fedCalendarEvidencePilot.js",
      "js/marketCalendarHistory/fedCalendarSourceEvidenceSet.js",
      "js/marketCalendarHistory/calendarPartialSourcePreparation.js"];
  assert.equal(metadata.build.files.includes("scripts/**/*"), false);
  for (const name of names) {
    assert.equal(metadata.build.files.some(value => value.endsWith(name)), false);
    for (const file of runtimeFiles)
      assert.equal(fs.readFileSync(path.join(__dirname, "..", file), "utf8").includes(name), false);
  }
});

test("R19-17 Gate D embedded HTML cannot bypass accepted acquisition", () => {
  assert.throws(() => Pilot.createEvidenceInput({ rawHtml: GATE_D_HTML }, Pilot.LIVE_CONTEXT),
    /fed_calendar_evidence_acquisition_invalid/);
  assert.throws(() => Pilot.createEvidenceInput(acquisition(GATE_D_HTML),
    "historical_archive_fetch"), /fed_calendar_historical_route_not_approved/);
});

test("R19-18 source, route and parser authority remain exact", () => {
  const route = Network.getPolicy(SOURCE_ID).documents[0];
  assert.deepEqual(source, { sourceId: SOURCE_ID, authority: "US_FED", jurisdiction: "US",
    authorityLevel: "primary", sourceKind: "official_calendar",
    canonicalUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    allowedHosts: ["www.federalreserve.gov"], sourceTimeZone: "America/New_York",
    parserId: "us-fed-fomc-calendar-parser", parserVersion: 1, formalEligible: true });
  assert.deepEqual([route.role, route.url, route.kind, route.maxBytes],
    ["primary", source.canonicalUrl, "html", 3_000_000]);
  assert.deepEqual(route.allowedMime, ["text/html", "application/xhtml+xml"]);
});

test("R19-19 Runtime State retry and manual recovery policy remain unchanged", () => {
  assert.deepEqual(RuntimeState.RETRY_CLASSIFICATION.parser_structure_change,
    { retryable: false, delayMinutes: null, automatic: false, manualCandidate: true });
  assert.deepEqual(RuntimeState.RETRY_CLASSIFICATION.network_failure,
    { retryable: true, delayMinutes: 60, automatic: true });
  const runtimeState = { sourceId: SOURCE_ID, lastAttemptAt: "2026-11-09T01:00:00.000Z",
    lastSuccessAt: null, lastOutcome: "failure", retryAfter: null, lastHttpStatus: 200,
    lastDiagnosticClass: "parser_structure_change", coordinatorVersion: 1 }, formalState =
    { databaseStatus: "available", schemaStatus: "compatible", sourceCursorStatus: "available",
      lastAcceptedAt: "2026-11-08T01:00:00.000Z", securityStatus: "clear" }, sessionState =
    { attemptCount: 0 }, common = { sourceId: SOURCE_ID,
      requestedAt: "2026-11-09T02:00:00.000Z", runtimeState, formalState, sessionState };
  assert.deepEqual([UpdatePolicy.evaluateSourceUpdate({ ...common, trigger: "startup" }).decision,
    UpdatePolicy.evaluateSourceUpdate({ ...common, trigger: "startup" }).reason],
  ["blocked", "automatic_retry_disabled_parser_structure_change"]);
  assert.deepEqual([UpdatePolicy.evaluateSourceUpdate({ ...common, trigger: "manual" }).decision,
    UpdatePolicy.evaluateSourceUpdate({ ...common, trigger: "manual" }).reason],
  ["update", "manual_diagnostic_retry"]);
});

test("R19-20 Calendar Export leaks neither raw Fed HTML nor Evidence references", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), snapshot =
    (await h.runtime.readSnapshot()).snapshot, artifact = CalendarExport.create({
      appVersion: "1.1.0-beta.16", generatedAt: "2026-11-09T06:00:00.000Z",
      archiveResult: { status: "available", snapshot, coverage: {
        sourceSetIdentity: Contract.SOURCE_SET_ID, expectedCount: 13, coverageCount: 1,
        completeness: "partial", formalAvailability: "available", persistedSourceIds: [SOURCE_ID],
        absentSourceIds: Contract.EXPECTED_SOURCE_IDS.filter(value => value !== SOURCE_ID),
        invalidSourceIds: [], sources: [] } }, runtimeStates: [],
      runtimeStateRead: { status: "absent", reason: null, invalidSources: [] } }), serialized =
      CalendarExport.serialize(artifact), document = result.sourceEvidenceSet.documents[0];
  assert.doesNotMatch(serialized, /sourceEvidenceSet|occurrenceId|parserInput|rawBody|rawHtml/);
  assert.equal(serialized.includes(document.evidenceRef.occurrenceId), false);
  assert.equal(serialized.includes(HTML), false);
});

test("R19-21 all thirteen Calendar Evidence validators are registered", async t => {
  const h = fixture(t), result = await h.runtime.acquireAndCommit(INPUT), preparation =
    fs.readFileSync(require.resolve(
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.equal(EvidenceSet.validateSourceEvidenceSet(result.sourceEvidenceSet), true);
  for (const sourceId of Contract.EXPECTED_SOURCE_IDS)
    assert.equal(preparation.includes(`"${sourceId}":`), true, sourceId);
});

test("R19-22 Economic evidence, Runtime State and exports remain isolated", () => {
  const pilot = fs.readFileSync(require.resolve(
    "../js/marketCalendarIsolated/fedCalendarEvidencePilot.js"), "utf8"), preparation =
    fs.readFileSync(require.resolve(
      "../js/marketCalendarHistory/calendarPartialSourcePreparation.js"), "utf8");
  assert.doesNotMatch(pilot, /economicValues|RuntimeState|runtimeState|manualReset|startup|canary|IPC/);
  assert.doesNotMatch(preparation, /economicValues/);
});
