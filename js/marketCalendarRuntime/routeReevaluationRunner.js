"use strict";
// Isolated mock composition only. No production import/wiring, transport or UI capability.
const Flights = require("./sourceSingleFlight.js");
const Authority = require("./calendarRouteAuthority.js");
const Policy = require("./routeReevaluationPolicy.js");
const Store = require("../storage/marketCalendarRuntimeStateStore.js");
function createIsolatedReevaluationStore({ indexedDB, targetEnvironment, getRouteAuthority } = {}) {
  if (targetEnvironment !== "isolated_test") throw new TypeError("isolated_reevaluation_required");
  return Store.createRuntimeStateStore({ indexedDB, targetEnvironment, getRouteAuthority, reevaluationPolicy: Policy });
}
const scopes = new WeakMap(); let nextScope = 0;
function createIsolatedReevaluationRunner({ targetEnvironment, store, getAuthority, acquire, now } = {}) {
  if (targetEnvironment !== "isolated_test" || !store?.reserveReevaluation || !store?.completeReevaluation ||
      typeof getAuthority !== "function" || typeof acquire !== "function" || typeof now !== "function")
    throw new TypeError("isolated_reevaluation_required");
  if (!scopes.has(store)) scopes.set(store, ++nextScope);
  function check({ sourceId, trigger } = {}) {
    if (!["startup", "manual"].includes(trigger)) return Promise.resolve({ reason: "trigger_invalid", networkEligible: false });
    const selected = Authority.selectRoute({ sourceId, operation: Flights.OPERATION }, getAuthority());
    if (!selected.valid || !selected.acquisitionAllowed)
      return Promise.resolve({ reason: selected.reason, networkEligible: false });
    return Flights.runSourceFlight({ sourceId, operation: Flights.OPERATION,
      acquisitionPolicyIdentity: { isolatedScope: scopes.get(store), routeIdentity: selected.routeIdentity,
        activationVersion: selected.activationVersion }, execute: async () => {
        const reservation = await store.reserveReevaluation({ sourceId, requestedAt: now() });
        if (!reservation.networkEligible) return reservation;
        const current = Authority.selectRoute({ sourceId, operation: Flights.OPERATION }, getAuthority());
        if (!current.valid || !current.acquisitionAllowed || current.activationState !== "alternative_active" ||
            !Policy.sameBinding(Policy.binding(current), reservation.state.routeBinding))
          return { status: "unavailable", reason: "stale_route_result", networkEligible: false };
        // Only a committed reservation authorizes this single mock execution. Never retry here.
        let result;
        try { result = await acquire({ sourceId, routeBinding: reservation.state.routeBinding }); }
        catch (_) { result = { lastAttemptAt: reservation.token.reservedAt, lastOutcome: "failure",
          lastHttpStatus: null, lastDiagnosticClass: "network_failure" }; }
        return store.completeReevaluation({ token: reservation.token, result, completedAt: now() });
      } });
  }
  return Object.freeze({ check });
}
module.exports = Object.freeze({ createIsolatedReevaluationStore, createIsolatedReevaluationRunner });
