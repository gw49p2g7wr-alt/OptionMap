"use strict";

const fs = require("node:fs"), path = require("node:path");
const windows = platform => (platform || process.platform) === "win32";
function normalize(value, platform = process.platform) {
  const api = windows(platform) ? path.win32 : path;
  const result = api.normalize(String(value));
  return windows(platform) ? result.toLowerCase() : result;
}
function samePath(a, b, platform = process.platform) { return normalize(a, platform) === normalize(b, platform); }
function contains(root, target, platform = process.platform) {
  const api = windows(platform) ? path.win32 : path;
  const relative = api.relative(normalize(root, platform), normalize(target, platform));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}
function canonical(target, fsApi = fs, platform = process.platform) {
  const actual = fsApi.realpathSync(target);
  if (!samePath(actual, target, platform)) throw Error("filesystem_canonical_identity_invalid");
  return actual;
}
function secureDirectoryStat(stat, { platform = process.platform, owner = true } = {}) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (!windows(platform) && ((stat.mode & 0o077) || owner && typeof process.getuid === "function" && stat.uid !== process.getuid())) return false;
  return true;
}
function secureFileStat(stat, { platform = process.platform, owner = true, maxBytes = null } = {}) {
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1 || maxBytes !== null && stat.size > maxBytes) return false;
  if (!windows(platform) && ((stat.mode & 0o077) || owner && typeof process.getuid === "function" && stat.uid !== process.getuid())) return false;
  return true;
}
const noFollowFlag = (platform = process.platform) => windows(platform) ? 0 : (fs.constants.O_NOFOLLOW || 0);
function syncDirectory(target, fsApi = fs, platform = process.platform) {
  if (windows(platform)) return { strategy: "file_sync_publish_readback", synced: false };
  const fd = fsApi.openSync(target, fs.constants.O_RDONLY | noFollowFlag(platform));
  try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
  return { strategy: "directory_fsync", synced: true };
}
module.exports = Object.freeze({ windows, normalize, samePath, contains, canonical, secureDirectoryStat,
  secureFileStat, noFollowFlag, syncDirectory });
