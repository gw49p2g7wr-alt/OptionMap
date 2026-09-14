(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const contractApi = commonJs ? require("./wallHistoryContract.js") : root?.OptionMapWallHistoryContract;
    const api = factory(contractApi);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapWallHistoryProjection = api;
        root.projectWallHistoryReadOnly = input => api.projectWallHistory(input);
    }
})(typeof window !== "undefined" ? window : globalThis, function (contractApi) {
    "use strict";
    const PROJECTION_VERSION = 1;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const date = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || "");
    const active = (entry, field = "activeVersionKey") => entry?.revisions?.find(
        revision => revision.versionKey === entry[field]);
    const recordKey = record => `${record.optionType}|${record.strike}`;
    const wallKey = (contract, record) => contractApi.wallIdentity(contract, record.strike, record.optionType);

    function weekdayGaps(previous, current) {
        if (!date(previous) || !date(current) || previous >= current) return [];
        const result = [], cursor = new Date(`${previous}T00:00:00Z`), end = new Date(`${current}T00:00:00Z`);
        while (cursor < end) { cursor.setUTCDate(cursor.getUTCDate() + 1); const day = cursor.getUTCDay();
            if (cursor < end && day !== 0 && day !== 6) result.push(cursor.toISOString().slice(0, 10)); }
        return result;
    }

    function rankRecords(records) {
        const ranks = new Map();
        for (const side of ["call", "put"]) {
            const eligible = records.filter(record => record.optionType === side && record.published === true)
                .slice().sort((a, b) => b.value - a.value || a.strike - b.strike);
            let previousValue = null, rank = 0;
            eligible.forEach((record, index) => { if (record.value !== previousValue) rank = index + 1;
                ranks.set(recordKey(record), rank); previousValue = record.value; });
        }
        return ranks;
    }

    function ivIndex(history) {
        const result = new Map();
        for (const entry of history?.entries || []) { const revision = active(entry); if (!revision) continue;
            for (const record of revision.canonical?.records || []) result.set(
                `${entry.contract}|${entry.tradingDate}|${recordKey(record)}`, { record, revision }); }
        return result;
    }

    function matchingPrice(snapshots, revision, contract, tradingDate) {
        const matches = (snapshots || []).filter(snapshot => snapshot?.price > 0 &&
            snapshot.contract === contract && snapshot.tradingDate === tradingDate &&
            snapshot.sourceVersionReference?.contract === contract &&
            snapshot.sourceVersionReference?.tradingDate === tradingDate &&
            snapshot.sourceVersionReference?.versionKey === revision.versionKey &&
            snapshot.sourceVersionReference?.signature === revision.signature)
            .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        const snapshot = matches.at(-1);
        return snapshot ? { status: "observed", value: snapshot.price, snapshotId: snapshot.snapshotId,
            observedAt: snapshot.observedAt, quotedAt: snapshot.quotedAtNormalized,
            mapping: "exact_qri_source_revision" } : { status: "missing", value: null,
            reason: "exact_reference_mapping_unavailable" };
    }

    function oiEntries(history) {
        return (history?.entries || []).map(entry => ({ entry, revision: active(entry) }))
            .filter(item => item.revision && date(item.entry.sourceDateKey))
            .sort((a, b) => a.entry.sourceDateKey.localeCompare(b.entry.sourceDateKey) ||
                a.entry.contract.localeCompare(b.entry.contract));
    }

    function projectWallHistory({ qriOptionsHistory, qriOptionIvHistory = null,
        priceSnapshots = [] } = {}) {
        const iv = ivIndex(qriOptionIvHistory), walls = new Map(), datesByContract = new Map(),
            contexts = new Map(), errors = [];
        for (const { entry, revision } of oiEntries(qriOptionsHistory)) {
            if (revision.contract !== entry.contract || revision.tradingDate !== entry.sourceDateKey ||
                revision.openInterestStatus !== "available" || !Array.isArray(revision.canonical?.records)) {
                errors.push({ entryKey: entry.entryKey || null, reason: "invalid_active_oi_revision" }); continue;
            }
            const dates = datesByContract.get(entry.contract) || [];
            dates.push(entry.sourceDateKey); datesByContract.set(entry.contract, dates);
            contexts.set(`${entry.contract}|${entry.sourceDateKey}`, { revision });
            const ranks = rankRecords(revision.canonical.records), byKey = new Map(
                revision.canonical.records.map(record => [recordKey(record), record]));
            for (const record of revision.canonical.records) {
                const id = wallKey(entry.contract, record); if (!id) continue;
                const wall = walls.get(id) || { wallIdentity: id, source: contractApi.WALL_SOURCE,
                    contract: entry.contract, strike: record.strike, side: record.optionType, observations: [] };
                const state = record.published === true ? "observed" : "notPublished";
                const ivFact = iv.get(`${entry.contract}|${entry.sourceDateKey}|${recordKey(record)}`);
                const ivValue = ivFact?.record?.iv?.status === "available" ? ivFact.record.iv.value : null;
                const reference = matchingPrice(priceSnapshots, revision, entry.contract, entry.sourceDateKey);
                wall.observations.push({ observationIdentity: contractApi.observationIdentity(id,
                    entry.sourceDateKey, revision.versionKey), tradingDate: entry.sourceDateKey,
                    sourceRevision: revision.versionKey, sourceSignature: revision.signature,
                    state, openInterest: state === "observed" ? record.value : null,
                    rank: state === "observed" ? ranks.get(recordKey(record)) : null,
                    iv: { status: ivFact?.record?.iv?.status || "missing", value: ivValue,
                        sourceRevision: ivFact?.revision?.versionKey || null }, reference,
                    priceDistance: reference.status === "observed" ? record.strike - reference.value : null,
                    priceDistancePercent: reference.status === "observed"
                        ? (record.strike - reference.value) / reference.value : null });
                walls.set(id, wall);
            }
        }
        for (const wall of walls.values()) for (const tradingDate of datesByContract.get(wall.contract) || []) {
            if (wall.observations.some(item => item.tradingDate === tradingDate)) continue;
            const revision = contexts.get(`${wall.contract}|${tradingDate}`).revision;
            wall.observations.push({ observationIdentity: contractApi.observationIdentity(wall.wallIdentity,
                tradingDate, revision.versionKey), tradingDate, sourceRevision: revision.versionKey,
                sourceSignature: revision.signature, state: "missing", openInterest: null, rank: null,
                iv: { status: "missing", value: null, sourceRevision: null },
                reference: matchingPrice(priceSnapshots, revision, wall.contract, tradingDate),
                priceDistance: null, priceDistancePercent: null });
        }
        const projectedWalls = [...walls.values()].map(wall => {
            wall.observations.sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
            let previousObserved = null, previousIv = null, maxOi = null, maxOiDate = null;
            for (const item of wall.observations) {
                item.previousObservedTradingDate = previousObserved?.tradingDate || null;
                item.previousObservationDelta = item.state === "observed" && previousObserved
                    ? item.openInterest - previousObserved.openInterest : null;
                item.rankChange = item.state === "observed" && previousObserved
                    ? item.rank - previousObserved.rank : null;
                item.shrinkState = item.state !== "observed" ? "unavailable"
                    : item.openInterest === 0 ? "zero_confirmed"
                    : item.previousObservationDelta < 0 ? "shrinking" : "not_shrinking";
                item.zeroState = item.state === "observed" && item.openInterest === 0
                    ? "zero_confirmed" : item.state === "observed" ? "nonzero" : "unavailable";
                item.ivChange = item.iv.status === "available" && previousIv !== null
                    ? item.iv.value - previousIv : null;
                if (item.state === "observed") { if (maxOi === null || item.openInterest > maxOi) {
                    maxOi = item.openInterest; maxOiDate = item.tradingDate; } previousObserved = item; }
                if (item.iv.status === "available") previousIv = item.iv.value;
            }
            const observed = wall.observations.filter(item => item.state === "observed");
            const notPublished = wall.observations.filter(item => item.state === "notPublished");
            const missing = wall.observations.filter(item => item.state === "missing");
            const gaps = wall.observations.slice(1).flatMap((item, index) => {
                const previous = wall.observations[index]; const candidateDates = weekdayGaps(previous.tradingDate,
                    item.tradingDate); return candidateDates.length ? [{ state: contractApi.GAP_STATE,
                    afterTradingDate: previous.tradingDate, beforeTradingDate: item.tradingDate,
                    candidateDates, basis: contractApi.DATE_SEMANTICS.gap }] : []; });
            return { ...wall, firstSeenDate: observed[0]?.tradingDate || null, maxOi, maxOiDate,
                gapEvents: gaps, coverage: { observationCount: wall.observations.length,
                    observedCount: observed.length, notPublishedCount: notPublished.length,
                    missingCount: missing.length, gapEventCount: gaps.length,
                    ivObservedCount: wall.observations.filter(item => item.iv.status === "available").length,
                    referenceObservedCount: wall.observations.filter(item => item.reference.status === "observed").length },
                quality: { complete: missing.length === 0 && gaps.length === 0,
                    firstSeenIsHistoryBounded: true, gapBasis: contractApi.DATE_SEMANTICS.gap } };
        }).sort((a, b) => a.contract.localeCompare(b.contract) || a.strike - b.strike ||
            a.side.localeCompare(b.side));
        return freeze({ projectionVersion: PROJECTION_VERSION, readOnly: true,
            contractVersion: contractApi.CONTRACT_VERSION, semantics: { rank: contractApi.RANK_METHOD,
                dates: contractApi.DATE_SEMANTICS, observationStates: contractApi.OBSERVATION_STATES,
                gapState: contractApi.GAP_STATE, derived: contractApi.DERIVATION_SEMANTICS },
            unavailableMetrics: ["volume", "optionPrice", "settlement", "bid", "ask"],
            walls: projectedWalls, diagnostics: { errorCount: errors.length, errors,
                wallCount: projectedWalls.length, contractCount: datesByContract.size,
                rolloverMerged: false, inferredUnavailableMetrics: false } });
    }
    return Object.freeze({ PROJECTION_VERSION, weekdayGaps, rankRecords, projectWallHistory });
});
