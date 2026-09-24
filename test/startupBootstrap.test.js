"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Bootstrap = require("../js/startupBootstrap.js");

const success = name => ({ name, run: async () => name });
const rejected = name => ({ name, run: async () => { throw new Error(`${name}_failed`); } });
const pending = name => ({ name, run: () => new Promise(() => {}) });

function fixture(initializers, timeoutMs = 15) {
    let refreshCalls = 0;
    const coordinator = Bootstrap.createCoordinator({ initializers, timeoutMs,
        refresh: async () => { refreshCalls += 1; return { call: refreshCalls }; } });
    return { coordinator, refreshCalls: () => refreshCalls };
}

test("six successful initializers preserve restore and start one live refresh", async () => {
    const f = fixture(["weeklyCache", "participantCache", "participantHistory",
        "weeklyFuturesHistory", "weeklyOptionsHistory", "qriOptionsHistory"].map(success));
    const result = await f.coordinator.start();
    assert.equal(f.refreshCalls(), 1);
    assert.equal(result.diagnostics.length, 6);
    assert.ok(result.diagnostics.every(item => item.outcome === "success"));
});

test("one rejection is diagnosed and does not block refresh", async () => {
    const f = fixture([success("one"), rejected("participantHistory")]);
    const result = await f.coordinator.start();
    assert.equal(f.refreshCalls(), 1);
    assert.equal(result.diagnostics[1].name, "participantHistory");
    assert.equal(result.diagnostics[1].outcome, "rejected");
    assert.equal(result.diagnostics[1].reason, "participantHistory_failed");
    assert.ok(result.diagnostics[1].elapsedMs >= 0);
});

test("permanently pending initializer times out and refresh starts", async () => {
    const f = fixture([success("one"), pending("weeklyOptionsHistory")]);
    const result = await f.coordinator.start();
    assert.equal(f.refreshCalls(), 1);
    assert.equal(result.diagnostics[1].name, "weeklyOptionsHistory");
    assert.equal(result.diagnostics[1].outcome, "timeout");
    assert.equal(result.diagnostics[1].reason, "initializer_timeout");
});

test("multiple timeouts including IndexedDB blocked equivalent settle", async () => {
    const f = fixture([pending("weeklyOptionsHistory"), pending("qriOptionsHistory")]);
    const result = await f.coordinator.start();
    assert.equal(f.refreshCalls(), 1);
    assert.deepEqual(result.diagnostics.map(item => item.outcome), ["timeout", "timeout"]);
});

test("manual refresh during bootstrap starts immediately and automatic path joins it", async () => {
    const f = fixture([pending("blockedIndexedDb")], 20);
    const bootstrap = f.coordinator.start();
    const manual = f.coordinator.requestManualRefresh();
    assert.deepEqual(await manual, { call: 1 });
    await bootstrap;
    assert.equal(f.refreshCalls(), 1);
    assert.equal(f.coordinator.getState().startupRefreshTrigger, "manual");
});

test("start is idempotent and normal manual refresh remains available after bootstrap", async () => {
    const f = fixture([success("one")]);
    const first = f.coordinator.start();
    assert.equal(f.coordinator.start(), first);
    await first;
    await f.coordinator.requestManualRefresh();
    assert.equal(f.refreshCalls(), 2);
});
