(function (root, factory) { const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const projection = commonJs ? require("./formalArchiveInventoryProjection.js") :
        root?.OptionMapFormalArchiveInventoryProjection; const api = factory(projection, root);
    if (commonJs) module.exports = api;
    if (root) { root.OptionMapFormalArchiveInventoryRuntime = api;
        root.runFormalArchiveInventoryReadOnly = options => api.runReadOnlyInventory({
            localStorage: root.localStorage, indexedDB: root.indexedDB, ...options }); }
})(typeof window !== "undefined" ? window : globalThis, function (projection, root) {
    "use strict";
    const RUNTIME_VERSION = 1;
    const LOCAL_KEYS = Object.freeze(["optionMapQriOptionsLastValidV1", "optionMapQriOptionIvLastValidV1",
        "optionMapCurrentPriceLastValidV1", "optionMapLastValidQriOpenInterest",
        "optionMapLastValidWeeklyFutures", "optionMapLastValidWeeklyOptions",
        "optionMapLastValidParticipantData", "optionMapLastQriFuturesPrice",
        "optionMapWeeklyFuturesHistory", "optionMapParticipantHistory", "optionMapMorningBaselinesV4",
        "optionMapMorningBaselineV4AutomaticOutcomeV1",
        "optionMapMobileMorningBaselinesV1", "optionMapJpxSnapshots", "optionMapCurrentPrice",
        "optionMapPriceSource", "optionMapPriceMode", "optionMapPriceContract",
        "optionMapPriceQuotedAt", "optionMapPriceFetchedAt", "optionMapNightData",
        "optionMapDayData", "optionMapOptionData", "optionMapFutureOpenInterestData", "optionMapAiTemplates"]);
    const DATABASES = Object.freeze([
        { name: "optionMapQriOptionsHistory", version: 1, stores: ["qriOptionsHistoryMeta",
            "qriOptionsEntries", "qriOptionsRevisions"] },
        { name: "optionMapQriOptionIvHistory", version: 1, stores: ["qriOptionIvHistoryMeta",
            "qriOptionIvEntries", "qriOptionIvRevisions"] },
        { name: "optionMapWeeklyOptionsHistory", version: 1, stores: ["weeklyOptionsHistoryMeta",
            "weeklyOptionsEntries", "weeklyOptionsRevisions"] },
        { name: "optionMapPriceSnapshots", version: 1, stores: ["snapshots"] },
        { name: "optionMapMarketObservations", version: 1, stores: ["observations"] }]);
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function hash(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function readLocal(storage) { const values = {}; for (const key of LOCAL_KEYS) {
        let raw = null; try { raw = storage?.getItem?.(key) ?? null; } catch (_error) { raw = null; }
        let parsed = null; try { parsed = raw === null ? null : JSON.parse(raw); } catch (_error) { parsed = raw; }
        values[key] = { present: raw !== null, raw, parsed }; } return values; }
    function readAllLocal(storage) { const values = {};
        for (let index = 0; index < Number(storage?.length || 0); index += 1) {
            const key = storage.key(index); if (typeof key === "string") values[key] = storage.getItem(key);
        } return values; }
    function requestValue(request) { return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    function transactionDone(transaction) { return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => undefined; }); }
    async function existingDatabases(indexedDB) { if (typeof indexedDB?.databases !== "function") return [];
        return (await indexedDB.databases()).map(item => ({ name: item.name, version: item.version })); }
    async function readDatabase(indexedDB, descriptor, available) {
        const found = available.find(item => item.name === descriptor.name);
        if (!found) return { status: "missing", version: null, stores: {} };
        if (found.version !== descriptor.version) return { status: "version_mismatch",
            version: found.version, stores: {} };
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(
            descriptor.name, descriptor.version); request.onupgradeneeded = () => { request.transaction.abort();
                reject(new Error("indexeddb_upgrade_forbidden")); }; request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("indexeddb_open_failed")); });
        try { const stores = {}; const names = descriptor.stores.filter(name => db.objectStoreNames.contains(name));
            if (names.length !== descriptor.stores.length) return { status: "store_mismatch",
                version: db.version, stores: {} };
            const transaction = db.transaction(names, "readonly"), done = transactionDone(transaction);
            await Promise.all(names.map(async name => { stores[name] = clone(await requestValue(
                transaction.objectStore(name).getAll())); })); await done;
            return { status: "ready", version: db.version, stores };
        } finally { db.close(); }
    }
    function reconstruct(meta, entries, revisions, dateField) { const byEntry = new Map();
        for (const stored of revisions || []) { const key = stored.entryKey || stored.sourceDate;
            const value = clone(stored); delete value.revisionKey; delete value.entryKey;
            if (dateField === "sourceDate") delete value.sourceDate;
            const list = byEntry.get(key) || []; list.push(value); byEntry.set(key, list); }
        const keys = new Set((entries || []).map(entry => entry.entryKey || entry[dateField]));
        const orphanRevisionCount = (revisions || []).filter(item =>
            !keys.has(item.entryKey || item.sourceDate)).length;
        const header = clone(meta?.[0] || {}); delete header.id;
        const history = { ...header,
            entries: (entries || []).map(entry => ({ ...clone(entry),
                revisions: byEntry.get(entry.entryKey || entry[dateField]) || [] })) };
        Object.defineProperty(history, "orphanRevisionCount", { value: orphanRevisionCount,
            enumerable: false }); return history; }
    function localHistory(local, key) { const value = local[key]?.parsed;
        return value && typeof value === "object" ? clone(value) : { entries: [], validationValid: value == null }; }
    async function cacheProjection(local) { const descriptors = [
        ["optionMapQriOptionsLastValidV1", "qri_options_last_valid", "cache"],
        ["optionMapQriOptionIvLastValidV1", "qri_iv_last_valid", "cache"],
        ["optionMapCurrentPriceLastValidV1", "current_price_last_valid", "cache"],
        ["optionMapLastValidQriOpenInterest", "legacy_qri_oi", "legacy"],
        ["optionMapLastValidWeeklyFutures", "weekly_futures_last_valid", "cache"],
        ["optionMapLastValidWeeklyOptions", "weekly_options_last_valid", "cache"],
        ["optionMapLastValidParticipantData", "participant_last_valid", "cache"],
        ["optionMapLastQriFuturesPrice", "legacy_qri_price", "legacy"],
        ["optionMapMobileMorningBaselinesV1", "legacy_morning", "legacy"],
        ["optionMapJpxSnapshots", "legacy_jpx_snapshots", "legacy"],
        ["optionMapMorningBaselineV4AutomaticOutcomeV1", "morning_v4_automatic_outcome", "runtime_cache"],
        ["optionMapNightData", "legacy_night_input", "legacy"],
        ["optionMapDayData", "legacy_day_input", "legacy"],
        ["optionMapOptionData", "legacy_option_input", "legacy"],
        ["optionMapFutureOpenInterestData", "legacy_future_oi_input", "legacy"],
        ["optionMapCurrentPrice", "legacy_current_price", "legacy"],
        ["optionMapAiTemplates", "user_preference", "preference"]];
        const validators = {
            optionMapQriOptionsLastValidV1: root?.OptionMapQriOptionsLastValidCache
                ?.validateQriOptionsLastValidCache,
            optionMapQriOptionIvLastValidV1: root?.OptionMapQriOptionIvLastValidCache
                ?.validateQriOptionIvLastValidCache,
            optionMapCurrentPriceLastValidV1: root?.OptionMapCurrentPriceLastValidCache
                ?.validateCurrentPriceLastValidCacheV2,
            optionMapLastValidParticipantData: root?.OptionMapParticipantData?.validateParticipantCache
        };
        const overlaps = { qri_options_last_valid: ["qri_options_history"],
            qri_iv_last_valid: ["qri_option_iv_history"], current_price_last_valid: ["price_snapshots",
                "market_observations", "legacy_qri_price"], legacy_qri_oi: ["qri_options_history"],
            weekly_futures_last_valid: ["weekly_futures_history"],
            weekly_options_last_valid: ["weekly_options_history"],
            participant_last_valid: ["participant_history", "legacy_jpx_snapshots"],
            legacy_qri_price: ["current_price_last_valid", "price_snapshots", "market_observations"],
            legacy_morning: ["morning_v4"], legacy_jpx_snapshots: ["participant_history"] };
        return Promise.all(descriptors.map(async ([key, storageId, authorityClass]) => ({ storageId, key, authorityClass,
            present: local[key]?.present === true,
            signatureStatus: !local[key]?.present ? "missing" : typeof validators[key] === "function" ?
                await validators[key](local[key].parsed) ? "verified" : "invalid" : "unsigned_or_legacy",
            overlapsWith: overlaps[storageId] || [], migratable: false,
            migrationBlockedReasons: local[key]?.present ? ["cache_or_legacy_not_formal"] : ["missing"] })));
    }
    function cacheFacts(local) { const result = [], addCanonical = (cache, storageId, metric, valueOf) => {
        const canonical = cache?.canonical; if (!canonical) return;
        for (const record of canonical.records || []) result.push({ factKey: projection.identity(
            canonical.contract, record.strike, record.optionType, canonical.tradingDate), storageId,
        authorityClass: "cache", metric, value: valueOf(record) }); };
        addCanonical(local.optionMapQriOptionsLastValidV1?.parsed, "qri_options_last_valid",
            "openInterest", record => record.published ? record.value : null);
        addCanonical(local.optionMapQriOptionIvLastValidV1?.parsed, "qri_iv_last_valid",
            "iv", record => record.iv?.status === "available" ? record.iv.value : null);
        const old = local.optionMapLastValidQriOpenInterest?.parsed;
        for (const record of old?.positions || []) for (const [side, field] of [["call", "callOpenInterest"],
            ["put", "putOpenInterest"]]) result.push({ factKey: projection.identity(old.contract || "unknown",
                record.strike, side, String(old.sourceDate || "").slice(0, 10)), storageId: "legacy_qri_oi",
            authorityClass: "legacy", metric: "openInterest", value: record[field] }); return result; }
    async function snapshot(storage, indexedDB) { const local = readLocal(storage), localAll = readAllLocal(storage), available =
        await existingDatabases(indexedDB), databases = {};
        for (const descriptor of DATABASES) databases[descriptor.name] = await readDatabase(
            indexedDB, descriptor, available); return { local, localAll,
                databaseCatalog: available.slice().sort((a, b) => a.name.localeCompare(b.name)), databases }; }
    async function runReadOnlyInventory({ localStorage, indexedDB } = {}) {
        const before = await snapshot(localStorage, indexedDB), beforeFingerprint = await hash(before);
        const db = before.databases, qri = db.optionMapQriOptionsHistory?.stores || {},
            iv = db.optionMapQriOptionIvHistory?.stores || {}, weekly =
                db.optionMapWeeklyOptionsHistory?.stores || {};
        const histories = { qriOptions: reconstruct(qri.qriOptionsHistoryMeta,
            qri.qriOptionsEntries, qri.qriOptionsRevisions, "sourceDateKey"),
        qriOptionIv: reconstruct(iv.qriOptionIvHistoryMeta, iv.qriOptionIvEntries,
            iv.qriOptionIvRevisions, "tradingDate"), weeklyOptions: reconstruct(
            weekly.weeklyOptionsHistoryMeta, weekly.weeklyOptionsEntries,
            weekly.weeklyOptionsRevisions, "sourceDate"),
        weeklyFutures: localHistory(before.local, "optionMapWeeklyFuturesHistory"),
        participant: localHistory(before.local, "optionMapParticipantHistory"),
        morningV4: (() => { const source = localHistory(before.local, "optionMapMorningBaselinesV4");
            return { ...source, entries: (source.series || []).map(item => ({ ...item,
                sourceDate: item.formalTradingDate,
                revisions: (item.revisions || []).map(revision => ({ ...revision,
                    versionKey: revision.baselineId })), activeVersionKey: item.activeBaselineId })) }; })(),
        priceSnapshots: { entries: (db.optionMapPriceSnapshots?.stores?.snapshots || []).map(item => ({
            sourceDate: item.marketDate, activeVersionKey: item.snapshotId,
            revisions: [{ versionKey: item.snapshotId, replacedAt: null }] })) },
        marketObservations: { entries: (db.optionMapMarketObservations?.stores?.observations || []).map(item => ({
            sourceDate: item.marketDate, activeVersionKey: item.observationId,
            revisions: [{ versionKey: item.observationId, replacedAt: null }] })) } };
        const validations = await Promise.all([
            root?.OptionMapQriOptionsHistory?.validateHistory?.(histories.qriOptions),
            root?.OptionMapQriOptionIvHistory?.validateHistory?.(histories.qriOptionIv),
            root?.OptionMapWeeklyFuturesHistory?.validateHistory?.(histories.weeklyFutures),
            root?.OptionMapWeeklyOptionsHistory?.validateWeeklyOptionsHistory?.(histories.weeklyOptions),
            root?.OptionMapParticipantHistory?.validateParticipantHistory?.(histories.participant,
                root?.OptionMapParticipantData?.validateParticipantCache),
            root?.OptionMapMorningBaselineV4StorageFoundation?.validateMorningBaselineV4Storage?.(
                before.local.optionMapMorningBaselinesV4?.parsed),
            Promise.all((db.optionMapPriceSnapshots?.stores?.snapshots || []).map(item =>
                root?.OptionMapPriceSnapshot?.verifySnapshot?.(item))),
            Promise.all((db.optionMapMarketObservations?.stores?.observations || []).map(item =>
                root?.OptionMapMarketObservation?.verifyObservation?.(item))) ]);
        const validValue = value => value === true || value?.valid === true;
        [histories.qriOptions, histories.qriOptionIv, histories.weeklyFutures,
            histories.weeklyOptions, histories.participant, histories.morningV4]
            .forEach((history, index) => { if (validations[index] !== undefined) {
                history.validationValid = validValue(validations[index]);
                history.validationErrors = clone(validations[index]?.errors || []); } });
        histories.priceSnapshots.validationValid = (validations[6] || []).every(validValue);
        histories.marketObservations.validationValid = (validations[7] || []).every(validValue);
        const projectionResult = projection.projectFormalArchiveInventory({ histories,
            cacheInventory: await cacheProjection(before.local), cacheFacts: cacheFacts(before.local) });
        const after = await snapshot(localStorage, indexedDB), afterFingerprint = await hash(after);
        return freeze({ runtimeVersion: RUNTIME_VERSION, readOnly: true, indexedDbUpgradeAttempted: false,
            beforeFingerprint, afterFingerprint, fingerprintMatched: beforeFingerprint === afterFingerprint,
            databaseStatus: Object.fromEntries(Object.entries(before.databases).map(([name, value]) =>
                [name, { status: value.status, version: value.version }])), projection: projectionResult });
    }
    return freeze({ RUNTIME_VERSION, LOCAL_KEYS, DATABASES, runReadOnlyInventory });
});
