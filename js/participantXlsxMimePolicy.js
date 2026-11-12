"use strict";

const OFFICIAL_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const JPX_BINARY_XLSX_MIME = "binary/octet-stream";
const ACCEPTED_MIME_TYPES = Object.freeze([
  OFFICIAL_XLSX_MIME,
  JPX_BINARY_XLSX_MIME
]);

function isAcceptedParticipantsXlsxMime(value) {
  return typeof value === "string" && ACCEPTED_MIME_TYPES.includes(value);
}

module.exports = Object.freeze({ OFFICIAL_XLSX_MIME, JPX_BINARY_XLSX_MIME,
  ACCEPTED_MIME_TYPES, isAcceptedParticipantsXlsxMime });
