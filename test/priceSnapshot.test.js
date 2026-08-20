const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const api = require("../js/priceSnapshot.js");
const storeApi = require("../js/storage/priceSnapshotStore.js");

const GENERATED = "2026-08-21T00:00:00.000Z";
const OBSERVED = "2026-08-21T00:00:01.000Z";
const summary = (price = {}) => ({ generatedAt: GENERATED, marketDate: "2026-08-21",
    sourceVersions: [{ source: "qri-options", tradingDate: "2026-08-21", contract: "2026-09",
        versionKey: "qri-v1", signature: `sha256:${"a".repeat(64)}` }],
    dataQuality: { status: "complete", warnings: [] }, payload: { currentPrice: {
        available: true, status: "available", value: 65800, source: "qri-nikkei225-futures",
        mode: "automatic", contract: "2026-09", quotedAt: GENERATED, fetchedAt: GENERATED,
        ...price } } });
const renderer = (quotedAt = GENERATED) => ({ currentPrice: { quotedAt } });
const make = (changes = {}) => api.createSnapshot({ summary: changes.summary || summary(),
    rendererState: changes.rendererState || renderer(), observedAt: changes.observedAt || OBSERVED });
const databaseName = name => `price-snapshot-${name}-${Date.now()}-${Math.random()}`;

test("valid automatic snapshot preserves timestamps, identity, quality and source reference", async () => {
    const snapshot = await make();
    assert.equal((await api.verifySnapshot(snapshot)).valid, true);
    assert.match(snapshot.snapshotId, /^ps1-/);
    assert.equal(snapshot.price, 65800);
    assert.equal(snapshot.mode, "automatic");
    assert.equal(snapshot.contract, "2026-09");
    assert.equal(snapshot.quotedAtRaw, GENERATED);
    assert.equal(snapshot.quotedAtNormalized, GENERATED);
    assert.equal(snapshot.calendarDay, "2026-08-21");
    assert.equal(snapshot.session, "unknown");
    assert.equal(snapshot.dataQuality.availability, "available");
    assert.equal(snapshot.sourceVersionReference.versionKey, "qri-v1");
});

test("ambiguous quotedAt remains raw and is never inferred", async () => {
    const input = summary({ quotedAt: null });
    const snapshot = await make({ summary: input, rendererState: renderer("08/21 09:00") });
    assert.equal(snapshot.quotedAt, "08/21 09:00");
    assert.equal(snapshot.quotedAtRaw, "08/21 09:00");
    assert.equal(snapshot.quotedAtNormalized, null);
});

test("unavailable and invalid prices are rejected instead of zero-filled", async () => {
    const unavailable = summary({ available: false, value: null, source: null, mode: null,
        contract: null, quotedAt: null, fetchedAt: null });
    await assert.rejects(make({ summary: unavailable }), /current_price_unavailable/);
    await assert.rejects(make({ summary: summary({ value: Infinity }) }), /current_price_unavailable/);
    await assert.rejects(make({ summary: summary({ value: 0 }) }), /current_price_unavailable/);
});

test("manual snapshot is distinct and remains non-comparable without a contract", async () => {
    const automatic = await make();
    const manual = await make({ summary: summary({ source: "manual", mode: "manual", contract: null,
        quotedAt: null }), rendererState: renderer(null) });
    assert.equal(manual.mode, "manual");
    assert.equal(manual.contract, null);
    assert.notEqual(manual.semanticSignature, automatic.semanticSignature);
    assert.equal(api.previousComparableSnapshot([automatic, manual], manual).reason,
        "contract_unavailable");
});

test("store is append-only, dedupes same semantics for five minutes and restores after reopen", async () => {
    const name = databaseName("append");
    const store = storeApi.createPriceSnapshotStore({ indexedDB, databaseName: name });
    const first = await make();
    assert.equal((await store.append(first)).outcome, "appended");
    const duplicate = await make({ observedAt: "2026-08-21T00:04:01.000Z" });
    assert.equal(duplicate.semanticSignature, first.semanticSignature);
    assert.equal((await store.append(duplicate)).outcome, "duplicate");
    const later = await make({ observedAt: "2026-08-21T00:05:02.000Z" });
    assert.equal((await store.append(later)).outcome, "appended");
    store.closeStore();
    const restored = storeApi.createPriceSnapshotStore({ indexedDB, databaseName: name });
    const records = await restored.listAll();
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(item => item.snapshotId), [first.snapshotId, later.snapshotId]);
    assert.equal((await restored.listByContract("2026-09")).length, 2);
    restored.closeStore();
});

test("price, contract, source, mode, quality and fetchedAt changes remain separate records", async () => {
    const base = await make();
    const inputs = [
        summary({ value: 65810 }),
        summary({ contract: "2026-12" }),
        summary({ source: "licensed-vendor" }),
        summary({ source: "manual", mode: "manual", contract: "2026-09" }),
        (() => { const value = summary(); value.dataQuality = { status: "partial", warnings: ["qri"] };
            return value; })(),
        summary({ fetchedAt: "2026-08-21T00:01:00.000Z" })
    ];
    for (const input of inputs) assert.notEqual((await make({ summary: input })).semanticSignature,
        base.semanticSignature);
});

test("latest, previous comparable, elapsed, delta and percent use same contract only", async () => {
    const first = await make({ observedAt: "2026-08-21T00:00:00.000Z" });
    const rollover = await make({ summary: summary({ value: 66000, contract: "2026-12" }),
        observedAt: "2026-08-21T01:00:00.000Z" });
    const current = await make({ summary: summary({ value: 66458 }),
        observedAt: "2026-08-21T02:00:00.000Z" });
    const records = [current, rollover, first];
    assert.equal(api.latestSnapshot(records).snapshotId, current.snapshotId);
    const previous = api.previousComparableSnapshot(records, current);
    assert.equal(previous.snapshot.snapshotId, first.snapshotId);
    const comparison = api.compareSnapshots(previous.snapshot, current);
    assert.equal(comparison.available, true);
    assert.equal(comparison.elapsedMs, 2 * 60 * 60 * 1000);
    assert.equal(comparison.delta, 658);
    assert.equal(comparison.percentChange, 1);
    const stopped = api.compareSnapshots(first, rollover);
    assert.deepEqual([stopped.reason, stopped.boundary], ["contract_mismatch", "rollover_boundary"]);
});

test("approximate prior resolver requires an explicit target and tolerance", async () => {
    const first = await make({ observedAt: "2026-08-21T00:00:00.000Z" });
    const nearThreeHours = await make({ summary: summary({ value: 65900 }),
        observedAt: "2026-08-21T00:11:00.000Z" });
    const current = await make({ summary: summary({ value: 66000 }),
        observedAt: "2026-08-21T03:05:00.000Z" });
    assert.equal(api.resolveApproximatePrior([first, nearThreeHours, current], current).reason,
        "window_invalid");
    const resolved = api.resolveApproximatePrior([first, nearThreeHours, current], current,
        { targetMs: 3 * 60 * 60 * 1000, toleranceMs: 10 * 60 * 1000 });
    assert.equal(resolved.snapshot.snapshotId, first.snapshotId);
    assert.equal(resolved.distanceMs, 5 * 60 * 1000);
    assert.equal(api.resolveApproximatePrior([first, current], current,
        { targetMs: 6 * 60 * 60 * 1000, toleranceMs: 30 * 60 * 1000 }).reason,
    "target_snapshot_unavailable");
});

test("malformed and mutated snapshots are rejected", async () => {
    const malformed = await make(); malformed.price = Infinity;
    assert.equal(api.validateSnapshot(malformed).valid, false);
    const mutated = await make(); mutated.price = 1;
    assert.deepEqual((await api.verifySnapshot(mutated)).errors, ["semantic_signature_mismatch"]);
});

test("storage failure is isolated from the caller", async () => {
    let reported = null;
    const result = await api.persistBestEffort({ summary: summary(), rendererState: renderer(),
        observedAt: OBSERVED }, { append: async () => { throw new Error("quota"); } },
    error => { reported = error; });
    assert.deepEqual([result.saved, result.outcome, reported.message],
        [false, "storage_unavailable", "quota"]);
});

test("renderer wiring adds no fetch and does not alter Observation or formal short-term display", () => {
    const root = path.resolve(__dirname, "..");
    const preview = fs.readFileSync(path.join(root, "js/mobileSummaryPreview.js"), "utf8");
    const snapshotModule = fs.readFileSync(path.join(root, "js/priceSnapshot.js"), "utf8");
    const observation = fs.readFileSync(path.join(root, "js/marketObservation.js"), "utf8");
    assert.match(preview, /OptionMapPriceSnapshot\?\.persistBestEffort/);
    assert.doesNotMatch(snapshotModule, /\bfetch\s*\(|ipcRenderer|setInterval|setTimeout/);
    assert.doesNotMatch(preview, /OptionMapPriceSnapshot[^\n]*(?:shortTerm|TimeframeObservation)/);
    assert.doesNotMatch(observation, /PriceSnapshot|priceSnapshot/);
});
