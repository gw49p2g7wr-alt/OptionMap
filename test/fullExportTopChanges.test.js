"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Top = require("../js/fullExportTopChanges.js");
const AiSummary = require("../js/fullExportAiSummary.js");
const FullExport = require("../js/fullExport.js");

const clone = value => structuredClone(value);
const sectionPointer = domain => domain.startsWith("qriOptionIv.")
    ? "/sections/qriOptionIv" : `/sections/${domain}`;
function baseDomain(domain) {
    const identity = { source: domain, versionKey: `${domain}-v1`, signature: `${domain}-sig` };
    return { sourcePointer: sectionPointer(domain), category: "unchanged",
        predecessorSelection: "accepted_persisted_export",
        statusTransition: { category: "unchanged",
            previous: { status: "available", reason: null },
            current: { status: "available", reason: null } },
        freshnessTransition: { category: "unchanged",
            previous: { status: "fresh", reason: "current" },
            current: { status: "fresh", reason: "current" } },
        readinessTransition: { category: "unchanged",
            previous: { readiness: "current", reason: null, freshnessReason: "current" },
            current: { readiness: "current", reason: null, freshnessReason: "current" } },
        contractTransition: { category: "unchanged", previous: "2026-12", current: "2026-12" },
        identityTransition: { category: "unchanged", previous: identity, current: clone(identity) },
        valueTransition: { category: "unchanged", reason: null, fields: {} } };
}
function summary(overrides = {}) {
    const domains = Object.fromEntries(Top.DOMAIN_ORDER.map(domain =>
        [domain, baseDomain(domain)]));
    for (const [domain, value] of Object.entries(overrides)) {
        domains[domain] = { ...domains[domain], ...clone(value) };
    }
    return { status: "available", reason: null,
        authority: { source: "optionmap-full-export", sourceClass: "derived_index",
            origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
        asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
            pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
        freshness: { status: "not_applicable", reason: "index_only" },
        summary: { comparisonVocabularyVersion: 1, comparisonStatus: "comparable",
            authority: "derived_non_authoritative", changedDomainCount: 0,
            domains, unchangedCritical: [] },
        details: { authoritativeRootsUsed: [{ authoritativeRoot: "/sections" }] } };
}
const changed = (previous, current, category = "changed") =>
    ({ category, previous, current });

test("P18 no changes has an explicit available empty state", () => {
    const result = Top.buildTopChanges(summary());
    assert.equal(result.status, "available");
    assert.equal(result.reason, "no_changes");
    assert.equal(result.summary.changeCount, 0);
    assert.equal(result.summary.maxItemsPerBucket, 5);
    assert.deepEqual(Object.keys(result.summary.buckets), Top.BUCKET_ORDER);
    for (const bucket of Object.values(result.summary.buckets)) {
        assert.deepEqual(bucket, { totalCount: 0, shownCount: 0, omittedCount: 0, items: [] });
    }
});

test("P18 availability transition preserves exact P16 status and reason", () => {
    const transition = changed({ status: "unavailable", reason: "source_unavailable" },
        { status: "available", reason: null }, "added");
    const result = Top.buildTopChanges(summary({ marketSnapshot: {
        category: "added", statusTransition: transition } }));
    assert.deepEqual(result.summary.buckets.availabilityChanges.items[0], {
        domain: "marketSnapshot", changeType: "status_transition", category: "added",
        sourcePointer: "/sections/changeSummary", previous: transition.previous,
        current: transition.current, evidencePointer: "/sections/marketSnapshot"
    });
});

test("P18 bucket limit reports total shown and omitted without silent truncation", () => {
    const overrides = {};
    for (const domain of Top.DOMAIN_ORDER.slice(0, 6)) overrides[domain] = {
        category: "changed", statusTransition: changed(
            { status: "partial", reason: "partial" },
            { status: "available", reason: null }) };
    const bucket = Top.buildTopChanges(summary(overrides)).summary.buckets.availabilityChanges;
    assert.deepEqual([bucket.totalCount, bucket.shownCount, bucket.omittedCount], [6, 5, 1]);
    assert.deepEqual(bucket.items.map(value => value.domain), Top.DOMAIN_ORDER.slice(0, 5));
});

test("P18 readiness transition retains the P15 reasons", () => {
    const transition = changed({ readiness: "limited", reason: "date_unverifiable",
        freshnessReason: "expected_trading_date_unknown" },
    { readiness: "current", reason: null, freshnessReason: "current" });
    const item = Top.buildTopChanges(summary({ qriOptions: {
        category: "changed", readinessTransition: transition } })).summary
        .buckets.readinessChanges.items[0];
    assert.deepEqual([item.previous, item.current], [transition.previous, transition.current]);
});

test("P18 contract roll is explicit and does not manufacture a numeric delta", () => {
    const result = Top.buildTopChanges(summary({ qriOptions: { category: "changed",
        contractTransition: changed("2026-11", "2026-12"),
        valueTransition: { category: "not_comparable", reason: "contract_transition", fields: {} }
    } }));
    assert.deepEqual(result.summary.buckets.contractChanges.items[0].previous, "2026-11");
    assert.deepEqual(result.summary.buckets.contractChanges.items[0].current, "2026-12");
    assert.equal(result.summary.buckets.valueChanges.totalCount, 0);
});

test("P18 freshness transition remains distinct from readiness and availability", () => {
    const transition = changed({ status: "stale", reason: "saved_last_valid" },
        { status: "fresh", reason: "current" });
    const result = Top.buildTopChanges(summary({ qriOptionsNextContract: {
        category: "changed", freshnessTransition: transition } }));
    assert.deepEqual(result.summary.buckets.freshnessChanges.items[0].previous,
        transition.previous);
    assert.equal(result.summary.buckets.readinessChanges.totalCount, 0);
});

test("P18 QRI OI reuses P16 ordering and preserves formal numeric facts", () => {
    const qri = baseDomain("qriOptions");
    qri.category = "changed";
    qri.contractTransition = { category: "unchanged", previous: "2026-11", current: "2026-11" };
    qri.valueTransition = { category: "changed", reason: null, fields: {},
        evidencePointer: "/sections/qriHistoryComparison/details/comparison",
        reusedEvidence: { highlights: [{ optionType: "call", topIncreases: [
            { contract: "2026-11", optionType: "call", strike: 68000,
                previous: { value: 100 }, current: { value: 140 }, delta: 40 },
            { contract: "2026-11", optionType: "call", strike: 67000,
                previous: { value: 100 }, current: { value: 120 }, delta: 20 }],
        topDecreases: [{ contract: "2026-11", optionType: "call", strike: 69000,
            previous: { value: 90 }, current: { value: 70 }, delta: -20 }],
        newlyPublished: [{ contract: "2026-11", optionType: "call", strike: 70000,
            previous: { value: null }, current: { value: 55 }, delta: null }],
        noLongerPublished: [{ contract: "2026-11", optionType: "call", strike: 66000,
            previous: { value: 65 }, current: { value: null }, delta: null }] }] } };
    const items = Top.buildTopChanges(summary({ qriOptions: qri })).summary
        .buckets.valueChanges.items;
    assert.deepEqual(items.map(value => [value.changeType, value.strike]), [
        ["qri_oi_top_increase", 68000], ["qri_oi_top_increase", 67000],
        ["qri_oi_top_decrease", 69000], ["qri_oi_newly_published", 70000],
        ["qri_oi_no_longer_published", 66000]
    ]);
    assert.deepEqual([items[0].optionType, items[0].contract, items[0].previous,
        items[0].current, items[0].delta], ["call", "2026-11", 100, 140, 40]);
});

test("P18 Morning V5 supports first and superseding observations", () => {
    const first = baseDomain("morningV5Formal");
    first.category = "first_observation";
    first.identityTransition = { category: "first_observation", previous: null,
        current: { source: "formal-morning-v5", versionKey: "v1", signature: "sig1",
            observationId: "observation-1" } };
    const firstItem = Top.buildTopChanges(summary({ morningV5Formal: first })).summary
        .buckets.newObservations.items[0];
    assert.equal(firstItem.changeType, "first_observation");
    assert.equal(firstItem.current.observationId, "observation-1");

    const next = baseDomain("morningV5Formal");
    next.category = "changed";
    next.identityTransition = changed(
        { source: "formal-morning-v5", versionKey: "v1", signature: "sig1",
            observationId: "observation-1" },
        { source: "formal-morning-v5", versionKey: "v2", signature: "sig2",
            observationId: "observation-2" });
    const nextItem = Top.buildTopChanges(summary({ morningV5Formal: next })).summary
        .buckets.newObservations.items[0];
    assert.equal(nextItem.changeType, "superseding_observation");
    assert.deepEqual([nextItem.previous.observationId, nextItem.current.observationId],
        ["observation-1", "observation-2"]);
});

test("P18 excludes non-comparable values from the numeric digest", () => {
    const result = Top.buildTopChanges(summary({ marketSnapshot: { category: "changed",
        valueTransition: { category: "not_comparable", reason: "contract_transition",
            fields: { value: { category: "changed", previous: 1, current: 2, delta: 1 } } }
    } }));
    assert.equal(result.summary.buckets.valueChanges.totalCount, 0);
});

test("P18 ordering is deterministic across source object insertion order", () => {
    const source = summary({ marketSnapshot: { category: "changed",
        valueTransition: { category: "changed", reason: null, fields: {
            zeta: { category: "changed", previous: 1, current: 2, delta: 1 },
            alpha: { category: "changed", previous: 3, current: 5, delta: 2 }
        } } }, participants: { category: "changed", readinessTransition: changed(
            { readiness: "reference" }, { readiness: "current" }) } });
    const reversed = clone(source);
    reversed.summary.domains = Object.fromEntries(
        Object.entries(reversed.summary.domains).reverse());
    const first = Top.buildTopChanges(source), second = Top.buildTopChanges(reversed);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.summary.buckets.valueChanges.items.map(value => value.field),
        ["alpha", "zeta"]);
});

test("P18 AI Summary copies only the exact pointer and compact bucket counts", () => {
    const changeSummary = summary({ marketSnapshot: { category: "added",
        statusTransition: changed({ status: "unavailable", reason: "missing" },
            { status: "available", reason: null }, "added") } });
    const topChanges = Top.buildTopChanges(changeSummary);
    const result = AiSummary.buildFullExportAiSummary({ exportMeta: {
        generatedAt: "2026-10-20T08:00:00+09:00" }, compactSummary: {},
    sections: { changeSummary, topChanges }, warnings: [] });
    assert.equal(result.status, "available", JSON.stringify(result));
    assert.equal(result.summary.topChanges.sourcePointer, "/sections/topChanges");
    assert.equal(result.summary.topChanges.changeCount, topChanges.summary.changeCount);
    assert.deepEqual(result.summary.topChanges.bucketCounts.availabilityChanges,
        { totalCount: 1, shownCount: 1, omittedCount: 0 });
    assert.equal(Object.hasOwn(result.summary.topChanges, "items"), false);
});

test("P18 consumes only P16 and stays identical when unrelated raw sections change", () => {
    const authority = summary({ overallV2: { category: "changed",
        valueTransition: { category: "changed", reason: null, fields: {
            direction: { category: "changed", previous: 1, current: 2, delta: 1 }
        } } } });
    const first = Top.buildTopChanges(authority);
    const unrelated = { qriOptions: { raw: [1, 2, 3] }, previousExport: { arbitrary: true } };
    unrelated.qriOptions.raw.push(4);
    const second = Top.buildTopChanges(clone(authority));
    assert.deepEqual(first, second);
    assert.equal(first.summary.sourceAuthority, "/sections/changeSummary");
});

function envelope(source) {
    return { status: "available", reason: null,
        authority: { source, sourceClass: null, origin: null,
            formalStatus: null, versionKey: null, signature: null },
        asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
            pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
        freshness: { status: "fresh", reason: "current" }, summary: {}, details: {} };
}
test("P18 is optional additive v1 data and changes no required schema field", () => {
    const sections = Object.fromEntries(FullExport.REQUIRED_SECTION_KEYS.map(name =>
        [name, envelope(name)]));
    sections.topChanges = Top.buildTopChanges(summary());
    const generatedAt = "2026-10-20T08:00:00+09:00";
    const result = FullExport.buildFullExport({ exportMeta: { generatedAt,
        timeZone: "Asia/Tokyo", profile: "full", appVersion: "1.1.0-beta.13", readOnly: true },
    compactSummary: { generatedAt, market: "Nikkei 225 derivatives", session: {},
        currentPrice: {}, currentContract: null,
        overallV2: { interpretation: FullExport.SAFE_INTERPRETATION }, morningChange: {},
        importantLevels: {}, qriHighlights: [], freshnessIssues: [], warnings: [] },
    sections, warnings: [] });
    assert.equal(result.schemaVersion, "optionmap-full-export-v1");
    assert.equal(FullExport.REQUIRED_SECTION_KEYS.includes("topChanges"), false);
    assert.equal(FullExport.validateFullExport(result).valid, true);
});

test("P18 builder is frozen pure bounded code without storage network or scoring", () => {
    const result = Top.buildTopChanges(summary());
    assert.equal(Object.isFrozen(result.summary.buckets), true);
    assert.throws(() => result.summary.buckets.availabilityChanges.items.push({}), TypeError);
    const source = fs.readFileSync(path.join(__dirname, "../js/fullExportTopChanges.js"), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|indexedDB|ipcRenderer|ipcMain/);
    assert.doesNotMatch(source, /importanceScore|severityScore|bullish|bearish|BUY|SELL/);
});
