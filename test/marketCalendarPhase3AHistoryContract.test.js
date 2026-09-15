"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Contract = require("../js/marketCalendarHistory/historyContract.js");
const T1 = "2026-09-16T05:15:58.893Z", T2 = "2026-09-16T05:16:00.000Z";

test("acceptedAtはfetch後かつsource cursorよりstrictly monotonic", () => {
    const run = { sourceId: "us-bls-calendar", runId: "run-1", status: "accepted",
        acceptedAt: T2, fetchedAt: [T1] };
    assert.equal(Contract.validateAcceptedRun(run, { previousAcceptedAt: T1 }).valid, true);
    assert.deepEqual(Contract.validateAcceptedRun({ ...run, acceptedAt: T1 },
        { previousAcceptedAt: T1 }).errors, ["accepted_at_not_monotonic"]);
    assert.deepEqual(Contract.validateAcceptedRun({ ...run, acceptedAt: T1, fetchedAt: [T2] }).errors,
        ["accepted_before_fetch"]);
});

test("revision intervalはUTC millisecond half-openの正区間", () => {
    assert.equal(Contract.validateInterval({ validFrom: T1, validTo: T2 }).valid, true);
    assert.equal(Contract.validateInterval({ validFrom: T1, validTo: null }).valid, true);
    assert.deepEqual(Contract.validateInterval({ validFrom: T1, validTo: T1 }).errors,
        ["interval_not_positive"]);
});

test("unobservedはcoverage確認なしに生成できない", () => {
    const base = { eventKey: "event", sourceId: "source", runId: "run", acceptedAt: T1 };
    assert.deepEqual(Contract.validateObservation({ ...base, state: "unobserved" }).errors,
        ["unobserved_without_coverage"]);
    assert.equal(Contract.validateObservation({ ...base, state: "source_incomplete" }).valid, true);
});

test("authority/parser/migration originとobservation stateを固定", () => {
    assert.deepEqual(Contract.REVISION_ORIGINS, ["initial_observation", "authority_semantic_change",
        "parser_interpretation_change", "canonical_schema_migration", "manual_repair"]);
    assert.ok(Contract.OBSERVATION_STATES.includes("unobserved"));
    assert.ok(!Contract.OBSERVATION_STATES.includes("cancelled"));
});
