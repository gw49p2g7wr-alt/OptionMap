"use strict";

const MAX_CONCURRENCY = 3;
const activePools = new Set();

function deepFreeze(value) {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function clone(value) {
  try { return structuredClone(value); }
  catch (_error) { throw Object.assign(new TypeError("task_result_not_cloneable"), {
    code: "task_result_not_cloneable" }); }
}

function rejection(inputIndex, taskIdentity, code) {
  return { inputIndex, taskIdentity, status: "rejected", value: null,
    failure: { code } };
}

function validateTask(task, inputIndex) {
  const taskIdentity = typeof task?.taskIdentity === "string" && task.taskIdentity.length > 0
    ? task.taskIdentity : null;
  if (!task || typeof task !== "object" || Array.isArray(task))
    return { valid: false, result: rejection(inputIndex, null, "task_descriptor_invalid") };
  if (!taskIdentity)
    return { valid: false, result: rejection(inputIndex, null, "task_identity_invalid") };
  if (typeof task.execute !== "function")
    return { valid: false, result: rejection(inputIndex, taskIdentity, "task_executor_invalid") };
  return { valid: true, inputIndex, taskIdentity, execute: task.execute };
}

function inputError(code) {
  return Object.freeze(Object.assign(new TypeError(code), { code }));
}

function runBoundedTasks(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return Promise.reject(inputError("pool_request_invalid"));
  if (!Array.isArray(input.tasks)) return Promise.reject(inputError("tasks_container_invalid"));
  const maxConcurrency = input.maxConcurrency === undefined ? MAX_CONCURRENCY : input.maxConcurrency;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY)
    return Promise.reject(inputError("max_concurrency_invalid"));

  const results = new Array(input.tasks.length), queue = [];
  for (let index = 0; index < input.tasks.length; index += 1) {
    const checked = validateTask(input.tasks[index], index);
    if (checked.valid) queue.push(checked); else results[index] = checked.result;
  }

  const pool = { activeTaskCount: 0, queuedTaskCount: queue.length,
    peakActiveTaskCount: 0, unresolvedTaskCount: queue.length, settled: false };
  activePools.add(pool);

  return new Promise(resolve => {
    let cursor = 0;
    const finish = () => {
      if (pool.settled || pool.unresolvedTaskCount !== 0) return;
      pool.settled = true;
      activePools.delete(pool);
      const fulfilledCount = results.filter(result => result.status === "fulfilled").length;
      const rejectedCount = results.length - fulfilledCount;
      resolve(deepFreeze({ results: clone(results), summary: { taskCount: results.length,
        fulfilledCount, rejectedCount, maxConcurrency }, diagnostics: {
        activeTaskCount: 0, queuedTaskCount: 0,
        peakActiveTaskCount: pool.peakActiveTaskCount, unresolvedTaskCount: 0 } }));
    };
    const settle = (task, result) => {
      results[task.inputIndex] = result;
      pool.activeTaskCount -= 1;
      pool.unresolvedTaskCount -= 1;
      pump();
      finish();
    };
    const start = task => {
      pool.activeTaskCount += 1;
      pool.queuedTaskCount -= 1;
      pool.peakActiveTaskCount = Math.max(pool.peakActiveTaskCount, pool.activeTaskCount);
      Promise.resolve().then(() => task.execute(deepFreeze({ inputIndex: task.inputIndex,
        taskIdentity: task.taskIdentity }))).then(value => {
          let detached;
          try { detached = clone(value); }
          catch (error) {
            settle(task, rejection(task.inputIndex, task.taskIdentity, error.code)); return;
          }
          settle(task, { inputIndex: task.inputIndex, taskIdentity: task.taskIdentity,
            status: "fulfilled", value: detached, failure: null });
        }, error => settle(task, rejection(task.inputIndex, task.taskIdentity,
          typeof error?.code === "string" && /^[a-z0-9_]+$/.test(error.code)
            ? error.code : "task_execution_failed")));
    };
    function pump() {
      while (pool.activeTaskCount < maxConcurrency && cursor < queue.length) start(queue[cursor++]);
    }
    if (pool.unresolvedTaskCount === 0) finish(); else pump();
  });
}

function getTaskPoolDiagnostics() {
  let activeTaskCount = 0, queuedTaskCount = 0, unresolvedTaskCount = 0;
  for (const pool of activePools) {
    activeTaskCount += pool.activeTaskCount;
    queuedTaskCount += pool.queuedTaskCount;
    unresolvedTaskCount += pool.unresolvedTaskCount;
  }
  return deepFreeze({ activePoolCount: activePools.size, activeTaskCount,
    queuedTaskCount, unresolvedTaskCount });
}

module.exports = Object.freeze({ MAX_CONCURRENCY, runBoundedTasks, getTaskPoolDiagnostics });
