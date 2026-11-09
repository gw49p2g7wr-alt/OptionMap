"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Shadow = require("../js/qriRawTransportShadow.js");
const Parser = require("../js/qriOptions.js");
const { rawQriHtml, rawQriBytes } = require("./fixtures/qri/rawQriPageFixture.js");

const ROOT = path.join(__dirname, "..");
const SECRET = "qri-main-shadow-fixture-secret-32-bytes-minimum";
const NOW = "2026-11-10T00:30:00.000Z";

function authority() {
  return Qri.createMainAuthority({ keyId: "qri-main-shadow-v1", secret: SECRET });
}

function successResponse(body = rawQriBytes, headers = {}) {
  return { kind: "response", statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8",
      "content-length": String(body.byteLength), ...headers }, body };
}

function client(sequence, calls = []) {
  let index = 0;
  return { calls, requestOnce(options) {
    calls.push(options);
    const step = sequence[Math.min(index++, sequence.length - 1)];
    return typeof step === "function" ? step(options) : Promise.resolve(step);
  } };
}

const warmup = async input => ({ accepted:
  input.sessionPartition === Shadow.SESSION_PARTITION &&
  input.userAgent === Shadow.USER_AGENT && input.plan === Shadow.WARMUP_PLAN, reason: null });

function service(requestClient, overrides = {}) {
  return Shadow.createQriRawTransportShadow({ authority: overrides.authority || authority(),
    requestClient, warmupSession: overrides.warmupSession || warmup,
    now: () => NOW, requestTimeoutMs: overrides.requestTimeoutMs || 100,
    bodyTimeoutMs: overrides.bodyTimeoutMs || 100,
    maxResponseBytes: overrides.maxResponseBytes || Shadow.MAX_RESPONSE_BYTES });
}

function activeInput(overrides = {}) {
  return { intent: Qri.createAcquisitionIntent({ requestKind: "active" }),
    authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11") },
    runId: "shadow-run-1", requestId: "shadow-request-1", ...overrides };
}

function v1ActiveChain(main = authority()) {
  const intent = Qri.createAcquisitionIntent({ requestKind: "active" });
  const route = Qri.resolveQriIntent(intent, {
    activeContractIdentity: Qri.createContractIdentity("2026-11") }).route;
  const acquisition = Qri.createMainAcquisitionIdentity({ intent, route,
    runId: "parent-run", requestId: "parent-request" }, main);
  const parserInputIdentity = Qri.createParserInputIdentity({ state: "bound",
    sha256: "1".repeat(64), encoding: "utf-8", rawContentSha256: null });
  const receipt = Qri.createAcquisitionReceipt({ acquisition, intent, route,
    acceptedInitialUrl: route.canonicalUrl, acceptedFinalUrl: route.canonicalUrl,
    fetchedAt: NOW, parserInputIdentity }, main);
  return { main, intent, route, acquisition, receipt };
}

function childInput(main = authority()) {
  const parent = v1ActiveChain(main);
  const manifest = Qri.createParentManifest({ parentReceipt: parent.receipt, entries: [
    { contractIdentity: Qri.createContractIdentity("2026-12"),
      canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1", allowedRoles: ["major_sq", "next"] }
  ] }, main);
  const entry = manifest.entries[0];
  return { parent, manifest, entry, input: {
    intent: Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "next",
      parentAcquisitionId: parent.acquisition.acquisitionId,
      listedContractId: entry.listedContractId }),
    authorityContext: { parentManifest: manifest, parentReceipt: parent.receipt, authority: main },
    runId: "child-run", requestId: "child-request" } };
}

test("Q2-1 normal active raw acquisition captures exact bounded transport facts", async () => {
  const calls = [];
  const main = authority();
  const result = await service(client([successResponse()], calls), { authority: main })
    .acquire(activeInput());
  assert.equal(result.status, "available");
  assert.equal(result.receipt.contractVersion, Qri.RECEIPT_V2_VERSION);
  assert.equal(Qri.validateAcquisitionReceipt(result.receipt, main), true);
  assert.deepEqual([result.rawFacts.httpStatus, result.rawFacts.mediaType,
    result.rawFacts.encoding, result.rawFacts.byteLength],
  [200, "text/html", "utf-8", rawQriBytes.byteLength]);
  assert.deepEqual(result.copyRawBytesForMainTest(), rawQriBytes);
  assert.notEqual(result.copyRawBytesForMainTest(), result.copyRawBytesForMainTest());
  assert.equal(calls[0].url, Qri.ACTIVE_URL);
});

test("Q2-2 exact SHA is stable over identical original bytes and bound before decode", async () => {
  const first = await service(client([successResponse()])).acquire(activeInput());
  const second = await service(client([successResponse()])).acquire(activeInput());
  const expected = Shadow.sha256Bytes(rawQriBytes);
  assert.equal(first.rawFacts.contentSha256, expected);
  assert.equal(second.rawFacts.contentSha256, expected);
  assert.equal(first.receipt.parserInputIdentity.rawContentSha256, expected);
  assert.equal(first.receipt.transportIdentity.contentSha256, expected);
});

test("Q2-3 byte ceiling rejects declared and streamed oversize bodies", async () => {
  const declared = successResponse(Buffer.from("x"), { "content-length": "65" });
  const streamed = successResponse(Buffer.alloc(65));
  const a = await service(client([declared]), { maxResponseBytes: 64 }).acquire(activeInput());
  const b = await service(client([streamed]), { maxResponseBytes: 64 }).acquire(activeInput());
  assert.deepEqual([a.reason, b.reason], ["byte_ceiling_exceeded", "byte_ceiling_exceeded"]);
});

test("Q2-4 non-200 HTTP status rejects before parser input", async () => {
  const response = { ...successResponse(), statusCode: 403 };
  const result = await service(client([response])).acquire(activeInput());
  assert.deepEqual([result.status, result.reason, result.parserInput],
    ["unavailable", "http_status_rejected", null]);
});

test("Q2-5 MIME must be exact text/html", async () => {
  const response = successResponse(rawQriBytes, { "content-type": "text/plain; charset=utf-8" });
  const result = await service(client([response])).acquire(activeInput());
  assert.equal(result.reason, "mime_rejected");
});

test("Q2-6 explicit Shift_JIS charset decodes deterministically", async () => {
  const bytes = Buffer.from("<meta charset=shift_jis><p>ASCII</p>", "ascii");
  const response = successResponse(bytes, { "content-type": "text/html; charset=Shift_JIS" });
  const result = await service(client([response])).acquire(activeInput());
  assert.deepEqual([result.status, result.rawFacts.encoding, result.parserInput],
    ["available", "shift_jis", bytes.toString("ascii")]);
});

test("Q2-7 unknown, missing and conflicting charsets fail closed", async () => {
  const unknown = successResponse(Buffer.from("<meta charset=x-unknown>"),
    { "content-type": "text/html; charset=x-unknown" });
  const missing = successResponse(Buffer.from("<html></html>"),
    { "content-type": "text/html" });
  const conflict = successResponse(Buffer.from("<meta charset=shift_jis>"),
    { "content-type": "text/html; charset=utf-8" });
  const results = [];
  for (const response of [unknown, missing, conflict]) {
    results.push((await service(client([response])).acquire(activeInput())).reason);
  }
  assert.deepEqual(results, ["charset_unsupported", "charset_unverifiable", "charset_conflict"]);
});

test("Q2-8 one canonical-equivalent redirect is accepted and signed", async () => {
  const redirect = { kind: "redirect", statusCode: 301,
    redirectUrl: "https://svc.qri.jp/jpx/nkopm" };
  const main = authority();
  const result = await service(client([redirect, successResponse()]), { authority: main })
    .acquire(activeInput());
  assert.equal(result.status, "available");
  assert.equal(result.receipt.transportIdentity.redirectHops.length, 1);
  assert.equal(Qri.validateAcquisitionReceipt(result.receipt, main), true);
});

test("Q2-9 redirect outside the exact route is rejected", async () => {
  const redirect = { kind: "redirect", statusCode: 302,
    redirectUrl: "https://svc.qri.jp/jpx/nkopm/1" };
  const result = await service(client([redirect])).acquire(activeInput());
  assert.equal(result.reason, "redirect_outside_route");
});

test("Q2-10 redirect loop and count beyond three reject", async () => {
  const loop = client([
    { kind: "redirect", statusCode: 302, redirectUrl: "https://svc.qri.jp/jpx/nkopm" },
    { kind: "redirect", statusCode: 302, redirectUrl: Qri.ACTIVE_URL }
  ]);
  const excessive = client([
    { kind: "redirect", statusCode: 302, redirectUrl: "https://svc.qri.jp/jpx/nkopm//" },
    { kind: "redirect", statusCode: 302, redirectUrl: "https://svc.qri.jp/jpx/nkopm///" },
    { kind: "redirect", statusCode: 302, redirectUrl: "https://svc.qri.jp/jpx/nkopm////" },
    { kind: "redirect", statusCode: 302, redirectUrl: "https://svc.qri.jp/jpx/nkopm/////" }
  ]);
  assert.equal((await service(loop).acquire(activeInput())).reason, "redirect_loop");
  assert.equal((await service(excessive).acquire(activeInput())).reason, "redirect_limit_exceeded");
});

test("Q2-11 cookies stay main-owned and secret response headers never enter result or receipt", async () => {
  const calls = [];
  const response = successResponse(rawQriBytes, { "set-cookie": "secret=qri-cookie-value" });
  const result = await service(client([response], calls)).acquire(activeInput());
  assert.equal(calls[0].useSessionCookies, true);
  assert.equal(calls[0].sessionPartition, Shadow.SESSION_PARTITION);
  assert.doesNotMatch(JSON.stringify(result), /secret|qri-cookie-value|set-cookie/i);
  assert.equal(result.diagnostics.sessionCookies, "main_owned_not_exposed");
});

test("Q2-12 active request URL is only the Q1 main-resolved route", async () => {
  const calls = [];
  const result = await service(client([successResponse()], calls)).acquire(activeInput());
  assert.equal(result.status, "available");
  assert.equal(calls[0].url, Qri.ACTIVE_URL);
  assert.equal(Object.hasOwn(activeInput().intent, "url"), false);
  const injected = await service(client([successResponse()])).acquire({ ...activeInput(),
    url: "https://evil.example/" });
  assert.equal(injected.reason, "request_envelope_invalid");
  const contextInjected = await service(client([successResponse()])).acquire(activeInput({
    authorityContext: { activeContractIdentity: Qri.createContractIdentity("2026-11"),
      url: "https://evil.example/" }
  }));
  assert.equal(contextInjected.reason, "authority_context_invalid");
});

test("Q2-13 listed child resolves only from the accepted signed parent manifest", async () => {
  const main = authority();
  const child = childInput(main);
  const calls = [];
  const result = await service(client([successResponse()], calls), { authority: main })
    .acquire(child.input);
  assert.equal(result.status, "available");
  assert.equal(calls[0].url, child.entry.canonicalUrl);
  assert.equal(result.receipt.parentAcquisitionId, child.parent.acquisition.acquisitionId);
});

test("Q2-14 unknown listed child rejects without a transport request", async () => {
  const main = authority();
  const child = childInput(main);
  const calls = [];
  child.input.intent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "next",
    parentAcquisitionId: child.parent.acquisition.acquisitionId,
    listedContractId: `qri-listed-contract-v1|sha256:${"a".repeat(64)}` });
  const result = await service(client([successResponse()], calls), { authority: main })
    .acquire(child.input);
  assert.equal(result.reason, "listed_contract_unknown");
  assert.equal(calls.length, 0);
});

test("Q2-15 parent manifest tamper rejects before transport", async () => {
  const main = authority();
  const child = childInput(main);
  const calls = [];
  const tampered = structuredClone(child.manifest);
  tampered.entries[0].canonicalUrl = "https://svc.qri.jp/jpx/nkopm/2";
  child.input.authorityContext.parentManifest = tampered;
  const result = await service(client([successResponse()], calls), { authority: main })
    .acquire(child.input);
  assert.equal(result.reason, "parent_manifest_invalid");
  assert.equal(calls.length, 0);
});

test("Q2-16 raw CloudFront/block signatures reject parser input", async () => {
  const block = Buffer.from("<meta charset=utf-8><h1>403 ERROR</h1>The request could not be satisfied");
  const result = await service(client([successResponse(block)])).acquire(activeInput());
  assert.deepEqual([result.reason, result.parserInput, result.receipt],
    ["block_page_detected", null, null]);
});

test("Q2-17 request and body timeouts fail closed with no retry", async () => {
  const calls = [];
  const never = () => new Promise(() => {});
  const requestTimeout = await service(client([never], calls), { requestTimeoutMs: 5 })
    .acquire(activeInput());
  const pendingBody = { kind: "response", statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: new Promise(() => {}) };
  const bodyTimeout = await service(client([pendingBody]),
    { bodyTimeoutMs: 5 }).acquire(activeInput());
  assert.deepEqual([requestTimeout.reason, bodyTimeout.reason, calls.length],
    ["request_timeout", "body_timeout", 1]);
});

test("Q2-18 accepted raw transport is activated only through bounded Q6 IPC", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(main, /require\("\.\/js\/qriRawTransportShadow\.js"\)/);
  assert.match(main, /ipcMain\.handle\("acquire-qri-page"/);
  assert.match(preload, /ipcRenderer\.invoke\("acquire-qri-page"/);
  assert.match(index, /optionMapBridge\.acquireQriPage\(\{ requestKind: "active" \}\)/);
  for (const source of [main, preload, index]) {
    assert.doesNotMatch(source, /ipcMain\.handle\("fetch-option-page"|ipcRenderer\.invoke\("fetch-option-page"|optionMapBridge\.fetchQriOptionPage/);
  }
});

test("Q2-19 existing QRI parser accepts the decoded raw server fixture", async () => {
  const result = await service(client([successResponse()])).acquire(activeInput());
  const parsed = Parser.parseQriOptionsPage(result.parserInput, Qri.ACTIVE_URL);
  assert.deepEqual([parsed.source, parsed.contract, parsed.tradingDate,
    parsed.records.length, parsed.openInterestStatus],
  [Qri.SOURCE_ID, "2026-11", "2026-11-10", 2, "available"]);
});

test("Q2-20 parser dependency is raw HTML compatible with no post-JS DOM input", () => {
  const parserSource = Parser.parseQriOptionsPage.toString();
  const raw = Parser.parseQriOptionsPage(rawQriHtml, Qri.ACTIVE_URL);
  const domEquivalent = Parser.parseQriOptionsPage(String(rawQriHtml), Qri.ACTIVE_URL);
  assert.deepEqual(raw, domEquivalent);
  assert.doesNotMatch(parserSource, /document\.|window\.|querySelector|innerHTML|outerHTML|eval\(/);
  assert.equal("raw_html_parser_compatible", "raw_html_parser_compatible");
});

test("v1 receipts remain valid while unknown receipt versions fail closed", async () => {
  const main = authority();
  const v1 = v1ActiveChain(main).receipt;
  assert.equal(Qri.validateAcquisitionReceipt(v1, main), true);
  const result = await service(client([successResponse()]), { authority: main }).acquire(activeInput());
  assert.equal(Qri.validateAcquisitionReceipt(result.receipt, main), true);
  const future = structuredClone(result.receipt);
  future.contractVersion = "qri-acquisition-receipt-v3";
  assert.equal(Qri.validateAcquisitionReceipt(future, main), false);
});

test("shadow module has no storage, Vault, renderer, preload or history authority", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/qriRawTransportShadow.js"), "utf8");
  assert.doesNotMatch(source, /indexedDB|localStorage|sourceEvidence|evidenceVault|ipcMain|ipcRenderer|BrowserWindow|writeFile|appendFile/);
});

test("Electron net adapter binds the existing main session and returns exact delivered bytes", async () => {
  const expectedSession = Object.freeze({ name: "qri-session" });
  let requestOptions = null;
  class FakeRequest extends EventEmitter {
    end() {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { "content-type": ["text/html; charset=utf-8"] };
      this.emit("response", response);
      queueMicrotask(() => {
        response.emit("data", rawQriBytes.subarray(0, 17));
        response.emit("data", rawQriBytes.subarray(17));
        response.emit("end");
      });
    }
    abort() {}
  }
  const net = { request(options) { requestOptions = options; return new FakeRequest(); } };
  const adapter = Shadow.createElectronNetClient({ net, session: expectedSession });
  const controller = new AbortController();
  const response = await adapter.requestOnce({ url: Qri.ACTIVE_URL, method: "GET",
    headers: { Accept: "text/html" }, useSessionCookies: true,
    sessionPartition: Shadow.SESSION_PARTITION, redirect: "manual", cache: "no-store",
    maxBytes: Shadow.MAX_RESPONSE_BYTES, signal: controller.signal });
  assert.equal(response.kind, "response");
  assert.deepEqual(await response.body, rawQriBytes);
  assert.equal(requestOptions.session, expectedSession);
  assert.deepEqual([requestOptions.useSessionCookies, requestOptions.credentials,
    requestOptions.redirect, requestOptions.cache], [true, "include", "manual", "no-store"]);
});

test("Electron warm-up uses only the fixed JPX plan and same main-owned cookie session", async () => {
  const calls = [];
  const requestClient = { async requestOnce(options) {
    calls.push(options);
    return { kind: "response", statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  } };
  const warm = Shadow.createElectronSessionWarmup({ requestClient });
  const result = await warm({ plan: Shadow.WARMUP_PLAN,
    sessionPartition: Shadow.SESSION_PARTITION, userAgent: Shadow.USER_AGENT,
    signal: new AbortController().signal });
  assert.equal(result.accepted, true);
  assert.deepEqual(calls.map(item => item.url), [Shadow.JPX_HOME_URL, Shadow.JPX_QUOTES_URL]);
  assert.ok(calls.every(item => item.useSessionCookies === true && item.redirect === "follow"));
  assert.equal(calls[1].headers.Referer, Shadow.JPX_HOME_URL);
});
