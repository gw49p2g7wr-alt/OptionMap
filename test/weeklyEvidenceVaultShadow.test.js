"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");

const W1 = require("../js/weeklyAcquisitionAuthorityContract.js");
const W2 = require("../js/weeklyRawTransportShadow.js");
const Contract = require("../js/weeklyEvidenceSetContract.js");
const Shadow = require("../js/weeklyEvidenceVaultShadow.js");
const SetStore = require("../js/storage/weeklyEvidenceSetStore.js");
const Evidence = require("../js/sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const WeeklyOptions = require("../js/weeklyOptions.js");

const REPO = path.resolve(__dirname, "..");
const DATE = "2026-11-06";
const MIME = W2.OBSERVED_JPX_MIME;
const NOW = new Date("2026-11-12T06:00:00.000Z");

function authority(suffix = "a") {
  return W1.createMainAuthority({ keyId: `weekly-w3-${suffix}`,
    secret: Buffer.alloc(32, suffix.charCodeAt(0)) });
}

function futuresRows(valid = true) {
  const rows = Array.from({ length: 8 }, () => []);
  rows[1][0] = "（ 2026年11月6日現在 ）";
  rows[2][0] = "2026年11月9日";
  if (valid) {
    rows[4] = ["＜日経225先物＞"];
    rows[5] = ["1", "2026年12月限月", "12724", "ＨＳＢＣ証券", "33,597",
      "12400", "野村証券", "33,492"];
  }
  return rows;
}

function optionsRows(valid = true) {
  const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
  if (!valid) return rows;
  rows[0][0] = WeeklyOptions.SOURCE_TITLE;
  rows[1][0] = "（ 2026年11月6日現在 ）";
  rows[2][0] = "2026年11月9日";
  rows[6][1] = "プット（2026年11月限月）";
  rows[6][11] = "コール（2026年11月限月）";
  [10, 25, 40, 55, 70].forEach((start, block) => {
    const strike = 65375 + block * 125;
    rows[start - 1][1] = strike;
    rows[start - 1][11] = strike;
    for (let index = 0; index < 15; index += 1) {
      rows[start - 1 + index][0] = index + 1;
      rows[start - 1 + index][10] = index + 1;
    }
  });
  rows[9][2] = "12479";
  rows[9][3] = "ＡＢＮクリアリン証券";
  rows[9][4] = 392;
  rows[9][15] = "11746";
  rows[9][16] = "ＵＢＳ証券";
  rows[9][17] = 250;
  return rows;
}

function xlsx(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

const FUTURES = xlsx(futuresRows());
const OPTIONS = xlsx(optionsRows());
const BAD_FUTURES = xlsx(futuresRows(false));
const BAD_OPTIONS = xlsx(optionsRows(false));

function listing(valid = true) {
  return new TextEncoder().encode(valid ? JSON.stringify({ UpdateDate: "2026/11/09 15:31",
    TableDatas: [{ TradeDate: "20261106",
      IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/" +
        "20261106_indexfut_oi_by_tp.xlsx",
      IndexOptions: "/automation/markets/derivatives/open-interest/files/2026/" +
        "20261106_nk225op_oi_by_tp.xlsx" }] }) : "{}");
}

function response(bytes, mime = MIME) {
  return new Response(bytes, { status: 200, headers: { "content-type": mime,
    "content-length": String(bytes.byteLength) } });
}

function transport(main, overrides = {}) {
  const urls = { listing: W1.createListingRoute(2026).canonicalUrl,
    futures: W1.createWorkbookRoute("weekly_futures_workbook", DATE).canonicalUrl,
    options: W1.createWorkbookRoute("weekly_options_workbook", DATE).canonicalUrl };
  return W2.createWeeklyRawTransportShadow({ authority: main, now: () => NOW,
    fetchImpl: async url => {
      if (url === urls.listing) return overrides.listing ? overrides.listing() : response(listing());
      if (url === urls.futures) return overrides.futures ? overrides.futures() : response(FUTURES);
      if (url === urls.options) return overrides.options ? overrides.options() : response(OPTIONS);
      return new Response(null, { status: 404 });
    } });
}

function harness(t, options = {}) {
  const main = options.main || authority(options.suffix || "a"),
    root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
      "optionmap-weekly-w3-"))),
    vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null }),
    setStore = SetStore.createIsolatedWeeklyEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }), transportShadow = transport(main, options.overrides),
    shadow = Shadow.createWeeklyEvidenceVaultShadow({ transportShadow, vault, setStore,
      authority: main, testHooks: options.rejectParserRole === undefined ? null :
        { rejectParserRole: options.rejectParserRole } }),
    intent = W1.createAcquisitionIntent({ requestKind: "explicit_source_date", targetDate: DATE });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { main, root, vault, setStore, transportShadow, shadow, intent };
}

async function captured(t, options = {}) {
  const h = harness(t, options), result = await h.shadow.capture({ intent: h.intent,
    requestId: options.requestId || "weekly-w3-request-1" });
  return { ...h, result, run: result.runs[0] };
}

function occurrenceFile(root, id) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, "occurrences",
    `${id.split(":").at(-1)}.json`);
}

function objectFile(root, digest) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, "objects",
    digest.slice(0, 2), digest);
}

function setFile(root, id) {
  return path.join(root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    SetStore.DIRECTORY_NAME, `${SetStore.setDigest(id)}.json`);
}

test("W3-1 shared listing raw is persisted exactly", async t => {
  const h = await captured(t), id = h.run.listingOccurrenceId,
    occurrence = h.vault.readOccurrence(id), bytes = h.vault.readRawBytes(occurrence.contentSha256);
  assert.deepEqual(new Uint8Array(bytes), listing());
  assert.deepEqual([occurrence.sourceId, occurrence.requestRole, occurrence.encoding],
    [Contract.LISTING_SOURCE_ID, Contract.LISTING_ROLE, "utf-8"]);
});

test("W3-2 Futures workbook raw is persisted exactly", async t => {
  const h = await captured(t), entry = h.run.futures.evidenceSet.roles[1];
  assert.deepEqual(new Uint8Array(h.vault.readRawBytes(entry.contentSha256)), FUTURES);
  assert.equal(h.vault.readOccurrence(entry.occurrenceId).sourceId,
    W1.ROLE_AUTHORITY.weekly_futures_workbook.sourceId);
});

test("W3-3 Options workbook raw is persisted exactly", async t => {
  const h = await captured(t), entry = h.run.options.evidenceSet.roles[1];
  assert.deepEqual(new Uint8Array(h.vault.readRawBytes(entry.contentSha256)), OPTIONS);
  assert.equal(h.vault.readOccurrence(entry.occurrenceId).sourceId,
    W1.ROLE_AUTHORITY.weekly_options_workbook.sourceId);
});

test("W3-4 listing content is globally SHA-deduplicated", async t => {
  const h = await captured(t), second = await h.shadow.capture({ intent: h.intent,
    requestId: "weekly-w3-request-2" });
  assert.equal(second.status, "available");
  assert.equal(second.diagnostics.contentWriteCount, 0);
  const listingSha = h.run.futures.evidenceSet.roles[0].contentSha256;
  assert.equal(h.vault.occurrencesByContentSha256(listingSha).length, 2);
});

test("W3-5 workbook content is deduplicated on reacquisition", async t => {
  const h = await captured(t), second = await h.shadow.capture({ intent: h.intent,
    requestId: "weekly-w3-request-2" });
  assert.equal(second.diagnostics.contentWriteCount, 0);
  for (const domain of [h.run.futures, h.run.options])
    assert.equal(h.vault.occurrencesByContentSha256(domain.evidenceSet.roles[1].contentSha256)
      .length, 2);
});

test("W3-6 same raw under a different run creates separate immutable occurrences", async t => {
  const h = await captured(t), second = await h.shadow.capture({ intent: h.intent,
    requestId: "weekly-w3-request-2" });
  assert.deepEqual([second.diagnostics.occurrenceWriteCount,
    h.vault.vaultStatus().occurrenceCount], [3, 6]);
  assert.equal(second.diagnostics.formalWriteCount, 0);
  assert.equal(second.diagnostics.historyWriteCount, 0);
});

test("W3-7 exact duplicate occurrence and set submission is write0", async t => {
  const h = await captured(t), duplicate = await h.shadow.capture({ intent: h.intent,
    requestId: "weekly-w3-request-1" });
  assert.deepEqual([duplicate.diagnostics.contentWriteCount,
    duplicate.diagnostics.occurrenceWriteCount, duplicate.diagnostics.evidenceSetWriteCount],
  [0, 0, 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 3);
});

test("W3-8 Futures domain Evidence Set is accepted in fixed role order", async t => {
  const h = await captured(t), set = h.run.futures.evidenceSet;
  assert.equal(h.run.futures.status, "available");
  assert.deepEqual(set.roles.map(value => value.role),
    [Contract.LISTING_ROLE, "weekly_futures_workbook"]);
  assert.equal(Contract.validateEvidenceSetAgainstVault(set, h.vault, h.main), true);
});

test("W3-9 Options domain Evidence Set is accepted in fixed role order", async t => {
  const h = await captured(t), set = h.run.options.evidenceSet;
  assert.equal(h.run.options.status, "available");
  assert.deepEqual(set.roles.map(value => value.role),
    [Contract.LISTING_ROLE, "weekly_options_workbook"]);
  assert.equal(Contract.validateEvidenceSetAgainstVault(set, h.vault, h.main), true);
});

test("W3-10 both domain sets reuse one listing occurrence", async t => {
  const h = await captured(t);
  assert.equal(h.run.futures.evidenceSet.roles[0].occurrenceId,
    h.run.options.evidenceSet.roles[0].occurrenceId);
  assert.equal(h.run.listingOccurrenceId,
    h.run.futures.evidenceSet.roles[0].occurrenceId);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 3);
});

test("W3-11 Futures failure leaves only Options set accepted", async t => {
  const h = await captured(t, { overrides: { futures: () => response(BAD_FUTURES) } });
  assert.deepEqual([h.result.status, h.run.futures.status, h.run.options.status],
    ["partial", "unavailable", "available"]);
  assert.equal(h.result.diagnostics.retainedOccurrenceCount, 3);
});

test("W3-12 Options failure leaves only Futures set accepted", async t => {
  const h = await captured(t, { overrides: { options: () => response(BAD_OPTIONS) } });
  assert.deepEqual([h.result.status, h.run.futures.status, h.run.options.status],
    ["partial", "available", "unavailable"]);
  assert.equal(h.result.diagnostics.retainedOccurrenceCount, 3);
});

test("W3-13 listing transport failure rejects both sets and writes raw0", async t => {
  const h = await captured(t, { overrides: { listing: () =>
    response(listing(), "application/json") } });
  assert.deepEqual([h.result.status, h.result.runs.length,
    h.result.diagnostics.retainedOccurrenceCount], ["unavailable", 0, 0]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 0);
});

test("W3-14 listing parser failure retains listing raw and accepts set0", async t => {
  const h = await captured(t, { overrides: { listing: () => response(listing(false)) } });
  assert.deepEqual([h.result.reason, h.result.runs.length,
    h.result.diagnostics.retainedOccurrenceCount], ["listing_parse_rejected", 0, 1]);
  assert.equal(h.vault.vaultStatus().occurrenceCount, 1);
});

test("W3-15 Futures parser rejection retains raw and does not affect Options", async t => {
  const h = await captured(t, { rejectParserRole: "weekly_futures_workbook" });
  assert.equal(h.run.futures.reason, "parser_binding_rejected");
  assert.equal(h.run.options.status, "available");
  assert.equal(h.vault.vaultStatus().occurrenceCount, 3);
});

test("W3-16 Options parser rejection retains raw and does not affect Futures", async t => {
  const h = await captured(t, { rejectParserRole: "weekly_options_workbook" });
  assert.equal(h.run.options.reason, "parser_binding_rejected");
  assert.equal(h.run.futures.status, "available");
  assert.equal(h.vault.vaultStatus().occurrenceCount, 3);
});

test("W3-17 mixed sourceDate invalidates the domain set", async t => {
  const h = await captured(t), mixed = structuredClone(h.run.futures.evidenceSet);
  mixed.sourceDate = "2026-10-30";
  assert.equal(Contract.validateEvidenceSet(mixed, h.main), false);
});

test("W3-18 mixed runId invalidates the domain set", async t => {
  const h = await captured(t), mixed = structuredClone(h.run.futures.evidenceSet);
  mixed.runId = h.run.options.evidenceSet.runId.replace(/.$/, "0");
  assert.equal(Contract.validateEvidenceSet(mixed, h.main), false);
});

test("W3-19 wrong role or sourceId cannot enter a Weekly domain set", async t => {
  const h = await captured(t), role = structuredClone(h.run.futures.evidenceSet),
    source = structuredClone(h.run.futures.evidenceSet);
  role.roles[1].role = "weekly_options_workbook";
  source.sourceId = "jpx-daily-derivatives-open-interest";
  assert.equal(Contract.validateEvidenceSet(role, h.main), false);
  assert.equal(Contract.validateEvidenceSet(source, h.main), false);
});

test("W3-20 setHash tamper is rejected", async t => {
  const h = await captured(t), tampered = structuredClone(h.run.options.evidenceSet);
  tampered.setHash = "0".repeat(64);
  assert.equal(Contract.validateEvidenceSet(tampered, h.main), false);
});

test("W3-21 raw tamper invalidates only the affected set", async t => {
  const h = await captured(t), entry = h.run.futures.evidenceSet.roles[1],
    file = objectFile(h.root, entry.contentSha256), bytes = fs.readFileSync(file);
  bytes[0] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.equal(h.shadow.resolve(h.run.futures.evidenceSet.evidenceSetId).reason,
    "evidence_set_integrity_invalid");
  assert.equal(h.shadow.resolve(h.run.options.evidenceSet.evidenceSetId).status, "available");
});

test("W3-22 restart verifies sets occurrences content and domain identities", async t => {
  const h = await captured(t), vault = Vault.createIsolatedVault({ root: h.root,
    targetEnvironment: "isolated_test", crashAt: null }),
    setStore = SetStore.createIsolatedWeeklyEvidenceSetStore({ root: h.root,
      targetEnvironment: "isolated_test" }), shadow = Shadow.createWeeklyEvidenceVaultShadow({
      transportShadow: h.transportShadow, vault, setStore, authority: h.main, testHooks: null });
  for (const domain of [h.run.futures, h.run.options]) {
    const resolved = shadow.resolve(domain.evidenceSet.evidenceSetId);
    assert.equal(resolved.status, "available");
    assert.equal(resolved.documents.length, 2);
    for (const document of resolved.documents)
      assert.equal(crypto.createHash("sha256").update(document.bytes).digest("hex"),
        document.occurrence.contentSha256);
  }
});

test("W3-23 cross-domain occurrence injection is rejected", async t => {
  const h = await captured(t), foreign = structuredClone(h.run.futures.evidenceSet);
  foreign.roles[1] = structuredClone(h.run.options.evidenceSet.roles[1]);
  assert.equal(Contract.validateEvidenceSet(foreign, h.main), false);
});

test("W3-24 renderer cannot inject raw bytes paths or occurrence constructors", () => {
  const source = fs.readFileSync(path.join(REPO, "js/weeklyEvidenceVaultShadow.js"), "utf8");
  assert.doesNotMatch(source, /ipcMain|ipcRenderer|webContents|rendererRecord|storagePath/);
  assert.match(source, /transportShadow\.acquireIntentForEvidence/);
  assert.throws(() => W1.createAcquisitionIntent({ requestKind: "latest_available",
    bytes: FUTURES }), /fields_invalid/);
});

test("W3-25 Weekly semantic history is unchanged and unreferenced", () => {
  const sources = ["js/weeklyEvidenceSetContract.js", "js/weeklyEvidenceVaultShadow.js",
    "js/storage/weeklyEvidenceSetStore.js"].map(file =>
    fs.readFileSync(path.join(REPO, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /weeklyFuturesHistory|weeklyOptionsHistory|localStorage|indexedDB/);
  assert.doesNotMatch(sources, /Overall|Morning|FullExport/);
});

test("W3-26 production path uses the Evidence pipeline and package closure includes W3", () => {
  const production = ["main.js", "preload.js", "index.html"].map(file =>
    fs.readFileSync(path.join(REPO, file), "utf8")).join("\n"),
    packageConfig = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.match(production, /weeklyEvidenceVaultShadow/);
  assert.match(production, /weeklyEvidenceSetStore/);
  assert.equal(packageConfig.build.files.includes("js/**/*"), true);
});

test("W3 occurrence and set record tampering remains fail-closed", async t => {
  const h = await captured(t), set = h.run.futures.evidenceSet,
    occurrencePath = occurrenceFile(h.root, set.roles[1].occurrenceId),
    occurrence = JSON.parse(fs.readFileSync(occurrencePath, "utf8"));
  occurrence.occurrence.runId = "weekly-run-v1|sha256:" + "0".repeat(64);
  fs.writeFileSync(occurrencePath, `${JSON.stringify(occurrence)}\n`);
  assert.equal(h.shadow.resolve(set.evidenceSetId).reason, "evidence_set_integrity_invalid");
});

test("W3 stored set tampering is rejected on reopen", async t => {
  const h = await captured(t), set = h.run.options.evidenceSet,
    file = setFile(h.root, set.evidenceSetId), value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.roles[1].occurrenceId = h.run.futures.evidenceSet.roles[1].occurrenceId;
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  assert.equal(h.shadow.resolve(set.evidenceSetId).reason, "evidence_set_integrity_invalid");
});

test("W3 source policy and exact raw identities remain the generic Vault authority", async t => {
  const h = await captured(t);
  for (const domain of [h.run.futures, h.run.options]) {
    for (const entry of domain.evidenceSet.roles) {
      const metadata = h.vault.readContentMetadata(entry.contentSha256);
      assert.equal(metadata.contentObject.sha256, entry.contentSha256);
      assert.equal(metadata.contentObject.byteLength, entry.byteLength);
      assert.equal(Evidence.verifyContentBytes(h.vault.readRawBytes(entry.contentSha256),
        entry.contentSha256, entry.byteLength).valid, true);
    }
  }
});
