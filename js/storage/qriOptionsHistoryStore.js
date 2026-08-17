(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("../qriOptionsHistory.js") : root?.OptionMapQriOptionsHistory;
    const api = factory(historyApi, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoryStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (historyApi, root) {
    "use strict";

    const DATABASE_NAME = "optionMapQriOptionsHistory";
    const DB_VERSION = 1;
    const META_STORE = "qriOptionsHistoryMeta";
    const ENTRY_STORE = "qriOptionsEntries";
    const REVISION_STORE = "qriOptionsRevisions";
    const META_KEY = "history";
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
        });
    }
    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
            transaction.onerror = () => undefined;
        });
    }
    function storageFailure(error) {
        const detail = `${error?.name || ""}:${error?.message || error || ""}`;
        return /QuotaExceeded/i.test(detail) ? "quota_failure" : "transaction_failed";
    }
    function metadataRecord(history) {
        return { id: META_KEY, historyVersion: history.historyVersion,
            parserVersion: history.parserVersion, schemaVersion: history.schemaVersion,
            source: history.source, signatureAlgorithm: history.signatureAlgorithm,
            createdAt: history.createdAt, updatedAt: history.updatedAt };
    }
    function entryRecord(entry) {
        return { entryKey: entry.entryKey, contract: entry.contract,
            sourceDateKey: entry.sourceDateKey, activeVersionKey: entry.activeVersionKey,
            firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt };
    }
    function revisionRecord(entryKey, revision) {
        return { revisionKey: `${entryKey}|${revision.versionKey}`, entryKey, ...clone(revision) };
    }
    function historyFromRecords(meta, entries, revisions) {
        if (!meta) return historyApi.createEmptyQriOptionsHistory();
        const byEntry = new Map();
        for (const stored of revisions) {
            const list = byEntry.get(stored.entryKey) || [];
            const revision = clone(stored);
            delete revision.revisionKey; delete revision.entryKey;
            list.push(revision); byEntry.set(stored.entryKey, list);
        }
        return { historyVersion: meta.historyVersion, parserVersion: meta.parserVersion,
            schemaVersion: meta.schemaVersion, source: meta.source,
            signatureAlgorithm: meta.signatureAlgorithm, createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            entries: entries.map(entry => ({ ...clone(entry),
                revisions: byEntry.get(entry.entryKey) || [] }))
                .sort((a, b) => a.sourceDateKey.localeCompare(b.sourceDateKey) ||
                    a.contract.localeCompare(b.contract)) };
    }

    function createQriOptionsHistoryStore(configuration = {}) {
        const indexedDb = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || DATABASE_NAME;
        let database = null;
        let opening = null;

        async function openHistoryStore() {
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
                        const entries = db.createObjectStore(ENTRY_STORE, { keyPath: "entryKey" });
                        entries.createIndex("byContract", "contract", { unique: false });
                        entries.createIndex("bySourceDate", "sourceDateKey", { unique: false });
                    }
                    if (!db.objectStoreNames.contains(REVISION_STORE)) {
                        const revisions = db.createObjectStore(REVISION_STORE, { keyPath: "revisionKey" });
                        revisions.createIndex("byEntryKey", "entryKey", { unique: false });
                    }
                };
                request.onsuccess = () => {
                    database = request.result;
                    database.onversionchange = () => { database.close(); database = null; };
                    resolve(database);
                };
                request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
                request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
            }).finally(() => { opening = null; });
            return opening;
        }
        function closeHistoryStore() { if (database) database.close(); database = null; }

        async function readRecords() {
            const db = await openHistoryStore();
            const transaction = db.transaction([META_STORE, ENTRY_STORE, REVISION_STORE], "readonly");
            const done = transactionDone(transaction);
            const [meta, entries, revisions] = await Promise.all([
                requestResult(transaction.objectStore(META_STORE).get(META_KEY)),
                requestResult(transaction.objectStore(ENTRY_STORE).getAll()),
                requestResult(transaction.objectStore(REVISION_STORE).getAll())
            ]);
            await done; return { meta, entries, revisions };
        }
        async function loadHistory() {
            const records = await readRecords();
            const empty = !records.meta && records.entries.length === 0 && records.revisions.length === 0;
            const history = empty ? historyApi.createEmptyQriOptionsHistory()
                : historyFromRecords(records.meta, records.entries, records.revisions);
            const validation = await historyApi.validateHistory(history);
            const entryKeys = new Set(records.entries.map(entry => entry.entryKey));
            const orphanRevisions = records.revisions.filter(revision => !entryKeys.has(revision.entryKey));
            return { status: empty ? "empty" : validation.valid && orphanRevisions.length === 0
                ? "ready" : "corrupted", history, validation,
            orphanRevisions: clone(orphanRevisions) };
        }

        async function commitHistory(history, options = {}) {
            const validation = await historyApi.validateHistory(history);
            if (!validation.valid) return { saved: false, outcome: "invalid_history", errors: validation.errors };
            const db = await openHistoryStore();
            const transaction = db.transaction([META_STORE, ENTRY_STORE, REVISION_STORE], "readwrite");
            const done = transactionDone(transaction);
            try {
                const meta = transaction.objectStore(META_STORE);
                const entries = transaction.objectStore(ENTRY_STORE);
                const revisions = transaction.objectStore(REVISION_STORE);
                meta.clear(); entries.clear(); revisions.clear();
                for (const entry of history.entries) {
                    entries.put(entryRecord(entry));
                    for (const revision of entry.revisions) revisions.put(revisionRecord(entry.entryKey, revision));
                }
                if (options.failAfter === "revisions") throw new Error("injected_transaction_failure");
                meta.put(metadataRecord(history));
                if (options.failAfter === "metadata") throw new Error("injected_transaction_failure");
            } catch (error) {
                try { transaction.abort(); } catch (_error) { /* inactive */ }
                try { await done; } catch (_error) { /* rollback */ }
                return { saved: false, outcome: storageFailure(error), error: error.message };
            }
            try { await done; } catch (error) {
                return { saved: false, outcome: storageFailure(error), error: error.message };
            }
            return { saved: true, outcome: "committed" };
        }

        async function persistCandidate(candidate, options = {}) {
            let snapshot;
            try { snapshot = await loadHistory(); }
            catch (error) { throw new Error(`indexeddb_read_failed:${error?.message || error}`); }
            if (!['empty', 'ready'].includes(snapshot.status)) {
                return { saved: false, outcome: "corrupted_existing_history" };
            }
            const merged = await historyApi.mergeCandidate(snapshot.history, candidate, options);
            if (!merged.changed) return { saved: false, outcome: merged.outcome };
            if (options.failWith === "quota") {
                return { saved: false, outcome: "quota_failure", error: "QuotaExceededError" };
            }
            const result = await commitHistory(merged.history, options);
            return result.saved ? { saved: true, outcome: merged.outcome } : result;
        }

        async function loadHistoryMeta() { return clone((await readRecords()).meta || null); }
        async function loadEntries() { return clone((await readRecords()).entries)
            .sort((a, b) => a.sourceDateKey.localeCompare(b.sourceDateKey)); }
        async function loadEntry(contract, sourceDateKey) {
            const result = await loadHistory();
            if (result.status === "corrupted") return { status: "corrupted", entry: null };
            const entry = result.history.entries.find(item => item.contract === contract &&
                item.sourceDateKey === sourceDateKey);
            return { status: entry ? "available" : "unavailable", entry: clone(entry || null) };
        }
        async function getActiveRevision(contract, sourceDateKey) {
            const result = await loadHistory();
            if (result.status === "corrupted") return { status: "corrupted", revision: null };
            const revision = historyApi.getActiveRevision(result.history, contract, sourceDateKey);
            return { status: revision ? "available" : "unavailable", revision };
        }
        async function listContracts() {
            const result = await loadHistory();
            return result.status === "corrupted" ? [] : historyApi.listContracts(result.history);
        }
        async function listSourceDates(contract) {
            const result = await loadHistory();
            return result.status === "corrupted" ? [] : historyApi.listSourceDates(result.history, contract);
        }
        async function clearForTests() {
            const db = await openHistoryStore();
            const transaction = db.transaction([META_STORE, ENTRY_STORE, REVISION_STORE], "readwrite");
            const done = transactionDone(transaction);
            transaction.objectStore(META_STORE).clear();
            transaction.objectStore(ENTRY_STORE).clear();
            transaction.objectStore(REVISION_STORE).clear();
            await done;
        }
        return Object.freeze({ openHistoryStore, closeHistoryStore, loadHistory,
            commitHistory, persistCandidate, loadHistoryMeta, loadEntries,
            loadEntry, getActiveRevision, listContracts, listSourceDates,
            clearForTests });
    }

    let defaultStore;
    const getDefaultStore = () => defaultStore ||
        (defaultStore = createQriOptionsHistoryStore());
    return Object.freeze({ DATABASE_NAME, DB_VERSION, META_STORE, ENTRY_STORE,
        REVISION_STORE, createQriOptionsHistoryStore,
        openHistoryStore: (...args) => getDefaultStore().openHistoryStore(...args),
        closeHistoryStore: (...args) => getDefaultStore().closeHistoryStore(...args),
        loadHistory: (...args) => getDefaultStore().loadHistory(...args),
        commitHistory: (...args) => getDefaultStore().commitHistory(...args),
        persistCandidate: (...args) => getDefaultStore().persistCandidate(...args),
        loadHistoryMeta: (...args) => getDefaultStore().loadHistoryMeta(...args),
        loadEntries: (...args) => getDefaultStore().loadEntries(...args),
        loadEntry: (...args) => getDefaultStore().loadEntry(...args),
        getActiveRevision: (...args) => getDefaultStore().getActiveRevision(...args),
        listContracts: (...args) => getDefaultStore().listContracts(...args),
        listSourceDates: (...args) => getDefaultStore().listSourceDates(...args) });
});
