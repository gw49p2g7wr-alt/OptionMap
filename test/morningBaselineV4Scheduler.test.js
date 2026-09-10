const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Scheduler = require("../js/morningBaselineV4Scheduler.js");

const missing = () => ({ restoreStatus: "missing", integrityStatus: "missing",
    applicabilityStatus: "no_baseline", reason: "no_baseline" });
const applicable = () => ({ restoreStatus: "valid", integrityStatus: "valid",
    applicabilityStatus: "applicable", selectedBaselineId: "mb4-saved" });

test("application wiring gives automatic capture exclusively to the scheduler", () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.doesNotMatch(source, /runAutomaticFirstSuccessCapture/);
    assert.equal((source.match(/\.captureAutomatic\s*\(/g) || []).length, 1);
    assert.match(source, /formalBaselineRetryScheduler\s*=\s*window\.OptionMapMorningBaselineV4Scheduler/);
});

function fixture(options = {}) {
    let time = options.time || "2026-09-08T05:00:00+09:00";
    let restore = options.restore || missing(); const timers = []; const cleared = [];
    const captureCalls = []; const targetedCalls = [];
    const scheduler = Scheduler.createScheduler({ now: () => time,
        setTimer: (fn, delay) => { const value = { fn, delay }; timers.push(value); return value; },
        clearTimer: value => cleared.push(value), getRestoreState: () => restore,
        evaluateRestore: async () => restore, isUserRefreshActive: options.userRefresh || (() => false),
        createRequestId: value => `request-${value}`,
        captureAutomatic: async context => { captureCalls.push(context);
            const result = options.capture ? await options.capture(context) :
                { status: "waiting_for_eligibility", reason: "qri_ineligible" };
            if (result.saved) restore = applicable(); return result; },
        targetedRefresh: async (...args) => { targetedCalls.push(args[0]);
            return options.targeted || { status: "waiting", reason: "qri_ineligible", targetedSources: [] }; } });
    return { scheduler, timers, cleared, captureCalls, targetedCalls,
        setTime: value => { time = value; }, setRestore: value => { restore = value; } };
}
test("JST window boundaries are exact", () => {
    assert.equal(Scheduler.windowDecision("2026-09-08T04:59:59+09:00").eligible, false);
    assert.equal(Scheduler.windowDecision("2026-09-08T05:00:00+09:00").eligible, true);
    assert.equal(Scheduler.windowDecision("2026-09-08T08:59:59+09:00").eligible, true);
    assert.equal(Scheduler.windowDecision("2026-09-08T09:00:00+09:00").eligible, false);
});
test("05:00 and 08:59:59 may attempt while 09:00 never captures", async () => {
    const opening = fixture({ time: "2026-09-08T05:00:00+09:00" });
    await opening.scheduler.tick(); assert.equal(opening.captureCalls.length, 1);
    const finalSecond = fixture({ time: "2026-09-08T08:59:59+09:00" });
    await finalSecond.scheduler.tick(); assert.equal(finalSecond.captureCalls.length, 1);
    const cutoff = fixture({ time: "2026-09-08T09:00:00+09:00" });
    await cutoff.scheduler.tick(); assert.equal(cutoff.captureCalls.length, 0);
});
test("before window schedules one wake and after window performs no catch-up", async () => {
    const before = fixture({ time: "2026-09-08T04:59:59+09:00" }); await before.scheduler.tick();
    assert.equal(before.timers.length, 1); assert.equal(before.captureCalls.length, 0);
    const after = fixture({ time: "2026-09-08T09:10:00+09:00" }); await after.scheduler.tick();
    assert.deepEqual([after.scheduler.getState().stoppedReason, after.captureCalls.length], ["window_closed", 0]);
});
test("applicable persisted baseline and invalid storage stop without capture", async () => {
    const saved = fixture({ restore: applicable() }); await saved.scheduler.tick();
    assert.equal(saved.scheduler.getState().stoppedReason, "baseline_applicable");
    const invalid = fixture({ restore: { restoreStatus: "invalid",
        integrityStatus: "integrity_invalid" } }); await invalid.scheduler.tick();
    assert.equal(invalid.scheduler.getState().stoppedReason, "storage_invalid");
    assert.equal(saved.captureCalls.length + invalid.captureCalls.length, 0);
});
test("ineligible attempt waits 30 minutes without replaying missed intervals", async () => {
    const f = fixture(); await f.scheduler.tick();
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, Scheduler.INTERVAL_MS);
    assert.equal(f.captureCalls.length, 1); assert.equal(f.scheduler.getState().attemptCount, 1);
});
test("later eligible attempt saves once and stops subsequent ticks", async () => {
    let calls = 0; const f = fixture({ capture: async () => ++calls === 1
        ? { status: "waiting_for_eligibility", reason: "qri_ineligible" }
        : { status: "saved", saved: true } });
    await f.scheduler.tick(); await f.scheduler.tick(); const count = f.captureCalls.length;
    assert.equal(f.scheduler.getState().stoppedReason, "baseline_applicable");
    await f.scheduler.tick(); assert.equal(f.captureCalls.length, count);
});
test("restored applicable baseline stops after post-capture comparison publication without network", async () => {
    let restore = missing(); let comparison = { status: "unavailable", restoreReason: "no_baseline" };
    let publishes = 0; let networkFetches = 0;
    const scheduler = Scheduler.createScheduler({ now: () => "2026-09-08T05:02:00+09:00",
        setTimer: () => 1, clearTimer: () => {}, evaluateRestore: async () => restore,
        captureAutomatic: async () => {
            restore = { ...applicable(), selectedScopeId:
                "morning-v4-scope|2026-09|2026-09-08|same_date_explicit" };
            publishes += 1; comparison = { status: "available", restoreReason: null,
                selectedBaselineId: restore.selectedBaselineId, scopeId: restore.selectedScopeId };
            return { status: "saved", saved: true, activeBaselineId: restore.selectedBaselineId };
        }, targetedRefresh: async () => { networkFetches += 1; return { status: "completed" }; } });
    assert.equal(comparison.status, "unavailable"); await scheduler.tick();
    assert.deepEqual([comparison.status, comparison.restoreReason, comparison.selectedBaselineId,
        comparison.scopeId, publishes, networkFetches, scheduler.getState().stoppedReason],
    ["available", null, "mb4-saved",
        "morning-v4-scope|2026-09|2026-09-08|same_date_explicit", 1, 0, "baseline_applicable"]);
});
test("automatic outcome alone never stops without an applicable restored baseline", async () => {
    let first = true;
    const isolated = Scheduler.createScheduler({ now: () => "2026-09-08T06:00:00+09:00",
        setTimer: () => 1, clearTimer: () => {}, evaluateRestore: async () => missing(),
        captureAutomatic: async () => first ? (first = false, { status: "saved", saved: true }) :
            ({ status: "waiting_for_eligibility", reason: "capture_in_progress" }),
        targetedRefresh: async () => ({ status: "waiting", reason: "unclassified",
            targetedSources: [] }) });
    await isolated.tick();
    assert.notEqual(isolated.getState().stoppedReason, "baseline_applicable");
});
test("pending and capture-in-progress conditions wait for a later retry", async () => {
    const pending = fixture({ restore: { restoreStatus: "valid", integrityStatus: "valid",
        applicabilityStatus: "pending", selectedBaselineId: null },
    capture: async () => ({ status: "waiting_for_eligibility", reason: "capture_in_progress" }) });
    await pending.scheduler.tick();
    assert.equal(pending.scheduler.getState().status, "scheduled");
    assert.equal(pending.timers[0].delay, Scheduler.INTERVAL_MS);
});
test("user refresh and dispose invalidate scheduler work", async () => {
    let active = true; const f = fixture({ userRefresh: () => active }); await f.scheduler.tick();
    assert.equal(f.captureCalls.length, 0); assert.equal(f.scheduler.getState().lastReason, "user_refresh_priority");
    active = false; f.scheduler.dispose(); await f.scheduler.tick();
    assert.equal(f.scheduler.getState().stoppedReason, "disposed");
});
test("a delayed wake after 09:00 performs no missed-attempt replay", async () => {
    const f = fixture({ time: "2026-09-08T08:30:00+09:00" });
    await f.scheduler.tick(); const before = f.captureCalls.length;
    f.setTime("2026-09-08T09:10:00+09:00");
    await f.timers[0].fn();
    assert.equal(f.captureCalls.length, before);
    assert.equal(f.scheduler.getState().stoppedReason, "window_closed");
});
test("user refresh beginning during targeted work makes the attempt stale", async () => {
    let active = false; let captured = 0;
    const scheduler = Scheduler.createScheduler({ now: () => "2026-09-08T06:00:00+09:00",
        setTimer: () => 1, clearTimer: () => {}, evaluateRestore: async () => missing(),
        isUserRefreshActive: () => active,
        captureAutomatic: async () => { captured += 1; return { status: "waiting_for_eligibility",
            reason: "qri_ineligible" }; },
        targetedRefresh: async () => { active = true; return { status: "stale",
            reason: "user_refresh_priority", targetedSources: ["qri"] }; } });
    await scheduler.tick();
    assert.equal(captured, 1);
    assert.equal(scheduler.getState().lastReason, "user_refresh_priority");
});
test("getter is detached and deeply frozen without baseline duplication", () => {
    const f = fixture(); const a = f.scheduler.getState(); const b = f.scheduler.getState();
    assert.notEqual(a, b); assert.equal(Object.isFrozen(a), true);
    assert.equal(Object.hasOwn(a, "baseline"), false);
});
