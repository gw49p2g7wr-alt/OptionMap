(function (root, factory) {
    const dates = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarDate.js") : root?.OptionMapCalendarDate;
    const api = factory(dates);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCalendarNavigationIntent = api;
})(typeof window !== "undefined" ? window : globalThis, function (dates) {
    "use strict";
    const available = value => ["available", "partial"].includes(value?.status) && Number(value.count) > 0;
    function resolve({ calendarDate, today, availability } = {}) {
        const relationToToday = dates.relation(calendarDate, today), historical = relationToToday === "historical";
        return Object.freeze({ selectedCalendarDate: calendarDate, relationToToday,
            destinations: Object.freeze({ scheduledEvents: ["available", "partial"].includes(
                availability?.events?.status), liveContext: relationToToday === "today",
                timeTravel: historical && available(availability?.qriTimeTravel),
                wallHistory: historical && available(availability?.wallHistory),
                participant: historical && available(availability?.participant) }),
            defaultDestination: "calendar_date_detail" });
    }
    return Object.freeze({ resolve });
});
