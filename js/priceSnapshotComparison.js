(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const snapshotApi = commonJs ? require("./priceSnapshot.js") : root?.OptionMapPriceSnapshot;
    const api = factory(snapshotApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapPriceSnapshotComparison = api;
})(typeof window !== "undefined" ? window : globalThis, function (snapshotApi) {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function unavailable(reason, current = null, details = {}) {
        return { available: false, reason, current: clone(current), previous: null,
            elapsedMs: null, priceDelta: null, percentChange: null, direction: "unavailable",
            directionLabel: "比較不可", arrow: "--", ...details };
    }

    function snapshotReference(snapshot) {
        return snapshot ? { snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt,
            price: snapshot.price, contract: snapshot.contract, source: snapshot.source,
            mode: snapshot.mode } : null;
    }

    async function createPriceSnapshotComparison(records) {
        if (!Array.isArray(records)) return unavailable("history_invalid");
        const validations = await Promise.all(records.map(record => snapshotApi.verifySnapshot(record)));
        const invalidIndex = validations.findIndex(validation => !validation.valid);
        if (invalidIndex >= 0) return unavailable("invalid_snapshot", null,
            { invalidSnapshotId: records[invalidIndex]?.snapshotId || null,
                validationErrors: clone(validations[invalidIndex].errors || []) });

        const latest = snapshotApi.latestSnapshot(records);
        if (!latest) return unavailable("current_snapshot_unavailable");
        const current = snapshotReference(latest);
        const previousResult = snapshotApi.previousComparableSnapshot(records, latest);
        if (!previousResult.available) {
            const earlier = records.filter(record => record.snapshotId !== latest.snapshotId &&
                record.observedAt < latest.observedAt);
            const rollover = latest.contract && earlier.length > 0 &&
                earlier.every(record => record.contract !== latest.contract);
            return unavailable(rollover ? "contract_mismatch" : previousResult.reason, current,
                rollover ? { boundary: "rollover_boundary" } : {});
        }

        const compared = snapshotApi.compareSnapshots(previousResult.snapshot, latest);
        if (!compared.available) return unavailable(compared.reason, current,
            compared.boundary ? { boundary: compared.boundary } : {});
        const direction = compared.delta > 0 ? "up" : compared.delta < 0 ? "down" : "neutral";
        return { available: true, reason: null, current,
            previous: snapshotReference(previousResult.snapshot), elapsedMs: compared.elapsedMs,
            priceDelta: compared.delta, percentChange: compared.percentChange, direction,
            directionLabel: direction === "up" ? "上昇" : direction === "down" ? "下落" : "横ばい",
            arrow: direction === "up" ? "↑" : direction === "down" ? "↓" : "→" };
    }

    return Object.freeze({ createPriceSnapshotComparison });
});
