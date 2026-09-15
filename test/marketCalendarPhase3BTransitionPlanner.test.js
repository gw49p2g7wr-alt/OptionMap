"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const T1 = "2026-09-16T05:15:58.893Z", T2 = "2026-09-16T06:00:00.000Z";
const H1 = "a".repeat(64), H2 = "b".repeat(64), EH = "c".repeat(64);
function event(hash = H1, evidenceKey = "source|sha256:e1") { return { eventKey: "JP|BOJ|BOJ_MPM|2026-09|regular|national",
    revisionKey: `JP|BOJ|BOJ_MPM|2026-09|regular|national|sha256:${hash}`,
    canonicalContentHash: hash, acquisitionEvidenceKey: evidenceKey, acquisitionEvidenceHash: EH,
    acquisitionEvidence: { fetchedAt: T1, parserVersion: 1 }, logical: { eventType: "BOJ_MPM" },
    schedule: { kind: "date_only" }, title: { ja: "会合" } }; }
const run = (id, acceptedAt = T1) => ({ sourceId: "source", runId: id, acceptedAt,
    fetchedAt: [T1], status: "accepted", semanticSetHash: H1 });

test("initial planはrevision/evidence/observationをappend", () => {
    const result = Planner.planTransition({ run: run("r1"), canonicalSet: [event()] });
    assert.equal(result.ok, true); assert.equal(result.plan.appendRevisions[0].validFrom, T1);
    assert.equal(result.plan.appendRevisions[0].revisionOrigin, "initial_observation");
    assert.equal(result.plan.appendEvidence.length, 1);
    assert.equal(result.plan.appendObservations[0].state, "observed");
});

test("semantic unchangedはrevisionを作らずevidenceだけappend", () => {
    const e = event(), snapshot = { entries: [{ eventKey: e.eventKey, sourceId: "source",
        activeRevisionKey: e.revisionKey }], revisions: [{ ...e, validFrom: T1, validTo: null }],
        evidence: [], observations: [], runs: [], cursors: [{ sourceId: "source", acceptedAt: T1 }] };
    const result = Planner.planTransition({ snapshot, run: run("r2", T2),
        canonicalSet: [event(H1, "source|sha256:e2")] });
    assert.equal(result.plan.appendRevisions.length, 0); assert.equal(result.plan.closeRevisions.length, 0);
    assert.equal(result.plan.appendEvidence.length, 1);
});

test("semantic changeは同じboundaryでcloseとappend", () => {
    const old = event(), snapshot = { entries: [{ eventKey: old.eventKey, sourceId: "source",
        activeRevisionKey: old.revisionKey }], revisions: [{ ...old, validFrom: T1, validTo: null }],
        runs: [], cursors: [{ sourceId: "source", acceptedAt: T1 }] };
    const result = Planner.planTransition({ snapshot, run: run("r2", T2), canonicalSet: [event(H2)] });
    assert.equal(result.plan.closeRevisions[0].validTo, T2);
    assert.equal(result.plan.appendRevisions[0].validFrom, T2);
    assert.equal(result.plan.appendRevisions[0].revisionOrigin, "authority_semantic_change");
});

test("disappearanceはlifecycle revisionを作らずobservationだけ", () => {
    const old = event(), snapshot = { entries: [{ eventKey: old.eventKey, sourceId: "source",
        activeRevisionKey: old.revisionKey }], revisions: [{ ...old, validFrom: T1, validTo: null }],
        runs: [], cursors: [{ sourceId: "source", acceptedAt: T1 }] }, other = { ...event(),
            eventKey: "other", revisionKey: `other|sha256:${H1}` };
    const result = Planner.planTransition({ snapshot, run: run("r2", T2), canonicalSet: [other],
        coverage: { confirmed: true, eventKeys: [old.eventKey] } });
    assert.equal(result.plan.closeRevisions.length, 0);
    assert.equal(result.plan.appendObservations.find(x => x.eventKey === old.eventKey).state, "unobserved");
});

test("duplicate runはidempotentまたはconflict", () => {
    const snapshot = { runs: [{ ...run("r1"), semanticSetHash: H1 }], cursors: [] };
    assert.equal(Planner.planTransition({ snapshot, run: run("r1"), canonicalSet: [event()] }).outcome,
        "already_committed");
    assert.equal(Planner.planTransition({ snapshot, run: { ...run("r1"), semanticSetHash: H2 },
        canonicalSet: [event()] }).outcome, "duplicate_run_conflict");
});
