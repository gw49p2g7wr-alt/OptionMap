const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Readiness = require("../js/fullExportConsumerReadiness.js");
const FullExport = require("../js/fullExport.js");
const FullExportV2 = require("../js/fullExportV2.js");
const AiSummary = require("../js/fullExportAiSummary.js");

const AS_OF = { tradingDate: "2026-10-19", sourceDate: null, snapshotDate: null,
    pageUpdatedAt: null, fetchedAt: null, confirmedAt: null };
const fresh = (overrides = {}) => ({ status: "fresh", reason: "current", origin: "live",
    dataTradingDate: "2026-10-19", expectedTradingDate: "2026-10-19",
    expectedTradingDateSource: "formal_calendar_history_readonly",
    payloadValidation: "valid", dateRelation: "matched", consumerState: "valid_current",
    staleReason: null, ...overrides });
const envelope = (name, overrides = {}) => ({ status: "available", reason: null,
    authority: { source: name, sourceClass: "formal_live", origin: "live",
        formalStatus: "verified", versionKey: `${name}-version`, signature: `${name}-signature` },
    asOf: { ...AS_OF }, freshness: fresh(), summary: { contract: "2026-12" },
    details: {}, ...overrides });

function sectionsFixture() {
    const names = new Set([...FullExport.REQUIRED_SECTION_KEYS,
        "morningV5Formal", "qriOptionIv"]);
    const sections = Object.fromEntries([...names].map(name => [name, envelope(name)]));
    sections.qriHistoryComparison = envelope("qriHistoryComparison", {
        authority: { ...envelope("history").authority, origin: "history" },
        freshness: { applicable: false, status: "not_applicable", reason: "history_fact",
            sourceType: "observation_history", promotedToCurrent: false }, summary: {} });
    sections.intelligence = envelope("intelligence", {
        authority: { ...envelope("history").authority, origin: "history" },
        freshness: { applicable: false, status: "not_applicable", reason: "history_fact",
            sourceType: "observation_history", promotedToCurrent: false }, summary: {} });
    sections.morning = envelope("morning", { freshness: { applicable: false,
        status: "not_applicable", reason: "session_based_reference",
        sourceType: "morning_baseline", promotedToCurrent: false }, summary: {} });
    sections.qriOptionIv = envelope("qriOptionIv", { summary: { roles: {
        active: { status: "available", reason: null, contract: "2026-11",
            tradingDate: "2026-10-19", origin: "live", freshness: fresh() },
        next: { status: "available", reason: null, contract: "2026-12",
            tradingDate: "2026-10-19", origin: "history", freshness: fresh({ status: "saved",
                reason: "saved_last_valid", origin: "history", expectedTradingDate: null,
                dateRelation: "unverifiable", consumerState: "valid_saved_fallback",
                staleReason: "saved_data_origin" }) },
        major_sq: { status: "available", reason: null, contract: "2027-03",
            tradingDate: "2026-10-19", origin: "live", freshness: fresh() }
    } }, details: {} });
    return sections;
}

function inputWithIndex(sections = sectionsFixture()) {
    sections.consumerReadiness = Readiness.buildConsumerReadinessIndex(sections);
    return { exportMeta: { generatedAt: "2026-10-19T10:00:00+09:00",
        timeZone: "Asia/Tokyo", profile: "full", appVersion: "1.1.0-beta.8", readOnly: true },
    compactSummary: { generatedAt: "2026-10-19T10:00:00+09:00",
        market: "Nikkei 225 derivatives", session: {}, currentPrice: {},
        currentContract: "2026-12", overallV2: {
            interpretation: FullExport.SAFE_INTERPRETATION }, morningChange: {},
        importantLevels: {}, qriHighlights: [], freshnessIssues: [], warnings: [] },
    sections, warnings: [] };
}

test("fresh valid facts are indexed current without changing source facts", () => {
    const sections = sectionsFixture(); const before = structuredClone(sections);
    const result = Readiness.buildConsumerReadinessIndex(sections);
    assert.equal(result.summary.entries.marketSnapshot.readiness, "current");
    assert.equal(result.summary.entries.marketSnapshot.freshnessReason, "current");
    assert.equal(result.summary.entries["qriOptionIv.active"].readiness, "current");
    assert.deepEqual(sections, before);
    assert.equal(Object.isFrozen(result.summary.entries.marketSnapshot), true);
});

test("valid saved-last-valid facts are reference and retain provenance", () => {
    const sections = sectionsFixture();
    sections.qriOptionsNextContract.freshness = fresh({ status: "stale",
        reason: "saved_last_valid", origin: "history", expectedTradingDate: null,
        dateRelation: "unverifiable", consumerState: "valid_saved_fallback",
        staleReason: "saved_data_origin" });
    sections.marketSnapshot = envelope("market", { status: "unavailable",
        reason: "current_price_stale_reference", freshness: fresh({ status: "stale",
            reason: "stale_reference", consumerState: "valid_stale",
            staleReason: "previous_session_quote" }), summary: null, details: null });
    const entry = Readiness.buildConsumerReadinessIndex(sections).summary.entries
        .qriOptionsNextContract;
    assert.deepEqual([entry.readiness, entry.freshnessReason, entry.consumerState,
        entry.payloadValidation, entry.origin],
    ["reference", "saved_last_valid", "valid_saved_fallback", "valid", "history"]);
    assert.equal(Readiness.buildConsumerReadinessIndex(sections).summary.entries
        ["qriOptionIv.next"].readiness, "reference");
    assert.equal(Readiness.buildConsumerReadinessIndex(sections).summary.entries
        .marketSnapshot.readiness, "reference");
});

test("valid date-unverifiable facts are limited, not unavailable or invalid", () => {
    const sections = sectionsFixture();
    sections.qriOptions.freshness = fresh({ status: "stale", reason: "date_unverifiable",
        expectedTradingDate: null, dateRelation: "unverifiable",
        consumerState: "valid_date_unverifiable",
        staleReason: "expected_trading_date_unknown" });
    const entry = Readiness.buildConsumerReadinessIndex(sections).summary.entries.qriOptions;
    assert.deepEqual([entry.status, entry.readiness, entry.freshnessReason,
        entry.payloadValidation], ["available", "limited", "date_unverifiable", "valid"]);
});

test("missing acquisition is unavailable while genuine identity failure is invalid", () => {
    const sections = sectionsFixture();
    sections.qriOptionsMajorSqNextContract = envelope("major", { status: "unavailable",
        reason: "major_sq_locator_unavailable", freshness: { status: "unavailable",
            reason: "major_sq_locator_unavailable", payloadValidation: "unavailable",
            consumerState: "invalid_or_unavailable" }, summary: null, details: null });
    sections.marketSnapshot = envelope("market", { status: "unavailable",
        reason: "current_price_identity_mismatch", freshness: { status: "unavailable",
            reason: "freshness_status_unavailable", payloadValidation: "valid",
            consumerState: "invalid_or_unavailable" }, summary: null, details: null });
    const entries = Readiness.buildConsumerReadinessIndex(sections).summary.entries;
    assert.equal(entries.qriOptionsMajorSqNextContract.readiness, "unavailable");
    assert.equal(entries.qriOptionsMajorSqNextContract.reason,
        "major_sq_locator_unavailable");
    assert.equal(entries.marketSnapshot.readiness, "invalid");
    assert.equal(entries.marketSnapshot.reason, "current_price_identity_mismatch");
});

test("valid historical facts are reference rather than stale", () => {
    const entries = Readiness.buildConsumerReadinessIndex(sectionsFixture()).summary.entries;
    assert.equal(entries.qriHistoryComparison.readiness, "reference");
    assert.equal(entries.qriHistoryComparison.freshnessReason, "history_fact");
    assert.equal(entries.intelligence.readiness, "reference");
});

test("partial Weekly is limited and unavailable Morning V5 stays unavailable", () => {
    const sections = sectionsFixture();
    sections.weeklyOptions = envelope("weeklyOptions", { status: "partial",
        reason: "comparison_unavailable" });
    sections.morningV5Formal = envelope("morningV5Formal", { status: "unavailable",
        reason: "formal_morning_v5_not_saved", freshness: { status: "unavailable",
            reason: "formal_observation_not_saved" }, summary: null, details: null });
    const entries = Readiness.buildConsumerReadinessIndex(sections).summary.entries;
    assert.equal(entries.weeklyOptions.readiness, "limited");
    assert.equal(entries.weeklyOptions.reason, "comparison_unavailable");
    assert.equal(entries.morningV5Formal.readiness, "unavailable");
});

test("every index entry copies status, reason, freshness, contract and date from its authority", () => {
    const sections = sectionsFixture();
    const entries = Readiness.buildConsumerReadinessIndex(sections).summary.entries;
    for (const name of Readiness.SECTION_TARGETS) {
        const source = sections[name], entry = entries[name];
        assert.equal(entry.status, source.status, name);
        assert.equal(entry.reason, source.reason, name);
        assert.equal(entry.freshnessStatus, source.freshness.status, name);
        assert.equal(entry.freshnessReason, source.freshness.reason, name);
        assert.equal(entry.sourcePointer, `/sections/${name}`, name);
    }
    for (const role of Readiness.ROLE_TARGETS) {
        const source = sections.qriOptionIv.summary.roles[role];
        const entry = entries[`qriOptionIv.${role}`];
        assert.equal(entry.status, source.status, role);
        assert.equal(entry.reason, source.reason, role);
        assert.equal(entry.freshnessStatus, source.freshness.status, role);
        assert.equal(entry.contract, source.contract, role);
        assert.equal(entry.dataTradingDate, source.freshness.dataTradingDate, role);
    }
});

test("index is optional additive in v1 and preserved unchanged by v2", () => {
    const input = inputWithIndex(); const readiness = input.sections.consumerReadiness;
    const v1 = FullExport.buildFullExport(input);
    assert.equal(v1.schemaVersion, "optionmap-full-export-v1");
    assert.equal(FullExport.REQUIRED_SECTION_KEYS.includes("consumerReadiness"), false);
    assert.equal(FullExport.validateFullExport(v1).valid, true);
    const canonical = { contractVersion: 1, selectionPolicy: {
        scope: "export_basis_revisions", wholeHistoryIncluded: false,
        rawHtmlIncluded: false, rawExcelIncluded: false }, qriOpenInterest: {},
    qriImpliedVolatility: {}, weeklyFutures: {}, weeklyOptions: {}, participants: {},
    jpxDerivativesOpenInterestDaily: { status: "unavailable" } };
    const v2 = FullExportV2.build(v1, canonical);
    assert.equal(v2.schemaVersion, "optionmap-full-export-v2");
    assert.deepEqual(v2.sections.consumerReadiness, readiness);
    assert.equal(FullExportV2.validate(v2).valid, true);
});

test("AI Summary references the one index and never duplicates readiness entries", () => {
    const input = inputWithIndex();
    const ai = AiSummary.buildFullExportAiSummary(input);
    assert.deepEqual(ai.summary.consumerReadiness, {
        sourceSection: "consumerReadiness", sourcePointer: "/sections/consumerReadiness",
        status: input.sections.consumerReadiness.status,
        reason: input.sections.consumerReadiness.reason,
        vocabularyVersion: Readiness.VOCABULARY_VERSION, authoritativeRoot: "/sections"
    });
    assert.equal(Object.hasOwn(ai.summary.consumerReadiness, "entries"), false);
});

test("readiness foundation has no runtime, storage, network, clock, or scoring dependency", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/fullExportConsumerReadiness.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(|document\.|ipcRenderer|ipcMain/);
    assert.doesNotMatch(code, /Date\.now|new\s+Date|Math\.random|percentage|qualityScore|confidenceScore|tradeSignal/);
    assert.deepEqual(Readiness.READINESS_VALUES,
        ["current", "reference", "limited", "unavailable", "invalid"]);
});
