"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWeeklyListingAcquisitionDiagnostics } = require(
  "../js/security/weeklyListingAcquisitionDiagnostics.js"
);

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const policySource = fs.readFileSync(
  path.join(root, "js/security/networkUrlPolicy.js"), "utf8"
);

function tracker() {
  let tick = 0;
  return createWeeklyListingAcquisitionDiagnostics({
    now: () => `2026-08-31T05:00:0${tick++}.000Z`
  });
}

const validUrl =
  "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_2026.json";

test("initial stateはruntime-only未開始", () => {
  const state = tracker().getState();
  assert.equal(state.status, "not_started");
  assert.equal(state.networkStarted, false);
  assert.equal(state.accepted, false);
});

test("valid requested URL identityはraw URLを保持しない", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  const state = diagnostics.getState();
  assert.equal(state.requestedValidation, "accepted");
  assert.deepEqual(state.requestedUrlClass, {
    hostClass: "jpx", pathnameClass: "open_interest_year_json", year: "2026"
  });
  assert.equal(JSON.stringify(state).includes(validUrl), false);
});

test("requested validator rejectのphaseとerrorCodeを保持する", () => {
  const diagnostics = tracker();
  diagnostics.begin("https://user:secret@evil.example/private?token=x");
  diagnostics.requestedValidated({ ok: false, errorCode: "invalid_credentials" });
  const state = diagnostics.getState();
  assert.equal(state.status, "failed");
  assert.equal(state.phase, "requested_url_validation");
  assert.equal(state.reason, "requested_validation_failed");
  assert.equal(state.requestedValidation, "rejected");
  assert.equal(state.errorCode, "invalid_credentials");
  assert.doesNotMatch(JSON.stringify(state), /secret|token|private/);
});

test("network startとnetwork failureを区別する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  assert.equal(diagnostics.getState().networkStarted, true);
  diagnostics.fail("network_started", "network_failed");
  assert.equal(diagnostics.getState().reason, "network_failed");
});

test("response receivedとfinal URL validを記録する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(200);
  diagnostics.finalValidated({ ok: true }, validUrl);
  const state = diagnostics.getState();
  assert.equal(state.responseReceived, true);
  assert.equal(state.httpStatus, 200);
  assert.equal(state.finalValidation, "accepted");
  assert.deepEqual(state.finalUrlShape, {
    hostname: "www.jpx.co.jp",
    pathname: "/automation/markets/derivatives/open-interest/json/open_interest_2026.json",
    hasPort: false,
    hasQuery: false,
    hasHash: false,
    hasCredentials: false
  });
});

test("redirect禁止成功時はallowlist済みrequested URLをauthorityとして記録する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(200);
  diagnostics.redirectProtected(validUrl);
  const state = diagnostics.getState();
  assert.equal(state.finalValidation, "accepted");
  assert.equal(state.redirectPolicy, "error");
  assert.equal(state.finalUrlAuthority, "requested_url_no_redirect");
  assert.equal(state.finalUrlShape.hostname, "www.jpx.co.jp");
  assert.equal(state.finalUrlShape.pathname,
    "/automation/markets/derivatives/open-interest/json/open_interest_2026.json");
});

test("final URL rejectをrequested rejectと区別する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(302);
  diagnostics.finalValidated(
    { ok: false, errorCode: "invalid_redirect" },
    "https://user:secret@redirect.example:8443/moved/listing.json?token=x#private"
  );
  const state = diagnostics.getState();
  assert.equal(state.phase, "final_url_validation");
  assert.equal(state.reason, "final_validation_failed");
  assert.equal(state.finalValidation, "rejected");
  assert.equal(state.errorCode, "invalid_redirect");
  assert.deepEqual(state.finalUrlShape, {
    hostname: "redirect.example",
    pathname: "/moved/listing.json",
    hasPort: true,
    hasQuery: true,
    hasHash: true,
    hasCredentials: true
  });
  assert.doesNotMatch(JSON.stringify(state), /secret|token|private|user:|8443/);
});

test("HTTP failureはstatusを保持してbodyを読まない", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(503);
  diagnostics.finalValidated({ ok: true }, validUrl);
  diagnostics.httpChecked(503);
  diagnostics.fail("http_status_checked", "http_error", null, { httpStatus: 503 });
  const state = diagnostics.getState();
  assert.equal(state.reason, "http_error");
  assert.equal(state.httpStatusChecked, true);
  assert.equal(state.httpStatus, 503);
  assert.equal(state.bodyRead, false);
});

test("body read・JSON parse・acceptedの全phaseを記録する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(200);
  diagnostics.finalValidated({ ok: true }, validUrl);
  diagnostics.httpChecked(200);
  diagnostics.bodyRead();
  diagnostics.jsonParsed();
  diagnostics.accepted();
  const state = diagnostics.getState();
  assert.equal(state.status, "accepted");
  assert.equal(state.phase, "accepted");
  assert.equal(state.bodyRead, true);
  assert.equal(state.jsonParsed, true);
  assert.equal(state.accepted, true);
  assert.ok(state.completedAt);
});

test("JSON parse failureはbody read成功後として保持する", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.responseReceived(200);
  diagnostics.finalValidated({ ok: true }, validUrl);
  diagnostics.httpChecked(200);
  diagnostics.bodyRead();
  diagnostics.fail("json_parsed", "json_parse_failed");
  const state = diagnostics.getState();
  assert.equal(state.reason, "json_parse_failed");
  assert.equal(state.bodyRead, true);
  assert.equal(state.jsonParsed, false);
});

test("getterはdetachedかつdeep frozen", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  const first = diagnostics.getState();
  const second = diagnostics.getState();
  assert.notEqual(first, second);
  assert.notEqual(first.requestedUrlClass, second.requestedUrlClass);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.requestedUrlClass), true);
  assert.throws(() => { first.status = "tampered"; }, TypeError);
  assert.equal(diagnostics.getState().status, "pending");
});

test("getterはside-effect freeでfetch・retry・storageを持たない", () => {
  const source = fs.readFileSync(
    path.join(root, "js/security/weeklyListingAcquisitionDiagnostics.js"), "utf8"
  );
  assert.doesNotMatch(source,
    /\bfetch\s*\(|net\.fetch|setTimeout|setInterval|localStorage|indexedDB|retry/);
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  const before = JSON.stringify(diagnostics.getState());
  diagnostics.getState();
  diagnostics.getState();
  assert.equal(JSON.stringify(diagnostics.getState()), before);
});

test("mainは1回のshared year listing acquisitionをphase順に観測する", () => {
  const block = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("fetch-jpx-open-interest-json"'),
    mainSource.indexOf('ipcMain.handle("get-weekly-listing-acquisition-diagnostics"')
  );
  for (const token of ["begin(jsonUrl)", "requestedValidated", "networkStarted",
    "responseReceived", "redirectProtected", "httpChecked", "bodyRead",
    "jsonParsed", "accepted"]) assert.match(block, new RegExp(token.replace(/[()]/g, "\\$&")));
  assert.equal((block.match(/net\.fetch/g) || []).length, 1);
  assert.doesNotMatch(block, /retry|setTimeout|setInterval/);
  assert.match(block, /redirect: "error"/);
  assert.match(block, /redirectProtected\(requestedUrl\)/);
  assert.doesNotMatch(block, /response\.url/);
  assert.ok(block.indexOf("redirectProtected(requestedUrl)") <
    block.indexOf("response.text()"));
});

test("redirectまたはnetwork rejectはbody未読のfail-closed", () => {
  const diagnostics = tracker();
  diagnostics.begin(validUrl);
  diagnostics.requestedValidated({ ok: true });
  diagnostics.networkStarted();
  diagnostics.fail("network_started", "network_or_redirect_rejected",
    "fetch_rejected", { redirectPolicy: "error" });
  const state = diagnostics.getState();
  assert.equal(state.status, "failed");
  assert.equal(state.reason, "network_or_redirect_rejected");
  assert.equal(state.redirectPolicy, "error");
  assert.equal(state.responseReceived, false);
  assert.equal(state.bodyRead, false);
  assert.equal(state.jsonParsed, false);
});

test("read-only IPC getterはruntime snapshotだけを返す", () => {
  assert.match(mainSource,
    /ipcMain\.handle\("get-weekly-listing-acquisition-diagnostics"[\s\S]*?weeklyListingDiagnostics\.getState\(\)/);
});

test("既存fallbackとSecurity 0D policyを変更しない", () => {
  assert.match(mainSource, /safeIpcFailure\(error, "JPX週次JSONを取得できませんでした"\)/);
  assert.match(mainSource, /networkUrlPolicy\.validateOpenInterestJsonUrl/);
  assert.match(policySource,
    /open-interest\\\/json\\\/open_interest_20\\d\{2\}\\\.json/);
});

test("observabilityはMorning・Formal・history/storageへ接続しない", () => {
  const source = fs.readFileSync(
    path.join(root, "js/security/weeklyListingAcquisitionDiagnostics.js"), "utf8"
  );
  assert.doesNotMatch(source,
    /Morning|Formal|LastValid|history|persist|localStorage|indexedDB|document\.|window\./);
});
