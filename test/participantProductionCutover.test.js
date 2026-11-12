"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");
const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
const { IDBKeyRange } = require("fake-indexeddb");

const P1 = require("../js/participantAcquisitionAuthorityContract.js");
const P2 = require("../js/participantRawTransportShadow.js");
const P3 = require("../js/participantEvidenceVaultShadow.js");
const Production = require("../js/participantProductionAcquisition.js");
const Writer = require("../js/participantFormalProductionWriter.js");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const SetStore = require("../js/storage/participantEvidenceSetStore.js");
const NetworkPolicy = require("../js/security/networkUrlPolicy.js");

const REPO = path.join(__dirname, "..");
const DATE = "2026-11-10";

function workbook(role, date, state) {
  const book = XLSX.utils.book_new(), index = P1.ROLE_ORDER.indexOf(role);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["手口上位一覧"], [null, "取引日 Trading Date :", date.replaceAll("-", "")],
    ["NK225F", "161090018", `${role} CONTRACT`, 1, `00${index + 1}`,
      `${role}証券`, `${role} Securities`, state.volume + index],
    ["ignored-marker", state.marker]
  ]), "Sheet1");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function response(bytes, status = 200) {
  return new Response(status === 200 ? bytes : null, { status, headers: status === 200 ?
    { "content-type": P2.MIME, "content-length": String(bytes.byteLength) } :
    { "content-type": "text/plain" } });
}

function harness(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-p5a-"))), authority = P1.createMainAuthority({ keyId: "participants-p5a-main",
    secret: Buffer.alloc(32, 85) }), state = { volume: 100, marker: "a", failureRole: null,
    parserFailureRole: null }, baseTransport = P2.createParticipantsRawTransportShadow({ authority,
      now: () => new Date("2026-11-10T09:30:00.000Z"), fetchImpl: async url => {
        const role = P1.ROLE_ORDER.find(item => P1.canonicalWorkbookUrl(item, DATE) === url);
        if (!role || state.failureRole === role) return response(new Uint8Array(), 500);
        if (state.parserFailureRole === role) return response(new Uint8Array([80, 75, 3, 4]));
        return response(workbook(role, DATE, state));
      } }), vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test",
      crashAt: null }), setStore = SetStore.createIsolatedParticipantEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }), evidenceBase =
      P3.createParticipantsEvidenceVaultShadow({ transportShadow: baseTransport, vault, setStore,
        authority, testHooks: null }), indexedDB = new FDBFactory(), writer =
      Writer.createParticipantFormalProductionWriter({ indexedDB, IDBKeyRange,
        databaseName: Schema.DATABASE_NAME });
  let formalCommits = 0, ids = 0;
  const formalBridge = overrides.formalBridge || { async commit(value) {
    formalCommits += 1; return writer.commit(value);
  } };
  let transport = overrides.transport || baseTransport;
  const evidenceShadow = overrides.evidenceShadow || evidenceBase;
  const discovery = overrides.discovery || { async latestFacts() {
    return { indexUrl: P1.CURRENT_INDEX_URL,
      hrefs: P1.ROLE_ORDER.map(role => P1.canonicalWorkbookUrl(role, DATE)),
      discoveryRequestId: "participants-p5a-index" };
  }, async rangeDates() { return { dates: [DATE], failureCount: 0,
    unavailableMonthCount: 0 }; }, probeStartDate: () => DATE };
  const service = Production.createParticipantProductionAcquisition({ authority,
    transportShadow: transport, evidenceShadow, formalBridge, vault, setStore, discovery,
    now: () => new Date("2026-11-10T10:00:00.000Z"),
    createId: kind => `participants-${kind}-${++ids}` });
  t.after(() => { writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, state, authority, baseTransport, evidenceBase, vault, setStore, writer,
    formalCommits: () => formalCommits };
}

test("P5A-1 production latest acquisition uses the evidence-backed pipeline", async t => {
  const h = harness(t), result = await h.service.acquire({ requestKind: "latest_available" });
  assert.deepEqual([result.status, result.sourceDate, result.formalWriteCount,
    h.vault.vaultStatus().occurrenceCount], ["available", DATE, 1, 4]);
});

test("P5A-2 explicit source date uses only the bounded intent", async t => {
  const result = await harness(t).service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE });
  assert.deepEqual([result.status, result.sourceDate], ["available", DATE]);
});

test("P5A-3 backfill date is acquired by the same explicit production path", async t => {
  const h = harness(t), manifest = await h.service.acquire({ requestKind: "historical_backfill_range",
    startDate: DATE, endDate: DATE }), result = await h.service.acquire({
      requestKind: "explicit_source_date", targetDate: manifest.candidates[0].sourceDate });
  assert.deepEqual([manifest.classification, result.status], ["backfill_manifest", "available"]);
});

test("P5A-4 old Participants URL authority is unreachable", () => {
  const main = fs.readFileSync(path.join(REPO, "main.js"), "utf8"),
    preload = fs.readFileSync(path.join(REPO, "preload.js"), "utf8"),
    html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  assert.doesNotMatch(`${main}\n${preload}\n${html}`,
    /fetch-jpx-participant-json|fetchParticipantListing|makeParticipantUrls/);
  assert.equal(NetworkPolicy.validateRendererExcelUrl(
    P1.canonicalWorkbookUrl("dayAuction", DATE)).ok, false);
});

test("P5A-5 exact four-role success promotes a complete consumer result", async t => {
  const result = await harness(t).service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE });
  assert.deepEqual(Object.keys(result.completeSet.files), P1.ROLE_ORDER);
});

test("P5A-6 raw-only change retains semantic state and writes Formal0", async t => {
  const h = harness(t), first = await h.service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE }); h.state.marker = "raw-b";
  const second = await h.service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([first.completeSet.signature, second.completeSet.signature,
    second.classification, second.formalWriteCount],
  [first.completeSet.signature, first.completeSet.signature, "semantic_duplicate", 0]);
});

test("P5A-7 same-date semantic correction creates a new immutable Formal revision", async t => {
  const h = harness(t); await h.service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE }); h.state.volume = 200;
  const result = await h.service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([result.classification, result.formalWriteCount], ["same_date_correction", 1]);
});

test("P5A-8 one role failure cannot promote partial consumer state", async t => {
  const h = harness(t); h.state.failureRole = "nightJnet";
  const result = await h.service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([result.status, result.completeSet, result.diagnostics.retainedLastValid,
    h.vault.vaultStatus().occurrenceCount], ["unavailable", null, true, 3]);
});

test("P5A-9 parser failure cannot promote consumer state", async t => {
  const h = harness(t); h.state.parserFailureRole = "nightJnet";
  const result = await h.service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([result.status, result.reason, result.completeSet,
    h.vault.vaultStatus().occurrenceCount], ["unavailable", "parser_failed", null, 4]);
});

test("P5A-10 Evidence failure prevents Formal and consumer promotion", async t => {
  const base = harness(t), service = Production.createParticipantProductionAcquisition({
    authority: base.authority, transportShadow: base.baseTransport,
    evidenceShadow: { captureRawResults: async () => ({ status: "available" }),
      captureTransportSet: async () => ({ status: "unavailable" }) },
    formalBridge: { commit: async () => { throw new Error("must_not_run"); } },
    vault: base.vault, setStore: base.setStore,
    discovery: { latestFacts: async () => null, rangeDates: async () => ({ dates: [] }),
      probeStartDate: () => DATE }, now: () => new Date("2026-11-10T10:00:00.000Z"),
    createId: kind => `participants-${kind}-evidence` }), result = await service.acquire({
      requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([result.reason, result.formalWriteCount], ["evidence_failed", 0]);
});

test("P5A-11 Formal failure leaves consumer promotion unavailable", async t => {
  const base = harness(t), service = Production.createParticipantProductionAcquisition({
    authority: base.authority, transportShadow: base.baseTransport,
    evidenceShadow: base.evidenceBase,
    formalBridge: { commit: async () => ({ status: "rejected" }) }, vault: base.vault,
    setStore: base.setStore, discovery: { latestFacts: async () => null,
      rangeDates: async () => ({ dates: [] }), probeStartDate: () => DATE },
    now: () => new Date("2026-11-10T10:00:00.000Z"),
    createId: kind => `participants-${kind}-formal` }), result = await service.acquire({
      requestKind: "explicit_source_date", targetDate: DATE });
  assert.equal(result.reason, "formal_promotion_failed");
});

test("P5A-12 a stale earlier run cannot overwrite a later accepted run", async t => {
  let firstRelease, firstStarted, acquireCount = 0;
  const started = new Promise(resolve => { firstStarted = resolve; }),
    release = new Promise(resolve => { firstRelease = resolve; }), base = harness(t),
    transport = { resolveManifest: input => base.baseTransport.resolveManifest(input),
      acquireManifest: manifest => base.baseTransport.acquireManifest(manifest),
      parseRawManifest: (manifest, batch) => base.baseTransport.parseRawManifest(manifest, batch),
      async acquireRawManifest(manifest) { acquireCount += 1;
        if (acquireCount === 1) { firstStarted(); await release; }
        return base.baseTransport.acquireRawManifest(manifest); } }, service =
      Production.createParticipantProductionAcquisition({ authority: base.authority,
        transportShadow: transport, evidenceShadow: base.evidenceBase,
        formalBridge: { commit: value => base.writer.commit(value) }, vault: base.vault,
        setStore: base.setStore, discovery: { latestFacts: async () => null,
          rangeDates: async () => ({ dates: [] }), probeStartDate: () => DATE },
        now: () => new Date("2026-11-10T10:00:00.000Z"),
        createId: kind => `participants-${kind}-${Math.random().toString(16).slice(2)}` });
  const older = service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  await started;
  const newer = await service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  firstRelease();
  assert.deepEqual([(await older).reason, newer.status], ["stale_request", "available"]);
});

test("P5A-13 duplicate refresh creates no duplicate semantic revision", async t => {
  const h = harness(t); await h.service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE });
  const duplicate = await h.service.acquire({ requestKind: "explicit_source_date", targetDate: DATE });
  assert.deepEqual([duplicate.classification, duplicate.formalWriteCount],
    ["semantic_duplicate", 0]);
});

test("P5A-14 startup has one Participants production acquisition call", () => {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  assert.equal((html.match(/requestKind:\s*"latest_available"/g) || []).length, 1);
  assert.doesNotMatch(html, /fetchParticipantListing|findLatestParticipantDate/);
});

test("P5A-15 backfill renderer submits dates, never workbook routes", () => {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  assert.match(html, /requestKind:\s*"historical_backfill_range"/);
  assert.match(html, /requestKind:\s*"explicit_source_date", targetDate:/);
  assert.doesNotMatch(html, /participant-volume\/files\/daily/);
});

test("P5A-16 current Participants UI consumers retain canonical cache semantics", () => {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  assert.match(html, /applyParticipantCache\(liveCache, "live"/);
  assert.match(html, /setLatestParsedDayData/);
});

test("P5A-17 Full Export retains existing Participants projection", () => {
  const collector = fs.readFileSync(path.join(REPO, "js/fullExportCollector.js"), "utf8");
  assert.match(collector, /participant/);
  assert.doesNotMatch(collector, /rawBytes|vaultPath|evidenceSetPath/);
});

test("P5A-18 bounded result leaks no raw bytes paths or transport objects", async t => {
  const result = await harness(t).service.acquire({ requestKind: "explicit_source_date",
    targetDate: DATE }), serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /rawSha256|transportSet|manifestId|occurrenceId|vault|bytes/);
  assert.equal(result.diagnostics.rawPayloadExposed, false);
});

test("P5A-19 pre-activation Formal records remain accepted by the unchanged schema", () => {
  const source = fs.readFileSync(path.join(REPO,
    "js/formalArchive/participantFormalArchiveSchema.js"), "utf8");
  assert.match(source, /Object\.hasOwn\(value, "sourceEvidence"\)/);
  assert.match(source, /!validateSourceEvidence/);
});

test("P5A-20 existing parser authority and canonical cache versions are unchanged", () => {
  assert.deepEqual(P1.PARSER_AUTHORITY, { parserId: "jpx-participant-volume-workbook",
    parserVersion: 1, spreadsheetLibrary: "sheetjs", spreadsheetLibraryVersion: "0.20.3",
    sheetSelection: "first_worksheet", columnMappingVersion: 1 });
});
