(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapWallHistoryContract = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const WALL_SOURCE = "qri-nikkei225-option";
    const OBSERVATION_STATES = Object.freeze(["observed", "notPublished", "missing"]);
    const GAP_STATE = "gap";
    const RANK_METHOD = "competition_rank_oi_desc_strike_asc";
    const DATE_SEMANTICS = Object.freeze({
        observationDate: "qri_trading_date",
        previous: "previous_saved_observation_same_wall_identity",
        gap: "missing_weekday_candidate_not_exchange_calendar",
        firstSeen: "first_published_observation_in_available_history",
        rollover: "hard_identity_boundary"
    });
    const DERIVATION_SEMANTICS = Object.freeze({
        delta: "current_minus_previous_published_observation",
        rankChange: "current_rank_minus_previous_rank_negative_is_improvement",
        max: "maximum_published_oi_earliest_date_wins_tie",
        ivChange: "current_minus_previous_available_iv",
        priceDistance: "strike_minus_exactly_mapped_reference_price",
        disappearance: "only_published_zero_is_zero_confirmed",
        nonDisappearance: "notPublished_missing_gap_are_unknown_not_disappeared"
    });

    function validContract(value) {
        return /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
    }
    function validSide(value) { return value === "call" || value === "put"; }
    function canonicalStrike(value) {
        return Number.isFinite(value) && value > 0 ? String(value) : null;
    }
    function wallIdentity(contract, strike, side) {
        const normalizedStrike = canonicalStrike(strike);
        return validContract(contract) && normalizedStrike && validSide(side)
            ? `${WALL_SOURCE}|${contract}|${normalizedStrike}|${side}` : null;
    }
    function observationIdentity(wallId, tradingDate, sourceRevision) {
        return wallId && /^20\d{2}-\d{2}-\d{2}$/.test(tradingDate || "") &&
            typeof sourceRevision === "string" && sourceRevision.length
            ? `${wallId}|${tradingDate}|${sourceRevision}` : null;
    }

    return Object.freeze({ CONTRACT_VERSION, WALL_SOURCE, OBSERVATION_STATES, GAP_STATE,
        RANK_METHOD, DATE_SEMANTICS, DERIVATION_SEMANTICS, validContract, validSide, canonicalStrike,
        wallIdentity, observationIdentity });
});
