"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Change = require("../js/fullExportChangeSummary.js");
const AiSummary = require("../js/fullExportAiSummary.js");
const Security = require("../js/fullExportSecurity.js");
const FullExport = require("../js/fullExport.js");

const fresh = (status = "fresh", reason = "current_session") => ({ status, reason });
function authority(source, overrides = {}) {
    return { source, sourceClass: "formal_history", origin: "history",
        formalStatus: "verified", versionKey: `${source}-current`,
        signature: `${source}-signature`, ...overrides };
}
function envelope(source, overrides = {}) {
    return { status: "available", reason: null, authority: authority(source),
        asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
            pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
        freshness: fresh(), summary: {}, details: {}, ...overrides };
}
function sections({ intrinsic = true } = {}) {
    const result = {
        marketSnapshot: envelope("qri-nikkei225-futures", { authority: authority(
            "qri-nikkei225-futures", { sourceClass: "formal_live", origin: "live" }),
        summary: { value: 101, contract: "2026-12" } }),
        qriOptions: envelope("qri-nikkei225-options", {
            summary: { contract: "2026-11" }, authority: authority("qri-nikkei225-options",
                { versionKey: "qri-current", signature: "qri-current-signature" }) }),
        qriOptionsNextContract: envelope("qri-nikkei225-options", {
            summary: { contract: "2026-12", callAggregate: { value: 200 },
                putAggregate: { value: 180 } } }),
        qriOptionsMajorSqNextContract: envelope("qri-nikkei225-options", {
            summary: { contract: "2027-03", callAggregate: { value: 150 },
                putAggregate: { value: 170 } } }),
        qriOptionIv: envelope("qri-nikkei225-option-iv", { summary: { roles: {
            active: { status: "available", reason: null, contract: "2026-11",
                payloadId: "iv-active", sourceClass: "formal_history",
                formalStatus: "verified", freshness: fresh() },
            next: { status: "available", reason: null, contract: "2026-12",
                payloadId: "iv-next", sourceClass: "formal_history",
                formalStatus: "verified", freshness: fresh() },
            major_sq: { status: "available", reason: null, contract: "2027-03",
                payloadId: "iv-major", sourceClass: "formal_history",
                formalStatus: "verified", freshness: fresh() }
        } } }),
        weeklyFutures: envelope("weekly-futures", { details: intrinsic ? {
            previousIdentity: { sourceDate: "2026-10-02", versionKey: "weekly-old" },
            currentIdentity: { sourceDate: "2026-10-09", versionKey: "weekly-new" }
        } : {} }),
        weeklyOptions: envelope("weekly-options", { summary: { expiry: "2026-11" },
            details: intrinsic ? { comparison: { source: "formal_weekly_options_history",
                available: true, status: "comparable", previousSourceDate: "2026-10-02",
                currentSourceDate: "2026-10-09", previousVersionKey: "options-old",
                currentVersionKey: "options-new", changes: { strikeChanges: [
                    { strike: 50000, status: "continued", delta: 4 }] } } } : {} }),
        participants: envelope("participants", { summary: { recordCount: 20 } }),
        overallV2: envelope("overall-v2", { summary: { direction: 12, confidence: 80 } }),
        morning: envelope("morning-v4", { summary: { priceDelta: 20,
            supplyDemandDelta: 3, qriContract: "2026-11", futuresContract: "2026-12",
            contractRelation: "independent_cross_contract" }, details: intrinsic ? {
                baselineIdentity: { versionKey: "morning-old" },
                currentIdentity: { versionKey: "morning-new" },
                comparison: { status: "comparable", divergence: { priceDelta: 20,
                    supplyDemandDelta: 3 } }
            } : {} }),
        morningV5Formal: envelope("formal-morning-v5", { summary: {
            observationId: "observation-current", qriContract: "2026-11",
            futuresContract: "2026-12", contractRelation: "independent_cross_contract" },
        authority: authority("formal-morning-v5", { versionKey: "morning-v5-current",
            signature: "morning-v5-current-signature" }), details: {
            baselineSelection: { baselineObservationId: null },
            comparison: { aggregateClass: "first_observation" },
            sourceIdentities: { overall: { direction: 12, confidence: 80 },
                futures: { value: 68000 } }
        } }),
        importantLevels: envelope("important-levels", { summary: {
            upper: { price: 68500 }, lower: { price: 67500 } } }),
        qriHistoryComparison: intrinsic ? envelope("formal_qri_options_history", {
            authority: authority("formal_qri_options_history", { versionKey: "qri-current" }),
            summary: { previousTradingDate: "2026-10-16", currentTradingDate: "2026-10-19",
                highlights: [{ optionType: "call", netDelta: 25,
                    topIncreases: [{ strike: 68000, delta: 25 }], topDecreases: [],
                    newlyPublished: [], noLongerPublished: [] }] },
            details: { previousIdentity: { tradingDate: "2026-10-16",
                versionKey: "qri-previous", signature: "qri-previous-signature" },
            currentIdentity: { tradingDate: "2026-10-19", versionKey: "qri-current",
                signature: "qri-current-signature" }, comparison: { accepted: true } }
        }) : envelope("formal_qri_options_history", { status: "unavailable",
            reason: "comparison_unavailable", summary: null, details: null }),
        intelligence: envelope("intelligence", { summary: { snapshotCount: 2 } })
    };
    const readinessTargets = ["marketSnapshot", "qriOptions", "qriOptionsNextContract",
        "qriOptionsMajorSqNextContract", "weeklyFutures", "weeklyOptions", "participants",
        "overallV2", "morning", "morningV5Formal", "importantLevels", "intelligence",
        "qriOptionIv.active", "qriOptionIv.next", "qriOptionIv.major_sq"];
    result.consumerReadiness = envelope("optionmap-full-export", {
        authority: authority("optionmap-full-export", { sourceClass: "derived_index",
            origin: "runtime", formalStatus: "derived", versionKey: null, signature: null }),
        freshness: { status: "not_applicable", reason: "index_only" },
        summary: { vocabularyVersion: 1, authoritativeRoot: "/sections",
            entries: Object.fromEntries(readinessTargets.map(name => [name,
                { status: "available", readiness: "current", reason: null }])) } });
    return result;
}
function accepted(domain, previousSections) {
    return { domain, selection: "accepted_persisted_export", sections: previousSections,
        persistence: { contract: "optionmap-full-export-predecessor-v1",
            contractVersion: 1, status: "accepted",
            versionKey: "export-previous", signature: "export-previous-signature" } };
}

test("P16 first observation is explicit and historical-only domains are not comparable", () => {
    const result = Change.buildChangeSummary({ sections: sections({ intrinsic: false }) });
    assert.equal(result.status, "available");
    assert.equal(result.summary.comparisonStatus, "first_observation");
    assert.equal(result.summary.domains.marketSnapshot.category, "first_observation");
    assert.equal(result.summary.domains.qriHistoryComparison.category, "not_comparable");
    assert.equal(result.summary.domains.intelligence.category, "not_comparable");
});

test("P16 unchanged accepted identity remains unchanged", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    assert.equal(result.summary.domains.marketSnapshot.category, "unchanged");
    assert.equal(result.summary.domains.marketSnapshot.identityTransition.category, "unchanged");
});

test("P16 unaccepted process-memory predecessor is rejected", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.marketSnapshot.summary.value = 1;
    const result = Change.buildChangeSummary({ sections: current, predecessors: {
        marketSnapshot: { domain: "marketSnapshot", selection: "previous_process_memory",
            sections: previous }
    } });
    assert.equal(result.summary.domains.marketSnapshot.category, "first_observation");
    assert.equal(result.summary.domains.marketSnapshot.predecessorSelection, null);
});

test("P16 unavailable to available is an objective added status transition", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.marketSnapshot.status = "unavailable";
    previous.marketSnapshot.reason = "current_price_unavailable";
    previous.marketSnapshot.summary = null;
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    assert.equal(result.summary.domains.marketSnapshot.category, "added");
    assert.deepEqual(result.summary.domains.marketSnapshot.statusTransition, {
        category: "added",
        previous: { status: "unavailable", reason: "current_price_unavailable" },
        current: { status: "available", reason: null }
    });
});

test("P16 stale reference to fresh current preserves freshness reasons", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.marketSnapshot.freshness = { status: "stale", reason: "stale_reference" };
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    assert.deepEqual(result.summary.domains.marketSnapshot.freshnessTransition, {
        category: "changed", previous: { status: "stale", reason: "stale_reference" },
        current: { status: "fresh", reason: "current_session" }
    });
});

test("P16 P15 readiness transition reuses exact readiness and reason facts", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.consumerReadiness.summary.entries.marketSnapshot = {
        status: "available", readiness: "reference", reason: "saved_last_valid",
        freshnessReason: "saved_last_valid" };
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    const transition = result.summary.domains.marketSnapshot.readinessTransition;
    assert.equal(transition.category, "changed");
    assert.equal(transition.previous.readiness, "reference");
    assert.equal(transition.previous.reason, "saved_last_valid");
    assert.equal(transition.current.readiness, "current");
});

test("P16 same-contract formally comparable value emits an exact numeric delta", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.marketSnapshot.summary.value = 99;
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    assert.deepEqual(result.summary.domains.marketSnapshot.valueTransition.fields.value, {
        category: "changed", previous: 99, current: 101, delta: 2
    });
});

test("P16 contract roll is explicit and cross-contract values are not comparable", () => {
    const current = sections({ intrinsic: false }), previous = structuredClone(current);
    previous.marketSnapshot.summary.contract = "2026-09";
    previous.marketSnapshot.summary.value = 65000;
    const result = Change.buildChangeSummary({ sections: current,
        predecessors: { marketSnapshot: accepted("marketSnapshot", previous) } });
    const domain = result.summary.domains.marketSnapshot;
    assert.equal(domain.contractTransition.category, "changed");
    assert.equal(domain.valueTransition.category, "not_comparable");
    assert.equal(domain.valueTransition.reason, "contract_transition");
});

test("P16 Morning V5 uses the persisted supersedes baseline and existing comparison", () => {
    const current = sections({ intrinsic: false });
    current.morningV5Formal.details.baselineSelection.baselineObservationId = "observation-previous";
    current.morningV5Formal.details.comparison = { aggregateClass: "full",
        supply: { comparable: true, delta: 2 }, price: { comparable: true, delta: 100 } };
    const previous = { observationId: "observation-previous", versionKey: "morning-v5-previous",
        signature: "morning-v5-previous-signature", freshness: fresh(),
        contractContext: { qriContract: "2026-11", futuresContract: "2026-12",
            relation: "independent_cross_contract" },
        result: { supplyDirection: 10, supplyConfidence: 75, futuresPrice: 67900 } };
    const latest = { observationId: "observation-current", versionKey: "morning-v5-current",
        signature: "morning-v5-current-signature", freshness: fresh(),
        contractContext: { qriContract: "2026-11", futuresContract: "2026-12",
            relation: "independent_cross_contract" },
        result: { supplyDirection: 12, supplyConfidence: 80, futuresPrice: 68000 } };
    const result = Change.buildChangeSummary({ sections: current,
        evidence: { morningV5Observations: [previous, latest] } });
    const domain = result.summary.domains.morningV5Formal;
    assert.equal(domain.predecessorSelection, "same_domain_formal_history");
    assert.equal(domain.identityTransition.previous.observationId, "observation-previous");
    assert.equal(domain.valueTransition.evidencePointer,
        "/sections/morningV5Formal/details/comparison");
    assert.equal(domain.valueTransition.category, "changed");
    assert.deepEqual(domain.valueTransition.reusedEvidence,
        current.morningV5Formal.details.comparison);
});

test("P16 QRI OI reuses the accepted formal comparison without recalculation", () => {
    const current = sections(), result = Change.buildChangeSummary({ sections: current });
    const domain = result.summary.domains.qriOptions;
    assert.equal(domain.predecessorSelection, "same_domain_formal_history");
    assert.equal(domain.valueTransition.evidencePointer,
        "/sections/qriHistoryComparison/details/comparison");
    assert.deepEqual(domain.valueTransition.reusedEvidence.highlights,
        current.qriHistoryComparison.summary.highlights);
    assert.equal(result.summary.unchangedCritical[0].fact, "active_qri_contract");
});

test("P16 AI Summary only points to the one change index", () => {
    const current = sections();
    current.changeSummary = Change.buildChangeSummary({ sections: current });
    const source = { exportMeta: {
        generatedAt: "2026-10-19T08:00:00+09:00" }, compactSummary: {},
    sections: current, warnings: [] };
    const inspected = Security.inspectFullExportSecurity(source);
    assert.equal(inspected.valid, true, JSON.stringify(inspected));
    const ai = AiSummary.buildFullExportAiSummary(source);
    assert.equal(ai.status, "available", JSON.stringify(ai));
    assert.deepEqual(ai.summary.changeSummary, {
        sourceSection: "changeSummary", sourcePointer: "/sections/changeSummary",
        status: "available", reason: null, comparisonVocabularyVersion: 1,
        comparisonStatus: current.changeSummary.summary.comparisonStatus,
        changedDomainCount: current.changeSummary.summary.changedDomainCount
    });
    assert.equal(Object.hasOwn(ai.summary.changeSummary, "domains"), false);
});

test("P16 output is deterministic, frozen, non-authoritative and has no write/network layer", () => {
    const current = sections(), first = Change.buildChangeSummary({ sections: current });
    const second = Change.buildChangeSummary({ sections: structuredClone(current) });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(Object.isFrozen(first.summary.domains.marketSnapshot), true);
    assert.equal(first.authority.formalStatus, "derived");
    assert.equal(first.details.interpretation, "objective_facts_only_no_trade_interpretation");
    assert.equal(FullExport.SCHEMA_VERSION, "optionmap-full-export-v1");
    assert.equal(FullExport.REQUIRED_SECTION_KEYS.includes("changeSummary"), false);
    const source = fs.readFileSync(path.join(__dirname,
        "../js/fullExportChangeSummary.js"), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|indexedDB|ipcRenderer|ipcMain|BUY|SELL/);
});
