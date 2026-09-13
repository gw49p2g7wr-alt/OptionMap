(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("./participantFormalArchiveSchema.js") :
        root?.OptionMapParticipantFormalArchiveSchema;
    const historyApi = commonJs ? require("../participantHistory.js") : root?.OptionMapParticipantHistory;
    const participantApi = commonJs ? require("../participantData.js") : root?.OptionMapParticipantData;
    const api = factory(schema, historyApi, participantApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveMigrationPreview = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, historyApi, participantApi) {
    "use strict";
    const PREVIEW_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function sha256(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function participantRecords(completeSet) { const records = [];
        for (const file of Object.values(completeSet?.files || {}))
            for (const bucket of ["large", "mini", "topix", "micro", "option"])
                if (Array.isArray(file?.data?.[bucket]?.records)) records.push(...file.data[bucket].records);
        return records;
    }
    function projectRevision(entry, revision) { const entryKey = schema.entryKeyFor(entry.sourceDate),
        revisionKey = `${entryKey}|${revision.versionKey}`;
        return { revisionKey, entryKey, sourceDate: entry.sourceDate, versionKey: revision.versionKey,
            contentSignature: revision.signature, signatureAlgorithm: revision.signatureAlgorithm,
            signature: revision.signature, confirmedAt: revision.confirmedAt,
            replacedAt: revision.replacedAt, revisionState: revision.versionKey === entry.activeVersionKey ?
                "active" : "replaced", completeSet: clone(revision.completeSet) }; }
    function reconstruct(entries, revisions) { const byEntry = new Map();
        for (const revision of revisions) { const list = byEntry.get(revision.entryKey) || [];
            list.push({ versionKey: revision.versionKey, signatureAlgorithm: revision.signatureAlgorithm,
                signature: revision.signature, confirmedAt: revision.confirmedAt,
                replacedAt: revision.replacedAt, completeSet: clone(revision.completeSet) });
            byEntry.set(revision.entryKey, list); }
        return entries.map(entry => ({ sourceDate: entry.sourceDate,
            activeVersionKey: entry.activeRevisionKey.slice(entry.entryKey.length + 1),
            firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt,
            revisions: byEntry.get(entry.entryKey) || [] })); }
    async function previewMigration(history) {
        const sourceFingerprint = await sha256(history); const sourceEntries = Array.isArray(history?.entries) ?
            history.entries : [], failures = [], duplicates = [], conflicts = [], entries = [], revisions = [],
            dateCounts = new Map(), versionGroups = new Map();
        for (const entry of sourceEntries) { dateCounts.set(entry?.sourceDate,
            (dateCounts.get(entry?.sourceDate) || 0) + 1);
            for (const revision of entry?.revisions || []) { const values = versionGroups.get(
                revision?.versionKey) || []; values.push({ sourceDate: entry?.sourceDate,
                    signature: revision?.signature }); versionGroups.set(revision?.versionKey, values); } }
        for (const [sourceDate, count] of dateCounts) if (count > 1)
            duplicates.push({ type: "source_date", sourceDate, count });
        for (const [versionKey, values] of versionGroups) if (values.length > 1) {
            const item = { type: "version_key", versionKey,
                sourceDates: [...new Set(values.map(value => value.sourceDate))] };
            if (new Set(values.map(value => value.signature)).size === 1) duplicates.push(item);
            else conflicts.push(item); }
        let sourceValid = false; try { sourceValid = await historyApi.validateParticipantHistory(
            history, participantApi.validateParticipantCache) === true; } catch (_error) {}
        for (const entry of sourceEntries) { const reasons = [], projected = [], sourceDate = entry?.sourceDate;
            if ((dateCounts.get(sourceDate) || 0) > 1) reasons.push("duplicate_source_date");
            if (!Array.isArray(entry?.revisions) || !entry.revisions.length)
                reasons.push("revisions_missing");
            for (const revision of entry?.revisions || []) { const group = versionGroups.get(
                revision.versionKey) || [];
                if (group.length > 1) reasons.push(new Set(group.map(value => value.signature)).size === 1 ?
                    "duplicate_version_key" : "version_key_signature_conflict");
                let payloadValid = false; try { payloadValid = await participantApi
                    .validateParticipantCache(revision.completeSet) === true; } catch (_error) {}
                if (!payloadValid) reasons.push("complete_set_invalid");
                const value = projectRevision(entry, revision); if (!schema.validateRevision(value))
                    reasons.push("archive_revision_invalid"); projected.push(value); }
            const active = projected.filter(item => item.revisionState === "active");
            if (active.length !== 1) reasons.push("active_revision_invalid");
            const archiveEntry = { entryKey: schema.entryKeyFor(sourceDate), sourceDate,
                activeRevisionKey: active[0]?.revisionKey || "", firstSeenAt: entry?.firstSeenAt,
                lastSeenAt: entry?.lastSeenAt };
            if (!schema.validateEntry(archiveEntry)) reasons.push("archive_entry_invalid");
            const uniqueReasons = [...new Set(reasons)];
            if (uniqueReasons.length) failures.push({ sourceDate: sourceDate || null,
                revisionCount: entry?.revisions?.length || 0,
                versionKeys: (entry?.revisions || []).map(revision => revision.versionKey || null),
                reasons: uniqueReasons });
            else { entries.push(archiveEntry); revisions.push(...projected); } }
        const createdAt = entries.reduce((value, entry) => !value || entry.firstSeenAt < value ?
            entry.firstSeenAt : value, null), updatedAt = entries.reduce((value, entry) =>
                !value || entry.lastSeenAt > value ? entry.lastSeenAt : value, null);
        const metadata = entries.length ? { id: schema.META_KEY,
            archiveSchemaVersion: schema.ARCHIVE_SCHEMA_VERSION, dataset: schema.DATASET,
            authorityClass: schema.AUTHORITY_CLASS, retentionPolicy: schema.RETENTION_POLICY,
            createdAt, updatedAt, integrityAlgorithm: "sha256", entryCount: entries.length,
            revisionCount: revisions.length } : null;
        const archive = { metadata, entries, revisions }; const projectedArchiveFingerprint = await sha256(archive);
        const roundTrip = reconstruct(entries, revisions), sourceSemantics = clone(sourceEntries);
        const semanticEquivalence = sourceValid && failures.length === 0 && duplicates.length === 0 &&
            conflicts.length === 0 && canonical(roundTrip) === canonical(sourceSemantics);
        const sourceRevisionCount = sourceEntries.reduce((sum, entry) =>
            sum + (entry?.revisions?.length || 0), 0);
        return Object.freeze({ previewVersion: PREVIEW_VERSION, shadowOnly: true, sourceFingerprint,
            projectedArchiveFingerprint, semanticEquivalence, semanticEquivalenceStatus:
                semanticEquivalence ? "PASS" : "FAIL", sourceValid,
            counts: { sourceDateCount: sourceEntries.length, sourceRevisionCount,
                activeRevisionCount: sourceEntries.filter(entry => entry.revisions?.filter(revision =>
                    revision.versionKey === entry.activeVersionKey).length === 1).length,
                participantRecordCount: sourceEntries.reduce((sum, entry) => sum +
                    (entry.revisions || []).reduce((total, revision) => total +
                        participantRecords(revision.completeSet).length, 0), 0),
                projectedActiveRevisionCount: revisions.filter(revision =>
                    revision.revisionState === "active").length,
                projectedReplacedRevisionCount: revisions.filter(revision =>
                    revision.revisionState === "replaced").length,
                versionKeyCount: revisions.filter(revision => revision.versionKey).length,
                contentSignatureCount: revisions.filter(revision => revision.contentSignature).length,
                completeSetCount: revisions.filter(revision => revision.completeSet).length,
                migratableCount: revisions.length,
                nonMigratableCount: sourceRevisionCount - revisions.length },
            failures, duplicates, conflicts, projectedArchive: archive,
            diagnostics: { databaseOpened: false, storageWritten: false, migrationPerformed: false,
                uiConnected: false, fullExportConnected: false } });
    }
    return Object.freeze({ PREVIEW_VERSION, previewMigration });
});
