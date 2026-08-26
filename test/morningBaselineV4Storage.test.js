const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Baseline = require("../js/morningBaselineV4.js");
const Foundation = require("../js/morningBaselineV4Storage.js");
const ReadOnly = require("../js/storage/morningBaselineV4ReadOnlyStore.js");
const Store = require("../js/storage/morningBaselineV4Store.js");

const identity = (source, versionKey) => ({ source, versionKey,
    signature: `sha256:${source}-${versionKey}`, verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: null });

function input(options = {}) {
    const tradingDate = options.tradingDate || "2026-08-26";
    const contract = options.contract || "2026-09";
    const qriVersion = options.qriVersion || "qri-v1";
    const option = component("option", options.optionDirection ?? 0.5, 55);
    const weekly = component("weekly", 0.2, 45);
    const capturedAt = options.capturedAt || `${tradingDate}T08:00:00+09:00`;
    const sourceAt = options.sourceAt || `${tradingDate}T08:00:00+09:00`;
    return { capturedAt,
        marketContext: { captureCalendarDate: tradingDate, formalTradingDate: tradingDate,
            sessionIdentity: options.scopeId === undefined ? `scope|${contract}|${tradingDate}` : options.scopeId,
            sessionMappingStatus: options.sessionMappingStatus || "verified" },
        overallV2Context: { origin: "formal_live", formalApplied: true, superseded: false,
            logicVersion: "overall-v2-weights-55-45-v1", evaluatedAt: sourceAt,
            inputIdentity: identity("overall-v2-input", `input-${qriVersion}`),
            componentIdentities: { option: identity("qri-options", qriVersion),
                weekly: identity("weekly-futures-history", "weekly-v1") },
            result: { status: "complete", direction: options.direction ?? 37,
                directionLabel: "買い優勢", confidence: 78,
                confidenceFactors: { agreement: 85 }, components: { option, weekly },
                metadata: { calculatedAt: sourceAt, coverage: 100, warnings: [] } } },
        currentPriceContext: { available: true, sourceKind: "live", origin: "live",
            mode: "automatic", value: options.price || 42000, contract, quoteDate: tradingDate,
            quotedAtNormalized: `${tradingDate}T07:59:00+09:00`, quoteSignature: "a".repeat(64),
            versionKey: options.priceVersion || "price-v1", wrapperSignature: "b".repeat(64),
            requestId: options.requestId || "request-1", fetchedAt: sourceAt,
            currentRequestVerified: true, identityVerified: true, acquisitionVerified: true,
            acquisitionIdentity: { requestId: options.requestId || "request-1", fetchedAt: sourceAt,
                sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "b".repeat(64) },
            qriTradingDateMapping: { status: "verified", quoteDate: tradingDate,
                qriTradingDate: tradingDate, relation: "same_date", mappingVerified: true,
                mappingSource: "same_date_explicit" } },
        qriContext: { available: true, origin: "formal_live", sourceKind: "live",
            formalRevisionAvailable: true, referenceOnly: false, usingFallback: false,
            restored: false, superseded: false, openInterestStatus: "available",
            identity: { verified: true, contract, tradingDate, pageUpdatedAt: sourceAt,
                canonicalSignature: "c".repeat(64), canonicalVersionKey: qriVersion,
                historyEntryId: `${contract}|${tradingDate}`, historyRevisionId: qriVersion } },
        weeklyContext: { available: true, origin: "formal_history", formalApplied: true,
            usingFallback: false, superseded: false, sourceDate: "2026-08-21",
            versionKey: "weekly-v1", signature: null, identityVerified: true,
            normalizedDirection: 0.2, qualityFactor: 1, effectiveWeight: 45,
            weightedContribution: 9, metadata: null },
        nearestLevelsContext: options.actualLevels ? { generatedFromFormalOnly: true,
            referenceOnly: false, usingFallback: false, contract, sourceVersionKey: qriVersion,
            upper: { available: true, price: 42500, distance: 500, optionType: "CALL" },
            lower: { available: true, price: 41500, distance: 500, optionType: "PUT" } } : null,
        dataQualityContext: { status: "complete", warnings: [],
            sourceAvailability: { overallV2: true, currentPrice: true, qri: true, weekly: true },
            fallbackFlags: { currentPrice: false, qri: false, weekly: false },
            componentAvailability: { option: true, weekly: true } } };
}

async function baseline(options) {
    const built = await Baseline.buildMorningBaselineV4(input(options));
    assert.equal(built.success, true, built.reason); return built.baseline;
}
async function container(options) {
    const built = await Foundation.buildMorningBaselineV4Storage({ baseline: await baseline(options) });
    assert.equal(built.success, true, built.reason); return built.container;
}
async function serialized(options) {
    const result = await Foundation.serializeMorningBaselineV4Storage(await container(options));
    assert.equal(result.success, true, result.reason); return result.serialized;
}
const mutate = (value, change) => { const copy = structuredClone(value); change(copy); return copy; };

test("dedicated fixed key is isolated from legacy Morning", () => {
    assert.equal(Foundation.STORAGE_KEY, "optionMapMorningBaselinesV4");
    assert.notEqual(Foundation.STORAGE_KEY, "optionMapMobileMorningBaselinesV1");
});
test("valid exact container builds", async () => { const value = await container();
    assert.equal(await Foundation.validateMorningBaselineV4Storage(value), true);
    assert.deepEqual(Object.keys(value).sort(), [...Foundation.STORAGE_FIELDS].sort());
    assert.deepEqual(Object.keys(value.series[0]).sort(), [...Foundation.SERIES_FIELDS].sort());
    assert.deepEqual(Object.keys(value.series[0].revisions[0]).sort(), [...Foundation.REVISION_FIELDS].sort());
    assert.equal(Object.hasOwn(value, "retentionPolicy"), false);
});
test("container build is detached, deeply frozen, and does not mutate baseline", async () => {
    const candidate = await baseline(); const before = structuredClone(candidate);
    const result = await Foundation.buildMorningBaselineV4Storage({ baseline: candidate });
    assert.deepEqual(candidate, before); assert.notEqual(result.container.series[0].revisions[0].snapshot, candidate);
    assert.equal(Object.isFrozen(result.container), true);
    assert.equal(Object.isFrozen(result.container.series[0].revisions[0].snapshot), true);
});
test("invalid baseline is rejected", async () => assert.equal(
    (await Foundation.buildMorningBaselineV4Storage({ baseline: {} })).reason, "invalid_baseline"));
test("unverified scope is not a formal storage candidate", async () => { const value = await baseline({
    scopeId: null, sessionMappingStatus: "unresolved" });
    assert.equal((await Foundation.buildMorningBaselineV4Storage({ baseline: value })).reason,
        "session_unverified"); });
test("nearestLevels null is stored and restored", async () => { const restored =
    await Foundation.restoreMorningBaselineV4Storage(await serialized());
    assert.equal(restored.container.series[0].revisions[0].snapshot.nearestLevels, null); });
test("actual formal nearestLevels remain compatible", async () => { const restored =
    await Foundation.restoreMorningBaselineV4Storage(await serialized({ actualLevels: true }));
    assert.equal(restored.container.series[0].revisions[0].snapshot.nearestLevels.upper.price, 42500); });
test("serialization is deterministic across object key order", async () => { const value = await container();
    const reordered = { series: value.series, baselineVersion: 4, storageVersion: 1 };
    assert.equal((await Foundation.serializeMorningBaselineV4Storage(value)).serialized,
        (await Foundation.serializeMorningBaselineV4Storage(reordered)).serialized); });
test("same formal content suppresses duplicate capture event", async () => { const first = await baseline();
    const initial = (await Foundation.buildMorningBaselineV4Storage({ baseline: first })).container;
    const duplicate = await baseline({ capturedAt: "2026-08-26T09:00:00+09:00" });
    const result = await Foundation.buildMorningBaselineV4Storage({ baseline: duplicate,
        existingContainer: initial });
    assert.deepEqual([result.status, result.changed, result.duplicate,
        result.container.series[0].revisions.length], ["unchanged", false, true, 1]); });
test("changed content creates revision and retains replaced active", async () => {
    const first = await baseline(); const initial = (await Foundation.buildMorningBaselineV4Storage({ baseline: first })).container;
    const before = structuredClone(initial);
    const second = await baseline({ capturedAt: "2026-08-26T09:00:00+09:00", requestId: "request-2",
        price: 42100, priceVersion: "price-v2", qriVersion: "qri-v2" });
    const changed = await Foundation.buildMorningBaselineV4Storage({ baseline: second,
        existingContainer: initial }); const series = changed.container.series[0];
    assert.equal(series.revisions.length, 2); assert.equal(series.activeBaselineId, second.baselineId);
    assert.equal(series.revisions[0].replacedAt, second.capturedAt);
    assert.equal(series.revisions[0].snapshot.baselineId, first.baselineId);
    assert.deepEqual(initial, before);
});
test("different verified scope is isolated in a separate series", async () => {
    const first = await baseline(); const initial = (await Foundation.buildMorningBaselineV4Storage({ baseline: first })).container;
    const second = await baseline({ tradingDate: "2026-08-27", capturedAt: "2026-08-27T08:00:00+09:00",
        scopeId: "scope|2026-09|2026-08-27", qriVersion: "qri-v2", priceVersion: "price-v2" });
    const result = await Foundation.buildMorningBaselineV4Storage({ baseline: second,
        existingContainer: initial }); assert.equal(result.container.series.length, 2); });
test("same scope cannot be rebound to another date or contract", async () => {
    const first = await baseline(); const initial = (await Foundation.buildMorningBaselineV4Storage({ baseline: first })).container;
    const second = await baseline({ tradingDate: "2026-08-27", capturedAt: "2026-08-27T08:00:00+09:00",
        scopeId: first.marketContext.sessionIdentity, qriVersion: "qri-v2", priceVersion: "price-v2" });
    assert.equal((await Foundation.buildMorningBaselineV4Storage({ baseline: second,
        existingContainer: initial })).reason, "scope_identity_mismatch"); });
test("older or equal changed capture cannot replace active", async () => { const first = await baseline({
    capturedAt: "2026-08-26T09:00:00+09:00" }); const initial = (await Foundation
        .buildMorningBaselineV4Storage({ baseline: first })).container;
    const stale = await baseline({ capturedAt: "2026-08-26T08:00:00+09:00", price: 42100,
        priceVersion: "price-v2", qriVersion: "qri-v2" });
    assert.equal((await Foundation.buildMorningBaselineV4Storage({ baseline: stale,
        existingContainer: initial })).reason, "stale_capture"); });

test("missing key is a normal read-only state", async () => {
    const result = await ReadOnly.createReadOnlyStore({ getItem: () => null }).read();
    assert.deepEqual([result.status, result.reason], ["missing", "missing"]); });
test("valid payload restores through read-only adapter", async () => { const value = await serialized();
    const result = await ReadOnly.createReadOnlyStore({ getItem: key => key === Foundation.STORAGE_KEY ? value : null }).read();
    assert.equal(result.status, "ready"); });
test("malformed JSON fails closed", async () => assert.equal(
    (await Foundation.restoreMorningBaselineV4Storage("{")).reason, "parse_failed"));
for (const [name, change] of [
    ["wrong storageVersion", value => { value.storageVersion = 2; }],
    ["wrong baselineVersion", value => { value.baselineVersion = 3; }],
    ["unknown storage field", value => { value.unknown = true; }],
    ["active revision mismatch", value => { value.series[0].activeBaselineId = "missing"; }],
    ["revision identity tamper", value => { value.series[0].revisions[0].baselineId = "tampered"; }],
    ["signature tamper", value => { value.series[0].revisions[0].snapshot.signature = "0".repeat(64); }],
    ["contentSignature tamper", value => { value.series[0].revisions[0].snapshot.contentSignature = "0".repeat(64); }],
    ["versionKey tamper", value => { value.series[0].revisions[0].snapshot.versionKey = "tampered"; }]
]) test(`${name} is rejected on restore`, async () => { const value = JSON.parse(await serialized()); change(value);
    assert.equal((await Foundation.restoreMorningBaselineV4Storage(JSON.stringify(value))).success, false); });
test("restore output is detached and deeply frozen", async () => { const original = JSON.parse(await serialized());
    const restored = await Foundation.restoreMorningBaselineV4Storage(original);
    assert.notEqual(restored.container, original); assert.equal(Object.isFrozen(restored), true);
    assert.equal(Object.isFrozen(restored.container.series[0].revisions[0].snapshot), true); });
test("restore does not judge current-session applicability", async () => {
    const old = await serialized({ tradingDate: "2025-01-06", capturedAt: "2025-01-06T08:00:00+09:00",
        scopeId: "scope|2026-09|2025-01-06" });
    assert.equal((await Foundation.restoreMorningBaselineV4Storage(old)).status, "ready"); });

function memoryStorage(entries = {}) {
    const values = new Map(Object.entries(entries)); const reads = []; const writes = [];
    return { values, reads, writes, getItem(key) { reads.push(key); return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
test("write store performs one atomic write to only the dedicated key", async () => {
    const storage = memoryStorage({ legacy: "keep", unrelated: "keep" });
    const result = await Store.createStore(storage).save(await baseline());
    assert.deepEqual([result.saved, result.writeCount, storage.writes.length], [true, 1, 1]);
    assert.equal(storage.writes[0][0], Foundation.STORAGE_KEY);
    assert.deepEqual([storage.values.get("legacy"), storage.values.get("unrelated")], ["keep", "keep"]);
});
test("duplicate save performs no write", async () => { const first = await baseline();
    const storage = memoryStorage(); const store = Store.createStore(storage); await store.save(first);
    storage.writes.length = 0; const duplicate = await baseline({
        capturedAt: "2026-08-26T09:00:00+09:00" }); const result = await store.save(duplicate);
    assert.deepEqual([result.status, result.duplicate, storage.writes.length], ["unchanged", true, 0]); });
test("invalid baseline performs no write", async () => { const storage = memoryStorage();
    assert.equal((await Store.createStore(storage).save({})).reason, "invalid_baseline");
    assert.equal(storage.writes.length, 0); });
test("serialization failure performs no write", async () => { const storage = memoryStorage();
    const result = await Store.createStore(storage, { stringify: () => { throw new Error("fail"); } })
        .save(await baseline()); assert.equal(result.reason, "serialization_failed");
    assert.equal(storage.writes.length, 0); });
test("serialization failure preserves an existing valid payload", async () => {
    const previous = await serialized(); const storage = memoryStorage({ [Foundation.STORAGE_KEY]: previous });
    const changed = await baseline({ capturedAt: "2026-08-26T09:00:00+09:00", requestId: "request-2",
        price: 42100, priceVersion: "price-v2", qriVersion: "qri-v2" });
    const result = await Store.createStore(storage, { stringify: () => { throw new Error("fail"); } }).save(changed);
    assert.equal(result.reason, "serialization_failed");
    assert.equal(storage.values.get(Foundation.STORAGE_KEY), previous);
    assert.equal(storage.writes.length, 0);
});
for (const [name, errorName, reason] of [["setItem", "Error", "storage_write_failed"],
    ["quota", "QuotaExceededError", "quota_exceeded"]]) test(`${name} failure is isolated and preserves existing payload`, async () => {
        const previous = await serialized(); const storage = memoryStorage({ [Foundation.STORAGE_KEY]: previous });
        storage.setItem = () => { const error = new Error(name); error.name = errorName; throw error; };
        const changed = await baseline({ capturedAt: "2026-08-26T09:00:00+09:00", requestId: "request-2",
            price: 42100, priceVersion: "price-v2", qriVersion: "qri-v2" });
        assert.equal((await Store.createStore(storage).save(changed)).reason, reason);
        assert.equal(storage.values.get(Foundation.STORAGE_KEY), previous);
    });
test("invalid existing payload is preserved and never overwritten", async () => {
    const storage = memoryStorage({ [Foundation.STORAGE_KEY]: "{" });
    const result = await Store.createStore(storage).save(await baseline());
    assert.equal(result.reason, "existing_storage_invalid");
    assert.equal(storage.values.get(Foundation.STORAGE_KEY), "{"); assert.equal(storage.writes.length, 0); });
test("read-only store never requests write capability or legacy fallback", async () => {
    const keys = []; const result = await ReadOnly.createReadOnlyStore({ getItem: key => { keys.push(key); return null; },
        setItem: () => { throw new Error("write forbidden"); } }).read();
    assert.equal(result.status, "missing"); assert.deepEqual(keys, [Foundation.STORAGE_KEY]); });

test("foundation has no runtime source recomputation or external connections", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4Storage.js"), "utf8");
    assert.doesNotMatch(source, /OverallJudgment|CurrentPriceState|QriOptionsHistory|WeeklyFormal|SessionScope|\bfetch\s*\(|setTimeout|setInterval|document\.|MobileSummary/);
});
test("adapters have no runtime builder UI Mobile fetch timer migration or legacy key", () => {
    const source = ["morningBaselineV4ReadOnlyStore.js", "morningBaselineV4Store.js"].map(file =>
        fs.readFileSync(path.join(__dirname, "../js/storage", file), "utf8")).join("\n");
    assert.doesNotMatch(source, /buildMorningBaselineV4\(|collector|saveMorning|document\.|MobileSummary|\bfetch\s*\(|setTimeout|setInterval|migration|backfill|optionMapMobileMorningBaselinesV1/);
});
test("v4 storage foundation is not runtime-wired", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("morningBaselineV4Storage.js"), false);
    assert.equal(html.includes("morningBaselineV4ReadOnlyStore.js"), false);
    assert.equal(html.includes("morningBaselineV4Store.js"), false);
});
