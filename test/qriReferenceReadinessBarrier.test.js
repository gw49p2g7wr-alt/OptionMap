"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Barrier = require("../js/qriReferenceReadinessBarrier.js");

test("default bound covers the accepted hidden-window acquisition lifecycle", () => {
    assert.equal(Barrier.DEFAULT_TIMEOUT_MS, 90000);
});

const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
};
const binding = (generation = 1, status = "saved", requestId = "market-1") => ({
    next: { generation, activeRequestId: requestId, status },
    majorSq: { generation, activeRequestId: requestId, status }
});
const runtime = result => ({ waitForCurrentSettle: () => result });

test("R1 settled generation proceeds immediately", async () => {
    const current = binding();
    const settled = value => Promise.resolve({ status: "settled", generation: 1,
        activeRequestId: "market-1", state: value });
    const barrier = Barrier.createBarrier({
        getNextRuntime: () => runtime(settled("next")),
        getMajorSqRuntime: () => runtime(settled("major")),
        getBinding: () => current
    });
    assert.deepEqual(await barrier.wait(), current);
    assert.equal(barrier.matches(current), true);
});

test("R2/R4 pending waits once and preserves settled role states", async () => {
    const next = deferred(); const major = deferred();
    const current = binding(1, "failed");
    const barrier = Barrier.createBarrier({ timeoutMs: 1000,
        getNextRuntime: () => runtime(next.promise),
        getMajorSqRuntime: () => runtime(major.promise), getBinding: () => current });
    let finished = false;
    const waiting = barrier.wait().then(value => (finished = true, value));
    await Promise.resolve(); assert.equal(finished, false);
    next.resolve({ status: "settled", generation: 1, activeRequestId: "market-1" });
    major.resolve({ status: "settled", generation: 1, activeRequestId: "market-1" });
    assert.deepEqual(await waiting, current);
});

test("R5 generation mismatch fails closed", async () => {
    const current = binding(2, "saved", "market-2");
    const old = Promise.resolve({ status: "settled", generation: 1,
        activeRequestId: "market-1" });
    const barrier = Barrier.createBarrier({ getNextRuntime: () => runtime(old),
        getMajorSqRuntime: () => runtime(old), getBinding: () => current });
    await assert.rejects(() => barrier.wait(), /qri_reference_generation_changed/);
});

test("R12 pending acquisition is bounded and never collects", async () => {
    const pending = new Promise(() => {});
    const barrier = Barrier.createBarrier({ timeoutMs: 5,
        getNextRuntime: () => runtime(pending), getMajorSqRuntime: () => runtime(pending),
        getBinding: () => binding(1, "scheduled") });
    await assert.rejects(() => barrier.wait(), /qri_reference_readiness_timeout/);
});

test("production wiring waits only in Full Export and retains non-awaiting refresh", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const exportWiring = html.slice(html.indexOf("function getQriReferenceReadinessBinding"),
        html.indexOf("const qriOptionsHistoryPersistence"));
    assert.match(exportWiring, /waitForQriReferenceReadiness/);
    assert.match(exportWiring, /OptionMapQriReferenceReadinessBarrier\.createBarrier/);
    assert.match(exportWiring, /qriReferenceReadiness/);
    const refreshWiring = html.slice(html.indexOf("function refreshAllMarketData"),
        html.indexOf("window\.refreshAllMarketData"));
    assert.doesNotMatch(refreshWiring, /waitForQriReferenceReadiness|\.waitForCurrentSettle/);
});

test("Morning targeted refresh yields while either reference acquisition is pending", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const schedulerWiring = html.slice(html.indexOf("let formalBaselineRetryScheduler"),
        html.indexOf("async function publishQriReferencePriceShadow"));
    assert.match(schedulerWiring, /function isQriReferenceAcquisitionPending\(\)/);
    assert.match(schedulerWiring,
        /new Set\(\["pending_formal_completion", "scheduled"\]\)/);
    assert.match(schedulerWiring, /qriReferenceAcquisitionRuntime/);
    assert.match(schedulerWiring, /qriMajorSqAcquisitionRuntime/);
    assert.equal((schedulerWiring.match(/isQriReferenceAcquisitionPending\(\)/g) || []).length, 3);
});

test("reference IV roles reuse the same settled Full Export section freshness", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8");
    const iv = source.slice(source.indexOf("const qriOptionIv ="),
        source.indexOf("const sections =", source.indexOf("const qriOptionIv =")));
    assert.match(iv, /role === "next" \? qriOptionsNextContract/);
    assert.match(iv, /qriOptionsMajorSqNextContract\)\.freshness/);
    assert.doesNotMatch(iv, /role === "next"\s*\?\s*"qriOptionsNextContract"/);
});
