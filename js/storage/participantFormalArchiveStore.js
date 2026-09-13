(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("../formalArchive/participantFormalArchiveSchema.js") :
        root?.OptionMapParticipantFormalArchiveSchema;
    const api = factory(schema, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, root) {
    "use strict";
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    const requestValue = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => undefined; });
    const failure = error => ({ status: "unavailable", reason:
        /version/i.test(error?.message || "") ? "archive_version_mismatch" : "archive_read_failed" });
    function createParticipantFormalArchiveStore(configuration = {}) {
        const indexedDB = configuration.indexedDB || root?.indexedDB;
        const keyRange = configuration.IDBKeyRange || root?.IDBKeyRange;
        const storageManager = configuration.storageManager || root?.navigator?.storage;
        const validateRevisionPayload = configuration.validateRevisionPayload;
        const databaseName = configuration.databaseName || schema.DATABASE_NAME;
        let database = null, opening = null;
        function openArchive() {
            if (database) return Promise.resolve(database); if (opening) return opening;
            if (!indexedDB?.open) return Promise.reject(new Error("indexeddb_unavailable"));
            opening = new Promise((resolve, reject) => { const request = indexedDB.open(
                databaseName, schema.DATABASE_VERSION);
                request.onupgradeneeded = event => { if (event.oldVersion !== 0) {
                    request.transaction.abort(); return; }
                    const db = request.result;
                    for (const [name, definition] of Object.entries(schema.STORE_DEFINITIONS)) {
                        const store = db.createObjectStore(name, { keyPath: definition.keyPath });
                        for (const index of definition.indexes) store.createIndex(
                            index.name, index.keyPath, { unique: index.unique });
                    } };
                request.onsuccess = () => { database = request.result;
                    database.onversionchange = () => { database.close(); database = null; }; resolve(database); };
                request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
                request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
            }).finally(() => { opening = null; }); return opening;
        }
        function closeArchive() { database?.close(); database = null; }
        async function readMetadata() { try { const db = await openArchive(), transaction =
            db.transaction(schema.META_STORE, "readonly"), done = transactionDone(transaction);
            const value = await requestValue(transaction.objectStore(schema.META_STORE).get(schema.META_KEY));
            await done; return { status: value ? schema.validateMetadata(value) ? "ready" : "corrupted" :
                "empty", metadata: clone(value || null) }; } catch (error) { return failure(error); } }
        async function readRevision(revisionKey) { try { const db = await openArchive(), transaction =
            db.transaction(schema.REVISION_STORE, "readonly"), done = transactionDone(transaction);
            const value = await requestValue(transaction.objectStore(schema.REVISION_STORE).get(revisionKey));
            await done; return { status: !value ? "unavailable" : schema.validateRevision(value) ?
                "available" : "corrupted", revision: clone(value || null) }; } catch (error) { return failure(error); } }
        async function readActiveRevision(sourceDate) { try { const db = await openArchive(), entryKey =
            schema.entryKeyFor(sourceDate), first = db.transaction(schema.ENTRY_STORE, "readonly"),
            firstDone = transactionDone(first), entry = await requestValue(
                first.objectStore(schema.ENTRY_STORE).get(entryKey)); await firstDone;
            if (!entry) return { status: "unavailable", entry: null, revision: null };
            if (!schema.validateEntry(entry)) return { status: "corrupted", entry: clone(entry), revision: null };
            const result = await readRevision(entry.activeRevisionKey);
            if (result.status === "available" && (result.revision.entryKey !== entry.entryKey ||
                result.revision.revisionState !== "active")) return { status: "corrupted",
                entry: clone(entry), revision: result.revision };
            return { status: result.status, entry: clone(entry), revision: result.revision };
        } catch (error) { return failure(error); } }
        async function readRange(options = {}) { try {
            const from = options.from || "2000-01-01", to = options.to || "2999-12-31";
            const limit = Math.max(1, Math.min(500, Number(options.limit) || 30));
            if (from > to) return { status: "invalid", reason: "invalid_range", entries: [] };
            const db = await openArchive(), transaction = db.transaction(schema.ENTRY_STORE, "readonly"),
                done = transactionDone(transaction), index = transaction.objectStore(schema.ENTRY_STORE)
                    .index("bySourceDate"), range = keyRange.bound(from, to), entries = [];
            await new Promise((resolve, reject) => { const request = index.openCursor(range, "next");
                request.onerror = () => reject(request.error); request.onsuccess = () => { const cursor = request.result;
                    if (!cursor || entries.length >= limit) return resolve();
                    if (!options.afterSourceDate || cursor.value.sourceDate > options.afterSourceDate)
                        entries.push(clone(cursor.value)); cursor.continue(); }; }); await done;
            if (entries.some(entry => !schema.validateEntry(entry))) return { status: "corrupted", entries: [] };
            return { status: entries.length ? "available" : "empty", entries,
                nextCursor: entries.length === limit ? entries.at(-1).sourceDate : null };
        } catch (error) { return failure(error); } }
        async function readLatest() { try { const db = await openArchive(), transaction =
            db.transaction(schema.ENTRY_STORE, "readonly"), done = transactionDone(transaction),
            index = transaction.objectStore(schema.ENTRY_STORE).index("bySourceDate"), entry =
                await new Promise((resolve, reject) => { const request = index.openCursor(null, "prev");
                    request.onsuccess = () => resolve(request.result?.value || null);
                    request.onerror = () => reject(request.error); }); await done;
            if (!entry) return { status: "empty", entry: null, revision: null };
            return readActiveRevision(entry.sourceDate);
        } catch (error) { return failure(error); } }
        async function readIntegrity() { try { const db = await openArchive(), names = [schema.META_STORE,
            schema.ENTRY_STORE, schema.REVISION_STORE], transaction = db.transaction(names, "readonly"),
            done = transactionDone(transaction), [meta, entries, revisions] = await Promise.all([
                requestValue(transaction.objectStore(schema.META_STORE).get(schema.META_KEY)),
                requestValue(transaction.objectStore(schema.ENTRY_STORE).getAll()),
                requestValue(transaction.objectStore(schema.REVISION_STORE).getAll())]); await done;
            const entryKeys = new Set(entries.map(item => item.entryKey)); let activeMismatchCount = 0;
            for (const entry of entries) { const own = revisions.filter(item => item.entryKey === entry.entryKey),
                active = own.filter(item => item.revisionKey === entry.activeRevisionKey &&
                    item.revisionState === "active" && item.replacedAt === null);
                if (active.length !== 1 || own.filter(item => item.revisionState === "active").length !== 1)
                    activeMismatchCount += 1; }
            const orphanRevisionCount = revisions.filter(item => !entryKeys.has(item.entryKey)).length;
            const invalidRecordCount = entries.filter(item => !schema.validateEntry(item)).length +
                revisions.filter(item => !schema.validateRevision(item)).length;
            let invalidSignatureCount = 0, unverifiedRevisionCount = 0;
            for (const revision of revisions) { if (typeof validateRevisionPayload !== "function") {
                unverifiedRevisionCount += 1; continue; }
                try { if (await validateRevisionPayload(clone(revision.completeSet)) !== true)
                    invalidSignatureCount += 1; } catch (_error) { invalidSignatureCount += 1; } }
            const metadataValid = meta ? schema.validateMetadata(meta) : entries.length === 0 && revisions.length === 0;
            const countMismatch = meta ? meta.entryCount !== entries.length ||
                meta.revisionCount !== revisions.length : entries.length + revisions.length > 0;
            const structurallyValid = metadataValid && !countMismatch && !orphanRevisionCount &&
                !activeMismatchCount && !invalidRecordCount && !invalidSignatureCount;
            return { status: !structurallyValid ? "corrupted" : entries.length ?
                unverifiedRevisionCount ? "unverified" : "ready" : "empty",
            metadataValid, countMismatch, entryCount: entries.length, revisionCount: revisions.length,
            activeMismatchCount, orphanRevisionCount, invalidRecordCount, invalidSignatureCount,
            unverifiedRevisionCount };
        } catch (error) { return failure(error); } }
        async function readCapacityDiagnostic() { try { const db = await openArchive(), names =
            [schema.META_STORE, schema.ENTRY_STORE, schema.REVISION_STORE], transaction =
                db.transaction(names, "readonly"), done = transactionDone(transaction), records =
                (await Promise.all(names.map(name => requestValue(transaction.objectStore(name).getAll())))).flat();
            await done; const encodedBytes = records.reduce((sum, value) => sum +
                new TextEncoder().encode(JSON.stringify(value)).length, 0);
            let estimate = null; try { estimate = await storageManager?.estimate?.() || null; } catch (_error) {}
            return { status: "available", archivePayloadBytes: encodedBytes,
                originUsageBytes: estimate?.usage ?? null, originQuotaBytes: estimate?.quota ?? null,
                measurement: "serialized_payload_estimate_not_leveldb_disk_size" };
        } catch (error) { return failure(error); } }
        return Object.freeze({ openArchive, closeArchive, readMetadata, readLatest, readRange, readRevision,
            readActiveRevision, readIntegrity, readCapacityDiagnostic });
    }
    return Object.freeze({ createParticipantFormalArchiveStore });
});
