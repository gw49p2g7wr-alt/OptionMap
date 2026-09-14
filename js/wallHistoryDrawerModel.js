(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapWallHistoryDrawerModel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const MODEL_VERSION = 1;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function build(wall, unavailableMetrics = []) {
        if (!wall?.wallIdentity || !Array.isArray(wall.observations)) return null;
        const observations = wall.observations.map(item => ({ tradingDate: item.tradingDate,
            state: item.state, openInterest: item.openInterest, previousObservationDelta:
            item.previousObservationDelta, rank: item.rank, rankChange: item.rankChange,
            shrinkState: item.shrinkState, zeroState: item.zeroState,
            ivStatus: item.iv?.status || "missing", iv: item.iv?.value ?? null,
            ivChange: item.ivChange, referenceStatus: item.reference?.status || "missing",
            referencePrice: item.reference?.value ?? null, priceDistance: item.priceDistance,
            sourceRevision: item.sourceRevision || null, sourceSignature: item.sourceSignature || null }));
        const gaps = (wall.gapEvents || []).map(item => clone(item));
        const latestObserved = observations.filter(item => item.state === "observed").at(-1) || null;
        const referenceVisible = Number(wall.coverage?.referenceObservedCount) > 0;
        return freeze({ modelVersion: MODEL_VERSION, wallIdentity: wall.wallIdentity,
            contract: wall.contract, strike: wall.strike, side: wall.side,
            firstSeenDate: wall.firstSeenDate, maxOi: wall.maxOi, maxOiDate: wall.maxOiDate,
            latestObserved: clone(latestObserved), observations, gaps,
            coverage: clone(wall.coverage || {}), quality: clone(wall.quality || {}),
            reference: referenceVisible ? { visible: true, observations: observations.filter(item =>
                item.referenceStatus === "observed").map(item => ({ tradingDate: item.tradingDate,
                price: item.referencePrice, priceDistance: item.priceDistance })) } : null,
            unavailableFacts: ["volume", "optionPrice", "settlement", "bid", "ask"].map(name => ({
                name, status: unavailableMetrics.includes(name) ? "not_saved" : "not_saved",
                note: "未保存・推測なし" })) });
    }
    return Object.freeze({ MODEL_VERSION, build });
});
