(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningV5SupplyDemandLane = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const LANE_VERSION = 1;
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function sha256(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function unavailable(reason) { return freeze({ laneVersion: LANE_VERSION, available: false,
        status: "unavailable", reason, referenceOnly: false }); }
    async function buildMorningV5SupplyDemandLane(input = {}) {
        const qri = input.qri, weekly = input.weekly, overall = input.overall;
        if (qri?.available !== true || qri.origin !== "formal_live" || qri.referenceOnly === true ||
            qri.usingFallback === true || qri.restored === true || qri.identity?.verified !== true ||
            !text(qri.identity.contract) || !text(qri.identity.tradingDate) ||
            !text(qri.identity.canonicalVersionKey)) return unavailable("qri_not_formal");
        if (weekly?.available !== true || weekly.origin !== "formal_history" ||
            weekly.formalApplied !== true || weekly.usingFallback === true ||
            weekly.identityVerified !== true || !text(weekly.versionKey))
            return unavailable("weekly_not_formal");
        if (overall?.origin !== "formal_live" || overall.formalApplied !== true ||
            overall.referenceOnly === true || overall.superseded === true ||
            overall.inputIdentity?.verified !== true || !text(overall.logicVersion) ||
            !finite(overall.result?.direction) || !finite(overall.result?.confidence) ||
            overall.componentIdentities?.option?.versionKey !== qri.identity.canonicalVersionKey ||
            overall.componentIdentities?.weekly?.versionKey !== weekly.versionKey)
            return unavailable("overall_binding_invalid");
        const formalScopeId = `morning-v5-formal|${qri.identity.contract}|${qri.identity.tradingDate}`;
        const identity = { qriVersionKey: qri.identity.canonicalVersionKey,
            weeklyVersionKey: weekly.versionKey, overallVersionKey: overall.inputIdentity.versionKey,
            logicVersion: overall.logicVersion };
        const lane = { laneVersion: LANE_VERSION, available: true, status: "available", reason: null,
            referenceOnly: false, formalScopeId, optionContract: qri.identity.contract,
            formalTradingDate: qri.identity.tradingDate, direction: overall.result.direction,
            directionLabel: text(overall.result.directionLabel), confidence: overall.result.confidence,
            identity, sourceFingerprint: `morning-v5-formal|sha256:${await sha256(identity)}` };
        return freeze(lane);
    }
    function compareMorningV5SupplyDemandLanes(baseline, current) {
        if (baseline?.available !== true || current?.available !== true)
            return freeze({ available: false, reason: "lane_unavailable" });
        if (baseline.formalScopeId !== current.formalScopeId ||
            baseline.optionContract !== current.optionContract ||
            baseline.formalTradingDate !== current.formalTradingDate ||
            baseline.identity?.logicVersion !== current.identity?.logicVersion)
            return freeze({ available: false, reason: "formal_scope_mismatch" });
        return freeze({ available: true, reason: null, baselineDirection: baseline.direction,
            currentDirection: current.direction, directionDelta: current.direction - baseline.direction,
            baselineConfidence: baseline.confidence, currentConfidence: current.confidence });
    }
    return freeze({ LANE_VERSION, buildMorningV5SupplyDemandLane, compareMorningV5SupplyDemandLanes });
});
