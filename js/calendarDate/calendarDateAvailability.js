(function (root, factory) {
    const dates = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarDate.js") : root?.OptionMapCalendarDate;
    const api = factory(dates);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCalendarDateAvailability = api;
})(typeof window !== "undefined" ? window : globalThis, function (dates) {
    "use strict";
    const DOMAINS = Object.freeze(["events", "qriTimeTravel", "wallHistory", "participant"]);
    const STATUSES = Object.freeze(["unknown", "available", "partial", "unavailable", "invalid"]);
    function projection(calendarDate, values = {}) {
        if (!dates.isValid(calendarDate)) throw new TypeError("calendar_date_invalid");
        const availability = {};
        for (const domain of DOMAINS) { const input = values[domain] || { status: "unknown", count: null };
            if (!STATUSES.includes(input.status) || input.count !== null &&
                (!Number.isInteger(input.count) || input.count < 0)) throw new TypeError("availability_invalid");
            availability[domain] = Object.freeze({ status: input.status, count: input.count,
                ...(Number.isInteger(input.criticalCount) ? { criticalCount: input.criticalCount } : {}) }); }
        return Object.freeze({ calendarDate, selectable: true, availability: Object.freeze(availability) });
    }
    return Object.freeze({ DOMAINS, STATUSES, projection });
});
