(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("./participantFormalArchiveSchema.js") :
        root?.OptionMapParticipantFormalArchiveSchema;
    const storeApi = commonJs ? require("../storage/participantFormalArchiveStore.js") :
        root?.OptionMapParticipantFormalArchiveStore;
    const participantApi = commonJs ? require("../participantData.js") : root?.OptionMapParticipantData;
    const api = factory(schema, storeApi, participantApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveMigrationWriter = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, storeApi, participantApi) {
    "use strict";
    const WRITE_AUTHORIZATION = "participant-formal-archive-shadow-write-v1";
    const ALLOWED_TARGETS = new Set(["test", "profile_copy"]);
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    const requestValue = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => undefined; });
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function sha256(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function createParticipantFormalArchiveMigrationWriter(configuration = {}) {
        const authorized = configuration.indexedDB && ALLOWED_TARGETS.has(configuration.targetEnvironment) &&
            configuration.writeAuthorization === WRITE_AUTHORIZATION;
        if (!authorized) return Object.freeze({ writeProjection: async () => ({ written: false,
            status: "forbidden", reason: "explicit_non_production_target_required" }) });
        const store = storeApi.createParticipantFormalArchiveStore({ indexedDB: configuration.indexedDB,
            IDBKeyRange: configuration.IDBKeyRange, databaseName: configuration.databaseName,
            validateRevisionPayload: configuration.validateRevisionPayload ||
                participantApi.validateParticipantCache,
            storageManager: configuration.storageManager });
        async function readProjection(db, projection) { const names = [schema.META_STORE, schema.ENTRY_STORE,
            schema.REVISION_STORE], transaction = db.transaction(names, "readonly"),
            done = transactionDone(transaction), metaRequest = requestValue(
                transaction.objectStore(schema.META_STORE).get(schema.META_KEY)), entryStore =
                transaction.objectStore(schema.ENTRY_STORE), revisionStore =
                transaction.objectStore(schema.REVISION_STORE), entryRequests = projection.entries.map(item =>
                    requestValue(entryStore.get(item.entryKey))), revisionRequests = projection.revisions.map(item =>
                    requestValue(revisionStore.get(item.revisionKey))), [meta, entries, revisions] =
                    await Promise.all([metaRequest, Promise.all(entryRequests), Promise.all(revisionRequests)]);
            await done;
            return { metadata: clone(meta), entries: clone(entries), revisions: clone(revisions) }; }
        async function writeProjection(preview) {
            const projection = preview?.projectedArchive;
            if (preview?.semanticEquivalence !== true || !projection?.metadata ||
                !schema.validateMetadata(projection.metadata) ||
                projection.entries.some(item => !schema.validateEntry(item)) ||
                projection.revisions.some(item => !schema.validateRevision(item))) return {
                written: false, status: "blocked", reason: "invalid_or_non_equivalent_projection" };
            const before = await store.readIntegrity();
            if (before.status !== "empty") return { written: false, status: "blocked",
                reason: "target_archive_not_empty", before };
            const db = await store.openArchive(), names = [schema.META_STORE, schema.ENTRY_STORE,
                schema.REVISION_STORE], transaction = db.transaction(names, "readwrite"),
                done = transactionDone(transaction);
            try { transaction.objectStore(schema.META_STORE).add(clone(projection.metadata));
                for (const entry of projection.entries)
                    transaction.objectStore(schema.ENTRY_STORE).add(clone(entry));
                for (const revision of projection.revisions)
                    transaction.objectStore(schema.REVISION_STORE).add(clone(revision));
                await done;
            } catch (error) { try { transaction.abort(); } catch (_error) {}
                try { await done; } catch (_error) {}
                return { written: false, status: "failed", reason: "atomic_write_failed",
                    error: error?.message || String(error) }; }
            const readBack = await readProjection(db, projection), fingerprint = await sha256(readBack),
                integrity = await store.readIntegrity(), expectedFingerprint =
                    preview.projectedArchiveFingerprint, activeRevisionCount = readBack.revisions.filter(
                        item => item?.revisionState === "active").length,
                signaturesMatch = readBack.revisions.every((item, index) => item?.signature ===
                    projection.revisions[index]?.signature && item?.contentSignature ===
                    projection.revisions[index]?.contentSignature), countsMatch =
                    readBack.entries.length === projection.entries.length &&
                    readBack.revisions.length === projection.revisions.length &&
                    activeRevisionCount === preview.counts.projectedActiveRevisionCount,
                fingerprintMatched = fingerprint === expectedFingerprint,
                verified = integrity.status === "ready" && countsMatch && signaturesMatch && fingerprintMatched;
            return { written: true, status: verified ? "verified" : "mismatch", targetEnvironment:
                configuration.targetEnvironment, countsMatch, signaturesMatch, fingerprintMatched,
                expectedFingerprint, readBackFingerprint: fingerprint, activeRevisionCount,
                entryCount: readBack.entries.length, revisionCount: readBack.revisions.length, integrity };
        }
        return Object.freeze({ writeProjection, close: store.closeArchive });
    }
    return Object.freeze({ WRITE_AUTHORIZATION, createParticipantFormalArchiveMigrationWriter });
});
