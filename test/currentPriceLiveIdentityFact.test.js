const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Cache = require("../js/currentPriceLastValidCache.js");
const Fact = require("../js/currentPriceLiveIdentityFact.js");

const INPUT = Object.freeze({
    priceResult: Object.freeze({ available: true, source: "qri-nikkei225-futures",
        mode: "automatic", origin: "live", value: 66010, contract: "26年9月限",
        quotedAt: "08/26 05:30", fetchedAt: "2026-08-26T05:31:00+09:00" }),
    activeContract: "2026-09", pageTradingDate: "2026-08-26",
    pageUpdatedAt: "2026-08-26T05:30:30+09:00",
    sourceUrl: "https://svc.qri.jp/jpx/nkopm/202609",
    requestId: "qri-request-42", fetchedAt: "2026-08-26T05:31:00+09:00",
    isCurrentRequest: true
});
const build = overrides => Fact.buildCurrentPriceLiveIdentityFact({ ...INPUT, ...overrides,
    priceResult: { ...INPUT.priceResult, ...(overrides?.priceResult || {}) } });

test("missing price input is rejected", async () => {
    assert.equal((await Fact.buildCurrentPriceLiveIdentityFact({})).reason, "missing_input");
});

test("valid same-date live input produces a verified identity fact", async () => {
    const result = await build();
    assert.deepEqual([result.available, result.status, result.reason], [true, "available", null]);
    assert.deepEqual([result.identityVerified, result.acquisitionVerified], [true, true]);
});

test("manual price is rejected", async () => {
    assert.equal((await build({ priceResult: { mode: "manual" } })).reason, "manual_price");
});

for (const restored of [{ restored: true }, { origin: "cache" }, { origin: "saved" }]) {
    test(`restored price is rejected: ${JSON.stringify(restored)}`, async () => {
        assert.equal((await build({ priceResult: restored })).reason, "restored_price");
    });
}

for (const value of [NaN, 0, -1]) test(`invalid value ${String(value)} is rejected`, async () => {
    assert.equal((await build({ priceResult: { value } })).reason, "invalid_value");
});

test("contract is normalized and semantic mismatch is rejected", async () => {
    assert.equal((await build()).contract, "2026-09");
    assert.equal((await build({ priceResult: { contract: "26年12月限" } })).reason,
        "contract_mismatch");
});

test("missing quotedAt and resolver failure fail closed", async () => {
    assert.equal((await build({ priceResult: { quotedAt: null } })).reason,
        "quote_resolution_failed");
    assert.equal((await build({ priceResult: { quotedAt: "invalid" } })).reason,
        "quote_resolution_failed");
});

test("existing v2 helper verifies quote, version and wrapper signatures", async () => {
    const result = await build();
    assert.equal(result.quoteSignature, await Cache.createQuoteSignatureV2({
        cacheVersion: 1, schemaVersion: 2, source: result.sourceKind === "live"
            ? "qri-nikkei225-futures" : null, mode: result.mode, value: result.value,
        contract: result.contract, pageTradingDate: result.pageTradingDate,
        pageUpdatedAt: result.pageUpdatedAt, quotedAtRaw: result.quotedAtRaw,
        quoteDate: result.quoteDate, quotedAtNormalized: result.quotedAtNormalized,
        quoteDateResolution: result.quoteDateResolution,
        quoteDateResolutionSource: result.quoteDateResolutionSource,
        fetchedAt: result.fetchedAt, sourceUrl: result.sourceUrl,
        signatureAlgorithm: "sha256", quoteSignature: result.quoteSignature,
        signature: result.wrapperSignature, versionKey: result.versionKey }));
    assert.deepEqual([result.diagnostics.quoteSignatureVerified,
        result.diagnostics.versionKeyVerified, result.diagnostics.wrapperSignatureVerified],
    [true, true, true]);
});

test("quoteSignature is a verified market quote identity", async () => {
    const result = await build();
    assert.match(result.quoteSignature, /^[a-f0-9]{64}$/);
    assert.equal(result.quoteIdentity.quoteSignature, result.quoteSignature);
});

test("versionKey is a verified stable quote key", async () => {
    const first = await build();
    const second = await build({ requestId: "qri-request-43" });
    assert.equal(first.versionKey, second.versionKey);
    assert.equal(first.diagnostics.versionKeyVerified, true);
});

test("wrapper signature is retained as acquisition evidence", async () => {
    const result = await build();
    assert.match(result.wrapperSignature, /^[a-f0-9]{64}$/);
    assert.equal(result.acquisitionIdentity.wrapperSignature, result.wrapperSignature);
});

test("requestId is required and stale requests are rejected", async () => {
    assert.equal((await build({ requestId: null })).reason, "acquisition_unverified");
    assert.equal((await build({ isCurrentRequest: false })).reason, "stale_request");
});

test("fetchedAt and sourceUrl are required", async () => {
    assert.equal((await build({ fetchedAt: null,
        priceResult: { fetchedAt: null } })).reason, "acquisition_unverified");
    assert.equal((await build({ sourceUrl: null })).reason, "acquisition_unverified");
});

test("same-date QRI mapping is explicitly verified", async () => {
    const mapping = (await build()).qriTradingDateMapping;
    assert.deepEqual(mapping, { status: "verified", quoteDate: "2026-08-26",
        qriTradingDate: "2026-08-26", relation: "same_date", mappingVerified: true,
        mappingSource: "same_date_explicit" });
});

test("same-date diagnostics record explicit mapping verification", async () => {
    const result = await build();
    assert.equal(result.diagnostics.sameDateMappingVerified, true);
    assert.equal(result.diagnostics.crossDateRejected, false);
});

test("cross-date stays available but mapping remains unresolved", async () => {
    const result = await build({ priceResult: { quotedAt: "08/25 20:00" },
        pageUpdatedAt: "2026-08-25T20:01:00+09:00" });
    assert.deepEqual([result.available, result.reason], [true, "date_context_unresolved"]);
    assert.deepEqual(result.qriTradingDateMapping, { status: "date_context_unresolved",
        quoteDate: "2026-08-25", qriTradingDate: "2026-08-26",
        relation: "previous_date", mappingVerified: false, mappingSource: null });
    assert.equal(result.diagnostics.crossDateRejected, true);
});

test("pageUpdatedAt resolves quote date but never proves trading-date mapping", async () => {
    const result = await build({ priceResult: { quotedAt: "08/25 23:59" },
        pageUpdatedAt: "2026-08-26T00:01:00+09:00" });
    assert.equal(result.quoteDateResolutionSource, "pageUpdatedAt");
    assert.equal(result.qriTradingDateMapping.mappingVerified, false);
    assert.notEqual(result.qriTradingDateMapping.mappingSource, "pageUpdatedAt");
});

test("future quote date is never promoted to a verified mapping", async () => {
    const result = await build({ pageTradingDate: "2026-08-25" });
    assert.deepEqual([result.available, result.qriTradingDateMapping.relation,
        result.qriTradingDateMapping.mappingVerified], [true, "future_date", false]);
});

test("malformed page date context rejects quote resolution", async () => {
    assert.equal((await build({ pageTradingDate: "2026-02-30" })).reason,
        "quote_resolution_failed");
    assert.equal((await build({ pageUpdatedAt: "08/26 05:30" })).reason,
        "quote_resolution_failed");
});

test("identity and acquisition verification are independent", async () => {
    const result = await build();
    assert.equal(result.quoteIdentity.requestId, undefined);
    assert.equal(result.acquisitionIdentity.quoteSignature, undefined);
    assert.deepEqual(result.acquisitionIdentity, { requestId: INPUT.requestId,
        fetchedAt: INPUT.fetchedAt, sourceUrl: INPUT.sourceUrl,
        wrapperSignature: result.wrapperSignature });
});

test("builder does not mutate input", async () => {
    const input = JSON.parse(JSON.stringify(INPUT));
    const before = JSON.stringify(input);
    await Fact.buildCurrentPriceLiveIdentityFact(input);
    assert.equal(JSON.stringify(input), before);
});

test("result, mapping, identities and diagnostics are deeply frozen", async () => {
    const result = await build();
    for (const value of [result, result.qriTradingDateMapping, result.quoteIdentity,
        result.acquisitionIdentity, result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("failure output is deeply frozen", async () => {
    const result = await Fact.buildCurrentPriceLiveIdentityFact({});
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.qriTradingDateMapping), true);
    assert.equal(Object.isFrozen(result.diagnostics), true);
});

test("source and unavailable live facts are rejected", async () => {
    assert.equal((await build({ priceResult: { source: "manual" } })).reason,
        "source_ineligible");
    assert.equal((await build({ priceResult: { available: false } })).reason,
        "source_ineligible");
});

test("automatic non-live origin is ineligible", async () => {
    assert.equal((await build({ priceResult: { origin: "unknown" } })).reason,
        "source_ineligible");
});

test("identity and acquisition diagnostics both verify on success", async () => {
    const result = await build();
    assert.deepEqual({ builderUsed: result.diagnostics.builderUsed,
        validatorPassed: result.diagnostics.validatorPassed,
        currentRequestVerified: result.diagnostics.currentRequestVerified,
        identityVerified: result.diagnostics.identityVerified,
        acquisitionVerified: result.diagnostics.acquisitionVerified },
    { builderUsed: true, validatorPassed: true, currentRequestVerified: true,
        identityVerified: true, acquisitionVerified: true });
});

test("pure foundation has no external IO, runtime mutation or formal analysis wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceLiveIdentityFact.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|currentPriceState|OverallV2|judgment/.test(source), false);
    assert.deepEqual({ storage: source.includes("setItem("), database: source.includes("open("),
        timer: /setInterval|setTimeout/.test(source) }, { storage: false, database: false, timer: false });
});

test("diagnostics explicitly attest pure non-mutating behavior", async () => {
    const diagnostics = (await build()).diagnostics;
    assert.deepEqual({ storageAccessed: diagnostics.storageAccessed,
        databaseAccessed: diagnostics.databaseAccessed, fetchTriggered: diagnostics.fetchTriggered,
        runtimeMutated: diagnostics.runtimeMutated }, { storageAccessed: false,
        databaseAccessed: false, fetchTriggered: false, runtimeMutated: false });
});
