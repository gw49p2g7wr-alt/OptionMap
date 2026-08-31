"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const policy = require("../js/security/networkUrlPolicy.js");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

function accepted(validator, url) {
  assert.equal(validator(url).ok, true, url);
}

function rejected(validator, url, errorCode) {
  const result = validator(url);
  assert.equal(result.ok, false, url);
  if (errorCode) assert.equal(result.errorCode, errorCode, url);
}

test("QRI default・specific・referenceのexact URLだけを許可する", () => {
  accepted(policy.validateQriUrl, "https://svc.qri.jp/jpx/nkopm/");
  accepted(policy.validateQriUrl, "https://svc.qri.jp/jpx/nkopm/202609");
  accepted(policy.validateQriUrl, "https://svc.qri.jp/jpx/nkopm/202610/");
  rejected(policy.validateQriUrl, "https://svc.qri.jp/jpx/other", "invalid_path");
});

test("全policyはHTTP・wrong host・credentials・port・query・hashを拒否する", () => {
  const validator = policy.validateQriUrl;
  rejected(validator, "http://svc.qri.jp/jpx/nkopm/", "invalid_protocol");
  rejected(validator, "https://evil.example/jpx/nkopm/", "invalid_host");
  rejected(validator, "https://user:pass@svc.qri.jp/jpx/nkopm/", "invalid_credentials");
  rejected(validator, "https://svc.qri.jp:443/jpx/nkopm/", "invalid_port");
  rejected(validator, "https://svc.qri.jp/jpx/nkopm/?x=1", "invalid_query");
  rejected(validator, "https://svc.qri.jp/jpx/nkopm/#x", "invalid_hash");
});

test("encoded path・double slash・非stringを拒否する", () => {
  rejected(policy.validateQriUrl, "https://svc.qri.jp/jpx/nkopm/%2Fetc", "invalid_path");
  rejected(policy.validateQriUrl, "https://svc.qri.jp/jpx//nkopm/", "invalid_path");
  rejected(policy.validateQriUrl, "", "invalid_url");
  rejected(policy.validateQriUrl, null, "invalid_url");
});

test("renderer指定JPX pageはexact 2件だけ", () => {
  accepted(policy.validateJpxPageUrl,
    "https://www.jpx.co.jp/markets/derivatives/open-interest/index.html");
  accepted(policy.validateJpxPageUrl,
    "https://www.jpx.co.jp/markets/derivatives/participant-volume/index.html");
  rejected(policy.validateJpxPageUrl, "https://www.jpx.co.jp/");
  rejected(policy.validateJpxPageUrl,
    "https://www.jpx.co.jp/markets/derivatives/quotes/index.html");
});

test("JPX internal warm-upはrenderer target policyから分離する", () => {
  accepted(policy.validateJpxInternalUrl, "https://www.jpx.co.jp/");
  accepted(policy.validateJpxInternalUrl,
    "https://www.jpx.co.jp/markets/derivatives/quotes/index.html");
  rejected(policy.validateJpxInternalUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/index.html");
});

test("open-interest year JSONのexact pattern", () => {
  accepted(policy.validateOpenInterestJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_2025.json");
  accepted(policy.validateOpenInterestJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_2026.json");
  rejected(policy.validateOpenInterestJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/other_2026.json");
  rejected(policy.validateOpenInterestJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_2026.json?x=1");
});

test("participant monthly listと実在月YYYYMMだけを許可する", () => {
  accepted(policy.validateParticipantJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/json/participant-volume_monthlylist.json");
  accepted(policy.validateParticipantJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/json/participant_volume_202608.json");
  rejected(policy.validateParticipantJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/json/participant_volume_202613.json");
  rejected(policy.validateParticipantJsonUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/json/other.json");
});

test("Weekly Futures・Options Excel fixtureを許可する", () => {
  accepted(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260828_indexfut_oi_by_tp.xlsx");
  accepted(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260828_nk225op_oi_by_tp.xlsx");
});

test("Participant Excelは公式4種類だけを許可する", () => {
  const base = "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202608/20260828_";
  for (const suffix of [
    "volume_by_participant_whole_day.xlsx",
    "volume_by_participant_whole_day_J-NET.xlsx",
    "volume_by_participant_night.xlsx",
    "volume_by_participant_night_J-NET.xlsx"
  ]) accepted(policy.validateExcelUrl, `${base}${suffix}`);
  rejected(policy.validateExcelUrl, `${base}volume_by_participant_other.xlsx`);
});

test("Excelはarbitrary file・wrong directory・invalid date・directory mismatchを拒否する", () => {
  rejected(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/anything.xlsx");
  rejected(policy.validateExcelUrl,
    "https://www.jpx.co.jp/other/20260828_indexfut_oi_by_tp.xlsx");
  rejected(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260230_indexfut_oi_by_tp.xlsx",
    "invalid_date");
  rejected(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2025/20260828_indexfut_oi_by_tp.xlsx",
    "invalid_date");
  rejected(policy.validateExcelUrl,
    "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202607/20260828_volume_by_participant_night.xlsx",
    "invalid_date");
});

test("Excelもhost・protocol・credentials・port・query/hashを拒否する", () => {
  const path = "/automation/markets/derivatives/open-interest/files/2026/20260828_indexfut_oi_by_tp.xlsx";
  rejected(policy.validateExcelUrl, `http://www.jpx.co.jp${path}`, "invalid_protocol");
  rejected(policy.validateExcelUrl, `https://evil.example${path}`, "invalid_host");
  rejected(policy.validateExcelUrl, `https://u:p@www.jpx.co.jp${path}`, "invalid_credentials");
  rejected(policy.validateExcelUrl, `https://www.jpx.co.jp:443${path}`, "invalid_port");
  rejected(policy.validateExcelUrl, `https://www.jpx.co.jp${path}?x=1`, "invalid_query");
  rejected(policy.validateExcelUrl, `https://www.jpx.co.jp${path}#x`, "invalid_hash");
});

test("requested/finalの同一policy検証で不正redirectを拒否する", () => {
  const requested = "https://svc.qri.jp/jpx/nkopm/";
  assert.equal(policy.validateFinalUrl(policy.validateQriUrl,
    requested, "https://svc.qri.jp/jpx/nkopm/202609").ok, true);
  const redirect = policy.validateFinalUrl(policy.validateQriUrl,
    requested, "https://evil.example/");
  assert.equal(redirect.ok, false);
  assert.equal(redirect.errorCode, "invalid_redirect");
});

test("listing JSONはredirect禁止、Excelはbody読取前にresponse.urlを再検証する", () => {
  const openBlock = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("fetch-jpx-open-interest-json"'),
    mainSource.indexOf('ipcMain.handle("fetch-jpx-participant-json"')
  );
  const excelBlock = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("download-daytrading-excel"'),
    mainSource.indexOf('console.log(\n  "OpenAI APIキー')
  );
  assert.match(openBlock, /net\.fetch\(requestedUrl, \{[\s\S]*?redirect: "error"/);
  assert.doesNotMatch(openBlock, /response\.url/);
  assert.ok(openBlock.indexOf("redirectProtected(requestedUrl)") <
    openBlock.indexOf("response.text()"));
  assert.ok(openBlock.indexOf("response.text()") < openBlock.indexOf("JSON.parse(body)"));
  assert.ok(excelBlock.indexOf("response.url") < excelBlock.indexOf("response.arrayBuffer()"));
});

test("QRI/JPX hidden windowはfinal URL検証後だけDOMを抽出しpopupを拒否する", () => {
  assert.match(mainSource, /installHiddenWindowPolicy\(fetchWindow\)/);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  const qri = mainSource.slice(mainSource.indexOf('ipcMain.handle("fetch-option-page"'),
    mainSource.indexOf('ipcMain.handle("fetch-daytrading-page"'));
  assert.ok(qri.indexOf("finalValidation") < qri.indexOf("executeJavaScript"));
  assert.match(qri, /securityError\("invalid_redirect"\)/);
});

test("main windowはexact index reloadだけ許可しexternal/local別fileとpopupを拒否する", () => {
  const create = mainSource.slice(mainSource.indexOf("function createWindow()"));
  assert.match(create, /pathToFileURL\([\s\S]*index\.html/);
  assert.match(create, /webContents\.on\("will-navigate"/);
  assert.match(create, /targetUrl !== mainDocumentUrl/);
  assert.match(create, /event\.preventDefault\(\)/);
  assert.match(create, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.doesNotMatch(mainSource, /shell\.openExternal/);
});

test("error contractはraw credentials・stack・filesystem pathをrendererへ返さない", () => {
  assert.match(mainSource, /safeIpcFailure/);
  assert.doesNotMatch(mainSource, /return\s*\{\s*success:\s*false,\s*error:\s*error\.message/);
  assert.doesNotMatch(mainSource, /stack:\s*error/);
  assert.doesNotMatch(mainSource, /error:\s*excelUrl|error:\s*pageUrl|error:\s*jsonUrl/);
});

test("Security 0DはMorning・storage/schema・renderer semanticsへ配線しない", () => {
  const helperSource = fs.readFileSync(
    path.join(root, "js/security/networkUrlPolicy.js"), "utf8"
  );
  assert.doesNotMatch(helperSource,
    /Morning|localStorage|indexedDB|schemaVersion|Formal|LastValid|document\.|window\./);
  assert.doesNotMatch(mainSource, /OptionMapMorningBaselineV4Capture/);
});
