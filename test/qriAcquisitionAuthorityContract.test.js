"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");

const SECRET = "qri-main-authority-fixture-secret-32-bytes-minimum";
const authority = () => Qri.createMainAuthority({ keyId: "qri-main-session-v1", secret: SECRET });
const contract = value => Qri.createContractIdentity(value);
const parserInput = () => Qri.createParserInputIdentity({ state: "bound",
  sha256: "1".repeat(64), encoding: "utf-8", rawContentSha256: null });

function activeChain(overrides = {}) {
  const main = overrides.authority || authority();
  const intent = Qri.createAcquisitionIntent({ requestKind: "active" });
  const resolution = Qri.resolveQriIntent(intent, {
    activeContractIdentity: contract(overrides.contract || "2026-11")
  });
  assert.equal(resolution.accepted, true);
  const route = resolution.route;
  const acquisition = Qri.createMainAcquisitionIdentity({ intent, route,
    runId: overrides.runId || "run-1", requestId: overrides.requestId || "request-1" }, main);
  const receipt = Qri.createAcquisitionReceipt({ acquisition, intent, route,
    acceptedInitialUrl: route.canonicalUrl, acceptedFinalUrl: route.canonicalUrl,
    fetchedAt: overrides.fetchedAt || "2026-11-10T00:30:00.000Z",
    parserInputIdentity: parserInput() }, main);
  return { authority: main, intent, route, acquisition, receipt };
}

function referenceChain(role = "next", options = {}) {
  const active = activeChain(options);
  const manifest = Qri.createParentManifest({ parentReceipt: active.receipt, entries: [
    { contractIdentity: contract("2026-12"),
      canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1",
      allowedRoles: options.allowedRoles || ["next", "major_sq"] }
  ] }, active.authority);
  const entry = manifest.entries[0];
  const intent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role,
    parentAcquisitionId: active.acquisition.acquisitionId,
    listedContractId: entry.listedContractId });
  const resolution = Qri.resolveQriIntent(intent, { parentManifest: manifest,
    parentReceipt: active.receipt, authority: active.authority });
  assert.equal(resolution.accepted, true);
  const route = resolution.route;
  const acquisition = Qri.createMainAcquisitionIdentity({ intent, route,
    runId: "run-reference-1", requestId: `request-${role}-1` }, active.authority);
  const receipt = Qri.createAcquisitionReceipt({ acquisition, intent, route,
    acceptedInitialUrl: route.canonicalUrl, acceptedFinalUrl: route.canonicalUrl,
    fetchedAt: "2026-11-10T00:31:00.000Z", parserInputIdentity: parserInput() }, active.authority);
  return { ...active, parentIntent: active.intent, parentRoute: active.route,
    parentAcquisition: active.acquisition, parentReceipt: active.receipt,
    manifest, entry, intent, route, acquisition, receipt };
}

function candidate(chain, overrides = {}) {
  return { canonical: { source: Qri.SOURCE_ID,
    sourceUrl: chain.receipt.acceptedFinalUrl,
    contract: chain.receipt.contractIdentity.contract,
    gengetsu: chain.receipt.contractIdentity.gengetsu,
    tradingDate: "2026-11-10", ...overrides.canonical },
  acquisitionBinding: { acquisitionId: chain.receipt.acquisitionId,
    role: chain.receipt.role, parentAcquisitionId: chain.receipt.parentAcquisitionId,
    ...overrides.binding } };
}

function changed(value, mutate) {
  const result = structuredClone(value);
  mutate(result);
  return result;
}

test("Q1-1 active intent is bounded and main resolves the fixed active route", () => {
  const x = activeChain();
  assert.deepEqual(x.intent, { contractVersion: Qri.INTENT_VERSION,
    intentId: x.intent.intentId, requestKind: "active", role: "active",
    parentAcquisitionId: null, listedContractId: null });
  assert.deepEqual([x.route.canonicalUrl, x.route.path, x.route.sourceFamily,
    x.route.sourceId, x.route.contractIdentity.contract],
  [Qri.ACTIVE_URL, "/jpx/nkopm/", "qri", "qri-nikkei225-options", "2026-11"]);
  assert.equal(Qri.validateAcquisitionIntent(x.intent), true);
  assert.equal(Qri.validateRouteDescriptor(x.route), true);
});

test("Q1-2 arbitrary renderer URL, host, path and contract authority are impossible", () => {
  for (const field of ["url", "host", "path", "sourceId", "contractIdentity"]) {
    assert.throws(() => Qri.createAcquisitionIntent({ requestKind: "active",
      [field]: field === "url" ? Qri.ACTIVE_URL : "forged" }), /intent_fields_invalid/);
  }
});

test("Q1-3 credentials, query and hash cannot enter parent route authority", () => {
  const x = activeChain();
  for (const url of ["https://user:pass@svc.qri.jp/jpx/nkopm/1",
    "https://svc.qri.jp/jpx/nkopm/1?q=x", "https://svc.qri.jp/jpx/nkopm/1#x"]) {
    assert.throws(() => Qri.createParentManifest({ parentReceipt: x.receipt, entries: [
      { contractIdentity: contract("2026-12"), canonicalUrl: url, allowedRoles: ["next"] }
    ] }, x.authority), /manifest_entry_invalid/);
  }
});

test("Q1-4 accepted parent manifest resolves a listed reference without renderer URL", () => {
  const x = referenceChain("next");
  assert.deepEqual([x.route.role, x.route.canonicalUrl, x.route.contractIdentity.contract,
    x.route.parentAcquisitionId, x.route.listedContractId],
  ["next", "https://svc.qri.jp/jpx/nkopm/1", "2026-12",
    x.parentAcquisition.acquisitionId, x.entry.listedContractId]);
  assert.equal(Object.hasOwn(x.intent, "url"), false);
});

test("Q1-5 listed contract absent from the signed parent manifest rejects", () => {
  const x = referenceChain();
  const unknown = `qri-listed-contract-v1|sha256:${"a".repeat(64)}`;
  const intent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "next",
    parentAcquisitionId: x.parentAcquisition.acquisitionId, listedContractId: unknown });
  const result = Qri.resolveQriIntent(intent, { parentManifest: x.manifest,
    parentReceipt: x.parentReceipt, authority: x.authority });
  assert.deepEqual([result.accepted, result.reason], [false, "listed_contract_unknown"]);
});

test("Q1-6 forged parent acquisition identity rejects", () => {
  const x = referenceChain();
  const intent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "next",
    parentAcquisitionId: `qri-acquisition-v1|sha256:${"b".repeat(64)}`,
    listedContractId: x.entry.listedContractId });
  const result = Qri.resolveQriIntent(intent, { parentManifest: x.manifest,
    parentReceipt: x.parentReceipt, authority: x.authority });
  assert.deepEqual([result.accepted, result.reason], [false, "parent_acquisition_mismatch"]);
});

test("Q1-7 contract/path route tampering invalidates route identity", () => {
  const x = referenceChain();
  const wrongPath = changed(x.route, value => {
    value.path = "/jpx/nkopm/2";
    value.canonicalUrl = "https://svc.qri.jp/jpx/nkopm/2";
  });
  const wrongContract = changed(x.route, value => {
    value.contractIdentity = contract("2027-03");
  });
  assert.equal(Qri.validateRouteDescriptor(wrongPath), false);
  assert.equal(Qri.validateRouteDescriptor(wrongContract), false);
});

test("Q1-8 parser result for another contract rejects", () => {
  const x = referenceChain();
  const result = Qri.validateParserResultAgainstReceipt(x.receipt,
    candidate(x, { canonical: { contract: "2027-03", gengetsu: "202703" } }), x.authority);
  assert.deepEqual([result.accepted, result.reason], [false, "contract_mismatch"]);
});

test("Q1-9 active receipt cannot be rebound as Major SQ", () => {
  const x = activeChain();
  const result = Qri.validateParserResultAgainstReceipt(x.receipt,
    candidate(x, { binding: { role: "major_sq" } }), x.authority);
  assert.deepEqual([result.accepted, result.reason], [false, "role_mismatch"]);
});

test("Q1-10 main-issued receipt integrity is deterministic", () => {
  const x = activeChain();
  const duplicate = Qri.createAcquisitionReceipt({ acquisition: x.acquisition,
    intent: x.intent, route: x.route, acceptedInitialUrl: x.route.canonicalUrl,
    acceptedFinalUrl: x.route.canonicalUrl, fetchedAt: x.receipt.fetchedAt,
    parserInputIdentity: parserInput() }, x.authority);
  assert.deepEqual(duplicate, x.receipt);
  assert.equal(Qri.validateAcquisitionReceipt(x.receipt, x.authority,
    { acquisition: x.acquisition, intent: x.intent, route: x.route }), true);
  assert.match(x.receipt.authoritySignature, /^[0-9a-f]{64}$/);
});

test("Q1-11 receipt tampering and a forged authority key reject", () => {
  const x = activeChain();
  const tampered = changed(x.receipt, value => { value.fetchedAt = "2026-11-10T00:32:00.000Z"; });
  const impostor = Qri.createMainAuthority({ keyId: x.authority.keyId,
    secret: "different-main-authority-secret-at-least-32-bytes" });
  assert.equal(Qri.validateAcquisitionReceipt(tampered, x.authority), false);
  assert.equal(Qri.validateAcquisitionReceipt(x.receipt, impostor), false);
});

test("Q1-12 renderer sourceId spoof is outside the exact intent contract", () => {
  assert.throws(() => Qri.createAcquisitionIntent({ requestKind: "active",
    sourceId: Qri.FUTURES_SOURCE_ID }), /intent_fields_invalid/);
  const x = activeChain();
  const tampered = changed(x.receipt, value => { value.sourceId = Qri.FUTURES_SOURCE_ID; });
  assert.equal(Qri.validateAcquisitionReceipt(tampered, x.authority), false);
});

test("Q1-13 renderer raw SHA injection is outside the exact intent contract", () => {
  assert.throws(() => Qri.createAcquisitionIntent({ requestKind: "active",
    sha256: "a".repeat(64) }), /intent_fields_invalid/);
});

test("Q1-14 renderer bytes and Vault path injection are outside the intent contract", () => {
  for (const extra of [{ bytes: Buffer.from("forged") }, { vaultPath: "/tmp/forged" }]) {
    assert.throws(() => Qri.createAcquisitionIntent({ requestKind: "active", ...extra }),
      /intent_fields_invalid/);
  }
});

test("Q1-15 IV inherits exactly the accepted parent QRI receipt and parser input", () => {
  const x = referenceChain("major_sq");
  const result = Qri.createIvReceiptInheritance(x.receipt, {
    source: Qri.IV_SOURCE_ID, sourceUrl: x.receipt.acceptedFinalUrl,
    contract: "2026-12", tradingDate: "2026-11-10" }, x.authority);
  assert.equal(result.accepted, true);
  assert.deepEqual([result.inheritance.parentReceiptId,
    result.inheritance.parentAcquisitionId, result.inheritance.role,
    result.inheritance.parserInputIdentity],
  [x.receipt.receiptId, x.receipt.acquisitionId, "major_sq", x.receipt.parserInputIdentity]);
  assert.equal(Object.hasOwn(result.inheritance, "rawReceiptId"), false);
});

test("Q1-16 Futures quote remains a separate source outside QRI Options receipt authority", () => {
  const x = activeChain();
  assert.equal(x.receipt.sourceId, Qri.SOURCE_ID);
  assert.notEqual(x.receipt.sourceId, Qri.FUTURES_SOURCE_ID);
  assert.equal(Qri.FUTURES_SOURCE_ID, "qri-nikkei225-futures");
  assert.equal(Object.values(x.receipt).includes(Qri.FUTURES_SOURCE_ID), false);
});

test("Q1-17 unknown future contract versions fail closed", () => {
  const x = referenceChain();
  assert.equal(Qri.validateAcquisitionIntent(changed(x.intent,
    value => { value.contractVersion = "qri-acquisition-intent-v2"; })), false);
  assert.equal(Qri.validateRouteDescriptor(changed(x.route,
    value => { value.contractVersion = "qri-route-descriptor-v2"; })), false);
  assert.equal(Qri.validateParentManifest(changed(x.manifest,
    value => { value.contractVersion = "qri-parent-manifest-v2"; }),
  x.parentReceipt, x.authority), false);
  assert.equal(Qri.validateAcquisitionReceipt(changed(x.receipt,
    value => { value.contractVersion = "qri-acquisition-receipt-v2"; }), x.authority), false);
});

test("reference child is rejected without a valid parent and when role is not listed", () => {
  const x = referenceChain("next", { allowedRoles: ["next"] });
  const missing = Qri.resolveQriIntent(x.intent, {});
  assert.deepEqual([missing.accepted, missing.reason], [false, "parent_manifest_invalid"]);
  const major = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "major_sq",
    parentAcquisitionId: x.parentAcquisition.acquisitionId,
    listedContractId: x.entry.listedContractId });
  const denied = Qri.resolveQriIntent(major, { parentManifest: x.manifest,
    parentReceipt: x.parentReceipt, authority: x.authority });
  assert.deepEqual([denied.accepted, denied.reason], [false, "listed_role_not_allowed"]);
});

test("main acquisition identity cannot mix an intent with another listed route", () => {
  const first = referenceChain();
  const secondManifest = Qri.createParentManifest({ parentReceipt: first.parentReceipt, entries: [
    { contractIdentity: contract("2027-03"),
      canonicalUrl: "https://svc.qri.jp/jpx/nkopm/2", allowedRoles: ["next"] }
  ] }, first.authority);
  const secondIntent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: "next",
    parentAcquisitionId: first.parentAcquisition.acquisitionId,
    listedContractId: secondManifest.entries[0].listedContractId });
  assert.throws(() => Qri.createMainAcquisitionIdentity({ intent: secondIntent,
    route: first.route, runId: "mixed-run", requestId: "mixed-request" }, first.authority),
  /acquisition_identity_input_invalid/);
});

test("parent manifest rejects ambiguous duplicate contract or route authority", () => {
  const x = activeChain();
  assert.throws(() => Qri.createParentManifest({ parentReceipt: x.receipt, entries: [
    { contractIdentity: contract("2026-12"), canonicalUrl: "https://svc.qri.jp/jpx/nkopm/1",
      allowedRoles: ["next"] },
    { contractIdentity: contract("2026-12"), canonicalUrl: "https://svc.qri.jp/jpx/nkopm/2",
      allowedRoles: ["major_sq"] }
  ] }, x.authority), /parent_manifest_invalid/);
});

test("same semantic intent can create distinct main acquisition occurrences", () => {
  const first = activeChain({ runId: "run-1", requestId: "request-1" });
  const second = activeChain({ runId: "run-2", requestId: "request-2" });
  assert.equal(first.intent.intentId, second.intent.intentId);
  assert.equal(first.route.routeIdentity, second.route.routeIdentity);
  assert.notEqual(first.acquisition.acquisitionId, second.acquisition.acquisitionId);
  assert.notEqual(first.receipt.receiptId, second.receipt.receiptId);
});

test("valid parser binding fixes source, URL, contract, date and parent relationship", () => {
  const x = referenceChain();
  const result = Qri.validateParserResultAgainstReceipt(x.receipt, candidate(x), x.authority);
  assert.equal(result.accepted, true);
  assert.deepEqual([result.binding.sourceId, result.binding.sourceUrl,
    result.binding.contractIdentity.contract, result.binding.tradingDate,
    result.binding.parentAcquisitionId],
  [Qri.SOURCE_ID, x.route.canonicalUrl, "2026-12", "2026-11-10",
    x.parentAcquisition.acquisitionId]);
  assert.match(result.binding.canonicalIdentity,
    /^qri-parser-result-v1\|sha256:[0-9a-f]{64}$/);
});

test("parent manifest integrity binds entries, parser lineage and parent receipt", () => {
  const x = referenceChain();
  assert.equal(Qri.validateParentManifest(x.manifest, x.parentReceipt, x.authority), true);
  const tampered = changed(x.manifest, value => {
    value.entries[0].allowedRoles = ["major_sq"];
  });
  assert.equal(Qri.validateParentManifest(tampered, x.parentReceipt, x.authority), false);
  assert.deepEqual([x.manifest.parserId, x.manifest.parserVersion,
    x.manifest.parentParserInputIdentity],
  [Qri.MANIFEST_PARSER_ID, 2, x.parentReceipt.parserInputIdentity]);
});

test("parser-input and evidence identities remain reserved placeholders without bytes", () => {
  const x = activeChain();
  assert.equal(Object.hasOwn(x.receipt, "bytes"), false);
  assert.deepEqual(x.receipt.transportIdentity, Qri.TRANSPORT_PLACEHOLDER);
  assert.deepEqual(x.receipt.evidenceStatus, Qri.EVIDENCE_PLACEHOLDER);
  assert.equal(x.receipt.parserInputIdentity.state, "bound");
  assert.equal(x.receipt.parserInputIdentity.rawContentSha256, null);
});
