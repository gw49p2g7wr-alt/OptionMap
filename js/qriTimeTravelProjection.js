(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(commonJs ? module.require("./qriOptions" + "HistoricalViewModel.js")
        : root?.OptionMapQriOptionsHistoricalViewModel,
    commonJs ? module.require("./qriOptions" + "HistoricalAggregation.js")
        : root?.OptionMapQriOptionsHistoricalAggregation);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriTimeTravelProjection = api;
})(typeof window !== "undefined" ? window : globalThis, function (historicalApi, aggregationApi) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function inventory(history) {
        const byDate = new Map(), byContract = new Map();
        for (const entry of history?.entries || []) { if (!entry?.contract || !entry?.sourceDateKey) continue;
            const dateContracts = byDate.get(entry.sourceDateKey) || new Set(); dateContracts.add(entry.contract);
            byDate.set(entry.sourceDateKey, dateContracts); const dates = byContract.get(entry.contract) || new Set();
            dates.add(entry.sourceDateKey); byContract.set(entry.contract, dates); }
        return { dates: [...byDate.keys()].sort(), contracts: [...byContract.keys()].sort().reverse(),
            availability: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tradingDate, set]) =>
                ({ tradingDate, contracts: [...set].sort() })) };
    }
    function rows(snapshot) { return (snapshot?.facts || []).flatMap(point => [
        { strike: point.strike, side: "call", published: point.call.published, oi: point.call.value },
        { strike: point.strike, side: "put", published: point.put.published, oi: point.put.value }
    ]); }
    function aggregationSnapshot(aggregation) { return { facts: (aggregation?.points || []).map(point => ({
        strike: point.strike,
        call: { published: point.call.total !== null, value: point.call.total },
        put: { published: point.put.total !== null, value: point.put.total }
    })) }; }
    function activeIvIndex(history) {
        const index = new Map();
        for (const entry of history?.entries || []) {
            const revision = entry?.revisions?.find(item => item.versionKey === entry.activeVersionKey);
            if (!revision || revision.contract !== entry.contract || revision.tradingDate !== entry.tradingDate) continue;
            for (const record of revision.canonical?.records || []) index.set(
                `${entry.contract}|${entry.tradingDate}|${record.optionType}|${record.strike}`,
                { status: record.iv?.status || "missing", value: record.iv?.status === "available"
                    ? record.iv.value : null, sourceRevision: revision.versionKey });
        }
        return index;
    }
    function decorate(current, previous, iv = null, contract = null, tradingDate = null) {
        const previousMap = new Map(rows(previous).map(item => [`${item.side}|${item.strike}`, item]));
        const facts = rows(current).map(item => { const prior = previousMap.get(`${item.side}|${item.strike}`);
            const ivFact = iv?.get(`${contract}|${tradingDate}|${item.side}|${item.strike}`) || null;
            return { ...item, previousOi: prior?.published ? prior.oi : null,
                previousSavedObservationDelta: item.published && prior?.published ? item.oi - prior.oi : null,
                iv: { status: ivFact?.status || "missing", value: ivFact?.value ?? null,
                    sourceRevision: ivFact?.sourceRevision || null } }; });
        const top3 = Object.fromEntries(["call", "put"].map(side => [side, facts.filter(item => item.side === side &&
            item.published).sort((a, b) => b.oi - a.oi || a.strike - b.strike).slice(0, 3)
            .map((item, index) => ({ ...item, rank: index + 1 }))]));
        return { facts, top3, coverage: { total: facts.length,
            observed: facts.filter(item => item.published).length,
            notPublished: facts.filter(item => !item.published).length,
            comparable: facts.filter(item => item.previousSavedObservationDelta !== null).length },
            ivCoverage: { eligible: facts.length, observed: facts.filter(item =>
                item.iv.status === "available").length, missing: facts.filter(item =>
                item.iv.status !== "available").length } };
    }
    function result(status, reason, data = {}) { return freeze({ status, reason, readOnly: true,
        storageWrite: false, activeRevisionWrite: false, liveStateWrite: false, ...clone(data) }); }
    function build({ history, ivHistory = null, state } = {}) {
        const available = inventory(history); const date = state?.selectedTradingDate;
        const selected = state?.viewMode === "aggregate" ? [...(state.selectedContracts || [])]
            : [state?.selectedContract].filter(Boolean);
        const base = { state, dates: available.dates, contracts: available.contracts,
            availability: available.availability };
        if (!date || selected.length === 0) return result("unavailable", "selection_missing", base);
        const snapshots = [], views = [];
        for (const contract of selected) { const view = historicalApi.buildQriHistoricalViewModel({ history,
            selectedContract: contract, selectedTradingDate: date }); views.push(view);
            if (view.status !== "available") return result("unavailable", "snapshot_not_saved", { ...base,
                missingContracts: selected.filter(value => !available.availability.find(item =>
                    item.tradingDate === date)?.contracts.includes(value)) }); snapshots.push(view.snapshot); }
        let snapshot, chartData, identity, metadata;
        if (state.viewMode === "aggregate") { if (snapshots.length < 2)
            return result("unavailable", "aggregate_requires_two_contracts", base);
            const aggregation = aggregationApi.buildQriHistoricalAggregation({ snapshots });
            if (!aggregation || !["available", "partial"].includes(aggregation.status))
                return result("unavailable", aggregation?.reason || "aggregation_unavailable", base);
            snapshot = aggregationSnapshot(aggregation);
            chartData = { strikes: aggregation.strikes,
                callOpenInterest: aggregation.points.map(p => p.call.total),
                putOpenInterest: aggregation.points.map(p => p.put.total) };
            identity = aggregation.aggregationIdentity; metadata = { contracts: selected,
                activeVersionKeys: views.map(view => view.selection.activeVersionKey) };
        } else { snapshot = snapshots[0]; chartData = views[0].chartData;
            identity = views[0].selection.entryKey; metadata = views[0].metadata; }
        const priorDates = available.dates.filter(value => value < date && selected.every(contract =>
            available.availability.find(item => item.tradingDate === value)?.contracts.includes(contract)));
        const previousDate = priorDates.at(-1) || null; let previous = null;
        if (previousDate) { const previousSnapshots = selected.map(contract => historicalApi.buildQriHistoricalViewModel({
            history, selectedContract: contract, selectedTradingDate: previousDate }).snapshot);
            previous = state.viewMode === "aggregate"
                ? aggregationSnapshot(aggregationApi.buildQriHistoricalAggregation({ snapshots: previousSnapshots }))
                : previousSnapshots[0]; }
        const iv = state.viewMode === "single_contract" ? activeIvIndex(ivHistory) : null;
        const derived = decorate(snapshot, previous, iv, state.viewMode === "single_contract"
            ? selected[0] : null, date); return result("available", null, { ...base,
            identity, metadata, chartData, previousTradingDate: previousDate, top3: derived.top3,
            comparisonFacts: derived.facts, coverage: derived.coverage,
            ivCoverage: state.viewMode === "single_contract" ? derived.ivCoverage : {
                eligible: 0, observed: 0, missing: 0, reason: "aggregate_not_applicable" },
            quality: { complete: derived.coverage.notPublished === 0,
                previousObservationAvailable: previousDate !== null }, selectedRevision:
                state.viewMode === "single_contract" ? views[0].selection.activeVersionKey
                    : views.map(view => view.selection.activeVersionKey) });
    }
    return Object.freeze({ inventory, build });
});
