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
function sameOpenedIdentity(pathStat, fdStat, platform = process.platform) {
  if (pathStat.ino !== fdStat.ino) return false;
  if (!windows(platform)) return pathStat.dev === fdStat.dev;
  // Node 22 Windows path stats may report dev=0 while handle stats expose the volume ID.
  return pathStat.dev === 0 || pathStat.dev === fdStat.dev;
}
function validateSameOpenedFile({ file, root, pathStatBefore, fdStat, fsApi = fs,
  platform = process.platform, maxBytes = null }) {
  try {
    if (typeof file !== "string" || typeof root !== "string" ||
        !secureFileStat(pathStatBefore, { platform, maxBytes }) ||
        !secureFileStat(fdStat, { platform, maxBytes }) ||
        !sameOpenedIdentity(pathStatBefore, fdStat, platform) ||
        pathStatBefore.size !== fdStat.size || !contains(root, file, platform) ||
        !samePath(fsApi.realpathSync(file), file, platform)) return false;
    const pathStatAfter = fsApi.lstatSync(file);
    if (!secureFileStat(pathStatAfter, { platform, maxBytes }) ||
        !sameOpenedIdentity(pathStatAfter, fdStat, platform) || pathStatAfter.size !== fdStat.size ||
        !contains(root, file, platform) || !samePath(fsApi.realpathSync(file), file, platform)) return false;
    if (!windows(platform)) return true;

    let reopenedDescriptor;
    try {
      reopenedDescriptor = fsApi.openSync(file, fs.constants.O_RDONLY | noFollowFlag(platform));
      const reopened = fsApi.fstatSync(reopenedDescriptor), finalPathStat = fsApi.lstatSync(file);
      return secureFileStat(reopened, { platform, maxBytes }) &&
        secureFileStat(finalPathStat, { platform, maxBytes }) &&
        reopened.dev === fdStat.dev && reopened.ino === fdStat.ino && reopened.size === fdStat.size &&
        sameOpenedIdentity(finalPathStat, fdStat, platform) && finalPathStat.size === fdStat.size &&
        contains(root, file, platform) && samePath(fsApi.realpathSync(file), file, platform);
    } finally {
      if (reopenedDescriptor !== undefined) fsApi.closeSync(reopenedDescriptor);
    }
  } catch (_error) { return false; }
}
const noFollowFlag = (platform = process.platform) => windows(platform) ? 0 : (fs.constants.O_NOFOLLOW || 0);
function syncDirectory(target, fsApi = fs, platform = process.platform) {
  if (windows(platform)) return { strategy: "file_sync_publish_readback", synced: false };
  const fd = fsApi.openSync(target, fs.constants.O_RDONLY | noFollowFlag(platform));
  try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
  return { strategy: "directory_fsync", synced: true };
}
module.exports = Object.freeze({ windows, normalize, samePath, contains, canonical, secureDirectoryStat,
  secureFileStat, validateSameOpenedFile, noFollowFlag, syncDirectory });
