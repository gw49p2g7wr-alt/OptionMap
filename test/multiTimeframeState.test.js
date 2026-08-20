const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../js/multiTimeframeState.js");

const AS_OF = "2026-08-21T03:00:00.000Z";
const directionValue = direction => ({ up: 1, down: -1, neutral: 0 })[direction];
const quality = status => ({ status, warnings: status === "complete" ? [] : [status] });
const morning = (direction = "up", overrides = {}) => ({ available: true, direction,
    priceDelta: directionValue(direction), capturedAt: "2026-08-21T00:00:00.000Z",
    comparedAt: AS_OF, contract: "2026-09", quality: quality("complete"), ...overrides });
const previous = (direction = "up", overrides = {}) => ({ available: true, reason: null, direction,
    priceDelta: directionValue(direction), percentChange: directionValue(direction) / 100,
    previous: { observedAt: "2026-08-21T02:30:00.000Z", contract: "2026-09" },
    current: { observedAt: AS_OF, contract: "2026-09" }, elapsedMs: 30 * 60 * 1000,
    contract: "2026-09", boundary: null, quality: quality("complete"), ...overrides });
const medium = (direction = "up", overrides = {}) => ({ available: true,
    direction: directionValue(direction), directionLabel: direction === "up" ? "買い優勢"
        : direction === "down" ? "売り優勢" : "中立", confidence: 80, coverage: 100,
    agreement: 75, status: "complete", ...overrides });
const state = (a = "up", b = "up", c = "up", overrides = {}) =>
    api.createMultiTimeframeState({ asOf: AS_OF, marketDate: "2026-08-21",
        morning: morning(a), previousObservation: previous(b), mediumTerm: medium(c), ...overrides });

test("allAligned is true only for all-up and all-down", () => {
    assert.equal(state("up", "up", "up").relationship.allAligned, true);
    assert.equal(state("down", "down", "down").relationship.allAligned, true);
    assert.equal(state("neutral", "neutral", "neutral").relationship.allAligned, false);
    assert.equal(state("up", "up", "down").relationship.allAligned, false);
});

test("explicit directional fixtures produce only factual pair relationships", () => {
    const fixtures = [
        ["down", "up", "up", ["opposite_direction", "same_direction", "opposite_direction"]],
        ["down", "down", "up", ["opposite_direction", "opposite_direction", "same_direction"]],
        ["up", "down", "up", ["same_direction", "opposite_direction", "opposite_direction"]],
        ["up", "up", "down", ["opposite_direction", "opposite_direction", "same_direction"]],
        ["down", "up", "down", ["same_direction", "opposite_direction", "opposite_direction"]],
        ["up", "down", "down", ["opposite_direction", "same_direction", "opposite_direction"]]
    ];
    for (const [a, b, c, expected] of fixtures) {
        const relationship = state(a, b, c).relationship;
        assert.deepEqual([relationship.morningVsMedium, relationship.previousVsMedium,
            relationship.morningVsPrevious], expected);
    }
});

test("all 27 up/down/neutral combinations have consistent relationships", () => {
    const directions = ["up", "down", "neutral"];
    const combinations = [];
    for (const a of directions) for (const b of directions) for (const c of directions) {
        const result = state(a, b, c);
        combinations.push(`${a}|${b}|${c}`);
        assert.equal(result.status, "complete");
        assert.equal(result.relationship.morningVsMedium, api.pairRelationship(a, c));
        assert.equal(result.relationship.previousVsMedium, api.pairRelationship(b, c));
        assert.equal(result.relationship.morningVsPrevious, api.pairRelationship(a, b));
        assert.equal(result.relationship.allAligned,
            a === b && b === c && ["up", "down"].includes(a));
    }
    assert.equal(new Set(combinations).size, 27);
});

test("neutral is always neutral_mixed and never directional alignment", () => {
    assert.equal(api.pairRelationship("neutral", "neutral"), "neutral_mixed");
    assert.equal(api.pairRelationship("neutral", "up"), "neutral_mixed");
    assert.equal(api.pairRelationship("down", "neutral"), "neutral_mixed");
});

test("A, B or C unavailable makes the aggregate unavailable without filling direction", () => {
    const cases = [
        { morning: { available: false, reason: "not_captured" } },
        { previousObservation: { available: false, reason: "previous_comparable_unavailable" } },
        { mediumTerm: { available: false, reason: "overall_v2_unavailable" } }
    ];
    for (const override of cases) {
        const result = state("up", "up", "up", override);
        assert.equal(result.available, false);
        assert.equal(result.status, "unavailable");
        assert.equal(Object.values(result.relationship).includes("unavailable"), true);
    }
});

test("contract mismatch and rollover make B unavailable", () => {
    const mismatch = state("up", "up", "up", { previousObservation: previous("up", {
        available: false, reason: "contract_mismatch", boundary: "rollover_boundary" }) });
    assert.equal(mismatch.previousObservation.available, false);
    assert.equal(mismatch.previousObservation.reason, "contract_mismatch");
    assert.equal(mismatch.previousObservation.boundary, "rollover_boundary");
    const cross = state("up", "up", "up", { previousObservation: previous("up", {
        contract: "2026-12", current: { observedAt: AS_OF, contract: "2026-12" } }) });
    assert.equal(cross.previousObservation.reason, "contract_mismatch");
    assert.equal(cross.contract, null);
});

test("invalid A or B elapsed and timestamps safely stop that direction", () => {
    const invalidMorning = state("up", "up", "up", { morning: morning("up", {
        comparedAt: "2026-08-20T23:59:00.000Z" }) });
    assert.equal(invalidMorning.morning.reason, "morning_elapsed_invalid");
    const invalidPrevious = state("up", "up", "up", { previousObservation: previous("up", {
        elapsedMs: 1 }) });
    assert.equal(invalidPrevious.previousObservation.reason, "previous_elapsed_invalid");
    const invalidTimestamp = state("up", "up", "up", { previousObservation: previous("up", {
        previous: { observedAt: "08/21 11:30", contract: "2026-09" } }) });
    assert.equal(invalidTimestamp.previousObservation.reason, "previous_timestamp_invalid");
});

test("complete and partial quality are independent aggregate states", () => {
    assert.equal(state().status, "complete");
    const partial = state("up", "up", "up", { morning: morning("up", {
        quality: quality("partial") }) });
    assert.equal(partial.available, true);
    assert.equal(partial.status, "partial");
    assert.equal(partial.reason, "quality_partial");
    const stale = state("up", "up", "up", { previousObservation: previous("up", {
        quality: quality("stale") }) });
    assert.equal(stale.status, "partial");
});

test("numeric and existing side directions normalize without a threshold", () => {
    assert.deepEqual([api.normalizeDirection(1), api.normalizeDirection(-1),
        api.normalizeDirection(0), api.normalizeDirection("up"), api.normalizeDirection("down")],
    ["up", "down", "neutral", "up", "down"]);
    const inconsistent = state("up", "up", "up", { morning: morning("up", { priceDelta: -1 }) });
    assert.equal(inconsistent.morning.reason, "morning_direction_inconsistent");
});

test("existing Morning comparison shape is adapted without changing its schema", () => {
    const existing = { available: true, reason: null,
        baselineCapturedAt: "2026-08-21T00:00:00.000Z", comparedAt: AS_OF,
        currentPrice: { available: true, delta: -20,
            current: { contract: "2026-09" } },
        dataQuality: { available: true, baselineStatus: "complete",
            currentStatus: "complete", transition: "unchanged" } };
    const result = state("up", "up", "up", { morning: existing });
    assert.equal(result.morning.direction, "down");
    assert.equal(result.morning.priceDelta, -20);
    assert.equal(result.morning.elapsedMs, 3 * 60 * 60 * 1000);
    assert.equal(result.morning.contract, "2026-09");
    assert.equal(result.morning.quality.status, "complete");
});

test("module remains runtime-only and disconnected from protected systems", () => {
    const root = path.resolve(__dirname, "..");
    const moduleText = fs.readFileSync(path.join(root, "js/multiTimeframeState.js"), "utf8");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const preview = fs.readFileSync(path.join(root, "js/mobileSummaryPreview.js"), "utf8");
    assert.doesNotMatch(html + preview, /OptionMapMultiTimeframeState/);
    assert.doesNotMatch(moduleText, /\bfetch\s*\(|ipcRenderer|indexedDB|localStorage|setInterval|setTimeout/);
    assert.doesNotMatch(moduleText, /resolveApproximatePrior|3h|6h|翌朝/);
    assert.doesNotMatch(moduleText, /entry|reversal|momentum|trend|score/i);
});
