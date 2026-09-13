"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Projection = require("../js/formalArchiveInventoryProjection.js");
const revision = (versionKey, records) => ({ versionKey, signature: "a".repeat(64),
    replacedAt: null, canonical: { records } });
function histories() { return { qriOptions: { historyVersion: 1, schemaVersion: 2, entries: [{
    contract: "2026-10", sourceDateKey: "2026-09-14", activeVersionKey: "oi:v1",
    revisions: [revision("oi:v1", [{ optionType: "call", strike: 64000,
        published: true, value: 1200 }, { optionType: "put", strike: 64000,
        published: true, value: 900 }])] }] }, qriOptionIv: { historyVersion: 1,
    schemaVersion: 1, entries: [{ contract: "2026-10", tradingDate: "2026-09-14",
        activeVersionKey: "iv:v1", revisions: [revision("iv:v1", [{ optionType: "call",
            strike: 64000, iv: { status: "available", value: 0.24 } }, { optionType: "put",
            strike: 64000, iv: { status: "missing", value: null } }])] }] },
weeklyFutures: { version: 1, entries: [] }, weeklyOptions: { historyVersion: 1, entries: [] },
participant: { version: 1, entries: [] }, morningV4: { entries: [] },
priceSnapshots: { entries: [] }, marketObservations: { entries: [] } }; }
test("projects formal identities and joins QRI OI with IV by wall identity", () => {
    const result = Projection.projectFormalArchiveInventory({ histories: histories() });
    const call = result.wallHistory.find(item => item.side === "call");
    assert.equal(call.identity, "2026-10|64000|call|2026-09-14");
    assert.equal(call.openInterest.value, 1200); assert.equal(call.iv.value, 0.24);
    assert.deepEqual(call.missing, ["volume", "optionPrice"]);
    const put = result.wallHistory.find(item => item.side === "put");
    assert.equal(put.iv.availability, "missing");
});
test("never fabricates unsaved volume or option price", () => {
    const result = Projection.projectFormalArchiveInventory({ histories: histories() });
    assert.deepEqual(result.unavailableMetrics, ["volume", "optionPrice"]);
    assert.equal(result.diagnostics.fabricatedFields, false);
    assert.equal(result.wallHistory.every(item => !Object.hasOwn(item, "volume") &&
        !Object.hasOwn(item, "optionPrice")), true);
});
test("reports duplicates orphans missing weekdays retention and migration blockers", () => {
    const source = histories(); source.qriOptions.entries.push({ contract: "2026-10",
        sourceDateKey: "2026-09-16", activeVersionKey: "oi:v2",
        revisions: [revision("oi:v2", [])] }); source.qriOptions.orphanRevisionCount = 1;
    const result = Projection.projectFormalArchiveInventory({ histories: source,
        cacheFacts: [{ factKey: "2026-10|64000|call|2026-09-14", storageId: "cache",
            authorityClass: "cache", metric: "openInterest" }] });
    const qri = result.inventory.find(item => item.storageId === "qri_options_history");
    assert.deepEqual(qri.missingDates, ["2026-09-15"]); assert.equal(qri.migratableCount, 0);
    assert.deepEqual(qri.migrationBlockedReasons, ["orphan_revision"]);
    assert.equal(result.duplicates.length, 1);
});
test("uses Morning v4 baselineId as the active revision identity", () => {
    const source = histories(); source.morningV4 = { validationValid: true, entries: [{
        sourceDate: "2026-09-14", activeVersionKey: "baseline-1",
        revisions: [{ versionKey: "baseline-1", replacedAt: null }] }] };
    const result = Projection.projectFormalArchiveInventory({ histories: source });
    const morning = result.inventory.find(item => item.storageId === "morning_v4");
    assert.equal(morning.activeRevisionCount, 1);
    assert.equal(morning.signatureStatus, "verified");
});
