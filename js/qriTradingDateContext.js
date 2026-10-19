(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriTradingDateContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTEXT_VERSION = 1;
    const CALENDAR_AUTHORITY = "formal_calendar_history_readonly";
    const SESSION_AUTHORITY = "nikkei225_session_v1";
    const AUTHORITY_SOURCE = `${CALENDAR_AUTHORITY}+${SESSION_AUTHORITY}`;
    const datePattern = /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    } Object.values(value).forEach(freeze); return Object.freeze(value); };

    function validDate(value) {
        if (typeof value !== "string" || !datePattern.test(value)) return false;
        return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    }

    function jstParts(value) {
        if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
            minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
        const part = type => parts.find(item => item.type === type)?.value;
        const calendarDate = `${part("year")}-${part("month")}-${part("day")}`;
        const minute = Number(part("hour")) * 60 + Number(part("minute"));
        return validDate(calendarDate) && Number.isFinite(minute)
            ? { calendarDate, minute } : null;
    }

    function previousDate(value) {
        const date = new Date(`${value}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() - 1);
        return date.toISOString().slice(0, 10);
    }

    function sessionOf(value) {
        const parts = jstParts(value);
        if (!parts) return null;
        if (parts.minute >= 8 * 60 + 45 && parts.minute <= 15 * 60 + 45) {
            return freeze({ kind: "day", key: parts.calendarDate,
                calendarDate: parts.calendarDate });
        }
        if (parts.minute >= 17 * 60) return freeze({ kind: "night", key: parts.calendarDate,
            calendarDate: parts.calendarDate });
        if (parts.minute <= 6 * 60) return freeze({ kind: "night",
            key: previousDate(parts.calendarDate), calendarDate: parts.calendarDate });
        return freeze({ kind: "closed", key: parts.calendarDate,
            calendarDate: parts.calendarDate });
    }

    function resolve({ observedAt, payloadTradingDate, calendarAuthority } = {}) {
        const session = sessionOf(observedAt);
        const calendarDate = session?.calendarDate || null;
        const base = { contextVersion: CONTEXT_VERSION, calendarDate,
            sessionClass: session?.kind || null, sessionKey: session?.key || null,
            sessionTradingDate: null, payloadTradingDate: validDate(payloadTradingDate)
                ? payloadTradingDate : null, expectedTradingDate: null,
            relation: "date_context_unresolved", authoritySource: AUTHORITY_SOURCE,
            valid: false, reason: "date_context_unresolved" };
        const authorityValid = calendarAuthority?.status === "available" &&
            calendarAuthority.authority === CALENDAR_AUTHORITY &&
            validDate(calendarAuthority.calendarDate) &&
            validDate(calendarAuthority.previousValidTradingDate) &&
            validDate(calendarAuthority.formalTradingDate) &&
            validDate(calendarAuthority.nextValidTradingDate) &&
            calendarAuthority.calendarDate === calendarDate;
        if (!session || !base.payloadTradingDate || !authorityValid) return freeze(base);

        let expectedTradingDate = calendarAuthority.formalTradingDate;
        if (session.kind === "night") {
            if (session.key === calendarAuthority.formalTradingDate) {
                expectedTradingDate = calendarAuthority.nextValidTradingDate;
            } else if (session.key !== calendarAuthority.previousValidTradingDate) {
                return freeze(base);
            }
        }
        const common = { ...base, sessionTradingDate: expectedTradingDate,
            expectedTradingDate };
        if (base.payloadTradingDate === expectedTradingDate) {
            return freeze({ ...common, relation: session.kind === "night"
                ? "night_session_next_trading_date" : "same_trading_date",
            valid: true, reason: null });
        }
        if (base.payloadTradingDate < expectedTradingDate) {
            return freeze({ ...common, relation: "historical_reference",
                reason: "source_not_updated" });
        }
        return freeze({ ...common, relation: "date_mismatch", reason: "date_mismatch" });
    }

    return Object.freeze({ CONTEXT_VERSION, CALENDAR_AUTHORITY, SESSION_AUTHORITY,
        AUTHORITY_SOURCE, sessionOf, resolve });
});
