"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Weekly = require("../js/weeklyAcquisitionAuthorityContract.js");

const SECRET = "weekly-main-authority-fixture-secret-32-bytes-minimum";
const authority = () => Weekly.createMainAuthority({
  keyId: "weekly-main-session-v1", secret: SECRET
});
const changed = (value, mutate) => {
  const result = structuredClone(value);
  mutate(result);
  return result;
};

function explicitChain(options = {}) {
  const main = options.authority || authority();
  const date = options.date || "2026-11-06";
  const intent = Weekly.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: date
  });
  const listingResult = Weekly.createListingResult({
    listingYear: Number(date.slice(0, 4)),
    tradeDates: options.tradeDates || ["2026-10-30", date]
  });
  const discovery = Weekly.createDiscovery({ intent, listingResult,
    selectedTradeDate: date });
  const manifest = Weekly.createManifest({ intent, discovery,
    requestId: options.requestId || "weekly-request-explicit-1" }, main);
  return { authority: main, date, intent, listingResult, discovery, manifest };
}

test("W1-1 latest_available intent is bounded and route-free", () => {
  const intent = Weekly.createAcquisitionIntent({ requestKind: "latest_available" });
  assert.equal(Weekly.validateAcquisitionIntent(intent), true);
  assert.deepEqual([intent.requestKind, intent.targetDatePolicy, intent.targetDate,
    intent.startDate, intent.endDate],
  ["latest_available", "official_listing_latest_trade_date", null, null, null]);
  for (const field of ["url", "landingUrl", "listingUrl", "workbookUrl", "filename",
    "sourceId", "role", "bytes", "sha256", "vaultPath"])
    assert.equal(Object.hasOwn(intent, field), false);
});

test("W1-2 explicit_source_date intent accepts only an exact ISO source date", () => {
  const intent = Weekly.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: "2026-11-06"
  });
  assert.equal(Weekly.validateAcquisitionIntent(intent), true);
  assert.throws(() => Weekly.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: "2026-02-30"
  }), /intent_invalid/);
});

test("W1-3 historical_backfill_range intent is finite and ordered", () => {
  const intent = Weekly.createAcquisitionIntent({
    requestKind: "historical_backfill_range", startDate: "2026-10-01", endDate: "2026-11-06"
  });
  assert.equal(Weekly.validateAcquisitionIntent(intent), true);
  assert.throws(() => Weekly.createAcquisitionIntent({
    requestKind: "historical_backfill_range", startDate: "2026-11-06", endDate: "2026-10-01"
  }), /intent_invalid/);
});

test("W1-4 arbitrary landing URL is outside renderer intent and invalidates discovery", () => {
  assert.throws(() => Weekly.createAcquisitionIntent({ requestKind: "latest_available",
    landingUrl: "https://evil.test/index.html" }), /intent_fields_invalid/);
  const chain = explicitChain();
  assert.equal(Weekly.validateDiscovery(changed(chain.discovery,
    value => { value.landingUrl = "https://evil.test/index.html"; }), chain.intent,
  chain.listingResult), false);
});

test("W1-5 arbitrary listing URL cannot enter listing authority", () => {
  const route = Weekly.createListingRoute(2026);
  for (const url of ["https://evil.test/open_interest_2026.json",
    "http://www.jpx.co.jp" + route.path,
    route.canonicalUrl + "?x=1", route.canonicalUrl + "#x",
    route.canonicalUrl.replace("https://", "https://u:p@"),
    route.canonicalUrl.replace("www.jpx.co.jp", "www.jpx.co.jp:8443")])
    assert.equal(Weekly.validateListingRoute(changed(route,
      value => { value.canonicalUrl = url; })), false);
});

test("W1-6 arbitrary workbook URL cannot enter workbook authority", () => {
  const route = Weekly.createWorkbookRoute("weekly_futures_workbook", "2026-11-06");
  for (const url of ["https://evil.test/forged.xlsx",
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/forged.xlsx",
    route.canonicalUrl + "?download=1", route.canonicalUrl + "#x"])
    assert.equal(Weekly.validateWorkbookRoute(changed(route,
      value => { value.canonicalUrl = url; })), false);
});

test("W1-7 Futures source identity is fixed", () => {
  const route = Weekly.createWorkbookRoute("weekly_futures_workbook", "2026-11-06");
  assert.deepEqual([route.sourceFamily, route.sourceId, route.role], ["weekly",
    "jpx-weekly-index-futures-open-interest", "weekly_futures_workbook"]);
});

test("W1-8 Options source identity is fixed", () => {
  const route = Weekly.createWorkbookRoute("weekly_options_workbook", "2026-11-06");
  assert.deepEqual([route.sourceFamily, route.sourceId, route.role], ["weekly",
    "jpx-weekly-nikkei225-options-open-interest", "weekly_options_workbook"]);
});

test("W1-9 valid yearly listing route is deterministic", () => {
  const first = Weekly.createListingRoute(2026);
  const second = Weekly.createListingRoute(2026);
  assert.equal(Weekly.validateListingRoute(first), true);
  assert.equal(first.routeIdentity, second.routeIdentity);
  assert.equal(first.canonicalUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/" +
    "open_interest_2026.json");
});

test("W1-10 wrong listing year, directory or filename rejects", () => {
  const route = Weekly.createListingRoute(2026);
  for (const invalid of [
    changed(route, value => { value.listingYear = 2025; }),
    changed(route, value => {
      value.path = value.path.replace("/open-interest/json/", "/open-interest/files/");
      value.canonicalUrl = value.canonicalUrl.replace("/open-interest/json/",
        "/open-interest/files/");
    }),
    changed(route, value => { value.filename = "open_interest_2025.json"; })
  ]) assert.equal(Weekly.validateListingRoute(invalid), false);
});

test("W1-11 valid Futures route binds date, year directory and suffix", () => {
  const route = Weekly.createWorkbookRoute("weekly_futures_workbook", "2026-11-06");
  assert.equal(Weekly.validateWorkbookRoute(route), true);
  assert.equal(route.canonicalUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/" +
    "20261106_indexfut_oi_by_tp.xlsx");
});

test("W1-12 valid Options route binds date, year directory and suffix", () => {
  const route = Weekly.createWorkbookRoute("weekly_options_workbook", "2026-11-06");
  assert.equal(Weekly.validateWorkbookRoute(route), true);
  assert.equal(route.canonicalUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/" +
    "20261106_nk225op_oi_by_tp.xlsx");
});

test("W1-13 sourceDate and filename or year-directory mismatch rejects", () => {
  const route = Weekly.createWorkbookRoute("weekly_futures_workbook", "2026-11-06");
  const wrongDate = changed(route, value => {
    value.filename = value.filename.replace("20261106", "20261113");
    value.path = value.path.replace("20261106", "20261113");
    value.canonicalUrl = value.canonicalUrl.replace("20261106", "20261113");
  });
  const wrongYear = changed(route, value => {
    value.path = value.path.replace("/2026/", "/2025/");
    value.canonicalUrl = value.canonicalUrl.replace("/2026/", "/2025/");
  });
  assert.equal(Weekly.validateWorkbookRoute(wrongDate), false);
  assert.equal(Weekly.validateWorkbookRoute(wrongYear), false);
});

test("W1-14 Futures and Options suffixes cannot be swapped", () => {
  const futures = Weekly.createWorkbookRoute("weekly_futures_workbook", "2026-11-06");
  const swapped = changed(futures, value => {
    value.suffix = Weekly.ROLE_AUTHORITY.weekly_options_workbook.suffix;
    value.filename = value.filename.replace("indexfut_oi_by_tp", "nk225op_oi_by_tp");
    value.path = value.path.replace("indexfut_oi_by_tp", "nk225op_oi_by_tp");
    value.canonicalUrl = value.canonicalUrl.replace("indexfut_oi_by_tp", "nk225op_oi_by_tp");
  });
  assert.equal(Weekly.validateWorkbookRoute(swapped), false);
});

test("W1-15 discovery identity deterministically binds listing result and TradeDate", () => {
  const intent = Weekly.createAcquisitionIntent({ requestKind: "latest_available" });
  const listingResult = Weekly.createListingResult({ listingYear: 2026,
    tradeDates: ["2026-10-30", "2026-11-06"] });
  const first = Weekly.createDiscovery({ intent, listingResult,
    selectedTradeDate: "2026-11-06" });
  const second = Weekly.createDiscovery({ intent, listingResult,
    selectedTradeDate: "2026-11-06" });
  assert.equal(first.discoveryIdentity, second.discoveryIdentity);
  assert.deepEqual([first.sourceDate, first.tradeDate, first.listingYear],
    ["2026-11-06", "2026-11-06", 2026]);
  assert.throws(() => Weekly.createDiscovery({ intent, listingResult,
    selectedTradeDate: "2026-10-30" }), /discovery_input_invalid/);
});

test("W1-16 shared run identity binds intent, discovery, date, roles and request", () => {
  const chain = explicitChain();
  const repeated = Weekly.createManifest({ intent: chain.intent, discovery: chain.discovery,
    requestId: "weekly-request-explicit-1" }, chain.authority);
  const another = Weekly.createManifest({ intent: chain.intent, discovery: chain.discovery,
    requestId: "weekly-request-explicit-2" }, chain.authority);
  assert.equal(chain.manifest.runId, repeated.runId);
  assert.notEqual(chain.manifest.runId, another.runId);
  assert.match(chain.manifest.runId, /^weekly-run-v1\|sha256:[0-9a-f]{64}$/);
});

test("W1-17 Futures and Options have separate domain acquisition identities", () => {
  const chain = explicitChain();
  const futures = chain.manifest.futuresDescriptor;
  const options = chain.manifest.optionsDescriptor;
  assert.notEqual(futures.acquisitionId, options.acquisitionId);
  assert.equal(futures.runId, options.runId);
  assert.equal(Weekly.validateDomainAcquisition(futures, chain.manifest.runId), true);
  assert.equal(Weekly.validateDomainAcquisition(options, chain.manifest.runId), true);
});

test("W1-18 network completion order is outside deterministic manifest identity", () => {
  const chain = explicitChain();
  assert.deepEqual(chain.manifest.expectedRoles, Weekly.ROLES);
  assert.equal(Object.hasOwn(chain.manifest, "completionOrder"), false);
  assert.throws(() => Weekly.createManifest({ intent: chain.intent, discovery: chain.discovery,
    requestId: "weekly-request-extra", completionOrder: [...Weekly.ROLES].reverse()
  }, chain.authority), /manifest_input_invalid/);
});

test("W1-19 signed main-issued manifest validates with exact context", () => {
  const chain = explicitChain();
  assert.equal(Weekly.validateManifest(chain.manifest, chain.authority,
    { intent: chain.intent, discovery: chain.discovery }), true);
  assert.match(chain.manifest.authoritySignature, /^[0-9a-f]{64}$/);
  assert.deepEqual(chain.manifest.dateAuthority, Weekly.DATE_AUTHORITY);
  assert.deepEqual(chain.manifest.parserAuthorities, Weekly.PARSER_AUTHORITIES);
});

test("W1-20 manifest tampering rejects every bound authority field", () => {
  const chain = explicitChain();
  const mutations = [
    value => { value.sourceDate = "2026-11-13"; },
    value => { value.futuresDescriptor.sourceId = "forged-source"; },
    value => { value.optionsDescriptor.role = "weekly_futures_workbook"; },
    value => { value.futuresDescriptor.route.path = "/forged.xlsx"; },
    value => { value.runId = value.optionsDescriptor.acquisitionId.replace(
      "weekly-domain-acquisition-v1", "weekly-run-v1"); },
    value => { value.discoveryIdentity = value.intentId.replace("weekly-intent-v1",
      "weekly-discovery-v1"); },
    value => { value.contractVersion = "weekly-acquisition-manifest-v2"; }
  ];
  for (const mutate of mutations)
    assert.equal(Weekly.validateManifest(changed(chain.manifest, mutate), chain.authority), false);
  const impostor = Weekly.createMainAuthority({ keyId: chain.authority.keyId,
    secret: "different-weekly-authority-secret-at-least-32-bytes" });
  assert.equal(Weekly.validateManifest(chain.manifest, impostor), false);
});

test("W1-21 renderer sourceId spoof rejects", () => {
  assert.throws(() => Weekly.createAcquisitionIntent({ requestKind: "latest_available",
    sourceId: "jpx-daily-participant-volume" }), /intent_fields_invalid/);
  const chain = explicitChain();
  assert.equal(Weekly.validateDomainAcquisition(changed(chain.manifest.futuresDescriptor,
    value => { value.sourceId = "jpx-daily-participant-volume"; }), chain.manifest.runId), false);
});

test("W1-22 renderer bytes, hash, role and Vault path injection are impossible", () => {
  for (const extra of [{ bytes: Buffer.from("forged") }, { rawSha256: "a".repeat(64) },
    { role: "weekly_futures_workbook" }, { vaultPath: "/tmp/forged" },
    { evidenceSetId: "forged" }])
    assert.throws(() => Weekly.createAcquisitionIntent({ requestKind: "latest_available", ...extra }),
      /intent_fields_invalid/);
});

test("W1-23 Futures failure does not block Options promotion capability", () => {
  const result = Weekly.evaluatePromotionBoundary({ discoveryStatus: "accepted",
    futuresStatus: "futures_route_invalid", optionsStatus: "accepted" });
  assert.deepEqual(result, { futures: { canPromote: false, reason: "futures_route_invalid" },
    options: { canPromote: true, reason: null } });
});

test("W1-24 Options failure does not block Futures promotion capability", () => {
  const result = Weekly.evaluatePromotionBoundary({ discoveryStatus: "accepted",
    futuresStatus: "accepted", optionsStatus: "options_route_invalid" });
  assert.deepEqual(result, { futures: { canPromote: true, reason: null },
    options: { canPromote: false, reason: "options_route_invalid" } });
  const shared = Weekly.evaluatePromotionBoundary({ discoveryStatus: "listing_invalid",
    futuresStatus: "accepted", optionsStatus: "accepted" });
  assert.equal(shared.futures.canPromote, false);
  assert.equal(shared.options.canPromote, false);
});

test("W1-25 cross-domain source identities reject", () => {
  const chain = explicitChain();
  for (const sourceId of ["jpx-daily-participant-volume",
    "jp-jpx-derivatives-open-interest-daily", "jp-jpx-derivatives-calendar",
    "qri-nikkei225-options"])
    assert.equal(Weekly.validateDomainAcquisition(changed(chain.manifest.optionsDescriptor,
      value => { value.sourceId = sourceId; }), chain.manifest.runId), false);
});

test("W1-26 unknown contract versions fail closed", () => {
  const chain = explicitChain();
  assert.equal(Weekly.validateAcquisitionIntent(changed(chain.intent,
    value => { value.contractVersion = "weekly-acquisition-intent-v2"; })), false);
  assert.equal(Weekly.validateListingRoute(changed(chain.discovery.listingRoute,
    value => { value.contractVersion = "weekly-listing-route-v2"; })), false);
  assert.equal(Weekly.validateWorkbookRoute(changed(chain.manifest.futuresDescriptor.route,
    value => { value.contractVersion = "weekly-workbook-route-v2"; })), false);
  assert.equal(Weekly.validateDiscovery(changed(chain.discovery,
    value => { value.contractVersion = "weekly-official-discovery-v2"; }), chain.intent,
  chain.listingResult), false);
  assert.equal(Weekly.validateManifest(changed(chain.manifest,
    value => { value.contractVersion = "weekly-acquisition-manifest-v2"; }),
  chain.authority), false);
});

test("TradeDate, publishedDate, fetchedAt and confirmedAt remain separate authorities", () => {
  assert.deepEqual(Weekly.DATE_AUTHORITY, {
    sourceDate: "official_listing_trade_date",
    publishedDate: "workbook_declared_publication_date",
    fetchedAt: "main_transport_observation_time",
    confirmedAt: "semantic_revision_acceptance_time"
  });
  const chain = explicitChain();
  assert.equal(chain.discovery.sourceDate, chain.discovery.tradeDate);
  for (const field of ["publishedDate", "fetchedAt", "confirmedAt"])
    assert.equal(Object.hasOwn(chain.discovery, field), false);
});

test("current and previous Weekly history semantics are preserved as declarations only", () => {
  assert.deepEqual(Weekly.HISTORY_SEMANTICS, {
    current: "latest_source_date_active_revision",
    previous: "prior_distinct_source_date_active_revision",
    sameDatePriorRevision: "correction_history_not_previous_week"
  });
});

test("pure failure classifications are bounded and contain no transport errors", () => {
  assert.deepEqual(Weekly.FAILURE_REASONS, ["discovery_failed", "listing_invalid",
    "source_date_unavailable", "futures_route_invalid", "options_route_invalid",
    "manifest_invalid"]);
  assert.throws(() => Weekly.evaluatePromotionBoundary({ discoveryStatus: "network_timeout",
    futuresStatus: "accepted", optionsStatus: "accepted" }), /promotion_status_invalid/);
});

test("W1 remains pure and unwired with no transport, storage, IPC or Evidence activation", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root,
    "js/weeklyAcquisitionAuthorityContract.js"), "utf8");
  for (const forbidden of ["fetch(", "net.fetch", "ipcMain", "ipcRenderer", "localStorage",
    "indexedDB", "source-evidence-vault", "OptionMapWeeklyFuturesHistory",
    "OptionMapWeeklyOptionsHistory"])
    assert.equal(source.includes(forbidden), false, forbidden);
  for (const runtime of ["main.js", "preload.js", "index.html"])
    assert.equal(fs.readFileSync(path.join(root, runtime), "utf8")
      .includes("weeklyAcquisitionAuthorityContract"), false, runtime);
  assert.equal(require(path.join(root, "package.json")).build.files.includes("js/**/*"), true);
});
