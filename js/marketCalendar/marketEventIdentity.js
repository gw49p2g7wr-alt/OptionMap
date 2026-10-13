(function (root, factory) {
    const taxonomy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./eventTaxonomy.js") : root?.OptionMapMarketEventTaxonomy;
    const api = factory(taxonomy);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventIdentity = api;
})(typeof window !== "undefined" ? window : globalThis, function (taxonomy) {
    "use strict";
    const component = value => typeof value === "string" && value.length > 0 && !value.includes("|");
    const JGB_MATURITIES = Object.freeze(["2Y", "5Y", "10Y", "20Y", "30Y", "40Y"]);
    const BOJ_PUBLICATIONS = Object.freeze({ BOJ_SUMMARY_OF_OPINIONS: Object.freeze(["summary_of_opinions", "summary"]),
        BOJ_OUTLOOK_REPORT: Object.freeze(["outlook_report", "basic_view"]), BOJ_MPM_MINUTES: Object.freeze(["meeting_minutes", "minutes"]),
        JP_CGPI: Object.freeze(["CGPI", "monthly_release"]) });
    function validateBojPublicationIdentity(eventType, value) {
        const type = Object.hasOwn(BOJ_PUBLICATIONS, eventType) ? BOJ_PUBLICATIONS[eventType] : null, cgpi = eventType === "JP_CGPI";
        const keys = ["sourceId", "authority", "family", "reportType", "publicationDate",
            ...(cgpi ? ["referencePeriod"] : ["meetingStartDate", "meetingEndDate"])];
        if (!type || !value || typeof value !== "object" || Array.isArray(value) ||
            Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k)) ||
            value.sourceId !== "jp-boj-calendar" || value.authority !== "BOJ" || value.family !== type[0] ||
            value.reportType !== type[1] || !validAuctionDate(value.publicationDate)) return false;
        return cgpi ? /^20\d{2}-(0[1-9]|1[0-2])$/.test(value.referencePeriod) &&
            value.referencePeriod < value.publicationDate.slice(0, 7) :
            validAuctionDate(value.meetingStartDate) && validAuctionDate(value.meetingEndDate) &&
            value.meetingStartDate <= value.meetingEndDate && value.meetingEndDate <= value.publicationDate;
    }
    function validateSpeechIdentity(value) {
        const keys = ["sourceId", "family", "speakerRole", "speakerId", "eventDate", "officialEventComponent"];
        return !!value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)) &&
            value.sourceId === "jp-boj-calendar" && value.family === "speech_remarks" &&
            ["governor", "deputy_governor", "policy_board_member"].includes(value.speakerRole) &&
            typeof value.speakerId === "string" && /^[一-龯ぁ-んァ-ヶ]{1,30}$/.test(value.speakerId) &&
            validAuctionDate(value.eventDate) && component(value.officialEventComponent) &&
            value.officialEventComponent.length <= 200 &&
            /^(?:venue:.+|publication:ko\d{6}[a-z])$/.test(value.officialEventComponent);
    }
    function validAuctionDate(value) {
        if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
        const time = Date.parse(`${value}T00:00:00.000Z`);
        return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
    }
    function validateAuctionIdentity(value) {
        const fields = ["authority", "eventType", "instrumentClass", "maturity", "auctionDate"];
        return !!value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)) &&
            value.authority === "MOF" && value.eventType === "JP_JGB_AUCTION" &&
            value.instrumentClass === "normal_fixed_rate_jgb" && JGB_MATURITIES.includes(value.maturity) &&
            validAuctionDate(value.auctionDate);
    }
    function eventKeyFor(value) {
        if (Object.hasOwn(BOJ_PUBLICATIONS, value?.eventType)) {
            if (value.jurisdiction !== "JP" || value.authority !== "BOJ" ||
                !validateBojPublicationIdentity(value.eventType, value.bojPublicationIdentity) ||
                ["referencePeriod", "edition", "scope", "speechIdentity", "auctionIdentity"].some(k => Object.hasOwn(value, k)) ||
                value.authorityEventId != null) throw new TypeError("boj_publication_identity_invalid");
            const p = value.bojPublicationIdentity;
            return ["JP", "BOJ", value.eventType, p.sourceId, p.family, p.reportType,
                ...(value.eventType === "JP_CGPI" ? [p.referencePeriod] : [p.meetingStartDate, p.meetingEndDate]),
                p.publicationDate].join("|");
        }
        if (value?.bojPublicationIdentity !== undefined) throw new TypeError("boj_publication_wrong_event_type");
        if (value?.eventType === "BOJ_SPEECH") {
            if (value.jurisdiction !== "JP" || value.authority !== "BOJ" ||
                !validateSpeechIdentity(value.speechIdentity) || !taxonomy?.isEventType(value.eventType) ||
                ["referencePeriod", "edition", "scope"].some(k => Object.hasOwn(value, k)))
                throw new TypeError("boj_speech_identity_invalid");
            const s = value.speechIdentity;
            return ["JP", "BOJ", "BOJ_SPEECH", s.sourceId, s.family, s.speakerRole,
                s.speakerId, s.eventDate, s.officialEventComponent].join("|");
        }
        if (value?.speechIdentity !== undefined) throw new TypeError("speech_identity_for_wrong_event_type");
        if (value?.eventType === "JP_JGB_AUCTION") {
            if (!taxonomy?.isEventType(value.eventType) || taxonomy.EVENT_TYPES[value.eventType].jurisdiction !== "JP" ||
                value.jurisdiction !== "JP" || value.authority !== "MOF" ||
                !validateAuctionIdentity(value.auctionIdentity) ||
                ["referencePeriod", "edition", "scope"].some(key => Object.hasOwn(value, key)) ||
                value.authorityEventId != null) throw new TypeError("jgb_identity_invalid");
            const a = value.auctionIdentity;
            return ["JP", "MOF", "JP_JGB_AUCTION", a.instrumentClass, a.maturity, a.auctionDate].join("|");
        }
        if (value?.auctionIdentity !== undefined) throw new TypeError("logical_event_identity_invalid");
        const parts = [value?.jurisdiction, value?.authority, value?.eventType,
            value?.referencePeriod, value?.edition, value?.scope];
        if (!parts.every(component) || !taxonomy?.isEventType(value.eventType) ||
            taxonomy.EVENT_TYPES[value.eventType].jurisdiction !== value.jurisdiction)
            throw new TypeError("logical_event_identity_invalid");
        return parts.join("|");
    }
    function create(value) {
        const eventKey = eventKeyFor(value);
        if (Object.hasOwn(BOJ_PUBLICATIONS, value.eventType)) return Object.freeze({ eventKey,
            jurisdiction: "JP", authority: "BOJ", eventType: value.eventType,
            bojPublicationIdentity: Object.freeze({ ...value.bojPublicationIdentity }), authorityEventId: null });
        if (value.eventType === "BOJ_SPEECH") return Object.freeze({ eventKey,
            jurisdiction: "JP", authority: "BOJ", eventType: "BOJ_SPEECH",
            speechIdentity: Object.freeze({ ...value.speechIdentity }), authorityEventId: null });
        if (value.eventType === "JP_JGB_AUCTION") return Object.freeze({ eventKey,
            jurisdiction: "JP", authority: "MOF", eventType: "JP_JGB_AUCTION",
            auctionIdentity: Object.freeze({ ...value.auctionIdentity }), authorityEventId: null });
        return Object.freeze({ eventKey, jurisdiction: value.jurisdiction, authority: value.authority,
            eventType: value.eventType, referencePeriod: value.referencePeriod, edition: value.edition,
            scope: value.scope, authorityEventId: value.authorityEventId || null });
    }
    return Object.freeze({ eventKeyFor, create, JGB_MATURITIES, validAuctionDate, validateAuctionIdentity,
        validateSpeechIdentity, BOJ_PUBLICATIONS, validateBojPublicationIdentity });
});
