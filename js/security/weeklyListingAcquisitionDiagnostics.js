"use strict";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function sanitizeIdentity(value) {
  let url;
  try {
    url = new URL(typeof value === "string" ? value : "");
  } catch (_error) {
    return freeze({ hostClass: "invalid", pathnameClass: "invalid", year: null });
  }
  const match = url.pathname.match(
    /^\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_(20\d{2})\.json$/
  );
  return freeze({
    hostClass: url.hostname === "www.jpx.co.jp" ? "jpx" : "other",
    pathnameClass: match ? "open_interest_year_json" : "other",
    year: match?.[1] || null
  });
}

function sanitizeFinalUrlShape(value) {
  let url;
  try {
    url = new URL(typeof value === "string" ? value : "");
  } catch (_error) {
    return freeze({
      hostname: null,
      pathname: null,
      hasPort: null,
      hasQuery: null,
      hasHash: null,
      hasCredentials: null
    });
  }
  return freeze({
    hostname: url.hostname,
    pathname: url.pathname,
    hasPort: url.port !== "",
    hasQuery: url.search !== "",
    hasHash: url.hash !== "",
    hasCredentials: url.username !== "" || url.password !== ""
  });
}

function initialState() {
  return {
    status: "not_started",
    phase: null,
    reason: null,
    acquisitionGeneration: 0,
    requestedUrlClass: null,
    requestedValidation: null,
    networkStarted: false,
    responseReceived: false,
    finalValidation: null,
    finalUrlShape: null,
    redirectPolicy: null,
    finalUrlAuthority: null,
    httpStatus: null,
    httpStatusChecked: false,
    bodyRead: false,
    jsonParsed: false,
    accepted: false,
    errorCode: null,
    startedAt: null,
    completedAt: null
  };
}

function createWeeklyListingAcquisitionDiagnostics({
  now = () => new Date().toISOString()
} = {}) {
  let state = freeze(initialState());

  function update(patch) {
    state = freeze({ ...clone(state), ...clone(patch) });
    return state;
  }

  function begin(requestedUrl) {
    state = freeze({
      ...initialState(),
      status: "pending",
      phase: "requested_url_validation",
      acquisitionGeneration: state.acquisitionGeneration + 1,
      requestedUrlClass: sanitizeIdentity(requestedUrl),
      startedAt: now()
    });
  }

  function requestedValidated(validation) {
    if (!validation?.ok) {
      return fail("requested_url_validation", "requested_validation_failed",
        validation?.errorCode || "invalid_url", { requestedValidation: "rejected" });
    }
    return update({ requestedValidation: "accepted" });
  }

  function networkStarted() {
    return update({ phase: "network_started", networkStarted: true });
  }

  function responseReceived(httpStatus) {
    return update({ phase: "response_received", responseReceived: true,
      httpStatus: Number.isInteger(httpStatus) ? httpStatus : null });
  }

  function finalValidated(validation, finalUrl) {
    const finalUrlShape = sanitizeFinalUrlShape(finalUrl);
    if (!validation?.ok) {
      return fail("final_url_validation", "final_validation_failed",
        validation?.errorCode || "invalid_redirect", {
          finalValidation: "rejected", finalUrlShape
        });
    }
    return update({ phase: "final_url_validation", finalValidation: "accepted",
      finalUrlShape });
  }

  function redirectProtected(requestedUrl) {
    return update({
      phase: "final_url_validation",
      finalValidation: "accepted",
      finalUrlShape: sanitizeFinalUrlShape(requestedUrl),
      redirectPolicy: "error",
      finalUrlAuthority: "requested_url_no_redirect"
    });
  }

  function httpChecked(httpStatus) {
    return update({ phase: "http_status_checked", httpStatusChecked: true,
      httpStatus: Number.isInteger(httpStatus) ? httpStatus : null });
  }

  function bodyRead() {
    return update({ phase: "body_read", bodyRead: true });
  }

  function jsonParsed() {
    return update({ phase: "json_parsed", jsonParsed: true });
  }

  function accepted() {
    return update({ status: "accepted", phase: "accepted", accepted: true,
      completedAt: now() });
  }

  function fail(phase, reason, errorCode = null, extra = {}) {
    return update({ status: "failed", phase, reason, errorCode,
      ...clone(extra), completedAt: now() });
  }

  function getState() {
    return freeze(clone(state));
  }

  return freeze({ begin, requestedValidated, networkStarted, responseReceived,
    finalValidated, redirectProtected, httpChecked, bodyRead, jsonParsed,
    accepted, fail, getState });
}

module.exports = freeze({ createWeeklyListingAcquisitionDiagnostics });
