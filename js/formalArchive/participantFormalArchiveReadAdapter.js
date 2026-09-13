(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveReadAdapter = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const fallbackStatuses = new Set(["empty", "unavailable", "corrupted"]);
    function createParticipantFormalArchiveReadAdapter({ archiveReader, legacyReader } = {}) {
        async function withFallback(operation, legacyOperation, options) {
            let archive; try { archive = await archiveReader?.[operation]?.(options); }
            catch (_error) { archive = { status: "unavailable", reason: "archive_read_failed" }; }
            if (!fallbackStatuses.has(archive?.status)) return { ...archive, source: "formal_archive" };
            let legacy; try { legacy = await legacyReader?.[legacyOperation]?.(options); }
            catch (_error) { legacy = { status: "unavailable", reason: "legacy_read_failed" }; }
            return { ...legacy, source: "legacy_participant_history",
                fallback: { used: true, archiveStatus: archive?.status || "unavailable",
                    archiveReason: archive?.reason || null } };
        }
        return Object.freeze({
            readLatest: options => withFallback("readLatest", "readLatest", options),
            readRange: options => withFallback("readRange", "readRange", options),
            readRevision: revisionKey => withFallback("readRevision", "readRevision", revisionKey)
        });
    }
    return Object.freeze({ createParticipantFormalArchiveReadAdapter });
});
