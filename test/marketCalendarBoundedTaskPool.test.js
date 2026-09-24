"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

const task = (taskIdentity, execute = async () => taskIdentity) => ({ taskIdentity, execute });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {
  resolve = yes; reject = no;
}); return { promise, resolve, reject }; };
const flushMicrotasks = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

test.afterEach(() => assert.deepEqual(Pool.getTaskPoolDiagnostics(), {
  activePoolCount: 0, activeTaskCount: 0, queuedTaskCount: 0, unresolvedTaskCount: 0 }));

test("0 taskはhangせずempty resultとzero diagnosticsを返す", async () => {
  const result = await Pool.runBoundedTasks({ tasks: [], maxConcurrency: 3 });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.summary, { taskCount: 0, fulfilledCount: 0,
    rejectedCount: 0, maxConcurrency: 3 });
  assert.equal(result.diagnostics.peakActiveTaskCount, 0);
});

for (const count of [1, 2, 3]) test(`${count} taskは不要に3を超えず全件settle`, async () => {
  const gates = Array.from({ length: count }, deferred), started = [];
  const promise = Pool.runBoundedTasks({ tasks: gates.map((gate, index) => task(`t${index}`,
    async () => { started.push(index); return gate.promise; })), maxConcurrency: 3 });
  await Promise.resolve();
  assert.deepEqual(started, Array.from({ length: count }, (_, index) => index));
  assert.equal(Pool.getTaskPoolDiagnostics().activeTaskCount, count);
  gates.forEach((gate, index) => gate.resolve(index));
  const result = await promise;
  assert.equal(result.diagnostics.peakActiveTaskCount, count);
  assert.deepEqual(result.results.map(item => item.value),
    Array.from({ length: count }, (_, index) => index));
});

test("4 taskは3件だけ開始しslot解放後に4件目を開始", async () => {
  const gates = Array.from({ length: 4 }, deferred), started = [];
  const promise = Pool.runBoundedTasks({ tasks: gates.map((gate, index) => task(`t${index}`,
    async () => { started.push(index); return gate.promise; })) });
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(Pool.getTaskPoolDiagnostics(), { activePoolCount: 1,
    activeTaskCount: 3, queuedTaskCount: 1, unresolvedTaskCount: 4 });
  gates[1].resolve(1); await flushMicrotasks();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[0].resolve(0); gates[2].resolve(2); gates[3].resolve(3);
  const result = await promise;
  assert.equal(result.diagnostics.peakActiveTaskCount, 3);
  assert.deepEqual(result.results.map(item => item.inputIndex), [0, 1, 2, 3]);
});

test("12 taskでもpeak 3以下で全件settleし開始順を維持", async () => {
  let active = 0, peak = 0; const started = [];
  const tasks = Array.from({ length: 12 }, (_, index) => task(`t${index}`, async () => {
    started.push(index); active += 1; peak = Math.max(peak, active);
    await Promise.resolve(); active -= 1; return index;
  }));
  const result = await Pool.runBoundedTasks({ tasks });
  assert.equal(peak <= 3, true);
  assert.equal(result.diagnostics.peakActiveTaskCount <= 3, true);
  assert.equal(result.results.length, 12);
  assert.deepEqual(started, Array.from({ length: 12 }, (_, index) => index));
});

test("middle task async rejectはslotを解放し後続を継続", async () => {
  const started = [];
  const tasks = [0, 1, 2, 3].map(index => task(`t${index}`, async () => {
    started.push(index);
    if (index === 1) throw Object.assign(new Error("hidden stack"), { code: "network_failed" });
    return index;
  }));
  const result = await Pool.runBoundedTasks({ tasks });
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(result.results[1].status, "rejected");
  assert.deepEqual(result.results[1].failure, { code: "network_failed" });
  assert.equal(JSON.stringify(result).includes("hidden stack"), false);
  assert.equal(result.summary.fulfilledCount, 3);
});

test("first・multiple rejectでも全taskをsettleする", async () => {
  const result = await Pool.runBoundedTasks({ tasks: [0, 1, 2, 3, 4].map(index =>
    task(`t${index}`, async () => {
      if ([0, 2, 4].includes(index)) throw Object.assign(new Error("failure"), { code: "failed" });
      return index;
    })) });
  assert.deepEqual(result.results.map(item => item.status),
    ["rejected", "fulfilled", "rejected", "fulfilled", "rejected"]);
  assert.deepEqual(result.summary, { taskCount: 5, fulfilledCount: 2,
    rejectedCount: 3, maxConcurrency: 3 });
});

test("timeout相当rejectとsynchronous throwもslotを解放する", async () => {
  const started = [];
  const tasks = [task("timeout", async () => { started.push("timeout");
    throw Object.assign(new Error("timeout"), { code: "request_timeout" }); }),
  task("sync", () => { started.push("sync"); throw new Error("private"); }),
  task("ok", async () => { started.push("ok"); return true; }),
  task("after", async () => { started.push("after"); return true; })];
  const result = await Pool.runBoundedTasks({ tasks });
  assert.deepEqual(started, ["timeout", "sync", "ok", "after"]);
  assert.deepEqual(result.results.map(item => item.failure?.code || null),
    ["request_timeout", "task_execution_failed", null, null]);
  assert.equal(result.diagnostics.activeTaskCount, 0);
  assert.equal(result.diagnostics.queuedTaskCount, 0);
});

test("completion C→A→Bでもfinal resultsはinput order", async () => {
  const gates = [deferred(), deferred(), deferred()], completed = [];
  const promise = Pool.runBoundedTasks({ tasks: gates.map((gate, index) => task(`t${index}`,
    async () => { const value = await gate.promise; completed.push(index); return value; })) });
  await Promise.resolve();
  gates[2].resolve("C"); await flushMicrotasks();
  gates[0].resolve("A"); await flushMicrotasks();
  gates[1].resolve("B");
  const result = await promise;
  assert.deepEqual(completed, [2, 0, 1]);
  assert.deepEqual(result.results.map(item => item.value), ["A", "B", "C"]);
  const again = await Pool.runBoundedTasks({ tasks: [task("t0"), task("t1"), task("t2")] });
  assert.deepEqual(again.results.map(item => item.inputIndex), [0, 1, 2]);
});

for (const [name, input, code] of [
  ["zero", { tasks: [], maxConcurrency: 0 }, "max_concurrency_invalid"],
  ["above maximum", { tasks: [], maxConcurrency: 4 }, "max_concurrency_invalid"],
  ["fraction", { tasks: [], maxConcurrency: 1.5 }, "max_concurrency_invalid"],
  ["malformed container", { tasks: {} }, "tasks_container_invalid"]
]) test(`invalid input ${name}はtop-level reject`, async () => {
  await assert.rejects(Pool.runBoundedTasks(input), { code });
});

test("malformed descriptor・missing/non-function executorは個別rejectしvalid taskを継続", async () => {
  const result = await Pool.runBoundedTasks({ tasks: [null, { taskIdentity: "missing" },
    { taskIdentity: "bad", execute: true }, task("valid", async () => 7)] });
  assert.deepEqual(result.results.map(item => item.failure?.code || null), [
    "task_descriptor_invalid", "task_executor_invalid", "task_executor_invalid", null]);
  assert.equal(result.results[3].value, 7);
  assert.equal(result.summary.rejectedCount, 3);
});

test("duplicate task identityはdedupeせず別input indexで実行する", async () => {
  let calls = 0;
  const result = await Pool.runBoundedTasks({ tasks: [task("same", async () => ++calls),
    task("same", async () => ++calls)] });
  assert.equal(calls, 2);
  assert.deepEqual(result.results.map(item => item.taskIdentity), ["same", "same"]);
  assert.deepEqual(result.results.map(item => item.inputIndex), [0, 1]);
});

test("resultとdiagnosticsはdetached・deep frozenでqueueを公開しない", async () => {
  const value = { nested: { count: 1 } };
  const result = await Pool.runBoundedTasks({ tasks: [task("one", async () => value)] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.results[0].value.nested), true);
  assert.notEqual(result.results[0].value, value);
  assert.deepEqual(Object.keys(Pool.getTaskPoolDiagnostics()), ["activePoolCount",
    "activeTaskCount", "queuedTaskCount", "unresolvedTaskCount"]);
});

test("moduleはnetwork・IPC・storage・timer・AbortController・single-flightを持たない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/boundedTaskPool.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|ipcMain|indexedDB|localStorage|node:fs/);
  assert.doesNotMatch(source, /calendarAcquisitionService|setTimeout|setInterval|AbortController/);
  assert.doesNotMatch(source, /sourceSingleFlight|updateCoordinator|productionHistoryWriter/);
});
