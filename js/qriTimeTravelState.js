(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriTimeTravelState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function create(patch = {}) { return freeze({ mode: "historical", viewMode: "single_contract",
        selectedTradingDate: null, selectedContract: null, selectedContracts: [],
        selectedRevision: { policy: "active", versionKey: null }, generation: 0, ...clone(patch) }); }
    function transition(state, patch = {}) { return create({ ...clone(state), ...clone(patch),
        generation: Number(state?.generation || 0) + 1 }); }
    function returnLive(state) { return freeze({ ...clone(state), mode: "live",
        generation: Number(state?.generation || 0) + 1 }); }
    return Object.freeze({ create, transition, returnLive });
});
