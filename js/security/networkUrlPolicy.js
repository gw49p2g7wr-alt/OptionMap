"use strict";

const ERROR_CODES = Object.freeze({
  INVALID_URL: "invalid_url",
  INVALID_PROTOCOL: "invalid_protocol",
  INVALID_CREDENTIALS: "invalid_credentials",
  INVALID_HOST: "invalid_host",
  INVALID_PORT: "invalid_port",
  INVALID_QUERY: "invalid_query",
  INVALID_HASH: "invalid_hash",
  INVALID_PATH: "invalid_path",
  INVALID_DATE: "invalid_date",
  INVALID_REDIRECT: "invalid_redirect"
});

function result(ok, url = null, errorCode = null, kind = null) {
  return Object.freeze({ ok, url, errorCode, kind });
}

function hasExplicitPort(value) {
  const authority = String(value).match(/^https:\/\/([^/?#]*)/i)?.[1] || "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return /:\d+$/.test(host);
}

function parseHttpsUrl(value, hostname) {
  if (typeof value !== "string" || value.length === 0) {
    return result(false, null, ERROR_CODES.INVALID_URL);
  }
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    return result(false, null, ERROR_CODES.INVALID_URL);
  }
  if (url.protocol !== "https:") {
    return result(false, null, ERROR_CODES.INVALID_PROTOCOL);
  }
  if (url.username !== "" || url.password !== "") {
    return result(false, null, ERROR_CODES.INVALID_CREDENTIALS);
  }
  if (url.hostname !== hostname) {
    return result(false, null, ERROR_CODES.INVALID_HOST);
  }
  if (url.port !== "" || hasExplicitPort(value)) {
    return result(false, null, ERROR_CODES.INVALID_PORT);
  }
  if (url.search !== "") {
    return result(false, null, ERROR_CODES.INVALID_QUERY);
  }
  if (url.hash !== "") {
    return result(false, null, ERROR_CODES.INVALID_HASH);
  }
  if (/%[0-9a-f]{2}/i.test(url.pathname) || url.pathname.slice(1).includes("//")) {
    return result(false, null, ERROR_CODES.INVALID_PATH);
  }
  return result(true, url.href);
}

function validCalendarDate(compact) {
  if (!/^20\d{6}$/.test(compact || "")) return false;
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateQriUrl(value) {
  const parsed = parseHttpsUrl(value, "svc.qri.jp");
  if (!parsed.ok) return parsed;
  const url = new URL(parsed.url);
  return /^\/jpx\/nkopm(?:\/\d+)?\/?$/.test(url.pathname)
    ? result(true, url.href, null, "qri")
    : result(false, null, ERROR_CODES.INVALID_PATH);
}

const JPX_TARGET_PATHS = new Set([
  "/markets/derivatives/open-interest/index.html",
  "/markets/derivatives/participant-volume/index.html"
]);
const JPX_INTERNAL_PATHS = new Set([
  "/",
  "/markets/derivatives/quotes/index.html",
  "/markets/derivatives/participant-volume/index.html"
]);

function validateJpxPath(value, paths, kind) {
  const parsed = parseHttpsUrl(value, "www.jpx.co.jp");
  if (!parsed.ok) return parsed;
  const url = new URL(parsed.url);
  return paths.has(url.pathname)
    ? result(true, url.href, null, kind)
    : result(false, null, ERROR_CODES.INVALID_PATH);
}

function validateJpxPageUrl(value) {
  return validateJpxPath(value, JPX_TARGET_PATHS, "jpx_page");
}

function validateJpxInternalUrl(value) {
  return validateJpxPath(value, JPX_INTERNAL_PATHS, "jpx_internal");
}

function validateOpenInterestJsonUrl(value) {
  const parsed = parseHttpsUrl(value, "www.jpx.co.jp");
  if (!parsed.ok) return parsed;
  const url = new URL(parsed.url);
  return /^\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_20\d{2}\.json$/.test(url.pathname)
    ? result(true, url.href, null, "open_interest_json")
    : result(false, null, ERROR_CODES.INVALID_PATH);
}

function validateParticipantJsonUrl(value) {
  const parsed = parseHttpsUrl(value, "www.jpx.co.jp");
  if (!parsed.ok) return parsed;
  const url = new URL(parsed.url);
  const valid = url.pathname ===
      "/automation/markets/derivatives/participant-volume/json/participant-volume_monthlylist.json" ||
    /^\/automation\/markets\/derivatives\/participant-volume\/json\/participant_volume_(20\d{2})(0[1-9]|1[0-2])\.json$/.test(url.pathname);
  return valid
    ? result(true, url.href, null, "participant_json")
    : result(false, null, ERROR_CODES.INVALID_PATH);
}

const PARTICIPANT_SUFFIXES = new Set([
  "volume_by_participant_whole_day.xlsx",
  "volume_by_participant_whole_day_J-NET.xlsx",
  "volume_by_participant_night.xlsx",
  "volume_by_participant_night_J-NET.xlsx"
]);

function validateExcelUrl(value) {
  const parsed = parseHttpsUrl(value, "www.jpx.co.jp");
  if (!parsed.ok) return parsed;
  const url = new URL(parsed.url);
  let match = url.pathname.match(
    /^\/automation\/markets\/derivatives\/open-interest\/files\/(20\d{2})\/(20\d{6})_(indexfut_oi_by_tp|nk225op_oi_by_tp)\.xlsx$/
  );
  if (match) {
    if (!validCalendarDate(match[2]) || match[1] !== match[2].slice(0, 4)) {
      return result(false, null, ERROR_CODES.INVALID_DATE);
    }
    return result(true, url.href, null,
      match[3] === "indexfut_oi_by_tp" ? "weekly_futures_excel" : "weekly_options_excel");
  }
  match = url.pathname.match(
    /^\/automation\/markets\/derivatives\/participant-volume\/files\/daily\/(20\d{4})\/(20\d{6})_(volume_by_participant_[^/]+\.xlsx)$/
  );
  if (!match) return result(false, null, ERROR_CODES.INVALID_PATH);
  if (!validCalendarDate(match[2]) || match[1] !== match[2].slice(0, 6)) {
    return result(false, null, ERROR_CODES.INVALID_DATE);
  }
  return PARTICIPANT_SUFFIXES.has(match[3])
    ? result(true, url.href, null, "participant_excel")
    : result(false, null, ERROR_CODES.INVALID_PATH);
}

function validateFinalUrl(validator, requestedUrl, finalUrl) {
  if (typeof validator !== "function" || !validator(requestedUrl).ok ||
      !validator(finalUrl).ok) {
    return result(false, null, ERROR_CODES.INVALID_REDIRECT);
  }
  return result(true, validator(finalUrl).url, null, validator(finalUrl).kind);
}

module.exports = Object.freeze({
  ERROR_CODES,
  validateQriUrl,
  validateJpxPageUrl,
  validateJpxInternalUrl,
  validateOpenInterestJsonUrl,
  validateParticipantJsonUrl,
  validateExcelUrl,
  validateFinalUrl
});
