"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Participants = require("../js/participantAcquisitionAuthorityContract.js");

const SECRET = "participants-main-authority-fixture-secret-32-bytes-minimum";
const authority = () => Participants.createMainAuthority({
  keyId: "participants-main-session-v1", secret: SECRET
});
function changed(value, mutate) {
  const result = structuredClone(value);
  mutate(result);
  return result;
}

function sourceUrls(date) {
  return Object.fromEntries(Participants.ROLE_ORDER.map(role =>
    [role, Participants.canonicalWorkbookUrl(role, date)]));
}

function explicitChain(options = {}) {
  const main = options.authority || authority();
  const date = options.date || "2026-11-10";
  const intent = Participants.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: date
  });
  const discovery = Participants.createOfficialDiscovery({ intent,
    discoveryKind: "official_monthly_listing",
    discoveryRequestId: options.discoveryRequestId || "discovery-explicit-1",
    officialUrl: Participants.monthlyListingUrl(date), sourceDate: date,
    sourceUrls: sourceUrls(date), fallbackAttempt: null });
  const manifest = Participants.createAcquisitionManifest({ intent, discovery,
    requestId: options.requestId || "request-explicit-1" }, main);
  const acquisitions = Participants.createWorkbookAcquisitions(manifest, main);
  const completeSet = Participants.createCompleteSet({ manifest, acquisitions }, main);
  return { authority: main, date, intent, discovery, manifest, acquisitions, completeSet };
}

function parserResult(chain, role = "dayAuction") {
  const acquisition = chain.completeSet.acquisitions.find(item => item.role === role);
  return { manifestId: chain.manifest.manifestId, setIdentity: chain.completeSet.setIdentity,
    acquisitionId: acquisition.acquisitionId, runId: chain.manifest.runId,
    sourceFamily: Participants.SOURCE_FAMILY, sourceId: Participants.SOURCE_ID,
    sourceDate: chain.date, role, sourceUrl: acquisition.canonicalUrl,
    ...Participants.PARSER_AUTHORITY, canonicalSha256: "a".repeat(64) };
}

test("P1-1 latest intent is bounded and carries no renderer route authority", () => {
  const intent = Participants.createAcquisitionIntent({ requestKind: "latest_available" });
  assert.equal(Participants.validateAcquisitionIntent(intent), true);
  assert.deepEqual([intent.requestKind, intent.targetDatePolicy, intent.targetDate,
    intent.startDate, intent.endDate],
  ["latest_available", "official_latest_then_bounded_probe", null, null, null]);
  for (const field of ["url", "host", "path", "suffix", "role", "sourceId"])
    assert.equal(Object.hasOwn(intent, field), false);
});

test("P1-2 explicit source date and historical range intents are exact", () => {
  const explicit = Participants.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: "2026-11-10"
  });
  const range = Participants.createAcquisitionIntent({
    requestKind: "historical_backfill_range", startDate: "2026-10-01", endDate: "2026-11-10"
  });
  assert.equal(Participants.validateAcquisitionIntent(explicit), true);
  assert.equal(Participants.validateAcquisitionIntent(range), true);
  assert.throws(() => Participants.createAcquisitionIntent({
    requestKind: "historical_backfill_range", startDate: "2026-11-10", endDate: "2026-10-01"
  }), /intent_invalid/);
});

test("P1-3 arbitrary URL is outside every renderer intent", () => {
  for (const input of [
    { requestKind: "latest_available", url: "https://www.jpx.co.jp/forged.xlsx" },
    { requestKind: "explicit_source_date", targetDate: "2026-11-10", url: "https://evil.test/x" },
    { requestKind: "historical_backfill_range", startDate: "2026-11-01",
      endDate: "2026-11-10", url: "https://evil.test/x" }
  ]) assert.throws(() => Participants.createAcquisitionIntent(input), /intent_fields_invalid/);
});

test("P1-4 arbitrary workbook suffix rejects", () => {
  const intent = Participants.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: "2026-11-10"
  });
  const urls = sourceUrls("2026-11-10");
  urls.dayAuction = urls.dayAuction.replace("whole_day.xlsx", "forged.xlsx");
  assert.throws(() => Participants.createOfficialDiscovery({ intent,
    discoveryKind: "official_monthly_listing", discoveryRequestId: "discovery-1",
    officialUrl: Participants.monthlyListingUrl("2026-11-10"), sourceDate: "2026-11-10",
    sourceUrls: urls, fallbackAttempt: null }), /discovery_routes_invalid/);
});

test("P1-5 wrong host, path, query, hash, credentials and port reject", () => {
  const route = Participants.createRouteDescriptor("dayAuction", "2026-11-10");
  for (const url of ["https://evil.test" + route.path,
    "https://www.jpx.co.jp/wrong/" + route.filename,
    route.canonicalUrl + "?x=1", route.canonicalUrl + "#x",
    route.canonicalUrl.replace("https://", "https://u:p@"),
    route.canonicalUrl.replace("www.jpx.co.jp", "www.jpx.co.jp:8443")]) {
    assert.equal(Participants.validateRouteDescriptor(changed(route,
      value => { value.canonicalUrl = url; })), false);
  }
});

test("P1-6 date and month-directory mismatch reject", () => {
  const route = Participants.createRouteDescriptor("dayJnet", "2026-11-10");
  const wrongDirectory = changed(route, value => {
    value.path = value.path.replace("/202611/", "/202610/");
    value.canonicalUrl = value.canonicalUrl.replace("/202611/", "/202610/");
  });
  const wrongFilenameDate = changed(route, value => {
    value.filename = value.filename.replace("20261110", "20261111");
    value.path = value.path.replace("20261110", "20261111");
    value.canonicalUrl = value.canonicalUrl.replace("20261110", "20261111");
  });
  assert.equal(Participants.validateRouteDescriptor(wrongDirectory), false);
  assert.equal(Participants.validateRouteDescriptor(wrongFilenameDate), false);
});

test("P1-7 exact four main-owned roles form one accepted set", () => {
  const chain = explicitChain();
  assert.deepEqual(chain.manifest.routes.map(item => item.role), Participants.ROLE_ORDER);
  assert.deepEqual(chain.acquisitions.map(item => item.role), Participants.ROLE_ORDER);
  assert.equal(Participants.validateCompleteSet(chain.completeSet, chain.manifest,
    chain.authority), true);
});

test("P1-8 missing role rejects complete-set construction", () => {
  const chain = explicitChain();
  assert.throws(() => Participants.createCompleteSet({ manifest: chain.manifest,
    acquisitions: chain.acquisitions.slice(0, 3) }, chain.authority), /set_input_invalid/);
});

test("P1-9 duplicate role rejects complete-set construction", () => {
  const chain = explicitChain();
  const duplicate = [chain.acquisitions[0], chain.acquisitions[0],
    chain.acquisitions[2], chain.acquisitions[3]];
  assert.throws(() => Participants.createCompleteSet({ manifest: chain.manifest,
    acquisitions: duplicate }, chain.authority), /set_acquisition_invalid/);
});

test("P1-10 mixed source date rejects", () => {
  const chain = explicitChain();
  const mixed = changed(chain.acquisitions[0], value => {
    value.sourceDate = "2026-11-11";
  });
  assert.equal(Participants.validateWorkbookAcquisition(mixed, chain.manifest,
    chain.authority), false);
  assert.throws(() => Participants.createCompleteSet({ manifest: chain.manifest,
    acquisitions: [mixed, ...chain.acquisitions.slice(1)] }, chain.authority),
  /set_acquisition_invalid/);
});

test("P1-11 mixed run identity rejects", () => {
  const first = explicitChain({ requestId: "request-first" });
  const second = explicitChain({ requestId: "request-second" });
  assert.notEqual(first.manifest.runId, second.manifest.runId);
  assert.throws(() => Participants.createCompleteSet({ manifest: first.manifest,
    acquisitions: [first.acquisitions[0], ...second.acquisitions.slice(1)] }, first.authority),
  /set_acquisition_invalid/);
});

test("P1-12 network completion order cannot change complete-set identity", () => {
  const chain = explicitChain();
  const reversed = Participants.createCompleteSet({ manifest: chain.manifest,
    acquisitions: [...chain.acquisitions].reverse() }, chain.authority);
  assert.equal(reversed.setIdentity, chain.completeSet.setIdentity);
  assert.deepEqual(reversed.acquisitions.map(item => item.role), Participants.ROLE_ORDER);
});

test("P1-13 main-issued manifest integrity binds intent, discovery, run and routes", () => {
  const chain = explicitChain();
  assert.equal(Participants.validateAcquisitionManifest(chain.manifest, chain.authority,
    { intent: chain.intent, discovery: chain.discovery }), true);
  assert.match(chain.manifest.runId, /^participants-run-v1\|sha256:[0-9a-f]{64}$/);
  assert.match(chain.manifest.authoritySignature, /^[0-9a-f]{64}$/);
  assert.deepEqual(chain.manifest.parserAuthority, Participants.PARSER_AUTHORITY);
});

test("P1-14 manifest tampering or forged main authority rejects", () => {
  const chain = explicitChain();
  const tampered = changed(chain.manifest, value => {
    value.routes[0].role = "dayJnet";
  });
  const impostor = Participants.createMainAuthority({ keyId: chain.authority.keyId,
    secret: "different-participants-main-authority-secret-32-bytes" });
  assert.equal(Participants.validateAcquisitionManifest(tampered, chain.authority), false);
  assert.equal(Participants.validateAcquisitionManifest(chain.manifest, impostor), false);
});

test("P1-15 renderer sourceId spoof is outside intent and invalidates authority records", () => {
  assert.throws(() => Participants.createAcquisitionIntent({ requestKind: "latest_available",
    sourceId: "jp-jpx-derivatives-open-interest-daily" }), /intent_fields_invalid/);
  const chain = explicitChain();
  assert.equal(Participants.validateAcquisitionManifest(changed(chain.manifest,
    value => { value.sourceId = "jp-jpx-derivatives-open-interest-daily"; }),
  chain.authority), false);
});

test("P1-16 renderer bytes, raw hash and Vault path injection are impossible", () => {
  for (const extra of [{ bytes: Buffer.from("forged") }, { sha256: "a".repeat(64) },
    { vaultPath: "/tmp/forged" }]) {
    assert.throws(() => Participants.createAcquisitionIntent({
      requestKind: "latest_available", ...extra }), /intent_fields_invalid/);
  }
});

test("P1-17 JPX cross-domain identities cannot enter Participants authority", () => {
  const chain = explicitChain();
  for (const sourceId of ["jp-jpx-derivatives-open-interest-daily",
    "jp-jpx-derivatives-calendar", "jpx-weekly-futures", "qri-nikkei225-options"]) {
    assert.equal(Participants.validateWorkbookAcquisition(changed(chain.acquisitions[0],
      value => { value.sourceId = sourceId; }), chain.manifest, chain.authority), false);
  }
  assert.deepEqual([chain.manifest.sourceFamily, chain.manifest.sourceId],
    ["participants", "jpx-daily-participant-volume"]);
});

test("P1-18 parser result binds to exact role, date, URL, run and parser authority", () => {
  const chain = explicitChain();
  const result = Participants.bindParserResult({ manifest: chain.manifest,
    completeSet: chain.completeSet, result: parserResult(chain, "nightJnet") }, chain.authority);
  assert.equal(result.accepted, true);
  assert.deepEqual([result.binding.role, result.binding.sourceDate,
    result.binding.sourceUrl, result.binding.runId, result.binding.parserAuthority],
  ["nightJnet", chain.date, Participants.canonicalWorkbookUrl("nightJnet", chain.date),
    chain.manifest.runId, Participants.PARSER_AUTHORITY]);
});

test("P1-19 wrong parser role, date, URL or parser version rejects", () => {
  const chain = explicitChain();
  const base = parserResult(chain);
  for (const result of [
    changed(base, value => { value.role = "dayJnet"; }),
    changed(base, value => { value.sourceDate = "2026-11-11"; }),
    changed(base, value => { value.sourceUrl = Participants.canonicalWorkbookUrl(
      "dayAuction", "2026-11-11"); }),
    changed(base, value => { value.parserVersion = 2; })
  ]) assert.equal(Participants.bindParserResult({ manifest: chain.manifest,
    completeSet: chain.completeSet, result }, chain.authority).accepted, false);
});

test("P1-20 unknown future contract versions fail closed", () => {
  const chain = explicitChain();
  assert.equal(Participants.validateAcquisitionIntent(changed(chain.intent,
    value => { value.contractVersion = "participants-acquisition-intent-v2"; })), false);
  assert.equal(Participants.validateRouteDescriptor(changed(chain.manifest.routes[0],
    value => { value.contractVersion = "participants-workbook-route-v2"; })), false);
  assert.equal(Participants.validateDiscoveryResult(changed(chain.discovery,
    value => { value.contractVersion = "participants-official-discovery-v2"; })), false);
  assert.equal(Participants.validateAcquisitionManifest(changed(chain.manifest,
    value => { value.contractVersion = "participants-acquisition-manifest-v2"; }),
  chain.authority), false);
  assert.equal(Participants.validateCompleteSet(changed(chain.completeSet,
    value => { value.contractVersion = "participants-acquisition-set-v2"; }),
  chain.manifest, chain.authority), false);
});

test("official latest discovery selects the newest observed date only when all roles exist", () => {
  const intent = Participants.createAcquisitionIntent({ requestKind: "latest_available" });
  const older = Object.values(sourceUrls("2026-11-09"));
  const latest = Object.values(sourceUrls("2026-11-10"));
  const result = Participants.discoverLatestParticipantsSourceSet({ intent, indexFacts: {
    indexUrl: Participants.CURRENT_INDEX_URL, hrefs: [...latest].reverse().concat(older),
    discoveryRequestId: "latest-discovery-1"
  } });
  assert.equal(result.accepted, true);
  assert.equal(result.discovery.sourceDate, "2026-11-10");
  assert.deepEqual(result.discovery.routes.map(item => item.role), Participants.ROLE_ORDER);

  const partial = Participants.discoverLatestParticipantsSourceSet({ intent, indexFacts: {
    indexUrl: Participants.CURRENT_INDEX_URL, hrefs: latest.slice(0, 3).concat(older),
    discoveryRequestId: "latest-discovery-2"
  } });
  assert.deepEqual([partial.accepted, partial.reason, partial.sourceDate],
    [false, "latest_source_set_incomplete", "2026-11-10"]);
});

test("fallback policy is main-owned, dayAuction-only and bounded to ten attempts", () => {
  assert.deepEqual(Participants.FALLBACK_POLICY, {
    contractVersion: Participants.FALLBACK_POLICY_VERSION, owner: "main", enabled: true,
    maxAttempts: 10, probeRole: "dayAuction",
    dateStep: "previous_calendar_day_skip_weekends",
    routeFamily: Participants.ROUTE_FAMILY
  });
  const intent = Participants.createAcquisitionIntent({ requestKind: "latest_available" });
  const accepted = Participants.createOfficialDiscovery({ intent,
    discoveryKind: "bounded_day_probe", discoveryRequestId: "fallback-1",
    officialUrl: Participants.canonicalWorkbookUrl("dayAuction", "2026-11-10"),
    sourceDate: "2026-11-10", sourceUrls: sourceUrls("2026-11-10"), fallbackAttempt: 10 });
  assert.equal(Participants.validateDiscoveryResult(accepted), true);
  assert.throws(() => Participants.createOfficialDiscovery({ intent,
    discoveryKind: "bounded_day_probe", discoveryRequestId: "fallback-2",
    officialUrl: Participants.canonicalWorkbookUrl("dayAuction", "2026-11-10"),
    sourceDate: "2026-11-10", sourceUrls: sourceUrls("2026-11-10"), fallbackAttempt: 11 }),
  /discovery_invalid/);
});

test("historical range discovery accepts only an official monthly listing date inside its intent", () => {
  const intent = Participants.createAcquisitionIntent({
    requestKind: "historical_backfill_range", startDate: "2026-10-01", endDate: "2026-10-31"
  });
  const discovery = Participants.createOfficialDiscovery({ intent,
    discoveryKind: "official_monthly_listing", discoveryRequestId: "range-discovery-1",
    officialUrl: Participants.monthlyListingUrl("2026-10-15"), sourceDate: "2026-10-15",
    sourceUrls: sourceUrls("2026-10-15"), fallbackAttempt: null });
  assert.equal(Participants.discoveryMatchesIntent(discovery, intent), true);
  assert.throws(() => Participants.createOfficialDiscovery({ intent,
    discoveryKind: "official_monthly_listing", discoveryRequestId: "range-discovery-2",
    officialUrl: Participants.monthlyListingUrl("2026-11-01"), sourceDate: "2026-11-01",
    sourceUrls: sourceUrls("2026-11-01"), fallbackAttempt: null }),
  /discovery_input_invalid/);
});

test("P1 remains a pure unwired contract with no transport, storage, IPC or renderer activation", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root,
    "js/participantAcquisitionAuthorityContract.js"), "utf8");
  for (const forbidden of ["fetch(", "net.fetch", "ipcMain", "ipcRenderer", "localStorage",
    "indexedDB", "source-evidence-vault", "OptionMapParticipantHistory"])
    assert.equal(source.includes(forbidden), false, forbidden);
  for (const runtime of ["main.js", "preload.js", "index.html"])
    assert.equal(fs.readFileSync(path.join(root, runtime), "utf8")
      .includes("participantAcquisitionAuthorityContract"), false, runtime);
  assert.equal(require(path.join(root, "package.json")).build.files.includes("js/**/*"), true);
});
