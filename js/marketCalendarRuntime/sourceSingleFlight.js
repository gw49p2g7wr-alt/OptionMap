"use strict";

const registry = require("../marketCalendar/sourceRegistry.js");
const networkPolicy = require("./calendarNetworkPolicy.js");

const activeFlights = new Map();
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function deepFreeze(value) {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("policy_identity_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("policy_identity_invalid");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_KEYS.has(key) || value[key] === undefined)
      throw new TypeError("policy_identity_invalid");
    result[key] = canonicalize(value[key]);
  }
  return result;
}

function policyIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length === 0) throw new TypeError("policy_identity_invalid");
  const canonical = canonicalize(value);
  return { canonical, serialized: JSON.stringify(canonical) };
}

function validateSource(sourceId) {
  if (typeof sourceId !== "string" || sourceId.length === 0) return "malformed_source_id";
  if (registry.BLOCKED_SOURCES[sourceId]) return "blocked_source";
  if (registry.REPLACED_SOURCES[sourceId]) return "replaced_source";
  if (!registry.SOURCES[sourceId]) return "unknown_source";
  return null;
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    return { valid: false, reason: "request_invalid" };
  const sourceError = validateSource(request.sourceId);
  if (sourceError) return { valid: false, reason: sourceError };
  if (request.operation !== networkPolicy.OPERATION)
    return { valid: false, reason: "operation_not_allowed" };
  if (typeof request.execute !== "function")
    return { valid: false, reason: "execute_required" };
  let identity;
  try { identity = policyIdentity(request.acquisitionPolicyIdentity); }
  catch (_error) { return { valid: false, reason: "policy_identity_invalid" }; }
  return { valid: true, sourceId: request.sourceId, operation: request.operation,
    execute: request.execute, policy: identity.canonical,
    key: JSON.stringify([request.sourceId, request.operation, identity.serialized]) };
}

function cloneResult(value) {
  try { return structuredClone(value); }
  catch (_error) { throw new TypeError("execution_result_not_cloneable"); }
}

function callerResult(flight, joinedExistingFlight) {
  return flight.promise.then(value => deepFreeze({ sourceId: flight.sourceId,
    operation: flight.operation, joinedExistingFlight, flightIdentity: {
      key: flight.key, sourceId: flight.sourceId, operation: flight.operation,
      acquisitionPolicyIdentity: cloneResult(flight.policy) },
    executionOutcome: cloneResult(value) }));
}

function runSourceFlight(request) {
  const checked = validateRequest(request);
  if (!checked.valid) return Promise.reject(Object.freeze(Object.assign(
    new TypeError(checked.reason), { code: checked.reason })));
  const existing = activeFlights.get(checked.key);
  if (existing) return callerResult(existing, true);

  const flight = { key: checked.key, sourceId: checked.sourceId, operation: checked.operation,
    policy: deepFreeze(cloneResult(checked.policy)), promise: null };
  const context = deepFreeze({ sourceId: flight.sourceId, operation: flight.operation,
    acquisitionPolicyIdentity: cloneResult(flight.policy) });
  flight.promise = Promise.resolve().then(() => checked.execute(context)).finally(() => {
    if (activeFlights.get(flight.key) === flight) activeFlights.delete(flight.key);
  });
  activeFlights.set(flight.key, flight);
  return callerResult(flight, false);
}

function getFlightDiagnostics() {
  return deepFreeze({ activeFlightCount: activeFlights.size,
    flightKeys: [...activeFlights.keys()].sort() });
}

module.exports = Object.freeze({ OPERATION: networkPolicy.OPERATION, runSourceFlight,
  getFlightDiagnostics });
