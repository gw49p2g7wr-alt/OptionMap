(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const projectionApi = commonJs ? require("./wallHistoryProjection.js") : root?.OptionMapWallHistoryProjection;
    const comparisonApi = commonJs ? require("./qriOptionsHistoryComparison.js") :
        root?.OptionMapQriOptionsHistoryComparison;
    const api = factory(projectionApi, comparisonApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWallHistoryShadowEvaluation = api;
})(typeof window !== "undefined" ? window : globalThis, function (projectionApi, comparisonApi) {
    "use strict";
    const EVALUATION_VERSION = 1;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const active = entry => entry?.revisions?.find(revision => revision.versionKey === entry.activeVersionKey);
    const key = (contract, strike, side, date) => `${contract}|${strike}|${side}|${date}`;
    function diagnostic(wall) {
        return { wallIdentity: wall.wallIdentity, contract: wall.contract, strike: wall.strike,
            side: wall.side, observedPeriod: { from: wall.observations[0]?.tradingDate || null,
                to: wall.observations.at(-1)?.tradingDate || null }, firstSeen: wall.firstSeenDate,
            maxOi: wall.maxOi, maxDate: wall.maxOiDate, coverage: clone(wall.coverage),
            quality: clone(wall.quality), gaps: clone(wall.gapEvents), observations: wall.observations.map(item => ({
                tradingDate: item.tradingDate, state: item.state, openInterest: item.openInterest,
                previousObservationDelta: item.previousObservationDelta, rank: item.rank,
                rankChange: item.rankChange, shrinkState: item.shrinkState, zeroState: item.zeroState,
                ivStatus: item.iv.status, iv: item.iv.value, ivChange: item.ivChange,
                referenceStatus: item.reference.status, referencePrice: item.reference.value,
                priceDistance: item.priceDistance, priceDistancePercent: item.priceDistancePercent,
                sourceRevision: item.sourceRevision, sourceSignature: item.sourceSignature })) };
    }
    function rankedCandidates(walls, predicate, score, count = 3) {
        return walls.filter(predicate).slice().sort((a, b) => score(b) - score(a) ||
            a.wallIdentity.localeCompare(b.wallIdentity)).slice(0, count).map(diagnostic);
    }
    function representatives(walls) {
        const observedCount = wall => wall.coverage.observedCount;
        const deltas = wall => wall.observations.map(item => item.previousObservationDelta)
            .filter(Number.isFinite);
        return {
            longestCall: rankedCandidates(walls, wall => wall.side === "call", observedCount),
            longestPut: rankedCandidates(walls, wall => wall.side === "put", observedCount),
            rankedTop3: rankedCandidates(walls, wall => wall.observations.some(item =>
                item.state === "observed" && item.rank <= 3), wall => observedCount(wall)),
            largestGrowth: rankedCandidates(walls, wall => deltas(wall).some(value => value > 0),
                wall => Math.max(...deltas(wall))),
            largestShrink: rankedCandidates(walls, wall => deltas(wall).some(value => value < 0),
                wall => Math.abs(Math.min(...deltas(wall)))),
            zeroConfirmed: rankedCandidates(walls, wall => wall.observations.some(item =>
                item.zeroState === "zero_confirmed"), observedCount),
            ivJoined: rankedCandidates(walls, wall => wall.coverage.ivObservedCount > 0,
                wall => wall.coverage.ivObservedCount),
            ivMissing: rankedCandidates(walls, wall => wall.coverage.ivObservedCount === 0, observedCount),
            referenceJoined: rankedCandidates(walls, wall => wall.coverage.referenceObservedCount > 0,
                wall => wall.coverage.referenceObservedCount),
            referenceMissing: rankedCandidates(walls, wall =>
                wall.coverage.referenceObservedCount < wall.coverage.observationCount,
                wall => wall.coverage.observationCount - wall.coverage.referenceObservedCount),
            crossesGap: rankedCandidates(walls, wall => wall.coverage.gapEventCount > 0,
                wall => wall.coverage.gapEventCount)
        };
    }
    function historicalConsistency(history, projection) {
        const projected = new Map(projection.walls.flatMap(wall => wall.observations.map(item => [
            key(wall.contract, wall.strike, wall.side, item.tradingDate), { wall, item }])));
        const checks = [];
        for (const entry of history?.entries || []) { const revision = active(entry); if (!revision) continue;
            for (const record of revision.canonical?.records || []) {
                const found = projected.get(key(entry.contract, record.strike, record.optionType,
                    entry.sourceDateKey)); const expectedState = record.published ? "observed" : "notPublished";
                checks.push({ contract: entry.contract, tradingDate: entry.sourceDateKey,
                    strike: record.strike, side: record.optionType, sourceRevision: revision.versionKey,
                    matched: found?.item.sourceRevision === revision.versionKey && found.item.state === expectedState &&
                        found.item.openInterest === (record.published ? record.value : null) });
            }
        }
        return { checked: checks.length, mismatchCount: checks.filter(item => !item.matched).length,
            mismatches: checks.filter(item => !item.matched) };
    }
    function maximumConsistency(projection) {
        const groups = new Map();
        for (const wall of projection.walls) for (const item of wall.observations) {
            if (item.state !== "observed") continue; const groupKey = `${wall.contract}|${item.tradingDate}|${wall.side}`;
            const values = groups.get(groupKey) || []; values.push({ wall, item }); groups.set(groupKey, values);
        }
        const checks = [...groups.entries()].map(([groupKey, values]) => { const max = Math.max(
            ...values.map(value => value.item.openInterest)); const rankOne = values.filter(value => value.item.rank === 1);
            return { groupKey, maxOi: max, rankOneWallIdentities: rankOne.map(value => value.wall.wallIdentity),
                matched: rankOne.length > 0 && rankOne.every(value => value.item.openInterest === max) }; });
        return { checked: checks.length, mismatchCount: checks.filter(item => !item.matched).length,
            mismatches: checks.filter(item => !item.matched) };
    }
    async function previousComparisonConsistency(history, projection) {
        const contracts = [...new Set((history?.entries || []).map(entry => entry.contract))].sort(), checks = [];
        for (const contract of contracts) {
            const comparison = await comparisonApi.compareLatestSavedDates(history, contract);
            if (!comparison.available) { checks.push({ contract, status: comparison.status,
                reason: comparison.reason, checked: 0, mismatchCount: 0 }); continue; }
            let checked = 0, mismatchCount = 0;
            for (const record of comparison.comparison.records) {
                const wall = projection.walls.find(item => item.contract === contract &&
                    item.strike === record.strike && item.side === record.optionType);
                const observation = wall?.observations.find(item =>
                    item.tradingDate === comparison.currentSourceDate); checked += 1;
                const currentStateMatches = record.status === "comparable" || record.status === "current_only"
                    ? observation?.state === "observed"
                    : record.status === "previous_only" || record.status === "unobserved"
                        ? observation?.state === "notPublished" || observation?.state === "missing"
                        : false;
                const matched = currentStateMatches && observation?.previousObservationDelta === record.delta;
                if (!matched) mismatchCount += 1;
            }
            checks.push({ contract, status: comparison.status, previousDate: comparison.previousSourceDate,
                currentDate: comparison.currentSourceDate, checked, mismatchCount });
        }
        return { contracts: checks, checked: checks.reduce((sum, item) => sum + item.checked, 0),
            mismatchCount: checks.reduce((sum, item) => sum + item.mismatchCount, 0) };
    }
    async function evaluate(input = {}) {
        const projection = projectionApi.projectWallHistory(input), reps = representatives(projection.walls);
        const consistency = { historical: historicalConsistency(input.qriOptionsHistory, projection),
            maximum: maximumConsistency(projection),
            previousComparison: await previousComparisonConsistency(input.qriOptionsHistory, projection) };
        const categoryCounts = Object.fromEntries(Object.entries(reps).map(([name, values]) => [name, values.length]));
        const usefulSignals = ["longestCall", "longestPut", "rankedTop3", "largestGrowth", "largestShrink"]
            .filter(name => categoryCounts[name] > 0);
        const blockers = [];
        if (projection.walls.length === 0) blockers.push("no_projected_walls");
        if (consistency.historical.mismatchCount || consistency.maximum.mismatchCount ||
            consistency.previousComparison.mismatchCount) blockers.push("existing_view_mismatch");
        return freeze({ evaluationVersion: EVALUATION_VERSION, readOnly: true, projection,
            representatives: reps, categoryCounts, consistency,
            betaAssessment: { worthShowing: blockers.length === 0 && usefulSignals.length >= 3,
                usefulSignals, blockers, limitations: clone(projection.unavailableMetrics) },
            guards: { storageWrite: false, formalFactWrite: false, uiConnected: false,
                fullExportConnected: false, overallConnected: false, morningConnected: false,
                missingValuesImputed: false } });
    }
    return Object.freeze({ EVALUATION_VERSION, diagnostic, representatives, evaluate });
});
