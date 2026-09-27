"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const R = require("../js/marketCalendarIsolated/blsFixedRoute.js"), P = require("../js/marketCalendarIsolated/blsFixedParser.js"),
  A = require("../js/marketCalendarIsolated/blsFixedAssessment.js"), F = require("./fixtures/marketCalendar/blsFixedFixture.js"),
  C = require("../js/marketCalendar/marketEventCanonicalizer.js"), Legacy = require("../js/marketCalendarShadow/representativeParsers.js");
const assess = (a = F.acquisition(), date = "2026-09-26") => A.assess({ acquisitionResult: a, assessmentDateJst: date });
const response = (body, options = {}) => new Response(body, { headers: { "content-type": "text/html", ...options.headers }, status: options.status || 200 });
const binding = role => ({ sourceId: R.SOURCE_ID, role, requestedUrl: R.ROLES.find(r => r.role === role).url });
const utf8 = value => new TextEncoder().encode(value);
test("non-encoding http-equiv never vetoes undeclared UTF8 policy", () => {
  for (const meta of ['<meta http-equiv="x-ua-compatible" content="IE=Edge">',
    '<META HTTP-EQUIV="X-UA-COMPATIBLE" CONTENT="IE=Edge">',
    "<meta content='IE=Edge' http-equiv='x-ua-compatible'>",
    '<meta http-equiv="refresh" content="30">']) {
    const result = R.decode(utf8(meta + "<p>release</p>"), "text/html", binding("cpi"));
    assert.equal(result.ok, true); assert.equal(result.evidence.resolutionBasis, "source_policy_strict_utf8");
    assert.equal(result.evidence.html5MetaCharset, null); assert.equal(result.evidence.legacyMetaCharset, null);
  }
});
test("Content-Type charset candidates still veto fallback including malformed and late values", () => {
  for (const meta of ['<meta http-equiv="content-type" content="text/html; charset=">',
    '<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">',
    '<meta content="text/html; charset=" http-equiv="content-type">',
    ' '.repeat(1100) + '<meta http-equiv="content-type" content="text/html; charset=utf-8">'])
    assert.equal(R.decode(utf8(meta), "text/html", binding("cpi")).ok, false);
});
test("undeclared UTF8 is scoped to each exact BLS document and retains absent evidence", () => {
  for (const r of R.ROLES) {
    const d = R.decode(utf8("<html>統計</html>"), "text/html", binding(r.role));
    assert.equal(d.ok, true); assert.equal(d.evidence.resolutionBasis, "source_policy_strict_utf8");
    for (const k of ["httpCharset", "bom", "html5MetaCharset", "legacyMetaCharset"]) assert.equal(d.evidence[k], null);
    assert.equal(d.evidence.declarationState, "absent"); assert.equal(d.evidence.strictUtf8Validated, true);
    assert.deepEqual(d.warnings, ["encoding_undeclared_strict_utf8_source_policy"]);
  }
});
test("encoding fallback rejects other sources, paths, roles, MIME and missing binding", () => {
  for (const b of [undefined, { ...binding("cpi"), sourceId: "jp-boj-calendar" },
    { ...binding("cpi"), role: "jolts" }, { ...binding("cpi"), requestedUrl: R.ROLES[0].url + "?x=1" }])
    assert.equal(R.decode(utf8("x"), "text/html", b).ok, false);
  assert.equal(R.decode(utf8("x"), "text/plain", binding("cpi")).ok, false);
});
test("undeclared malformed and truncated UTF8 fail closed", () => {
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xe3, 0x81])])
    assert.equal(R.decode(bytes, "text/html", binding("cpi")).reason, "encoding_utf8_strict_decode_failed");
});
test("HTTP BOM and early meta preserve existing decoder result, never fallback", () => {
  const E = require("../js/marketCalendarShadow/htmlEncoding.js");
  for (const [bytes, type] of [[utf8("x"), "text/html;charset=utf-8"],
    [new Uint8Array([0xef, 0xbb, 0xbf, 120]), "text/html"],
    [utf8('<meta charset="utf-8">x'), "text/html"],
    [utf8('<meta http-equiv="Content-Type" content="text/html; charset=utf-8">x'), "text/html"],
    [utf8('<meta content="text/html; charset=utf-8" http-equiv="Content-Type">'), "text/html"]])
    assert.deepEqual(R.decode(bytes, type, binding("cpi")), E.decodeHtml(bytes, type));
});
test("late and malformed declarations only veto, never choose encoding", () => {
  for (const html of [" ".repeat(1100) + '<meta charset="utf-8">', '<meta charset="">',
    '<meta charset=>', '<meta charset',
    '<meta charset="shift_jis">']) assert.equal(R.decode(utf8(html), "text/html", binding("cpi")).ok, false);
  for (const type of ['text/html; charset=""', "text/html; charset=shift_jis"])
    assert.equal(R.decode(utf8("x"), type, binding("cpi")).ok, false);
});
test("declared conflict and declared invalid bytes never reach fallback", () => {
  assert.equal(R.decode(utf8('<meta charset="iso-8859-1">'), "text/html;charset=utf-8", binding("cpi")).ok, false);
  assert.equal(R.decode(new Uint8Array([0xc3, 0x28]), "text/html;charset=utf-8", binding("cpi")).ok, false);
});
test("encoding evidence changes neither eventKey nor semantic hash", async () => {
  const declared = await P.buildDocument("cpi", F.document("cpi"), F.acquisition().fetchedAt);
  const undeclared = await P.buildDocument("cpi", F.document("cpi", F.html("cpi").replace('<meta charset="utf-8">', "")), F.acquisition().fetchedAt);
  assert.equal(undeclared.parseOutcome, "success");
  assert.notDeepEqual(declared.encodingEvidence, undeclared.encodingEvidence);
  assert.equal(undeclared.encodingEvidence.resolutionBasis, "source_policy_strict_utf8");
  assert.deepEqual(declared.canonicalRecords.map(e => [e.eventKey, e.canonicalContentHash]),
    undeclared.canonicalRecords.map(e => [e.eventKey, e.canonicalContentHash]));
  assert.notEqual(declared.canonicalRecords[0].acquisitionEvidenceKey, undeclared.canonicalRecords[0].acquisitionEvidenceKey);
  // Identical bytes: only HTTP encoding evidence differs (not content, schedule or identity).
  const sameBytes = F.document("cpi", F.html("cpi").replace('<meta charset="utf-8">', ""));
  const httpDeclared = await P.buildDocument("cpi", { ...sameBytes, contentType: "text/html; charset=utf-8" }, F.acquisition().fetchedAt);
  assert.notDeepEqual(httpDeclared.encodingEvidence, undeclared.encodingEvidence);
  assert.deepEqual(httpDeclared.canonicalRecords.map(e => [e.eventKey, e.canonicalContentHash]),
    undeclared.canonicalRecords.map(e => [e.eventKey, e.canonicalContentHash]));
});
test("complete: four roles, multiple months, fixed evidence, 42-day operational coverage", async () => {
  const a = await assess(); assert.equal(a.outcome, "complete"); assert.equal(a.coverageState, "sufficient");
  assert.equal(a.candidateCount, 13); assert.equal(a.roleCoverage.flatMap(r => r.windowEvents).length, 6);
  assert.equal(a.absenceAuthority, "none"); assert.equal(a.disappearance, "not_evaluated");
  for (const d of a.documents) for (const e of d.canonicalRecords) assert.equal(e.acquisitionEvidence.sourceUrl, d.requestedUrl);
});
test("deterministic row/document ordering and repeated assessment", async () => {
  const first = await assess(), input = F.acquisition();
  input.documents = R.ROLES.map(r => F.document(r.role, F.html(r.role, [...F.rows[r.role]].reverse()))).reverse();
  const second = await assess(input); assert.equal(first.candidateIdentity, second.candidateIdentity);
  assert.deepEqual(first.canonicalRecords.map(e => e.revisionKey), second.canonicalRecords.map(e => e.revisionKey));
  assert.deepEqual(await assess(), first);
});
test("year turn and DST inherit America/New_York, never host offset", async () => {
  const d = F.document("cpi", F.html("cpi", [["December 2026", "Jan. 12, 2027", "08:30 AM"], ["January 2027", "Feb. 12, 2027", "08:30 AM"]]));
  const r = await P.buildDocument("cpi", d, "2026-09-26T00:00:00.000Z");
  assert.equal(r.parseOutcome, "success"); assert.equal(r.rows[0].referencePeriod, "2026-12");
  assert.equal(r.timezoneBasis, "inherited_bls_source_contract");
});
test("existing four monthly fixtures retain eventKey and semantic hash; evidence changes", async () => {
  const old = Legacy.parseBls(fs.readFileSync(path.join(__dirname, "fixtures/marketCalendar/blsMonthlyCalendar.html"), "utf8"), {
    sourceId: R.SOURCE_ID, sourceUrl: "https://www.bls.gov/schedule/", fetchedAt: F.acquisition().fetchedAt,
    parserId: R.shadowRegistry.getSource(R.SOURCE_ID).parserId, parserVersion: 1, rawContentHash: "a".repeat(64) });
  const fresh = await assess();
  for (const record of old.records) { const legacy = await C.canonicalize(record); assert.equal(legacy.ok, true);
    const next = fresh.canonicalRecords.find(e => e.eventKey === legacy.event.eventKey); assert.ok(next);
    assert.equal(next.canonicalContentHash, legacy.event.canonicalContentHash);
    assert.notEqual(next.acquisitionEvidenceKey, legacy.event.acquisitionEvidenceKey); }
});
test("one source run can link four document evidence URLs without schema changes", async () => {
  const H = require("../js/marketCalendarHistory/historyContract.js"), result = await assess();
  for (const e of result.canonicalRecords) assert.equal(H.validateEvidenceShape({ ...e.acquisitionEvidence,
    eventKey: e.eventKey, revisionKey: e.revisionKey, acquisitionEvidenceKey: e.acquisitionEvidenceKey,
    acquisitionEvidenceHash: e.acquisitionEvidenceHash, runId: "isolated-four-document-run",
    acceptedAt: "2026-09-26T00:01:00.000Z" }).valid, true);
  assert.equal(new Set(result.canonicalRecords.map(e => e.acquisitionEvidence.sourceUrl)).size, 4);
});
for (const reason of ["network_failure", "http_status_rejected"]) test(`partial ${reason} preserves successful roles`, async () => {
  const a = F.acquisition(); a.documents[3] = { role: "jolts", requestedUrl: R.ROLES[3].url, fetchOutcome: "failure", reason };
  const result = await assess(a); assert.equal(result.outcome, "partial"); assert.equal(result.candidateCount, 9);
  assert.deepEqual(result.failedRoles, ["jolts"]); assert.equal(result.coverageState, "partial");
  assert.equal(result.roleCoverage[3].disappearance, "not_evaluated");
});
const mutations = {
  "Reference Month missing": s => s.replace("August 2026", ""),
  "Release Date missing": s => s.replace("Sep. 11, 2026", ""),
  "Release Time missing": s => s.replace("08:30 AM", ""),
  "duplicate target month": () => F.html("cpi", [F.rows.cpi[0], F.rows.cpi[0]]),
  "conflicting duplicate": () => F.html("cpi", [F.rows.cpi[0], ["August 2026", "Sep. 12, 2026", "08:30 AM"]]),
  "nested table": s => s.replace("August 2026", "<table><tr><td>August 2026</td></tr></table>"),
  "table absent": () => "<meta charset='utf-8'><title>Schedule of Releases for the Consumer Price Index</title>",
  "malformed nesting": s => s.replace("August 2026</td>", "August 2026</th>"),
  "wrong title": s => s.replace("Consumer Price Index", "Producer Price Index")
};
for (const [name, mutate] of Object.entries(mutations)) test(`fail closed: ${name}`, async () => {
  const a = F.acquisition(); a.documents[0] = F.document("cpi", mutate(F.html("cpi")));
  const result = await assess(a); assert.equal(result.outcome, "partial");
  assert.equal(result.documents[0].candidateCount, 0); assert.equal(result.coverageState, "partial");
});
test("unrelated table/navigation/script cannot become schedule rows", async () => {
  const d = F.document("cpi", F.html("cpi") + "<table><tr><td>unrelated</td></tr></table><script>Reference Month Release Date Release Time</script>");
  assert.equal((await P.buildDocument("cpi", d, F.acquisition().fetchedAt)).candidateCount, 3);
});
test("coverage health cannot change semantic identity", async () => {
  const a = await assess(), b = await assess(F.acquisition(), "2027-01-01");
  assert.equal(a.candidateIdentity, b.candidateIdentity); assert.notEqual(a.coverageAssessmentIdentity, b.coverageAssessmentIdentity);
  assert.equal(b.coverageState, "partial");
});
test("invalid assessment and missing roles fail closed", async () => {
  assert.equal((await assess(F.acquisition(), "bad")).outcome, "invalid");
  const a = F.acquisition(); a.documents.pop(); assert.equal((await assess(a)).outcome, "partial");
  a.documents.push(a.documents[0]); assert.equal((await assess(a)).outcome, "invalid");
});
test("exact paths and fixed request shape reject renderer bypass", async () => {
  let calls = 0; const x = R.createAcquirer({ fetchImpl: () => { calls++; } });
  for (const extra of [{ url: "https://evil.test" }, { role: "cpi" }, { headers: {} }])
    assert.equal((await x.acquire({ sourceId: R.SOURCE_ID, ...extra })).outcome, "invalid");
  assert.equal(calls, 0);
  for (const url of [R.ROLES[0].url + "?x=1", R.ROLES[0].url + "#x", R.ROLES[0].url.replace("https:", "http:"),
    R.ROLES[0].url.replace("www.", "evil."), R.ROLES[0].url.replace("/cpi", "/%63pi"), R.ROLES[1].url])
    assert.equal(R.validateUrl("cpi", url).valid, false);
});
test("bounded acquisition four documents only; no credential/custom headers", async () => {
  const x = R.createAcquirer({ fetchImpl: async (url, options) => {
    assert.deepEqual(options.headers, { accept: "text/html" }); assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit"); return response(F.html(R.ROLES.find(r => r.url === url).role)); } });
  assert.equal((await assess(await x.acquire({ sourceId: R.SOURCE_ID }))).outcome, "complete");
  assert.deepEqual(x.diagnostics(), { activeTasks: 0, activeTimers: 0, requestCount: 4 });
});
const badResponses = {
  "invalid UTF8": () => response(new Uint8Array([0xff, 0xfe, 0xff])),
  "invalid MIME": () => response("x", { headers: { "content-type": "application/json" } }),
  "oversized length": () => response("x", { headers: { "content-length": String(R.MAX_BYTES + 1) } }),
  "oversized body": () => response("x".repeat(R.MAX_BYTES + 1)),
  "unexpected redirect": () => response(null, { status: 302, headers: { location: R.ROLES[0].url } }),
  "HTTP failure": () => response("x", { status: 404 })
};
for (const [name, make] of Object.entries(badResponses)) test(`acquisition rejects ${name} without retry`, async () => {
  const x = R.createAcquirer({ fetchImpl: async () => make() }); const a = await x.acquire({ sourceId: R.SOURCE_ID });
  assert.equal(a.outcome, "failed"); assert.equal(x.diagnostics().requestCount, 4);
  assert.equal(x.diagnostics().activeTimers, 0); assert.equal(x.diagnostics().activeTasks, 0);
});
test("request timeout aborts transport and cleans up", async () => {
  let pending = 0; const x = R.createAcquirer({ requestTimeoutMs: 5, fetchImpl: (_, o) => new Promise((resolve, reject) => {
    pending++; o.signal.addEventListener("abort", () => { pending--; reject(Error("aborted")); }, { once: true }); }) });
  const a = await x.acquire({ sourceId: R.SOURCE_ID }); assert.ok(a.documents.every(d => d.reason === "request_timeout"));
  assert.equal(pending, 0); assert.equal(x.diagnostics().activeTimers, 0);
});
test("body timeout cancels stream and cleans up", async () => {
  let pending = 0; const x = R.createAcquirer({ bodyTimeoutMs: 5, fetchImpl: async () => response(new ReadableStream({
    start() { pending++; }, cancel() { pending--; } })) });
  const a = await x.acquire({ sourceId: R.SOURCE_ID }); assert.equal(a.outcome, "failed");
  assert.equal(pending, 0); assert.equal(x.diagnostics().activeTimers, 0);
});
test("inactive implementation: production files do not import isolated route", () => {
  for (const file of ["main.js", "preload.js", "index.html", "js/marketCalendar/sourceRegistry.js",
    "js/marketCalendarRuntime/calendarAcquisitionService.js", "js/marketCalendarRuntime/calendarManualCheckService.js",
    "js/marketCalendarRuntime/calendarStartupRuntime.js"]) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /blsFixed/);
  for (const file of ["blsFixedRoute.js", "blsFixedParser.js", "blsFixedAssessment.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../js/marketCalendarIsolated", file), "utf8"), /require\([^)]*(?:marketCalendarHistory|\/storage\/)/);
});
