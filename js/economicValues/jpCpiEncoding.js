"use strict";

const Canonical = require("./economicValueCanonical.js");

function detect(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    prefix = new TextDecoder("windows-1252").decode(view.subarray(0, 1024)),
    match = prefix.match(/<meta\b[^>]*charset\s*=\s*["']?([A-Za-z0-9_-]+)/i),
    label = String(match?.[1] || "").toLowerCase().replace(/_/g, "-");
  if (["shift-jis", "sjis", "windows-31j"].includes(label)) return "shift_jis";
  if (["utf-8", "utf8"].includes(label)) return "utf-8";
  return null;
}
function decode(value) {
  if (typeof value === "string") return value;
  const encoding = detect(value);
  if (!encoding) throw new Error("jp_cpi_encoding_unverifiable");
  try { return new TextDecoder(encoding, { fatal: true }).decode(value); }
  catch (_error) { throw new Error("jp_cpi_encoding_invalid"); }
}

module.exports = Canonical.freeze({ detect, decode });
