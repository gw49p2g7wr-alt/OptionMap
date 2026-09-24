"use strict";

const zlib = require("node:zlib");

const LIMITS = Object.freeze({ maxCompressedBytes: 5_000_000, maxUncompressedBytes: 25_000_000,
  maxEntryCount: 256, maxEntryBytes: 8_000_000 });
const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

function fail(reason, details = {}) { return Object.freeze({ valid: false, reason, ...details }); }
function safeName(name) {
  return name && !name.startsWith("/") && !name.startsWith("\\") &&
    !/^[a-z]:/i.test(name) && !name.split(/[\\/]/).includes("..") && !name.includes("\\");
}
function findEocd(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= start; index -= 1)
    if (bytes.readUInt32LE(index) === EOCD) return index;
  return -1;
}
function inflateEntry(bytes, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== LOCAL) throw new Error("local_header_invalid");
  const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28),
    start = offset + 30 + nameLength + extraLength, end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error("entry_truncated");
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: entry.uncompressedSize + 1 });
  throw new Error("compression_method_not_allowed");
}

function inspectWorkbook(input, limits = LIMITS) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== LOCAL) return fail("zip_signature_invalid");
  if (bytes.length > limits.maxCompressedBytes) return fail("compressed_size_exceeded");
  const eocd = findEocd(bytes);
  if (eocd < 0) return fail("zip_eocd_missing");
  const disk = bytes.readUInt16LE(eocd + 4), centralDisk = bytes.readUInt16LE(eocd + 6),
    count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12),
    centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0) return fail("multi_disk_zip_forbidden");
  if (count === 0 || count > limits.maxEntryCount) return fail("entry_count_exceeded");
  if (centralOffset + centralSize > eocd) return fail("central_directory_invalid");
  const entries = [], names = new Set(); let cursor = centralOffset, total = 0;
  try {
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL)
        return fail("central_entry_invalid");
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10),
        compressedSize = bytes.readUInt32LE(cursor + 20), uncompressedSize = bytes.readUInt32LE(cursor + 24),
        nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30),
        commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42),
        name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (flags & 1) return fail("encrypted_entry_forbidden");
      if (!safeName(name)) return fail("path_traversal", { entry: name });
      if (names.has(name.toLowerCase())) return fail("duplicate_entry", { entry: name });
      if (uncompressedSize > limits.maxEntryBytes) return fail("entry_size_exceeded", { entry: name });
      total += uncompressedSize;
      if (total > limits.maxUncompressedBytes) return fail("uncompressed_size_exceeded");
      names.add(name.toLowerCase()); entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if ([...names].some(name => /(^|\/)(vbaProject\.bin|macrosheets\/|xl4macros)/i.test(name) ||
        /\.xlsm$/i.test(name))) return fail("macro_workbook_forbidden");
    const xmlEntries = entries.filter(entry => /(?:\.rels|\[content_types\]\.xml|workbook\.xml)$/i.test(entry.name));
    for (const entry of xmlEntries) {
      const content = inflateEntry(bytes, entry).toString("utf8");
      if (entry.name.endsWith(".rels") && /TargetMode\s*=\s*["']External["']/i.test(content))
        return fail("external_relationship_forbidden", { entry: entry.name });
      if (/externalLink/i.test(entry.name) || /externalLinks\//i.test(content))
        return fail("unsafe_external_reference", { entry: entry.name });
      if (/<Override\b[^>]*ContentType=["'][^"']*(?:macroEnabled|vbaProject)/i.test(content))
        return fail("macro_workbook_forbidden");
    }
  } catch (error) { return fail(error.message || "zip_parse_failed"); }
  return Object.freeze({ valid: true, reason: null, compressedBytes: bytes.length,
    uncompressedBytes: total, entryCount: entries.length });
}

function sanitizeValueOnly(input, XLSX, limits = LIMITS) {
  const inspected = inspectWorkbook(input, limits);
  if (inspected.valid) return Object.freeze({ valid: true, sanitized: false,
    bytes: new Uint8Array(input), inspection: inspected });
  if (!["external_relationship_forbidden", "unsafe_external_reference"].includes(inspected.reason))
    return inspected;
  if (!XLSX?.read || !XLSX?.write || !XLSX?.utils) return fail("workbook_sanitizer_unavailable");
  try {
    const source = XLSX.read(input, { type: "array", bookDeps: false, bookFiles: false,
      bookVBA: false, cellFormula: true, cellNF: true, cellStyles: true });
    if (!Array.isArray(source.SheetNames) || source.SheetNames.length === 0)
      return fail("workbook_structure_invalid");
    for (const name of source.SheetNames) {
      const sheet = source.Sheets[name];
      for (const cell of Object.values(sheet || {})) if (cell && typeof cell === "object" &&
          typeof cell.f === "string" && /\[[^\]]+\]|(?:file|https?|ftp):/i.test(cell.f))
        return fail("external_formula_forbidden");
    }
    // SheetJS does not retain OOXML external-link parts on read/write. Rewriting the
    // parsed workbook therefore removes those parts while preserving cell display
    // formats and workbook structure needed by the existing value-only parser.
    const bytes = new Uint8Array(XLSX.write(source, { type: "buffer", bookType: "xlsx",
      compression: true })), clean = inspectWorkbook(bytes, limits);
    return clean.valid ? Object.freeze({ valid: true, sanitized: true, bytes,
      originalReason: inspected.reason, inspection: clean }) : clean;
  } catch (_error) { return fail("workbook_value_only_sanitization_failed"); }
}

module.exports = Object.freeze({ LIMITS, inspectWorkbook, sanitizeValueOnly });
