"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");

const policy = (extra = {}) => ({ networkPolicyVersion: 1, documentSetVersion: 1, ...extra });
const request = (extra = {}) => ({ sourceId: "jp-boj-calendar", operation: Flights.OPERATION,
  acquisitionPolicyIdentity: policy(), execute: async () => ({ success: true }), ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {
  resolve = yes; reject = no;
}); return { promise, resolve, reject }; };

test.afterEach(() => assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0));

test("single callerはexecuteを1回だけ実行し成功後cleanupする", async () => {
  let calls = 0;
  const result = await Flights.runSourceFlight(request({ execute: async context => {
    calls += 1; return { success: true, context };
  } }));
  assert.equal(calls, 1);
  assert.equal(result.joinedExistingFlight, false);
  assert.equal(result.executionOutcome.success, true);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
});

test("two simultaneous same identityは1 executionへjoinする", async () => {
  let calls = 0; const gate = deferred();
  const execute = async () => { calls += 1; return gate.promise; };
  const first = Flights.runSourceFlight(request({ execute }));
  const joined = Flights.runSourceFlight(request({ execute: async () => {
    throw new Error("must_not_run");
  } }));
  await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve({ success: true, marker: "shared" });
  const [one, two] = await Promise.all([first, joined]);
  assert.equal(one.joinedExistingFlight, false);
  assert.equal(two.joinedExistingFlight, true);
  assert.deepEqual(one.executionOutcome, two.executionOutcome);
});

test("10 simultaneous same identityとtrigger差は1 executionへjoinする", async () => {
  let calls = 0; const gate = deferred();
  const promises = Array.from({ length: 10 }, (_, index) => Flights.runSourceFlight(request({
    trigger: index % 2 ? "manual" : "startup", requestedAt: `2026-09-24T00:00:0${index}.000Z`,
    execute: async () => { calls += 1; return gate.promise; } })));
  await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve({ success: true });
  const results = await Promise.all(promises);
  assert.equal(results.filter(item => item.joinedExistingFlight).length, 9);
});

test("retryとmanual相当もtriggerをidentityにせずjoinする", async () => {
  let calls = 0; const gate = deferred(), execute = async () => { calls += 1; return gate.promise; };
  const retry = Flights.runSourceFlight(request({ trigger: "retry", execute }));
  const manual = Flights.runSourceFlight(request({ trigger: "manual", execute }));
  await Promise.resolve(); assert.equal(calls, 1); gate.resolve({ success: true });
  assert.equal((await retry).joinedExistingFlight, false);
  assert.equal((await manual).joinedExistingFlight, true);
});

test("different sourceは別flightとして同時実行できる", async () => {
  let calls = 0; const gate = deferred();
  const execute = async () => { calls += 1; return gate.promise; };
  const boj = Flights.runSourceFlight(request({ execute }));
  const fed = Flights.runSourceFlight(request({ sourceId: "us-fed-fomc-calendar", execute }));
  await Promise.resolve(); assert.equal(calls, 2);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 2);
  gate.resolve({ success: true }); await Promise.all([boj, fed]);
});

test("same sourceでもincompatible policy identityはjoinしない", async () => {
  let calls = 0; const gate = deferred(), execute = async () => { calls += 1; return gate.promise; };
  const one = Flights.runSourceFlight(request({ execute }));
  const two = Flights.runSourceFlight(request({ acquisitionPolicyIdentity: policy({
    documentSetVersion: 2 }), execute }));
  await Promise.resolve(); assert.equal(calls, 2); gate.resolve({ success: true });
  await Promise.all([one, two]);
});

test("許可operationは現在一つで異なるoperationを実行しない", async () => {
  let calls = 0;
  await assert.rejects(Flights.runSourceFlight(request({ operation: "other",
    execute: async () => { calls += 1; } })), { code: "operation_not_allowed" });
  assert.equal(calls, 0);
});

test("settlement後のrequestはcacheせずnew executionを開始する", async () => {
  let calls = 0; const execute = async () => ({ execution: ++calls });
  const first = await Flights.runSourceFlight(request({ execute }));
  const second = await Flights.runSourceFlight(request({ execute }));
  assert.equal(calls, 2);
  assert.equal(first.executionOutcome.execution, 1);
  assert.equal(second.executionOutcome.execution, 2);
  assert.equal(second.joinedExistingFlight, false);
});

test("async rejectはjoin callerへ同じfailureを渡しcleanup後retry可能", async () => {
  let calls = 0; const gate = deferred();
  const first = Flights.runSourceFlight(request({ execute: async () => { calls += 1;
    return gate.promise; } }));
  const joined = Flights.runSourceFlight(request({ execute: async () => {
    throw new Error("must_not_run");
  } }));
  const failure = Object.assign(new Error("network_failed"), { code: "network_failed" });
  gate.reject(failure);
  await assert.rejects(first, error => error === failure);
  await assert.rejects(joined, error => error === failure);
  assert.equal(calls, 1); assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  const retried = await Flights.runSourceFlight(request({ execute: async () => ({ success: true }) }));
  assert.equal(retried.joinedExistingFlight, false);
});

test("timeout相当rejectはcleanupし次flightを許可する", async () => {
  const timeout = Object.assign(new Error("request_timeout"), { code: "request_timeout" });
  await assert.rejects(Flights.runSourceFlight(request({ execute: async () => { throw timeout; } })),
    error => error === timeout);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.equal((await Flights.runSourceFlight(request())).joinedExistingFlight, false);
});

test("synchronous throwもrejectとして共有・cleanupする", async () => {
  let calls = 0;
  const first = Flights.runSourceFlight(request({ execute: () => { calls += 1;
    throw Object.assign(new Error("sync_failure"), { code: "sync_failure" }); } }));
  const joined = Flights.runSourceFlight(request());
  await assert.rejects(first, { code: "sync_failure" });
  await assert.rejects(joined, { code: "sync_failure" });
  assert.equal(calls, 1);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
});

for (const [name, override, reason] of [
  ["malformed source", { sourceId: null }, "malformed_source_id"],
  ["unknown source", { sourceId: "unknown" }, "unknown_source"],
  ["blocked source", { sourceId: "jp-meti-calendar" }, "blocked_source"],
  ["replaced source", { sourceId: "jp-esri-calendar" }, "replaced_source"],
  ["missing execute", { execute: undefined }, "execute_required"],
  ["non-function execute", { execute: true }, "execute_required"],
  ["malformed policy", { acquisitionPolicyIdentity: null }, "policy_identity_invalid"]
]) test(`${name}はexecuteなしでreject`, async () => {
  let calls = 0;
  await assert.rejects(Flights.runSourceFlight(request({ execute: async () => { calls += 1; },
    ...override })), { code: reason });
  assert.equal(calls, 0);
});

test("policy property order・trigger・timestamp・object referenceでkeyを変えない", async () => {
  let calls = 0; const gate = deferred();
  const execute = async () => { calls += 1; return gate.promise; };
  const first = Flights.runSourceFlight(request({ acquisitionPolicyIdentity: {
    networkPolicyVersion: 1, nested: { beta: 2, alpha: 1 } }, trigger: "startup", execute }));
  const second = Flights.runSourceFlight(request({ acquisitionPolicyIdentity: {
    nested: { alpha: 1, beta: 2 }, networkPolicyVersion: 1 }, trigger: "manual",
    requestedAt: "2099-01-01T00:00:00.000Z", execute }));
  await Promise.resolve(); assert.equal(calls, 1);
  const diagnostics = Flights.getFlightDiagnostics();
  assert.equal(diagnostics.activeFlightCount, 1);
  assert.equal(Object.isFrozen(diagnostics.flightKeys), true);
  gate.resolve({ success: true });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.flightIdentity.key, two.flightIdentity.key);
});

test("caller resultはdetachedかつdeep frozenでregistryを公開しない", async () => {
  const payload = { success: true, nested: { value: 1 } };
  const one = await Flights.runSourceFlight(request({ execute: async () => payload }));
  assert.equal(Object.isFrozen(one), true);
  assert.equal(Object.isFrozen(one.executionOutcome.nested), true);
  assert.notEqual(one.executionOutcome, payload);
  assert.deepEqual(Object.keys(Flights.getFlightDiagnostics()), ["activeFlightCount", "flightKeys"]);
});

test("moduleはnetwork・IPC・storage・timer・AbortController・acquisition serviceを持たない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/sourceSingleFlight.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|ipcMain|indexedDB|localStorage|node:fs/);
  assert.doesNotMatch(source, /calendarAcquisitionService|setTimeout|setInterval|AbortController/);
  assert.doesNotMatch(source, /productionHistoryWriter|candidateBuilder|transitionPlanner/);
});
