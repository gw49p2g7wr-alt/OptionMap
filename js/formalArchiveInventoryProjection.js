(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapFormalArchiveInventoryProjection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const PROJECTION_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const date = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || "");
    const identity = (contract, strike, side, tradingDate) =>
        `${contract}|${strike}|${side}|${tradingDate}`;
    function missingDates(values, cadence = "daily") {
        const dates = [...new Set(values.filter(date))].sort(); if (dates.length < 2) return [];
        const available = new Set(dates), missing = [], cursor = new Date(`${dates[0]}T00:00:00Z`),
            end = new Date(`${dates.at(-1)}T00:00:00Z`);
        while (cursor < end) { cursor.setUTCDate(cursor.getUTCDate() + (cadence === "weekly" ? 7 : 1));
            const value = cursor.toISOString().slice(0, 10), day = cursor.getUTCDay();
            if ((cadence === "weekly" || day !== 0 && day !== 6) && cursor < end &&
                !available.has(value)) missing.push(value); }
        return missing;
    }
    function activeRevisions(history) { return (history?.entries || []).flatMap(entry => {
        const active = entry.revisions?.find(item => item.versionKey === entry.activeVersionKey);
        return active ? [{ entry, revision: active }] : []; }); }
    function integrity(history) { const entries = history?.entries || []; let revisions = 0,
        active = 0, invalid = 0, orphan = Number(history?.orphanRevisionCount || 0);
        for (const entry of entries) { const values = entry.revisions || []; revisions += values.length;
            const selected = values.filter(item => item.versionKey === entry.activeVersionKey);
            active += selected.length; if (selected.length !== 1 || selected[0]?.replacedAt !== null) invalid += 1;
            invalid += values.filter(item => item.versionKey !== entry.activeVersionKey &&
                item.replacedAt === null).length; }
        return { entryCount: entries.length, revisionCount: revisions, activeRevisionCount: active,
            invalidIdentityCount: invalid, orphanRevisionCount: orphan };
    }
    function inventoryRecord(id, authorityClass, history, retention) { const stats = integrity(history);
        const dates = (history?.entries || []).map(item => item.sourceDateKey || item.tradingDate ||
            item.sourceDate).filter(Boolean); const valid = history?.validationValid !== false &&
            stats.invalidIdentityCount === 0 && stats.orphanRevisionCount === 0;
        return { storageId: id, authorityClass, schemaVersion: history?.schemaVersion ?? null,
            historyVersion: history?.historyVersion ?? history?.version ?? null,
            ...stats, signatureStatus: valid ? "verified" : "invalid",
            validationErrors: clone(history?.validationErrors || []),
            retention: clone(retention), missingDates: missingDates(dates, retention?.cadence),
            missingDateBasis: retention?.cadence === "weekly" ?
                "seven_day_gap_not_exchange_calendar" : "weekday_gap_not_exchange_calendar",
            migratableCount: valid ? stats.activeRevisionCount : 0,
            migrationBlockedReasons: valid ? [] : [stats.orphanRevisionCount ? "orphan_revision" :
                "version_or_signature_invalid"] }; }
    function qriFacts(history) { return activeRevisions(history).flatMap(({ entry, revision }) =>
        (revision.canonical?.records || []).filter(record => record.published === true).map(record => ({
            factKey: identity(entry.contract, record.strike, record.optionType, entry.sourceDateKey),
            storageId: "qri_options_history", authorityClass: "formal",
            metric: "openInterest", contract: entry.contract, strike: record.strike,
            side: record.optionType, tradingDate: entry.sourceDateKey, value: record.value,
            versionKey: revision.versionKey, signature: revision.signature })) ); }
    function ivFacts(history) { return activeRevisions(history).flatMap(({ entry, revision }) =>
        (revision.canonical?.records || []).map(record => ({
            factKey: identity(entry.contract, record.strike, record.optionType, entry.tradingDate),
            storageId: "qri_option_iv_history", authorityClass: "formal", metric: "iv",
            contract: entry.contract, strike: record.strike, side: record.optionType,
            tradingDate: entry.tradingDate, value: record.iv?.status === "available" ? record.iv.value : null,
            availability: record.iv?.status || "unavailable", versionKey: revision.versionKey,
            signature: revision.signature })) ); }
    function wallProjection(oi, iv) { const byKey = new Map();
        for (const fact of [...oi, ...iv]) { const row = byKey.get(fact.factKey) || {
            identity: fact.factKey, contract: fact.contract, strike: fact.strike, side: fact.side,
            tradingDate: fact.tradingDate, openInterest: null, iv: null,
            missing: ["openInterest", "iv", "volume", "optionPrice"] };
            if (fact.metric === "openInterest") row.openInterest = clone(fact);
            if (fact.metric === "iv") row.iv = clone(fact); byKey.set(fact.factKey, row); }
        return [...byKey.values()].map(row => ({ ...row, missing: row.missing.filter(metric =>
            metric === "volume" || metric === "optionPrice" ||
            metric === "openInterest" && !row.openInterest || metric === "iv" && !row.iv) }))
            .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) ||
                a.contract.localeCompare(b.contract) || a.strike - b.strike || a.side.localeCompare(b.side)); }
    function duplicateGroups(facts, cacheFacts = []) { const groups = new Map();
        for (const fact of [...facts, ...cacheFacts]) { const key = `${fact.metric}|${fact.factKey}`;
            const values = groups.get(key) || []; values.push(fact); groups.set(key, values); }
        return [...groups.entries()].filter(([, values]) =>
            new Set(values.map(item => item.storageId)).size > 1).map(([factKey, values]) => ({
                factKey, storageIds: [...new Set(values.map(item => item.storageId))].sort(),
                authorityClasses: [...new Set(values.map(item => item.authorityClass))].sort() })); }
    function projectFormalArchiveInventory(input = {}) {
        const histories = input.histories || {}, oi = qriFacts(histories.qriOptions),
            iv = ivFacts(histories.qriOptionIv), cacheFacts = clone(input.cacheFacts || []);
        const inventory = [
            inventoryRecord("qri_options_history", "formal", histories.qriOptions, { policy: "unbounded" }),
            inventoryRecord("qri_option_iv_history", "formal", histories.qriOptionIv, { policy: "unbounded" }),
            inventoryRecord("weekly_futures_history", "formal", histories.weeklyFutures,
                { policy: "max_entries", maxEntries: 52, cadence: "weekly" }),
            inventoryRecord("weekly_options_history", "formal", histories.weeklyOptions,
                { ...(histories.weeklyOptions?.retentionPolicy || { policy: "unbounded" }),
                    cadence: "weekly" }),
            inventoryRecord("participant_history", "formal", histories.participant,
                { policy: "max_entries", maxEntries: 30 }),
            inventoryRecord("morning_v4", "formal_baseline", histories.morningV4,
                { policy: "unbounded" }),
            inventoryRecord("price_snapshots", "reference_observation", histories.priceSnapshots,
                { policy: "unbounded", dedupeWindowMs: 300000 }),
            inventoryRecord("market_observations", "derived_observation", histories.marketObservations,
                { policy: "unbounded", dedupeWindowMs: 300000 })];
        const formalFacts = [...oi, ...iv];
        const cacheInventory = clone(input.cacheInventory || []);
        return freeze({ projectionVersion: PROJECTION_VERSION, inventory,
            storageInventory: [...inventory, ...cacheInventory],
            totals: { storageCount: inventory.length, formalFactCount: formalFacts.length,
                migratableCount: inventory.reduce((sum, item) => sum + item.migratableCount, 0),
                blockedStorageCount: inventory.filter(item => item.migrationBlockedReasons.length).length },
            duplicates: duplicateGroups(formalFacts, cacheFacts),
            wallHistory: wallProjection(oi, iv), cacheInventory,
            unavailableMetrics: ["volume", "optionPrice"],
            diagnostics: { fabricatedFields: false, repairedStorage: false,
                migratedStorage: false, morningV5Included: false } });
    }
    return freeze({ PROJECTION_VERSION, identity, missingDates, projectFormalArchiveInventory });
});
