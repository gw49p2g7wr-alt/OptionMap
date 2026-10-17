"use strict";

// Main-side fixed approval scope. This module does not activate routes or perform I/O.
const Authority = require("./calendarRouteAuthority.js");
const State = require("./sourceUpdateState.js");
const B1 = require("./updatePolicy.js");
const OPERATION = "source-document-set";
const freeze = value => { if (value && typeof value === "object") {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const instant = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const binding = selection => Object.fromEntries(State.BINDING_FIELDS.map(k => [k, selection[k]]));
const sameBinding = (a, b) => State.validBinding(a) && State.validBinding(b) && State.BINDING_FIELDS.every(k => a[k] === b[k]);
function select(sourceId, authority) { return Authority.selectRoute({ sourceId, operation: OPERATION }, authority); }
// Generation 2 is a bounded future approval, usable only with a separately activated manifest.
// DEFAULT_AUTHORITY remains alternative_shadow. No API accepts caller-supplied approval manifests.
// Pins captured from D2d2a authority, not an independent identity algorithm. A future authority
// revision must not silently expand these approvals; fixtures verify the approved bindings.
const PINS = [
  ["jp-stat-cpi", "estat_release_calendar", "2eef5e07f5f399f2cb2e557b61d71fc250af12336cf8725295bfcf95923b2dad", "d2598e455be56901b55464e49e9e25251d32ef21610b6097955017b7a2e118b4"],
  ["jp-stat-labor", "estat_release_calendar", "164c12665d15b6997ce3855acf5e367a417139935279562999fd4c43002a2eb3", "f54eded9b30e759a8b85c850d9819ea24c944a6ad771ab477f9b60e543c2913e"],
  ["us-bls-calendar", "bls_fixed_schedule_pages", "7a0e4ac58cd6551709e393ff18c85596114e76c4f0d2f034a1e2203c88a8507d", "6f61ff1f15901f9fd2f1421fadc496dca74e62c2d87e15e85170740315ddcb14"]
];
const APPROVALS = freeze(Object.fromEntries(PINS.map(([sourceId, routeKind, fromIdentity, toIdentity]) => {
  return [sourceId, { sourceId, approvalId: `${sourceId}-route-generation-2`,
    fromBinding: { sourceContractVersion: 1, routeContractVersion: 1, routeKind: "legacy",
      routeIdentity: fromIdentity, activationVersion: 1 },
    targetBinding: { sourceContractVersion: 2, routeContractVersion: 1, routeKind,
      routeIdentity: toIdentity, activationVersion: 2 },
    allowedDiagnostic: sourceId === "us-bls-calendar" ? "network_failure" : "http_404" }];
})));
// A missing row is not a migration claim. It may be initialized only after a
// successful acquisition on the exact, fixed generation-2 production route.
function initialBinding(sourceId, authority) {
  const selected = select(sourceId, authority), approval = APPROVALS[sourceId];
  return selected.valid && selected.acquisitionAllowed && selected.activationState === "alternative_active" &&
    approval && sameBinding(binding(selected), approval.targetBinding) ? binding(selected) : null;
}
function evaluate({ sourceId, state, authority, requestedAt }) {
  const reject = reason => ({ eligible: false, reason });
  const current = select(sourceId, authority);
  if (!current.valid || !current.acquisitionAllowed) return reject(current.reason || "authority_invalid");
  if (!instant(requestedAt)) return reject("requested_at_invalid");
  const checked = State.validateCompatibleRuntimeState(state, sourceId);
  if (!checked.valid || !checked.state) return reject("runtime_state_invalid");
  if (state.reevaluation) return reject(state.reevaluation.status === "reserved" ?
    "reevaluation_interrupted" : "reevaluation_already_completed");
  const approval = APPROVALS[sourceId];
  if (!approval || current.activationState !== "alternative_active" ||
      !sameBinding(binding(current), approval.targetBinding)) return reject("reevaluation_not_approved");
  if (checked.recordKind === "v2" && !sameBinding(state.routeBinding, approval.fromBinding))
    return reject("reevaluation_not_approved");
  if (state.lastOutcome !== "failure" || state.lastDiagnosticClass !== approval.allowedDiagnostic ||
      (approval.allowedDiagnostic === "http_404" ? state.lastHttpStatus !== 404 : state.lastHttpStatus !== null) ||
      Date.parse(state.lastAttemptAt) > Date.parse(requestedAt)) return reject("reevaluation_not_approved");
  return { eligible: true, reason: null, approval, routeBinding: binding(current), routeClass: checked.routeClass };
}
function reserveState(state, evaluation, requestedAt) {
  const previousRouteSummary = { routeClass: evaluation.routeClass, lastOutcome: state.lastOutcome,
    lastDiagnosticClass: state.lastDiagnosticClass, lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt, lastHttpStatus: state.lastHttpStatus };
  return { sourceId: state.sourceId, lastAttemptAt: null, lastSuccessAt: null, lastOutcome: "none",
    retryAfter: null, lastHttpStatus: null, lastDiagnosticClass: null, coordinatorVersion: state.coordinatorVersion,
    runtimeStateContractVersion: 2, routeBinding: evaluation.routeBinding, reevaluation: {
      approvalId: evaluation.approval.approvalId, targetRouteIdentity: evaluation.routeBinding.routeIdentity,
      status: "reserved", reservedAt: requestedAt, completedAt: null, previousRouteSummary } };
}
const TOKEN_FIELDS = ["sourceId", "approvalId", "targetRouteIdentity", "activationVersion", "reservedAt"];
function reservationToken(state) { return { sourceId: state.sourceId, approvalId: state.reevaluation.approvalId,
  targetRouteIdentity: state.routeBinding.routeIdentity, activationVersion: state.routeBinding.activationVersion,
  reservedAt: state.reevaluation.reservedAt }; }
function completeState({ state, token, authority, result, completedAt }) {
  const reject = reason => ({ valid: false, reason });
  if (!exact(token, TOKEN_FIELDS) || !State.validateCompatibleRuntimeState(state, token.sourceId).valid ||
      state?.reevaluation?.status !== "reserved") return reject("stale_route_result");
  const selection = select(token.sourceId, authority), approval = APPROVALS[token.sourceId];
  if (!selection.valid || !selection.acquisitionAllowed || selection.activationState !== "alternative_active" ||
      !approval || !sameBinding(binding(selection), approval.targetBinding) ||
      state.reevaluation.approvalId !== approval.approvalId ||
      state.reevaluation.previousRouteSummary.lastDiagnosticClass !== approval.allowedDiagnostic ||
      (approval.allowedDiagnostic === "http_404" ? state.reevaluation.previousRouteSummary.lastHttpStatus !== 404 :
        state.reevaluation.previousRouteSummary.lastHttpStatus !== null) ||
      !sameBinding(state.routeBinding, binding(selection)) ||
      TOKEN_FIELDS.some(k => token[k] !== reservationToken(state)[k])) return reject("stale_route_result");
  if (!exact(result, ["lastAttemptAt", "lastOutcome", "lastHttpStatus", "lastDiagnosticClass"]) ||
      !instant(result.lastAttemptAt) || !instant(completedAt) || !["success", "failure"].includes(result.lastOutcome) ||
      Date.parse(result.lastAttemptAt) < Date.parse(token.reservedAt) || Date.parse(result.lastAttemptAt) > Date.parse(completedAt))
    return reject("runtime_state_invalid");
  const success = result.lastOutcome === "success";
  if (success && result.lastHttpStatus !== null && !(result.lastHttpStatus >= 200 && result.lastHttpStatus < 300) ||
      result.lastDiagnosticClass === "http_404" && result.lastHttpStatus !== 404 ||
      result.lastDiagnosticClass === "http_5xx" && !(result.lastHttpStatus >= 500 && result.lastHttpStatus < 600))
    return reject("runtime_state_invalid");
  const next = { ...state, ...result, lastSuccessAt: success ? result.lastAttemptAt : null,
    retryAfter: success ? null : State.retryAfterFor(result.lastDiagnosticClass, result.lastAttemptAt),
    reevaluation: { ...state.reevaluation, status: "completed", completedAt } };
  if (!State.validateCompatibleRuntimeState(next, token.sourceId).valid) return reject("runtime_state_invalid");
  return { valid: true, reason: null, state: next };
}
function initialStateUpdate({ sourceId, expectedBinding, state, authority, result, completedAt }) {
  const reject = reason => ({ valid: false, reason });
  const approved = initialBinding(sourceId, authority);
  if (state != null || !approved || !sameBinding(expectedBinding, approved))
    return reject("stale_route_result");
  if (!exact(result, ["lastAttemptAt", "lastOutcome", "lastHttpStatus", "lastDiagnosticClass"]) ||
      !instant(result.lastAttemptAt) || !instant(completedAt) || result.lastOutcome !== "success" ||
      result.lastDiagnosticClass !== null || Date.parse(result.lastAttemptAt) > Date.parse(completedAt) ||
      result.lastHttpStatus !== null && !(result.lastHttpStatus >= 200 && result.lastHttpStatus < 300))
    return reject("runtime_state_invalid");
  const next = { sourceId, lastAttemptAt: result.lastAttemptAt, lastSuccessAt: result.lastAttemptAt,
    lastOutcome: "success", retryAfter: null, lastHttpStatus: result.lastHttpStatus,
    lastDiagnosticClass: null, coordinatorVersion: 1, runtimeStateContractVersion: 2,
    routeBinding: approved, reevaluation: null };
  return State.validateCompatibleRuntimeState(next, sourceId).valid
    ? { valid: true, reason: null, state: next } : reject("runtime_state_invalid");
}
// Explicit route-aware boundary outside B1. Never treats a version difference as permission to retry.
function evaluateBoundUpdate(input, authority) {
  const { runtimeState: state } = input, checked = State.validateCompatibleRuntimeState(state, input.sourceId);
  const selected = select(input.sourceId, authority);
  const blocked = reason => ({ sourceId: input.sourceId, decision: "blocked", eligible: false, reason });
  if (!selected.valid || !selected.acquisitionAllowed) return blocked(selected.reason || "authority_invalid");
  if (!checked.valid) return blocked("runtime_state_invalid");
  if (state?.reevaluation?.status === "reserved") return blocked("reevaluation_interrupted");
  if (state && (checked.recordKind === "legacy" ? selected.routeKind !== "legacy" :
      !sameBinding(state.routeBinding, binding(selected)))) return blocked("route_binding_mismatch");
  return B1.evaluateSourceUpdate({ ...input, runtimeState: state ? State.legacyProjection(state) : null });
}
// Normal acquisition is not a new transition approval. Compare the exact state read
// before acquisition inside the storage transaction; never overwrite a newer result.
function normalStateUpdate({ sourceId, expectedState, state, authority, result, completedAt }) {
  const reject = reason => ({ valid: false, reason });
  const stable = value => JSON.stringify(value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value);
  const selected = select(sourceId, authority);
  if (!State.validateCompatibleRuntimeState(state, sourceId).valid ||
      !State.validateCompatibleRuntimeState(expectedState, sourceId).valid ||
      !state || !expectedState || stable(state) !== stable(expectedState) ||
      state.reevaluation !== null && state.reevaluation?.status !== "completed" ||
      !selected.valid || !selected.acquisitionAllowed ||
      selected.activationState !== "alternative_active" || !sameBinding(state.routeBinding, binding(selected)))
    return reject("stale_route_result");
  if (!exact(result, ["lastAttemptAt", "lastOutcome", "lastHttpStatus", "lastDiagnosticClass"]) ||
      !instant(result.lastAttemptAt) || !instant(completedAt) ||
      Date.parse(result.lastAttemptAt) < Date.parse(state.lastAttemptAt) ||
      Date.parse(completedAt) < Date.parse(result.lastAttemptAt) ||
      !["success", "failure"].includes(result.lastOutcome)) return reject("runtime_state_invalid");
  const success = result.lastOutcome === "success";
  if (success && (result.lastDiagnosticClass !== null || result.lastHttpStatus !== null &&
      !(result.lastHttpStatus >= 200 && result.lastHttpStatus < 300)) ||
      result.lastDiagnosticClass === "http_404" && result.lastHttpStatus !== 404 ||
      result.lastDiagnosticClass === "http_5xx" && !(result.lastHttpStatus >= 500 && result.lastHttpStatus < 600))
    return reject("runtime_state_invalid");
  const next = { ...state, ...result, lastSuccessAt: success ? result.lastAttemptAt : state.lastSuccessAt,
    retryAfter: success ? null : State.retryAfterFor(result.lastDiagnosticClass, result.lastAttemptAt) };
  return State.validateCompatibleRuntimeState(next, sourceId).valid
    ? { valid: true, state: next } : reject("runtime_state_invalid");
}
module.exports = Object.freeze({ APPROVALS, binding, sameBinding, initialBinding, evaluate, reserveState,
  reservationToken, completeState, initialStateUpdate, evaluateBoundUpdate, normalStateUpdate });
