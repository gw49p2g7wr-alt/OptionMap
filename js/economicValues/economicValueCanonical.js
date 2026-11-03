"use strict";

const crypto = require("node:crypto");

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = value => crypto.createHash("sha256").update(
  Buffer.isBuffer(value) || value instanceof Uint8Array ? value : stable(value)).digest("hex");
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const timestamp = value => typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const date = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const month = value => typeof value === "string" && /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(value);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const decimal = value => typeof value === "string" && /^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value);

module.exports = freeze({ stable, sha256, clone, freeze, exact, timestamp, date, month, hash, decimal });
