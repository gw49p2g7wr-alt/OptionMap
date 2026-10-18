const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AiSummary = require("../js/fullExportAiSummary.js");
const FullExport = require("../js/fullExport.js");

const envelope = (name, overrides = {}) => ({
    status: "available", reason: null,
    authority: { source: name, sourceClass: "formal_history", origin: "history",
        formalStatus: "verified", versionKey: `${name}-v1`, signature: `${name}-sig` },
    asOf: { tradingDate: "2026-09-07", sourceDate: "2026-09-06",
        snapshotDate: null, pageUpdatedAt: "2026-09-07T08:00:00+09:00",
        fetchedAt: "2026-09-06T23:01:00Z", confirmedAt: "2026-09-06T23:02:00Z" },
    freshness: { status: "fresh", reason: "current" },
    summary: {}, details: {}, ...overrides
});

function source() {
    const sections = Object.fromEntries(FullExport.REQUIRED_SECTION_KEYS.map(name =>
        [name, envelope(name)]));
    sections.marketSnapshot = envelope("marketSnapshot", { summary: { available: true,
        value: 42125, mode: "automatic", source: "qri", contract: "2026-09" } });
    sections.overallV2 = envelope("overallV2", { status: "partial",
        reason: "overall_v2_partial", summary: { status: "partial", direction: 24,
            confidence: 81, coverage: 50,
            interpretation: FullExport.SAFE_INTERPRETATION }, details: { result: {
                components: { option: { available: true }, weekly: { available: false } } } } });
    sections.qriOptions = envelope("qriOptions", { summary: { contract: "2026-09" } });
    sections.qriOptionsNextContract = envelope("qriOptionsNextContract", {
        freshness: { status: "stale", reason: "saved_last_valid", origin: "history",
            dataTradingDate: "2026-09-07", expectedTradingDate: "2026-09-07",
            expectedTradingDateSource: "formal_calendar_history_readonly",
            payloadValidation: "valid", dateRelation: "matched",
            consumerState: "valid_saved_fallback", staleReason: "saved_data_origin" },
        summary: { contract: "2026-10", tradingDate: "2026-09-07" } });
    sections.qriOptionsMajorSqNextContract = envelope("qriOptionsMajorSqNextContract", {
        status: "unavailable", reason: "major_sq_locator_unavailable",
        freshness: { status: "unavailable", reason: "major_sq_locator_unavailable" },
        asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
            pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
        summary: null, details: null });
    sections.qriHistoryComparison = envelope("qriHistoryComparison", { summary: {
        previousTradingDate: "2026-09-04", currentTradingDate: "2026-09-07" } });
    sections.qriOptionIv = envelope("qriOptionIv", { status: "partial",
        reason: "formal_iv_roles_partial", freshness: { status: "mixed",
            reason: "multiple_role_freshness" }, summary: { roles: {
                active: { status: "available", reason: null, contract: "2026-09",
                    tradingDate: "2026-09-07", payloadId: "iv-active",
                    freshness: { status: "fresh", reason: "current" } },
                next: { status: "available", reason: null, contract: "2026-10",
                    tradingDate: "2026-09-07", payloadId: "iv-next",
                    freshness: { status: "saved", reason: "formal_history" } },
                major_sq: { status: "unavailable", reason: "formal_iv_revision_unavailable",
                    contract: null, tradingDate: null, payloadId: null,
                    freshness: { status: "unavailable", reason: "role_unavailable" } }
            } } });
    sections.weeklyFutures = envelope("weeklyFutures", { asOf: {
        tradingDate: null, sourceDate: "2026-08-28", snapshotDate: null,
        pageUpdatedAt: null, fetchedAt: null, confirmedAt: null } });
    sections.weeklyOptions = envelope("weeklyOptions", { asOf: {
        tradingDate: null, sourceDate: "2026-08-28", snapshotDate: null,
        pageUpdatedAt: null, fetchedAt: null, confirmedAt: null } });
    sections.participants = envelope("participants", { status: "partial",
        reason: "night_jnet_unavailable", asOf: { tradingDate: null,
            sourceDate: "2026-09-04", snapshotDate: null, pageUpdatedAt: null,
            fetchedAt: null, confirmedAt: null }, details: { records: [{ broker: "A" }] } });
    sections.morning = envelope("morning", { details: {
        baselineIdentity: { baselineId: "baseline-1", versionKey: "baseline-v1",
            capturedAt: "2026-09-06T22:50:00Z", privateExtra: "excluded" },
        currentIdentity: { baselineId: "current-1", versionKey: "current-v1",
            capturedAt: "2026-09-06T23:00:00Z", records: [1, 2, 3] },
        comparison: { records: Array.from({ length: 100 }, (_, index) => index) } } });
    return {
        exportMeta: { generatedAt: "2026-09-07T08:30:00+09:00", timeZone: "Asia/Tokyo",
            profile: "full", appVersion: "1", readOnly: true },
        compactSummary: { generatedAt: "2026-09-07T08:30:00+09:00",
            market: "Nikkei 225 derivatives", session: { status: "verified" },
            currentPrice: { value: 42125 }, currentContract: "2026-09",
            overallV2: { interpretation: FullExport.SAFE_INTERPRETATION },
            morningChange: {}, importantLevels: {}, qriHighlights: [],
            freshnessIssues: [{ section: "qriOptionsNextContract", status: "stale",
                reason: "saved_last_valid", origin: "history",
                dataTradingDate: "2026-09-07", expectedTradingDate: "2026-09-07",
                expectedTradingDateSource: "formal_calendar_history_readonly",
                payloadValidation: "valid", dateRelation: "matched",
                consumerState: "valid_saved_fallback",
                staleReason: "saved_data_origin" }], warnings: [] },
        sections,
        warnings: [{ code: "qriOptionsMajorSqNextContract_unavailable",
            section: "qriOptionsMajorSqNextContract", reason: "major_sq_locator_unavailable" }]
    };
}

function resolvePointer(root, pointer) {
    return pointer.split("/").slice(1).reduce((value, part) =>
        value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

test("Formal section values are copied with group provenance without promotion", () => {
    const input = source();
    const result = AiSummary.buildFullExportAiSummary(input);
    assert.equal(result.status, "available");
    assert.equal(result.summary.generatedAt, input.exportMeta.generatedAt);
    assert.deepEqual(result.summary.market, {
        sourceSection: "marketSnapshot", sourcePointer: "/sections/marketSnapshot",
        status: "available", reason: null, freshnessStatus: "fresh",
        freshnessReason: "current", tradingDate: "2026-09-07", currentPrice: 42125,
        currentPriceMode: "automatic", currentContract: "2026-09"
    });
    assert.deepEqual(result.summary.overallV2.availableComponents, ["option"]);
    assert.deepEqual(result.summary.overallV2.unavailableComponents, ["weekly"]);
    assert.equal(result.summary.overallV2.status, "partial");
    assert.equal(result.summary.overallV2.direction, 24);
    assert.equal(result.summary.qriContracts.active.contract, "2026-09");
    assert.equal(result.summary.qriContracts.next.contract, "2026-10");
    assert.equal(result.summary.qriContracts.next.freshnessStatus, "stale");
    assert.deepEqual(result.summary.qriContracts.next.freshnessProvenance, {
        dataTradingDate: "2026-09-07", expectedTradingDate: "2026-09-07",
        expectedTradingDateSource: "formal_calendar_history_readonly", origin: "history",
        payloadValidation: "valid", dateRelation: "matched",
        consumerState: "valid_saved_fallback", staleReason: "saved_data_origin"
    });
    assert.equal(result.summary.qriContracts.majorSq.status, "unavailable");
    assert.equal(result.summary.qriContracts.majorSq.contract, null);
    assert.equal(result.summary.qriHistoryComparison.previousSourceDate, "2026-09-04");
    assert.equal(result.summary.qriOptionIv.sourcePointer, "/sections/qriOptionIv");
    assert.equal(result.summary.qriOptionIv.roles.next.payloadId, "iv-next");
    assert.equal(result.summary.qriOptionIv.roles.majorSq.status, "unavailable");
    assert.equal(result.summary.weekly.futures.sourceDate, "2026-08-28");
});

test("Morning identities use a fixed allowlist and raw records are never copied", () => {
    const result = AiSummary.buildFullExportAiSummary(source());
    assert.equal(result.summary.morning.baselineIdentity.baselineId, "baseline-1");
    assert.equal(result.summary.morning.baselineIdentity.privateExtra, undefined);
    assert.equal(result.summary.morning.currentIdentity.records, undefined);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /"broker"|"records"|privateExtra/);
});

test("data quality keeps section status and freshness separate and deduplicates exact issues", () => {
    const result = AiSummary.buildFullExportAiSummary(source());
    const issues = result.summary.dataQuality.affectedSections;
    assert.equal(issues.filter(issue => issue.section === "overallV2" &&
        issue.issueType === "section_status" && issue.status === "partial").length, 1);
    assert.equal(issues.filter(issue => issue.section === "qriOptionsNextContract" &&
        issue.issueType === "freshness" && issue.status === "stale" &&
        issue.reason === "saved_last_valid").length, 1);
    const next = issues.find(issue => issue.section === "qriOptionsNextContract" &&
        issue.issueType === "freshness");
    assert.deepEqual([next.payloadValidation, next.consumerState, next.origin],
        ["valid", "valid_saved_fallback", "history"]);
    assert.equal(issues.some(issue => Object.hasOwn(issue, "severity")), false);
    assert.ok(issues.some(issue => issue.section === "qriOptionIv.next" &&
        issue.issueType === "freshness" && issue.status === "saved"));
    assert.ok(issues.some(issue => issue.section === "qriOptionIv.major_sq" &&
        issue.issueType === "role_status" && issue.status === "unavailable"));
    assert.equal(result.summary.dataQuality.warnings[0].sourcePointer, "/warnings/0");
});

test("reading order is fixed and every source pointer resolves", () => {
    const input = source();
    const result = AiSummary.buildFullExportAiSummary(input);
    assert.deepEqual(result.summary.readingOrder.map(item => item.section),
        AiSummary.SECTION_ORDER.filter(name => input.sections[name]));
    for (const item of result.summary.readingOrder) {
        assert.ok(resolvePointer(input, item.pointer));
    }
    for (const item of [result.summary.market, result.summary.overallV2,
        ...Object.values(result.summary.qriContracts), result.summary.qriHistoryComparison,
        result.summary.qriOptionIv, ...Object.values(result.summary.weekly), result.summary.morning]) {
        assert.equal(resolvePointer(input, item.sourcePointer), input.sections[item.sourceSection]);
    }
});

test("builder is deterministic, detached, recursively frozen, and does not mutate input", () => {
    const input = source(); const before = structuredClone(input);
    const first = AiSummary.buildFullExportAiSummary(input);
    const reordered = source();
    reordered.sections = Object.fromEntries(Object.entries(reordered.sections).reverse());
    const second = AiSummary.buildFullExportAiSummary(reordered);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(first.summary.qriContracts.next), true);
    assert.throws(() => { first.summary.readingOrder.push({}); }, TypeError);
});

test("invalid, circular, non-plain, and security-invalid input fail closed", () => {
    const circular = source(); circular.sections.marketSnapshot.self = circular;
    const nonPlain = source(); nonPlain.sections.marketSnapshot.details = new Date();
    const forbidden = source(); forbidden.warnings.push({ secret: "no" });
    for (const input of [null, circular, nonPlain, forbidden]) {
        const result = AiSummary.buildFullExportAiSummary(input);
        assert.equal(result.status, "unavailable");
        assert.equal(result.summary, null);
        assert.equal(Object.isFrozen(result), true);
    }
});

test("summary size does not grow with raw record count", () => {
    const small = source(); const large = source();
    small.sections.qriOptions.details.records = [{ strike: 1 }];
    large.sections.qriOptions.details.records = Array.from({ length: 10000 }, (_, strike) => ({ strike }));
    small.sections.participants.details.records = [{ broker: "A" }];
    large.sections.participants.details.records = Array.from({ length: 10000 }, () => ({ broker: "A" }));
    const smallSize = JSON.stringify(AiSummary.buildFullExportAiSummary(small)).length;
    const largeSize = JSON.stringify(AiSummary.buildFullExportAiSummary(large)).length;
    assert.equal(largeSize, smallSize);
    assert.ok(smallSize < 10000, `summary size was ${smallSize}`);
});

test("optional aiSummary passes the v1 generic envelope while legacy v1 stays valid", () => {
    const input = source();
    const legacy = FullExport.buildFullExport(input);
    assert.equal(FullExport.validateFullExport(legacy).valid, true);
    input.sections.aiSummary = AiSummary.buildFullExportAiSummary(input);
    const additive = FullExport.buildFullExport(input);
    assert.equal(additive.schemaVersion, "optionmap-full-export-v1");
    assert.equal(FullExport.REQUIRED_SECTION_KEYS.includes("aiSummary"), false);
    assert.equal(FullExport.validateFullExport(additive).valid, true);
    assert.equal(Object.isFrozen(additive.sections.aiSummary.summary), true);
});

test("foundation source has no runtime, storage, network, DOM, eval, clock, or random dependency", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/fullExportAiSummary.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(|document\.|ipcRenderer|ipcMain/);
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function|Function\s*\(|Date\.now|Math\.random/);
    assert.doesNotMatch(code, /\bsession\s*:/);
    assert.doesNotMatch(code, /\.\.\.value|\.\.\.source\b|\.\.\.section\b/);
});
