(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const dates = commonJs ? require("./calendarDate/calendarDate.js") : root?.OptionMapCalendarDate;
    const calendar = commonJs ? require("./marketCalendarHistory/readOnlyCalendarConsumer.js") :
        root?.OptionMapMarketCalendarReadOnlyConsumer;
    const api = factory(dates, calendar);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportFormalTradingDateAuthority = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (dates, calendar) {
    "use strict";

    const AUTHORITY_VERSION = 2;
    const SOURCE_ID = "jp-jpx-market-holidays";
    const EVENT_TYPE = "JPX_MARKET_HOLIDAY";
    const SCOPE = "JPX_cash_markets";
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); };
    const validInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value));

    function jstDate(value) {
        if (!validInstant(value)) return null;
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value))
            .map(part => [part.type, part.value]));
        const result = `${parts.year}-${parts.month}-${parts.day}`;
        return dates?.isValid?.(result) ? result : null;
    }

    function weekday(value) {
        const day = new Date(`${value}T00:00:00.000Z`).getUTCDay();
        return day !== 0 && day !== 6;
    }

    function unavailable(reason, calendarDate = null) {
        return freeze({ authorityVersion: AUTHORITY_VERSION, status: "unavailable", reason,
            calendarDate, previousValidTradingDate: null, formalTradingDate: null,
            nextValidTradingDate: null, sourceId: SOURCE_ID,
            authority: "formal_calendar_history_readonly" });
    }

    function holidayDates(events) {
        const holidays = new Set();
        const coveredYears = new Set();
        let sourceSeen = false;
        for (const event of events || []) {
            if (event?.sourceId !== SOURCE_ID) continue;
            sourceSeen = true;
            if (event?.logical?.eventType !== EVENT_TYPE || event.logical.scope !== SCOPE ||
                !dates?.isValid?.(event.logical.referencePeriod) ||
                event.calendarDateStart !== event.logical.referencePeriod ||
                event.calendarDateEnd !== event.logical.referencePeriod || event.validTo !== null) {
                return { valid: false, sourceSeen, holidays };
            }
            holidays.add(event.logical.referencePeriod);
            coveredYears.add(event.logical.referencePeriod.slice(0, 4));
        }
        return { valid: true, sourceSeen, holidays, coveredYears };
    }

    function resolveFromCalendar({ observedAt, calendarResult } = {}) {
        const calendarDate = jstDate(observedAt);
        if (!calendarDate) return unavailable("observation_time_invalid");
        if (calendarResult?.status !== "available" || !Array.isArray(calendarResult.events))
            return unavailable("calendar_authority_unavailable", calendarDate);
        const inventory = holidayDates(calendarResult.events);
        if (!inventory.valid || !inventory.sourceSeen)
            return unavailable("jpx_holiday_authority_unavailable", calendarDate);
        let candidate = calendarDate;
        for (let step = 0; step < 14; step += 1) {
            if (weekday(candidate) && !inventory.holidays.has(candidate)) {
                let previousValidTradingDate = dates.addDays(candidate, -1);
                let previousResolved = false;
                for (let previousStep = 0; previousStep < 31; previousStep += 1) {
                    if (weekday(previousValidTradingDate) &&
                        !inventory.holidays.has(previousValidTradingDate)) {
                        previousResolved = true;
                        break;
                    }
                    previousValidTradingDate = dates.addDays(previousValidTradingDate, -1);
                }
                let nextValidTradingDate = dates.addDays(candidate, 1);
                let nextResolved = false;
                for (let nextStep = 0; nextStep < 31; nextStep += 1) {
                    if (weekday(nextValidTradingDate) &&
                        !inventory.holidays.has(nextValidTradingDate)) {
                        nextResolved = true;
                        break;
                    }
                    nextValidTradingDate = dates.addDays(nextValidTradingDate, 1);
                }
                const authorityYearsCovered = [previousValidTradingDate, candidate,
                    nextValidTradingDate].every(value =>
                    inventory.coveredYears.has(value.slice(0, 4)));
                if (!previousResolved || !nextResolved || !authorityYearsCovered) return unavailable(
                    "adjacent_trading_date_resolution_exhausted", calendarDate);
                return freeze({ authorityVersion: AUTHORITY_VERSION, status: "available", reason: null,
                    calendarDate, previousValidTradingDate,
                    formalTradingDate: candidate, nextValidTradingDate,
                    sourceId: SOURCE_ID,
                    authority: "formal_calendar_history_readonly",
                    relation: candidate === calendarDate ? "current_trading_day" :
                        "previous_trading_day", calendarStatus: candidate === calendarDate ?
                        "open_day" : inventory.holidays.has(calendarDate) ? "jpx_holiday" : "weekend" });
            }
            candidate = dates.addDays(candidate, -1);
        }
        return unavailable("trading_date_resolution_exhausted", calendarDate);
    }

    async function resolve({ observedAt, indexedDB, keyRange = globalThis.IDBKeyRange,
        query = calendar?.query } = {}) {
        const calendarDate = jstDate(observedAt);
        if (!calendarDate || typeof query !== "function")
            return unavailable(calendarDate ? "calendar_authority_unavailable" :
                "observation_time_invalid", calendarDate);
        const year = Number(calendarDate.slice(0, 4));
        let result;
        try { result = await query({ indexedDB, keyRange,
            startDate: `${year - 1}-01-01`, endDate: `${year + 1}-12-31` }); }
        catch (_error) { return unavailable("calendar_authority_unavailable", calendarDate); }
        return resolveFromCalendar({ observedAt, calendarResult: result });
    }

    return Object.freeze({ AUTHORITY_VERSION, SOURCE_ID, EVENT_TYPE, SCOPE,
        jstDate, resolveFromCalendar, resolve });
});
