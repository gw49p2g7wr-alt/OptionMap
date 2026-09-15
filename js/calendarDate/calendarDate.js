(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCalendarDate = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    function isValid(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }
    function create(calendarDate, displayTimeZone = "Asia/Tokyo") {
        if (!isValid(calendarDate)) throw new TypeError("calendar_date_invalid");
        try { new Intl.DateTimeFormat("en", { timeZone: displayTimeZone }).format(0); }
        catch (_error) { throw new TypeError("display_timezone_invalid"); }
        return Object.freeze({ calendarDate, calendarSystem: "iso8601", displayTimeZone });
    }
    function addDays(value, amount) {
        if (!isValid(value) || !Number.isInteger(amount)) throw new TypeError("calendar_date_operation_invalid");
        const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + amount);
        return date.toISOString().slice(0, 10);
    }
    function relation(value, today) {
        if (!isValid(value) || !isValid(today)) throw new TypeError("calendar_date_invalid");
        return value < today ? "historical" : value > today ? "future" : "today";
    }
    return Object.freeze({ isValid, create, addDays, relation });
});
