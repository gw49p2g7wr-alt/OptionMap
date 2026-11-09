"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Q4 = require("../js/qriFormalEvidenceBinding.js");
const Parser = require("../js/qriOptions.js");
const History = require("../js/qriOptionsHistory.js");
const AsKnownAt = require("../js/qriOptionsAsKnownAt.js");
const Store = require("../js/storage/qriOptionsHistoryStore.js");

const ROOT = path.join(__dirname, "..");
const SECRET = "qri-as-known-at-fixture-secret-32-bytes-minimum";
let databaseSequence = 0;

function authority() {
  return Qri.createMainAuthority({ keyId: "qri-main-as-known-at-v1", secret: SECRET });
}

function activeChain(main, contract = "2026-11") {
  const intent = Qri.createAcquisitionIntent({ requestKind: "active" });
  const route = Qri.resolveQriIntent(intent,
    { activeContractIdentity: Qri.createContractIdentity(contract) }).route;
  const acquisition = Qri.createMainAcquisitionIdentity({ intent, route,
    runId: `q5-active-${contract}`, requestId: `q5-active-request-${contract}` }, main);
  return { intent, route, acquisition, parentManifestId: null };
}

function parentChain(main) {
  const parent = activeChain(main);
  const parentReceipt = Qri.createAcquisitionReceipt({ acquisition: parent.acquisition,
    intent: parent.intent, route: parent.route, acceptedInitialUrl: parent.route.canonicalUrl,
    acceptedFinalUrl: parent.route.canonicalUrl, fetchedAt: "2026-11-10T00:00:00.000Z",
    parserInputIdentity: Qri.createParserInputIdentity() }, main);
  const manifest = Qri.createParentManifest({ parentReceipt, entries: [{
    contractIdentity: Qri.createContractIdentity("2026-12"),
    canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1",
    allowedRoles: ["major_sq", "next"]
  }] }, main);
  return { parent, parentReceipt, manifest, entry: manifest.entries[0] };
}

function receiptFor(role, main = authority()) {
  let chain;
  if (role === "active") chain = activeChain(main);
  else {
    const parent = parentChain(main), intent = Qri.createAcquisitionIntent({
      requestKind: "listed_reference", role,
      parentAcquisitionId: parent.parentReceipt.acquisitionId,
      listedContractId: parent.entry.listedContractId });
    const route = Qri.resolveQriIntent(intent, { parentManifest: parent.manifest,
      parentReceipt: parent.parentReceipt, authority: main }).route;
    const acquisition = Qri.createMainAcquisitionIdentity({ intent, route,
      runId: `q5-${role}-run`, requestId: `q5-${role}-request` }, main);
    chain = { intent, route, acquisition, parentManifestId: parent.manifest.manifestId };
  }
  const rawSha = Qri.sha256({ role, material: "raw" }), parserSha = Qri.sha256({ role,
    material: "parser" });
  const transportIdentity = Qri.createTransportIdentity({ httpStatus: 200,
    declaredContentType: "text/html; charset=utf-8", mediaType: "text/html", encoding: "utf-8",
    byteLength: 100, contentSha256: rawSha, redirectHops: [] });
  const parserInputIdentity = Qri.createParserInputIdentity({ state: "bound", sha256: parserSha,
    encoding: "utf-8", rawContentSha256: rawSha });
  const contextIdentity = Qri.createEvidenceContextIdentity({ acquisition: chain.acquisition,
    intent: chain.intent, route: chain.route, parentManifestId: chain.parentManifestId }, main);
  const evidenceStatus = Qri.createEvidenceStatus({ contentSha256: rawSha,
    occurrenceId: `source-occurrence-v1|sha256:${Qri.sha256({ role, material: "occurrence" })}`,
    role, contextIdentity, parentManifestId: chain.parentManifestId,
    listedContractId: chain.route.listedContractId });
  return Qri.createAcquisitionReceiptV3({ acquisition: chain.acquisition, intent: chain.intent,
    route: chain.route, acceptedInitialUrl: chain.route.canonicalUrl,
    acceptedFinalUrl: chain.route.canonicalUrl, fetchedAt: "2026-11-10T00:01:00.000Z",
    transportIdentity, parserInputIdentity, evidenceStatus,
    parentManifestId: chain.parentManifestId }, main);
}

function canonical({ contract = "2026-11", tradingDate = "2026-11-10",
  pageUpdatedAt = "2026-11-10T08:30:00+09:00", value = 100, role = "active" } = {}) {
  const sourceUrl = role === "active" ? Qri.ACTIVE_URL : "https://svc.qri.jp/jpx/nkopm/1";
  return { parserVersion: 2, schemaVersion: 2, source: Qri.SOURCE_ID, sourceUrl,
    pageUpdatedAt, tradingDate, openInterestAsOf: null, contract,
    gengetsu: contract.replace("-", ""), contractLabel: `${Number(contract.slice(5))}月限`,
    isActiveContract: true, lastTradingDate: `${contract}-13`, openInterestStatus: "available",
    availableContracts: [{ contract, label: `${Number(contract.slice(5))}月限`, url: sourceUrl,
      active: true, gengetsu: contract.replace("-", ""), lastTradingDate: `${contract}-13` }],
    records: [{ contract, optionType: "call", strike: 45000, published: true, value },
      { contract, optionType: "put", strike: 45000, published: true, value: value + 1 }] };
}

async function buildHistory(specifications) {
  let history = History.createEmptyQriOptionsHistory();
  for (const [index, spec] of specifications.entries()) {
    const data = canonical(spec), cache = await Parser.createCacheV2(data,
      spec.fetchedAt || `2026-11-10T00:0${index + 1}:00.000Z`),
      built = await History.createHistoryCandidate(cache), candidate = { ...built.candidate };
    if (spec.role) candidate.sourceEvidence = Q4.createBinding(receiptFor(spec.role));
    const merged = await History.mergeCandidate(history, candidate,
      { confirmedAt: spec.confirmedAt });
    assert.equal(merged.changed, true);
    history = merged.history;
  }
  return history;
}

async function query(history, knowledgeAt, overrides = {}) {
  return AsKnownAt.getQriRevisionAsKnownAt({ history,
    contract: overrides.contract || "2026-11",
    tradingDate: overrides.tradingDate || "2026-11-10", knowledgeAt });
}

const twoRevisionHistory = () => buildHistory([
  { value: 100, confirmedAt: "2026-11-10T01:00:00.000Z" },
  { value: 200, pageUpdatedAt: "2026-11-10T09:00:00+09:00",
    confirmedAt: "2026-11-10T02:00:00.000Z" }
]);

test("Q5-1 before first revision is explicitly not known yet", async () => {
  const result = await query(await twoRevisionHistory(), "2026-11-10T00:59:59.999Z");
  assert.deepEqual([result.status, result.reason, result.revision],
    ["unavailable", "not_known_yet", null]);
});

test("Q5-2 first revision is selected within its validity interval", async () => {
  const result = await query(await twoRevisionHistory(), "2026-11-10T01:30:00.000Z");
  assert.deepEqual([result.status, result.revision.canonical.records[0].value,
    result.validity.validFrom, result.validity.validTo],
  ["available", 100, "2026-11-10T01:00:00.000Z", "2026-11-10T02:00:00.000Z"]);
});

test("Q5-3 same-day correction before confirmation returns old revision", async () => {
  assert.equal((await query(await twoRevisionHistory(),
    "2026-11-10T01:59:59.999Z")).revision.canonical.records[0].value, 100);
});

test("Q5-4 exact correction boundary selects the new revision", async () => {
  assert.equal((await query(await twoRevisionHistory(),
    "2026-11-10T02:00:00.000Z")).revision.canonical.records[0].value, 200);
});

test("Q5-5 after correction selects the new revision", async () => {
  assert.equal((await query(await twoRevisionHistory(),
    "2026-11-10T05:00:00.000Z")).revision.canonical.records[0].value, 200);
});

test("Q5-6 three revisions select each exact half-open interval", async () => {
  const history = await buildHistory([
    { value: 100, confirmedAt: "2026-11-10T01:00:00Z" },
    { value: 200, pageUpdatedAt: "2026-11-10T09:00:00+09:00",
      confirmedAt: "2026-11-10T02:00:00Z" },
    { value: 300, pageUpdatedAt: "2026-11-10T10:00:00+09:00",
      confirmedAt: "2026-11-10T03:00:00Z" }
  ]);
  const values = [];
  for (const instant of ["2026-11-10T01:30:00Z", "2026-11-10T02:30:00Z",
    "2026-11-10T03:30:00Z"]) values.push((await query(history, instant)).revision
    .canonical.records[0].value);
  assert.deepEqual(values, [100, 200, 300]);
});

test("Q5-7 latest active revision remains valid for later instants", async () => {
  const result = await query(await twoRevisionHistory(), "2027-01-01T00:00:00Z");
  assert.deepEqual([result.revision.canonical.records[0].value, result.validity.validTo],
    [200, null]);
});

test("Q5-8 specified trading date never falls through to another entry", async () => {
  const history = await buildHistory([
    { tradingDate: "2026-11-09", value: 90, confirmedAt: "2026-11-09T01:00:00Z" },
    { tradingDate: "2026-11-10", value: 100, confirmedAt: "2026-11-10T01:00:00Z" }
  ]);
  const old = await query(history, "2026-11-10T05:00:00Z", { tradingDate: "2026-11-09" }),
    missing = await query(history, "2026-11-10T05:00:00Z", { tradingDate: "2026-11-08" });
  assert.deepEqual([old.revision.tradingDate, missing.reason], ["2026-11-09", "entry_not_found"]);
});

test("Q5-9 active contract Evidence role is retained", async () => {
  const history = await buildHistory([{ role: "active", value: 100,
    confirmedAt: "2026-11-10T01:00:00Z" }]), result = await query(history,
    "2026-11-10T02:00:00Z");
  assert.deepEqual([result.evidence.status, result.evidence.role], ["available", "active"]);
});

test("Q5-10 next contract is selected without parent network activity", async () => {
  const history = await buildHistory([{ role: "next", contract: "2026-12", value: 100,
    confirmedAt: "2026-11-10T01:00:00Z" }]), result = await query(history,
    "2026-11-10T02:00:00Z", { contract: "2026-12" });
  assert.deepEqual([result.status, result.evidence.role], ["available", "next"]);
});

test("Q5-11 Major SQ contract uses the same reader contract", async () => {
  const history = await buildHistory([{ role: "major_sq", contract: "2026-12", value: 100,
    confirmedAt: "2026-11-10T01:00:00Z" }]), result = await query(history,
    "2026-11-10T02:00:00Z", { contract: "2026-12" });
  assert.deepEqual([result.status, result.evidence.role], ["available", "major_sq"]);
});

test("Q5-12 pre-activation revision remains historically selectable", async () => {
  const result = await query(await twoRevisionHistory(), "2026-11-10T01:30:00Z");
  assert.deepEqual(result.evidence, { status: "unavailable", reason: "pre_activation",
    receiptVersion: null, acquisitionId: null, occurrenceId: null,
    contentSha256: null, role: null });
});

test("Q5-13 post-activation revision returns bounded Evidence identity", async () => {
  const history = await buildHistory([{ role: "active", value: 100,
    confirmedAt: "2026-11-10T01:00:00Z" }]), result = await query(history,
    "2026-11-10T02:00:00Z");
  assert.equal(result.evidence.receiptVersion, Qri.RECEIPT_V3_VERSION);
  assert.match(result.evidence.occurrenceId, /^source-occurrence-v1\|sha256:/);
  assert.equal(Object.hasOwn(result.evidence, "rawBytes"), false);
  assert.deepEqual(AsKnownAt.auditRevisionEvidence(result.revision,
    { resolveRevisionEvidence: () => ({ status: "available", reason: null }) }),
  { status: "available", reason: null });
});

test("Q5-14 overlapping intervals fail closed", async () => {
  const history = await twoRevisionHistory();
  history.entries[0].revisions[0].replacedAt = "2026-11-10T02:30:00.000Z";
  assert.deepEqual([(await query(history, "2026-11-10T02:15:00Z")).status,
    (await AsKnownAt.validateKnowledgeHistory(history)).reason],
  ["invalid", "knowledge_intervals_invalid"]);
});

test("Q5-15 replacedAt not after confirmedAt fails closed", async () => {
  const history = await twoRevisionHistory();
  history.entries[0].revisions[0].replacedAt = "2026-11-10T00:30:00.000Z";
  assert.equal((await query(history, "2026-11-10T01:30:00Z")).status, "invalid");
});

test("Q5-16 duplicate versionKey fails closed", async () => {
  const history = await twoRevisionHistory();
  history.entries[0].revisions[1].versionKey = history.entries[0].revisions[0].versionKey;
  assert.equal((await query(history, "2026-11-10T02:30:00Z")).status, "invalid");
});

test("Q5-17 inconsistent active pointer fails closed", async () => {
  const history = await twoRevisionHistory();
  history.entries[0].activeVersionKey = history.entries[0].revisions[0].versionKey;
  assert.equal((await query(history, "2026-11-10T02:30:00Z")).status, "invalid");
});

test("Q5-18 ambiguous or invalid timestamps reject", async () => {
  const history = await twoRevisionHistory();
  assert.equal((await query(history, "2026-11-10 02:30:00")).reason, "request_invalid");
  assert.equal((await query(history, "2026-02-30T02:30:00Z")).reason, "request_invalid");
  history.entries[0].revisions[0].confirmedAt = "2026-11-10T01:00:00";
  assert.equal((await query(history, "2026-11-10T02:30:00Z")).status, "invalid");
});

test("Q5-19 restart returns the same as-known-at result with readonly transactions", async () => {
  const history = await twoRevisionHistory(), databaseName = `${Store.DATABASE_NAME}-q5-${++databaseSequence}`,
    store = Store.createQriOptionsHistoryStore({ indexedDB, databaseName });
  assert.equal((await store.commitHistory(history)).saved, true);
  store.closeHistoryStore();
  const reopened = Store.createQriOptionsHistoryStore({ indexedDB, databaseName }),
    reader = AsKnownAt.createQriAsKnownAtReader({ historyStore: reopened });
  const db = await reopened.openHistoryStore(), original = db.transaction.bind(db);
  let readwrite = 0;
  db.transaction = (...args) => { if (args[1] === "readwrite") readwrite += 1; return original(...args); };
  const result = await reader.getQriRevisionAsKnownAt({ contract: "2026-11",
    tradingDate: "2026-11-10", knowledgeAt: "2026-11-10T01:30:00Z" });
  assert.deepEqual([result.status, result.revision.canonical.records[0].value, readwrite],
    ["available", 100, 0]);
});

test("Q5-20 P17 trading-date authority remains outside knowledge-time selection", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/qriTradingDateContext.js"), "utf8"),
    reader = fs.readFileSync(path.join(ROOT, "js/qriOptionsAsKnownAt.js"), "utf8");
  assert.doesNotMatch(source, /qriOptionsAsKnownAt|knowledgeAt/);
  assert.doesNotMatch(reader, /night_session_next_trading_date|date_context_unresolved/);
});

test("Q5-21 current/previous, Time Travel, Overall, Morning and Export remain disconnected", () => {
  for (const file of ["js/qriOptionsHistoryComparison.js", "js/qriTimeTravelProjection.js",
    "js/overallJudgmentV2.js", "js/morningV5FormalAuthority.js",
    "js/fullExportCollector.js", "index.html"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /qriOptionsAsKnownAt|getQriRevisionAsKnownAt/);
  }
});
