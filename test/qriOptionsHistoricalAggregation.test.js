"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Aggregation = require("../js/qriOptionsHistoricalAggregation.js");

const build = Aggregation.buildQriHistoricalAggregation;

function snapshot(contract, date = "2026-08-31", facts = [
    { strike: 65000, call: { published: true, value: 100 },
        put: { published: true, value: 200 } }
]) {
    return { identity: { contract, tradingDate: date,
        entryKey: `${contract}|${date}`, activeVersionKey: `version-${contract}-${date}` },
    facts };
}

test("2 contracts completeをstrike/side別に合算", () => {
    const value = build({ snapshots: [snapshot("2026-09"), snapshot("2026-10")] });
    assert.equal(value.status, "available");
    assert.deepEqual(value.contracts, ["2026-09", "2026-10"]);
    assert.deepEqual(value.points[0].call, {
        total: 200, contributingContracts: 2, expectedContracts: 2,
        coverage: { contributed: 2, expected: 2, ratio: 1 }, complete: true,
        contributions: [
            { contract: "2026-09", presence: "published", published: true, value: 100 },
            { contract: "2026-10", presence: "published", published: true, value: 100 }
        ]
    });
});

test("3 contracts completeを上限なしで合算", () => {
    const value = build({ snapshots: [snapshot("2026-11"), snapshot("2026-09"),
        snapshot("2026-10")] });
    assert.equal(value.points[0].put.total, 600);
    assert.equal(value.points[0].put.expectedContracts, 3);
    assert.equal(value.points[0].put.complete, true);
});

test("2件未満はnot_enough_contracts", () => {
    assert.equal(build({ snapshots: [] }).reason, "not_enough_contracts");
    assert.equal(build({ snapshots: [snapshot("2026-09")] }).status, "unavailable");
    assert.equal(build().reason, "not_enough_contracts");
});

test("duplicate contractはsilent dedupeせずinvalid", () => {
    const value = build({ snapshots: [snapshot("2026-09"), snapshot("2026-09")] });
    assert.deepEqual([value.status, value.reason], ["invalid", "duplicate_contract"]);
});

test("tradingDate完全一致を要求しmismatchをreject", () => {
    assert.equal(build({ snapshots: [snapshot("2026-09"), snapshot("2026-10")] })
        .tradingDate, "2026-08-31");
    const value = build({ snapshots: [snapshot("2026-09", "2026-08-30"),
        snapshot("2026-10", "2026-08-31")] });
    assert.deepEqual([value.status, value.reason], ["invalid", "trading_date_mismatch"]);
});

test("strike unionをnumeric ascendingで返す", () => {
    const fact = (strike, value) => ({ strike,
        call: { published: true, value }, put: { published: true, value } });
    const value = build({ snapshots: [snapshot("2026-09", undefined,
        [fact(66000, 1), fact(65000, 2)]), snapshot("2026-10", undefined,
        [fact(66500, 3), fact(66000, 4)])] });
    assert.deepEqual(value.strikes, [65000, 66000, 66500]);
    assert.deepEqual(value.points.map(point => point.strike), value.strikes);
});

test("absent strikeをcontract別presenceとして保持", () => {
    const value = build({ snapshots: [snapshot("2026-09"), snapshot("2026-10", undefined,
        [{ strike: 65500, call: { published: true, value: 5 },
            put: { published: true, value: 6 } }])] });
    const call = value.points.find(point => point.strike === 65000).call;
    assert.equal(call.total, 100);
    assert.equal(call.complete, false);
    assert.deepEqual(call.contributions[1], { contract: "2026-10", presence: "absent",
        published: null, value: null });
});

test("CALL/PUT unpublishedを独立保持しcontributor 0はtotal null", () => {
    const facts = value => [{ strike: 65000,
        call: { published: false, value: null },
        put: { published: true, value } }];
    const value = build({ snapshots: [snapshot("2026-09", undefined, facts(3)),
        snapshot("2026-10", undefined, facts(4))] });
    assert.equal(value.points[0].call.total, null);
    assert.equal(value.points[0].call.contributingContracts, 0);
    assert.equal(value.points[0].call.contributions[0].presence, "unpublished");
    assert.equal(value.points[0].put.total, 7);
    assert.equal(value.status, "partial");
});

test("published true zeroは正式contribution", () => {
    const zero = [{ strike: 65000, call: { published: true, value: 0 },
        put: { published: true, value: 0 } }];
    const value = build({ snapshots: [snapshot("2026-09", undefined, zero),
        snapshot("2026-10", undefined, zero)] });
    assert.equal(value.points[0].call.total, 0);
    assert.equal(value.points[0].call.contributingContracts, 2);
    assert.equal(value.status, "available");
});

test("CALL complete / PUT partialをside別coverageで保持", () => {
    const first = [{ strike: 65000, call: { published: true, value: 1 },
        put: { published: false, value: null } }];
    const second = [{ strike: 65000, call: { published: true, value: 2 },
        put: { published: true, value: 3 } }];
    const value = build({ snapshots: [snapshot("2026-09", undefined, first),
        snapshot("2026-10", undefined, second)] });
    assert.equal(value.points[0].call.complete, true);
    assert.equal(value.points[0].put.complete, false);
    assert.deepEqual(value.points[0].put.coverage, { contributed: 1, expected: 2, ratio: 0.5 });
    assert.deepEqual([value.status, value.reason], ["partial", "partial_coverage"]);
});

test("CALL partial / PUT completeをside別coverageで保持", () => {
    const first = [{ strike: 65000, call: { published: false, value: null },
        put: { published: true, value: 1 } }];
    const value = build({ snapshots: [snapshot("2026-09", undefined, first),
        snapshot("2026-10")] });
    assert.equal(value.points[0].call.complete, false);
    assert.equal(value.points[0].put.complete, true);
});

test("全side contributor 0はno_records", () => {
    const missing = [{ strike: 65000, call: { published: false, value: null },
        put: { published: false, value: null } }];
    const value = build({ snapshots: [snapshot("2026-09", undefined, missing),
        snapshot("2026-10", undefined, missing)] });
    assert.deepEqual([value.status, value.reason], ["unavailable", "no_records"]);
    assert.equal(value.points[0].call.total, null);
});

test("invalid identity/facts/valueをfail-closed", () => {
    const badIdentity = snapshot("2026-09"); badIdentity.identity.entryKey = "bad";
    assert.equal(build({ snapshots: [badIdentity, snapshot("2026-10")] }).reason,
        "snapshot_invalid");
    const badValue = snapshot("2026-09"); badValue.facts[0].call.value = -1;
    assert.equal(build({ snapshots: [badValue, snapshot("2026-10")] }).status, "invalid");
    const badUnpublished = snapshot("2026-09");
    badUnpublished.facts[0].put = { published: false, value: 0 };
    assert.equal(build({ snapshots: [badUnpublished, snapshot("2026-10")] }).status,
        "invalid");
});

test("同一snapshot内duplicate strikeをreject", () => {
    const duplicate = snapshot("2026-09"); duplicate.facts.push(structuredClone(duplicate.facts[0]));
    assert.equal(build({ snapshots: [duplicate, snapshot("2026-10")] }).reason,
        "snapshot_invalid");
});

test("provenanceとephemeral identityはinput order非依存", () => {
    const a = snapshot("2026-09"); const b = snapshot("2026-10");
    a.source = "qri-nikkei225-options";
    const first = build({ snapshots: [a, b] });
    const second = build({ snapshots: [b, a] });
    assert.deepEqual(first, second);
    assert.equal(first.provenance.snapshots[0].source, "qri-nikkei225-options");
    assert.match(first.aggregationIdentity, /qri-historical-aggregation-v1/);
    assert.match(first.aggregationIdentity, /version-2026-10/);
});

test("input非mutation・detached・deep frozen・deterministic", () => {
    const snapshots = [snapshot("2026-09"), snapshot("2026-10")];
    const before = structuredClone(snapshots);
    const first = build({ snapshots }); const second = build({ snapshots });
    assert.deepEqual(snapshots, before);
    assert.deepEqual(first, second);
    assert.notEqual(first.points[0].call.contributions, snapshots[0].facts);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.points[0].call.contributions[0]), true);
    assert.throws(() => { first.points[0].call.total = 999; }, TypeError);
});

test("historical noticeだけを持ちcurrent/formal applicabilityを持たない", () => {
    const value = build({ snapshots: [snapshot("2026-09"), snapshot("2026-10")] });
    assert.deepEqual(value.notices, { historicalAggregation: true,
        isCurrent: false, hasPartialCoverage: false });
    for (const forbidden of ["formalEligible", "overallV2Eligible", "tradeDecisionEligible",
        "currentSelectorApplicable"]) assert.equal(forbidden in value, false);
});

test("storage/network/DOM/windowとhistorical追加計算へ非接続", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsHistoricalAggregation.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /\bwindow\b|\bdocument\b|Chart\s*\(|setTimeout|setInterval/);
    assert.doesNotMatch(source, /OverallV2|Morning|Formal|Evidence|Last.Valid|currentSelector|\bIV\b/);
    assert.doesNotMatch(source,
        /wall|top3|signal|comparison|currentPrice|\bATM\b|support|resistance/i);
    assert.doesNotMatch(source, /setItem|put\s*\(|add\s*\(|persist|save/);
});
