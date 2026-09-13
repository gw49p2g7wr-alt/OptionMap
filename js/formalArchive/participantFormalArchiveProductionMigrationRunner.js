(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("./participantFormalArchiveSchema.js") :
        root?.OptionMapParticipantFormalArchiveSchema;
    const previewApi = commonJs ? require("./participantFormalArchiveMigrationPreview.js") :
        root?.OptionMapParticipantFormalArchiveMigrationPreview;
    const participantApi = commonJs ? require("../participantData.js") : root?.OptionMapParticipantData;
    const api = factory(schema, previewApi, participantApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveProductionMigrationRunner = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, defaultPreviewApi, participantApi) {
    "use strict";
    const OPERATION = "participant-formal-archive-production-migration-v1";
    const SOURCE_KEY = "optionMapParticipantHistory";
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
    const reject = (reason, gate, detail = null) => ({ status: "NO_GO", migrated: false,
        reason, gate, detail });
    function createProductionMigrationRunner(configuration = {}) {
        const indexedDB = configuration.indexedDB, keyRange = configuration.IDBKeyRange,
            sourceStorage = configuration.sourceStorage, runtimeProbe = configuration.runtimeProbe,
            storageManager = configuration.storageManager, previewApi = configuration.previewApi ||
                defaultPreviewApi, databaseName = configuration.databaseName || schema.DATABASE_NAME;
        let consumed = false;
        async function targetState() {
            if (typeof indexedDB?.databases !== "function") return { status: "unknown",
                reason: "database_catalog_unavailable" };
            const catalog = await indexedDB.databases(), target = catalog.find(item => item.name === databaseName);
            if (!target) return { status: "not_created", version: null, counts: null };
            if (target.version !== schema.DATABASE_VERSION) return { status: "version_mismatch",
                version: target.version, counts: null };
            const db = await new Promise((resolve, rejectOpen) => { const request = indexedDB.open(
                databaseName, schema.DATABASE_VERSION); request.onupgradeneeded = () => {
                    request.transaction.abort(); rejectOpen(new Error("upgrade_forbidden")); };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => rejectOpen(request.error || new Error("open_failed")); });
            try { const names = [schema.META_STORE, schema.ENTRY_STORE, schema.REVISION_STORE];
                if (!names.every(name => db.objectStoreNames.contains(name))) return {
                    status: "store_mismatch", version: db.version, counts: null };
                const transaction = db.transaction(names, "readonly"), done = transactionDone(transaction),
                    counts = await Promise.all(names.map(name => requestValue(
                        transaction.objectStore(name).count()))); await done;
                return { status: counts.every(count => count === 0) ? "empty" : "non_empty",
                    version: db.version, counts: Object.fromEntries(names.map((name, index) =>
                        [name, counts[index]])) };
            } finally { db.close(); }
        }
        async function openTarget() { return new Promise((resolve, rejectOpen) => {
            const request = indexedDB.open(databaseName, schema.DATABASE_VERSION);
            request.onupgradeneeded = event => { if (event.oldVersion !== 0) {
                request.transaction.abort(); return; }
                const db = request.result;
                for (const [name, definition] of Object.entries(schema.STORE_DEFINITIONS)) {
                    const store = db.createObjectStore(name, { keyPath: definition.keyPath });
                    for (const index of definition.indexes) store.createIndex(index.name,
                        index.keyPath, { unique: index.unique }); } };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => rejectOpen(request.error || new Error("open_failed")); }); }
        async function readProjection(db, projection) { const names = [schema.META_STORE,
            schema.ENTRY_STORE, schema.REVISION_STORE], transaction = db.transaction(names, "readonly"),
            done = transactionDone(transaction), metaRequest = requestValue(transaction.objectStore(
                schema.META_STORE).get(schema.META_KEY)), entryStore = transaction.objectStore(
                schema.ENTRY_STORE), revisionStore = transaction.objectStore(schema.REVISION_STORE),
            entryRequests = projection.entries.map(item => requestValue(entryStore.get(item.entryKey))),
            revisionRequests = projection.revisions.map(item => requestValue(
                revisionStore.get(item.revisionKey))), [metadata, entries, revisions] = await Promise.all([
                metaRequest, Promise.all(entryRequests), Promise.all(revisionRequests)]); await done;
            return { metadata: clone(metadata), entries: clone(entries), revisions: clone(revisions) }; }
        async function run(approval) {
            if (consumed) return reject("runner_already_consumed", "one_time"); consumed = true;
            if (!indexedDB || !sourceStorage?.getItem || typeof runtimeProbe !== "function")
                return reject("production_dependencies_missing", "configuration");
            const firstRuntime = await runtimeProbe();
            if (firstRuntime?.stopped !== true) return reject("optionmap_runtime_running", "runtime_stop",
                clone(firstRuntime || null));
            let raw; try { raw = sourceStorage.getItem(SOURCE_KEY); } catch (_error) {
                return reject("source_read_failed", "source"); }
            if (!raw) return reject("source_missing", "source");
            let source; try { source = JSON.parse(raw); } catch (_error) {
                return reject("source_json_invalid", "source"); }
            const preview = await previewApi.previewMigration(source);
            if (preview.semanticEquivalence !== true) return reject("semantic_equivalence_failed",
                "projection", { failures: preview.failures, duplicates: preview.duplicates,
                    conflicts: preview.conflicts });
            if (approval?.approved !== true || approval.operation !== OPERATION ||
                !/^[A-Za-z0-9_-]{16,128}$/.test(approval.approvalNonce || ""))
                return reject("explicit_approval_invalid", "approval");
            if (approval.sourceFingerprint !== preview.sourceFingerprint)
                return reject("source_fingerprint_mismatch", "source_fingerprint", {
                    expected: approval.sourceFingerprint, actual: preview.sourceFingerprint });
            if (approval.projectedArchiveFingerprint !== preview.projectedArchiveFingerprint)
                return reject("projected_fingerprint_mismatch", "projected_fingerprint", {
                    expected: approval.projectedArchiveFingerprint,
                    actual: preview.projectedArchiveFingerprint });
            const target = await targetState();
            if (!new Set(["not_created", "empty"]).has(target.status))
                return reject(target.status === "non_empty" ? "target_non_empty" :
                    "target_not_safely_writable", "target", target);
            const projectedWriteBytes = new TextEncoder().encode(JSON.stringify(
                preview.projectedArchive)).length; let estimate;
            try { estimate = await storageManager?.estimate?.(); } catch (_error) {}
            const availableBytes = estimate?.quota != null && estimate?.usage != null ?
                estimate.quota - estimate.usage : null, requiredBytes = projectedWriteBytes * 2;
            if (availableBytes === null || availableBytes < requiredBytes)
                return reject("insufficient_or_unknown_quota", "capacity", { availableBytes,
                    requiredBytes, projectedWriteBytes });
            const secondRuntime = await runtimeProbe();
            if (secondRuntime?.stopped !== true) return reject("optionmap_runtime_started_during_gate",
                "runtime_recheck", clone(secondRuntime || null));
            if (sourceStorage.getItem(SOURCE_KEY) !== raw)
                return reject("source_changed_during_gate", "source_recheck");
            let db, writeCompleted = false;
            try { db = await openTarget(); const projection = preview.projectedArchive,
                transaction = db.transaction([schema.META_STORE, schema.ENTRY_STORE,
                    schema.REVISION_STORE], "readwrite"), done = transactionDone(transaction);
                transaction.objectStore(schema.META_STORE).add(clone(projection.metadata));
                for (const entry of projection.entries)
                    transaction.objectStore(schema.ENTRY_STORE).add(clone(entry));
                for (const revision of projection.revisions)
                    transaction.objectStore(schema.REVISION_STORE).add(clone(revision));
                await done; writeCompleted = true;
                const readBack = await readProjection(db, projection), readBackFingerprint =
                    await sha256(readBack), sourceAfter = sourceStorage.getItem(SOURCE_KEY),
                    sourceUnchanged = sourceAfter === raw, signaturesMatch = readBack.revisions.every(
                        (item, index) => item?.signature === projection.revisions[index]?.signature &&
                        item?.contentSignature === projection.revisions[index]?.contentSignature),
                    activeRevisionCount = readBack.revisions.filter(item =>
                        item?.revisionState === "active").length, countsMatch =
                        readBack.entries.length === projection.entries.length &&
                        readBack.revisions.length === projection.revisions.length &&
                        activeRevisionCount === preview.counts.projectedActiveRevisionCount,
                    fingerprintMatched = readBackFingerprint === preview.projectedArchiveFingerprint,
                    accepted = sourceUnchanged && signaturesMatch && countsMatch && fingerprintMatched;
                return { status: accepted ? "ACCEPTED" : "ACCEPTANCE_FAILED", migrated: true,
                    approvalNonce: approval.approvalNonce, sourceFingerprint: preview.sourceFingerprint,
                    projectedArchiveFingerprint: preview.projectedArchiveFingerprint,
                    readBackFingerprint, sourceUnchanged, signaturesMatch, countsMatch,
                    fingerprintMatched, entryCount: readBack.entries.length,
                    revisionCount: readBack.revisions.length, activeRevisionCount,
                    capacity: { projectedWriteBytes, requiredBytes, availableBytes } };
            } catch (error) { let sourceUnchanged = false;
                try { sourceUnchanged = sourceStorage.getItem(SOURCE_KEY) === raw; } catch (_error) {}
                return { status: "FAILED", migrated: writeCompleted,
                    reason: "atomic_migration_failed", sourceUnchanged,
                    error: error?.message || String(error) };
            } finally { db?.close(); }
        }
        return Object.freeze({ run });
    }
    return Object.freeze({ OPERATION, SOURCE_KEY, createProductionMigrationRunner });
});
