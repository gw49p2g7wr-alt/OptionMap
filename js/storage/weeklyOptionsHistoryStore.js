(function (root, factory) {
    const historyApi = typeof module === "object" && module.exports
        ? require("../weeklyOptionsHistory.js")
        : root?.OptionMapWeeklyOptionsHistory;
    const api = factory(historyApi, root);

    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsHistoryStore = api;
})(typeof window !== "undefined" ? window : globalThis,
function (historyApi, root) {
    "use strict";

    const DATABASE_NAME = "optionMapWeeklyOptionsHistory";
    const DB_VERSION = 1;
    const META_STORE = "weeklyOptionsHistoryMeta";
    const ENTRY_STORE = "weeklyOptionsEntries";
    const REVISION_STORE = "weeklyOptionsRevisions";
    const META_KEY = "history";

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(
                transaction.error || new Error("indexeddb_transaction_aborted")
            );
            transaction.onerror = () => undefined;
        });
    }

    function entryRecord(entry) {
        return {
            sourceDate: entry.sourceDate,
            expiries: clone(entry.expiries),
            activeVersionKey: entry.activeVersionKey,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt
        };
    }

    function revisionRecord(sourceDate, revision) {
        return { sourceDate, ...clone(revision) };
    }

    function metadataRecord(history) {
        return {
            id: META_KEY,
            historyVersion: history.historyVersion,
            source: history.source,
            canonicalParserVersion: history.canonicalParserVersion,
            canonicalSchemaVersion: history.canonicalSchemaVersion,
            signatureAlgorithm: history.signatureAlgorithm,
            retentionPolicy: clone(history.retentionPolicy)
        };
    }

    function historyFromRecords(meta, entries, revisions) {
        const base = meta ? {
            historyVersion: meta.historyVersion,
            source: meta.source,
            canonicalParserVersion: meta.canonicalParserVersion,
            canonicalSchemaVersion: meta.canonicalSchemaVersion,
            signatureAlgorithm: meta.signatureAlgorithm,
            retentionPolicy: clone(meta.retentionPolicy),
            entries: []
        } : historyApi.createEmptyWeeklyOptionsHistory();
        const revisionsByDate = new Map();
        for (const stored of revisions) {
            const list = revisionsByDate.get(stored?.sourceDate) || [];
            const revision = clone(stored);
            if (revision && typeof revision === "object") delete revision.sourceDate;
            list.push(revision);
            revisionsByDate.set(stored?.sourceDate, list);
        }
        base.entries = entries.map(stored => ({
            ...clone(stored),
            revisions: revisionsByDate.get(stored?.sourceDate) || []
        })).sort((left, right) =>
            String(left?.sourceDate || "").localeCompare(String(right?.sourceDate || ""))
        );
        return base;
    }

    function usableHistory(history, validation) {
        const usable = historyApi.createEmptyWeeklyOptionsHistory(
            clone(history?.retentionPolicy || {})
        );
        const validIndexes = new Set(validation.validEntries.map(item => item.index));
        usable.entries = (history?.entries || [])
            .filter((_entry, index) => validIndexes.has(index))
            .map(clone);
        return usable;
    }

    function createWeeklyOptionsHistoryStore(configuration = {}) {
        const indexedDb = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || DATABASE_NAME;
        let database = null;
        let opening = null;

        async function openWeeklyOptionsHistoryStore() {
            if (database) return database;
            if (opening) return opening;
            if (!indexedDb?.open) throw new Error("indexeddb_unavailable");
            opening = new Promise((resolve, reject) => {
                const request = indexedDb.open(databaseName, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(META_STORE)) {
                        db.createObjectStore(META_STORE, { keyPath: "id" });
                    }
                    if (!db.objectStoreNames.contains(ENTRY_STORE)) {
                        db.createObjectStore(ENTRY_STORE, { keyPath: "sourceDate" });
                    }
                    if (!db.objectStoreNames.contains(REVISION_STORE)) {
                        const revisions = db.createObjectStore(REVISION_STORE, {
                            keyPath: ["sourceDate", "versionKey"]
                        });
                        revisions.createIndex("bySourceDate", "sourceDate", {
                            unique: false
                        });
                    }
                };
                request.onsuccess = () => {
                    database = request.result;
                    database.onversionchange = () => {
                        database.close();
                        database = null;
                    };
                    resolve(database);
                };
                request.onerror = () => reject(
                    request.error || new Error("indexeddb_open_failed")
                );
                request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
            }).finally(() => { opening = null; });
            return opening;
        }

        function closeWeeklyOptionsHistoryStore() {
            if (database) database.close();
            database = null;
        }

        async function readRecords() {
            const db = await openWeeklyOptionsHistoryStore();
            const transaction = db.transaction(
                [META_STORE, ENTRY_STORE, REVISION_STORE], "readonly"
            );
            const done = transactionDone(transaction);
            const [meta, entries, revisions] = await Promise.all([
                requestResult(transaction.objectStore(META_STORE).get(META_KEY)),
                requestResult(transaction.objectStore(ENTRY_STORE).getAll()),
                requestResult(transaction.objectStore(REVISION_STORE).getAll())
            ]);
            await done;
            return { meta, entries, revisions };
        }

        async function readWeeklyOptionsHistory() {
            const records = await readRecords();
            if (!records.meta && records.entries.length === 0 &&
                records.revisions.length === 0) {
                const history = historyApi.createEmptyWeeklyOptionsHistory();
                return {
                    status: "empty", history, usableHistory: clone(history),
                    diagnostics: await historyApi.validateWeeklyOptionsHistory(history),
                    orphanRevisions: []
                };
            }
            const history = historyFromRecords(
                records.meta, records.entries, records.revisions
            );
            const diagnostics = await historyApi.validateWeeklyOptionsHistory(history);
            const entryDates = new Set(records.entries.map(entry => entry?.sourceDate));
            const orphanRevisions = records.revisions.filter(revision =>
                !entryDates.has(revision?.sourceDate)
            ).map(revision => ({
                sourceDate: revision?.sourceDate || null,
                versionKey: revision?.versionKey || null,
                error: "orphan_revision"
            }));
            const metadataInvalid = !records.meta || diagnostics.topLevelErrors.length > 0;
            const recoveryRequired = diagnostics.recoveryRequired;
            return {
                status: metadataInvalid ? "metadata_invalid"
                    : recoveryRequired ? "recovery_required"
                        : diagnostics.valid && orphanRevisions.length === 0
                            ? "ready" : "partial",
                history,
                usableHistory: usableHistory(history, diagnostics),
                diagnostics: {
                    ...diagnostics,
                    metadataInvalid,
                    orphanRevisions
                },
                orphanRevisions
            };
        }

        async function persistWeeklyOptionsHistoryCandidate(candidate, options = {}) {
            const candidateBefore = clone(candidate);
            const snapshot = await readWeeklyOptionsHistory();
            if (!["empty", "ready"].includes(snapshot.status)) {
                return {
                    saved: false,
                    outcome: snapshot.status === "recovery_required"
                        ? "recovery_required" : "invalid_stored_history"
                };
            }
            let merged;
            try {
                merged = await historyApi.mergeWeeklyOptionsHistory(
                    snapshot.history, candidate, { confirmedAt: options.confirmedAt }
                );
            } catch (error) {
                return {
                    saved: false,
                    outcome: "invalid_candidate",
                    error: error?.message || String(error)
                };
            }
            if (!merged.changed) {
                return { saved: false, outcome: merged.outcome };
            }
            if (JSON.stringify(candidate) !== JSON.stringify(candidateBefore)) {
                throw new Error("candidate_mutated_during_merge");
            }
            const nextEntry = merged.history.entries.find(entry =>
                entry.sourceDate === candidate.sourceDate
            );
            const db = await openWeeklyOptionsHistoryStore();
            const transaction = db.transaction(
                [META_STORE, ENTRY_STORE, REVISION_STORE], "readwrite"
            );
            const done = transactionDone(transaction);
            try {
                const entries = transaction.objectStore(ENTRY_STORE);
                const revisions = transaction.objectStore(REVISION_STORE);
                const meta = transaction.objectStore(META_STORE);
                const storedEntry = await requestResult(entries.get(candidate.sourceDate));
                const snapshotEntry = snapshot.history.entries.find(entry =>
                    entry.sourceDate === candidate.sourceDate
                );
                if (JSON.stringify(storedEntry || null) !==
                    JSON.stringify(snapshotEntry ? entryRecord(snapshotEntry) : null)) {
                    throw new Error("concurrent_entry_change");
                }
                for (const revision of nextEntry.revisions) {
                    revisions.put(revisionRecord(nextEntry.sourceDate, revision));
                }
                if (options.failAfter === "revision") {
                    throw new Error("injected_transaction_failure");
                }
                entries.put(entryRecord(nextEntry));
                if (options.failAfter === "entry") {
                    throw new Error("injected_transaction_failure");
                }
                meta.put(metadataRecord(merged.history));
                if (options.failAfter === "metadata") {
                    throw new Error("injected_transaction_failure");
                }
            } catch (error) {
                try { transaction.abort(); } catch (_abortError) { /* already inactive */ }
                try { await done; } catch (_transactionError) { /* expected rollback */ }
                return { saved: false, outcome: "transaction_failed", error: error.message };
            }
            try {
                await done;
            } catch (error) {
                return { saved: false, outcome: "transaction_failed", error: error.message };
            }
            return { saved: true, outcome: merged.outcome };
        }

        async function getStoredWeeklyOptionsEntry(sourceDate) {
            const result = await readWeeklyOptionsHistory();
            const entry = result.history.entries.find(item =>
                item.sourceDate === sourceDate
            );
            if (!entry) return { status: "unavailable", entry: null };
            const detail = [...result.diagnostics.validEntries,
                ...result.diagnostics.invalidEntries].find(item =>
                item.sourceDate === sourceDate
            );
            return {
                status: detail?.recoveryRequired ? "recovery_required"
                    : detail?.valid ? "available" : "partial",
                entry: clone(entry),
                diagnostics: clone(detail)
            };
        }

        async function getStoredWeeklyOptionsRevision(sourceDate, versionKey) {
            const db = await openWeeklyOptionsHistoryStore();
            const transaction = db.transaction(REVISION_STORE, "readonly");
            const done = transactionDone(transaction);
            const stored = await requestResult(
                transaction.objectStore(REVISION_STORE).get([sourceDate, versionKey])
            );
            await done;
            if (!stored) return null;
            const result = clone(stored);
            delete result.sourceDate;
            return result;
        }

        async function getLatestStoredWeeklyOptionsRevision() {
            const result = await readWeeklyOptionsHistory();
            return historyApi.getLatestActiveWeeklyOptionsRevision(result.history);
        }

        async function getPreviousStoredWeeklyOptionsRevision(currentSourceDate) {
            const result = await readWeeklyOptionsHistory();
            return historyApi.findPreviousWeeklyOptionsRevision(
                result.history, currentSourceDate
            );
        }

        return Object.freeze({
            openWeeklyOptionsHistoryStore,
            closeWeeklyOptionsHistoryStore,
            readWeeklyOptionsHistory,
            persistWeeklyOptionsHistoryCandidate,
            getStoredWeeklyOptionsEntry,
            getStoredWeeklyOptionsRevision,
            getLatestStoredWeeklyOptionsRevision,
            getPreviousStoredWeeklyOptionsRevision
        });
    }

    let defaultStore = null;
    function getDefaultStore() {
        if (!defaultStore) defaultStore = createWeeklyOptionsHistoryStore();
        return defaultStore;
    }

    return Object.freeze({
        DATABASE_NAME,
        DB_VERSION,
        META_STORE,
        ENTRY_STORE,
        REVISION_STORE,
        createWeeklyOptionsHistoryStore,
        openWeeklyOptionsHistoryStore: (...args) =>
            getDefaultStore().openWeeklyOptionsHistoryStore(...args),
        closeWeeklyOptionsHistoryStore: (...args) =>
            getDefaultStore().closeWeeklyOptionsHistoryStore(...args),
        readWeeklyOptionsHistory: (...args) =>
            getDefaultStore().readWeeklyOptionsHistory(...args),
        persistWeeklyOptionsHistoryCandidate: (...args) =>
            getDefaultStore().persistWeeklyOptionsHistoryCandidate(...args),
        getStoredWeeklyOptionsEntry: (...args) =>
            getDefaultStore().getStoredWeeklyOptionsEntry(...args),
        getStoredWeeklyOptionsRevision: (...args) =>
            getDefaultStore().getStoredWeeklyOptionsRevision(...args),
        getLatestStoredWeeklyOptionsRevision: (...args) =>
            getDefaultStore().getLatestStoredWeeklyOptionsRevision(...args),
        getPreviousStoredWeeklyOptionsRevision: (...args) =>
            getDefaultStore().getPreviousStoredWeeklyOptionsRevision(...args)
    });
});
