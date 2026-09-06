(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("../qriOptionIvHistory.js") : root?.OptionMapQriOptionIvHistory;
    const api = factory(historyApi, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvHistoryStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (historyApi, root) {
    "use strict";

    const DATABASE_NAME = "optionMapQriOptionIvHistory";
    const DB_VERSION = 1;
    const META_STORE = "qriOptionIvHistoryMeta";
    const ENTRY_STORE = "qriOptionIvEntries";
    const REVISION_STORE = "qriOptionIvRevisions";
    const META_KEY = "history";
    const META_FIELDS = ["id", "historyVersion", "parserVersion", "schemaVersion", "source",
        "signatureAlgorithm", "createdAt", "updatedAt"];
    const ENTRY_RECORD_FIELDS = ["entryKey", "contract", "tradingDate", "activeVersionKey",
        "firstSeenAt", "lastSeenAt"];
    const REVISION_RECORD_FIELDS = ["revisionKey", "entryKey", ...historyApi.REVISION_FIELDS];
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const output = value => freeze(clone(value));
    const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === fields.length && fields.every(field =>
            Object.prototype.hasOwnProperty.call(value, field));
    const failureReason = error => {
        const detail = `${error?.name || ""}:${error?.message || error || ""}`;
        if (/QuotaExceeded/i.test(detail)) return "quota_failure";
        if (/blocked/i.test(detail)) return "indexeddb_open_blocked";
        if (/unavailable/i.test(detail)) return "indexeddb_unavailable";
        if (/open/i.test(detail)) return "indexeddb_open_failed";
        return "indexeddb_transaction_failed";
    };
    const requestResult = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
    });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
        transaction.onerror = () => undefined;
    });
    const metadataRecord = history => ({ id: META_KEY, historyVersion: history.historyVersion,
        parserVersion: history.parserVersion, schemaVersion: history.schemaVersion,
        source: history.source, signatureAlgorithm: history.signatureAlgorithm,
        createdAt: history.createdAt, updatedAt: history.updatedAt });
    const entryRecord = entry => ({ entryKey: entry.entryKey, contract: entry.contract,
        tradingDate: entry.tradingDate, activeVersionKey: entry.activeVersionKey,
        firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
    const revisionRecord = (entryKey, revision) => ({
        revisionKey: `${entryKey}|${revision.versionKey}`, entryKey, ...clone(revision)
    });

    function createStore(configuration = {}) {
        const indexedDb = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || DATABASE_NAME;
        let database = null;
        let opening = null;

        function openDatabase() {
            if (database) return Promise.resolve(database);
            if (opening) return opening;
            if (!indexedDb?.open) return Promise.reject(new Error("indexeddb_unavailable"));
            opening = new Promise((resolve, reject) => {
                const request = indexedDb.open(databaseName, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(META_STORE))
                        db.createObjectStore(META_STORE, { keyPath: "id" });
                    if (!db.objectStoreNames.contains(ENTRY_STORE)) {
                        const store = db.createObjectStore(ENTRY_STORE, { keyPath: "entryKey" });
                        store.createIndex("byContract", "contract", { unique: false });
                        store.createIndex("byTradingDate", "tradingDate", { unique: false });
                    }
                    if (!db.objectStoreNames.contains(REVISION_STORE)) {
                        const store = db.createObjectStore(REVISION_STORE, { keyPath: "revisionKey" });
                        store.createIndex("byEntryKey", "entryKey", { unique: false });
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
        function close() { if (database) database.close(); database = null; }
        async function initialize() {
            try { await openDatabase(); return output({ status: "ready", reason: null }); }
            catch (error) { return output({ status: "unavailable", reason: failureReason(error) }); }
        }
        async function readRecords() {
            const db = await openDatabase();
            const transaction = db.transaction([META_STORE, ENTRY_STORE, REVISION_STORE], "readonly");
            const done = transactionDone(transaction);
            const values = await Promise.all([
                requestResult(transaction.objectStore(META_STORE).get(META_KEY)),
                requestResult(transaction.objectStore(ENTRY_STORE).getAll()),
                requestResult(transaction.objectStore(REVISION_STORE).getAll())
            ]);
            await done; return { meta: values[0], entries: values[1], revisions: values[2] };
        }
        function reconstruct(records) {
            if (!records.meta) return historyApi.createEmptyHistory();
            const byEntry = new Map();
            for (const stored of records.revisions) {
                const revision = clone(stored); delete revision.revisionKey; delete revision.entryKey;
                const list = byEntry.get(stored.entryKey) || [];
                list.push(revision); byEntry.set(stored.entryKey, list);
            }
            return { historyVersion: records.meta.historyVersion,
                parserVersion: records.meta.parserVersion, schemaVersion: records.meta.schemaVersion,
                source: records.meta.source, signatureAlgorithm: records.meta.signatureAlgorithm,
                createdAt: records.meta.createdAt, updatedAt: records.meta.updatedAt,
                entries: records.entries.map(stored => ({ ...clone(stored),
                    revisions: (byEntry.get(stored.entryKey) || []).sort((a, b) =>
                        a.confirmedAt.localeCompare(b.confirmedAt) || a.versionKey.localeCompare(b.versionKey))
                })).sort((a, b) => a.contract.localeCompare(b.contract) ||
                    a.tradingDate.localeCompare(b.tradingDate)) };
        }
        async function loadHistory() {
            try {
                const records = await readRecords();
                const empty = !records.meta && records.entries.length === 0 && records.revisions.length === 0;
                const recordShapeValid = (!records.meta || exact(records.meta, META_FIELDS)) &&
                    records.entries.every(item => exact(item, ENTRY_RECORD_FIELDS)) &&
                    records.revisions.every(item => exact(item, REVISION_RECORD_FIELDS));
                const entryKeys = new Set(records.entries.map(item => item.entryKey));
                const orphanRevisions = records.revisions.filter(item => !entryKeys.has(item.entryKey));
                const history = reconstruct(records);
                const validation = await historyApi.validateHistory(history);
                const status = empty ? "empty" : recordShapeValid && orphanRevisions.length === 0 &&
                    validation.valid ? "ready" : "corrupted";
                return output({ status, reason: status === "corrupted" ? "stored_history_invalid" : null,
                    history, validation, orphanRevisionCount: orphanRevisions.length });
            } catch (error) {
                return output({ status: "unavailable", reason: failureReason(error), history: null,
                    validation: null, orphanRevisionCount: 0 });
            }
        }
        async function commitHistory(history, options = {}) {
            const validation = await historyApi.validateHistory(history);
            if (!validation.valid) return output({ saved: false, outcome: "invalid_history",
                errors: validation.errors });
            let transaction;
            let done;
            try {
                const db = await openDatabase();
                transaction = db.transaction([META_STORE, ENTRY_STORE, REVISION_STORE], "readwrite");
                done = transactionDone(transaction);
                const meta = transaction.objectStore(META_STORE);
                const entries = transaction.objectStore(ENTRY_STORE);
                const revisions = transaction.objectStore(REVISION_STORE);
                meta.clear(); entries.clear(); revisions.clear();
                for (const entry of history.entries) {
                    entries.put(entryRecord(entry));
                    for (const revision of entry.revisions)
                        revisions.put(revisionRecord(entry.entryKey, revision));
                }
                if (options.failAfter === "revisions") throw new Error("injected_transaction_failure");
                meta.put(metadataRecord(history));
                if (options.failAfter === "metadata") throw new Error("injected_transaction_failure");
                await done;
                return output({ saved: true, outcome: "committed" });
            } catch (error) {
                try { transaction?.abort(); } catch (_error) { /* inactive transaction */ }
                try { await done; } catch (_error) { /* rollback completed */ }
                return output({ saved: false, outcome: failureReason(error), error: error.message });
            }
        }
        async function persistCandidate(candidate, options = {}) {
            const loaded = await loadHistory();
            if (!new Set(["empty", "ready"]).has(loaded.status)) return output({ saved: false,
                outcome: loaded.status === "corrupted" ? "corrupted_existing_history" : loaded.reason });
            const merged = await historyApi.mergeCandidate(loaded.history, candidate, options);
            if (!merged.changed) return output({ saved: false, outcome: merged.outcome });
            if (options.failWith === "quota") return output({ saved: false,
                outcome: "quota_failure", error: "QuotaExceededError" });
            const committed = await commitHistory(merged.history, options);
            return committed.saved ? output({ saved: true, outcome: merged.outcome }) : committed;
        }
        async function getEntryByKey(entryKey) {
            const loaded = await loadHistory();
            if (!new Set(["empty", "ready"]).has(loaded.status)) return output({ status: loaded.status,
                reason: loaded.reason, entry: null });
            const entry = loaded.history.entries.find(item => item.entryKey === entryKey) || null;
            return output({ status: entry ? "available" : "unavailable",
                reason: entry ? null : "exact_entry_not_found", entry });
        }
        const getEntry = (contract, tradingDate) => getEntryByKey(historyApi.entryKeyFor(contract, tradingDate));
        async function getActiveRevision(contract, tradingDate) {
            const loaded = await loadHistory();
            if (!new Set(["empty", "ready"]).has(loaded.status)) return output({ status: loaded.status,
                reason: loaded.reason, revision: null });
            const revision = historyApi.getActiveRevision(loaded.history, contract, tradingDate);
            return output({ status: revision ? "available" : "unavailable",
                reason: revision ? null : "exact_revision_not_found", revision });
        }
        async function loadHistoryMetadata() {
            const loaded = await loadHistory();
            if (!new Set(["empty", "ready"]).has(loaded.status)) return output({ status: loaded.status,
                reason: loaded.reason, metadata: null });
            return output({ status: loaded.status, reason: null,
                metadata: metadataRecord(loaded.history) });
        }
        async function listContracts() {
            const loaded = await loadHistory();
            return output({ status: loaded.status, reason: loaded.reason,
                contracts: loaded.history ? historyApi.listContracts(loaded.history) : [] });
        }
        async function listTradingDates(contract) {
            const loaded = await loadHistory();
            return output({ status: loaded.status, reason: loaded.reason,
                tradingDates: loaded.history ? historyApi.listTradingDates(loaded.history, contract) : [] });
        }
        return Object.freeze({ initialize, openDatabase, close, loadHistory, commitHistory,
            persistCandidate, loadHistoryMetadata, getEntryByKey, getEntry, getActiveRevision,
            listContracts, listTradingDates });
    }

    return Object.freeze({ DATABASE_NAME, DB_VERSION, META_STORE, ENTRY_STORE, REVISION_STORE,
        createStore });
});
