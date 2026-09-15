(function (root, factory) {
    const taxonomy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./eventTaxonomy.js") : root?.OptionMapMarketEventTaxonomy;
    const api = factory(taxonomy);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventIdentity = api;
})(typeof window !== "undefined" ? window : globalThis, function (taxonomy) {
    "use strict";
    const component = value => typeof value === "string" && value.length > 0 && !value.includes("|");
    function eventKeyFor(value) {
        const parts = [value?.jurisdiction, value?.authority, value?.eventType,
            value?.referencePeriod, value?.edition, value?.scope];
        if (!parts.every(component) || !taxonomy?.isEventType(value.eventType) ||
            taxonomy.EVENT_TYPES[value.eventType].jurisdiction !== value.jurisdiction)
            throw new TypeError("logical_event_identity_invalid");
        return parts.join("|");
    }
    function create(value) {
        const eventKey = eventKeyFor(value);
        return Object.freeze({ eventKey, jurisdiction: value.jurisdiction, authority: value.authority,
            eventType: value.eventType, referencePeriod: value.referencePeriod, edition: value.edition,
            scope: value.scope, authorityEventId: value.authorityEventId || null });
    }
    return Object.freeze({ eventKeyFor, create });
});
