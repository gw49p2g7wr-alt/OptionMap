(function (root, factory) {
    const dates = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarDate.js") : root?.OptionMapCalendarDate;
    const api = factory(dates);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCalendarDateNavigation = api;
})(typeof window !== "undefined" ? window : globalThis, function (dates) {
    "use strict";
    function buildMonth({ year, month, weekStartsOn = "monday", displayTimeZone = "Asia/Tokyo" } = {}) {
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 ||
            !["monday", "sunday"].includes(weekStartsOn)) throw new TypeError("calendar_month_invalid");
        const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
        if (!dates.isValid(first)) throw new TypeError("calendar_month_invalid");
        const weekday = new Date(`${first}T00:00:00.000Z`).getUTCDay();
        const leading = weekStartsOn === "monday" ? (weekday + 6) % 7 : weekday;
        const start = dates.addDays(first, -leading), cells = [];
        for (let index = 0; index < 42; index += 1) { const calendarDate = dates.addDays(start, index);
            cells.push(Object.freeze({ ...dates.create(calendarDate, displayTimeZone),
                inMonth: calendarDate.slice(0, 7) === first.slice(0, 7), selectable: true })); }
        return Object.freeze({ year, month, weekStartsOn, cells: Object.freeze(cells) });
    }
    return Object.freeze({ buildMonth });
});
