(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventSchedule = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const time = value => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value || "");
    function formatter(timeZone) { try { return new Intl.DateTimeFormat("en-CA", { timeZone,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        second: "2-digit", hourCycle: "h23" }); } catch (_error) { return null; } }
    function partsAt(epoch, timeZone) { const format = formatter(timeZone); if (!format) return null;
        const values = Object.fromEntries(format.formatToParts(new Date(epoch))
            .filter(part => part.type !== "literal").map(part => [part.type, part.value]));
        return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
            hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }; }
    function resolveWallTime({ localDate, localTime, timeZone }) {
        if (!date(localDate) || !time(localTime) || !formatter(timeZone)) return null;
        const [year, month, day] = localDate.split("-").map(Number), values = localTime.split(":").map(Number);
        const target = Date.UTC(year, month - 1, day, values[0], values[1], values[2] || 0);
        let candidate = target;
        for (let count = 0; count < 4; count += 1) { const parts = partsAt(candidate, timeZone);
            const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
            candidate += target - represented; }
        const checked = partsAt(candidate, timeZone);
        if (!checked || checked.year !== year || checked.month !== month || checked.day !== day ||
            checked.hour !== values[0] || checked.minute !== values[1] || checked.second !== (values[2] || 0)) return null;
        const offsetMinutes = Math.round((Date.UTC(checked.year, checked.month - 1, checked.day,
            checked.hour, checked.minute, checked.second) - candidate) / 60000);
        const sign = offsetMinutes >= 0 ? "+" : "-", absolute = Math.abs(offsetMinutes);
        return Object.freeze({ instant: new Date(candidate).toISOString(),
            resolvedOffset: `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:` +
                String(absolute % 60).padStart(2, "0") });
    }
    function canonicalize(source) {
        if (!source || !["instant", "date_only", "all_day", "date_range"].includes(source.kind) ||
            !date(source.startDate) || !formatter(source.timeZone)) throw new TypeError("schedule_invalid");
        if (source.kind === "instant") { const resolved = resolveWallTime({ localDate: source.startDate,
            localTime: source.startTime, timeZone: source.timeZone });
            if (!resolved) throw new TypeError("wall_time_unresolvable");
            return Object.freeze({ kind: source.kind, canonicalStart: resolved.instant, canonicalEnd: null,
                sourceLocal: Object.freeze({ startDate: source.startDate, startTime: source.startTime,
                    endDate: null, endTime: null, timeZone: source.timeZone,
                    resolvedOffset: resolved.resolvedOffset }), precision: "exact" }); }
        if (source.startTime !== null) throw new TypeError("false_time_for_date_event");
        if (source.kind === "date_range" && (!date(source.endDate) || source.endDate < source.startDate))
            throw new TypeError("date_range_invalid");
        return Object.freeze({ kind: source.kind, canonicalStart: null, canonicalEnd: null,
            sourceLocal: Object.freeze({ startDate: source.startDate, startTime: null,
                endDate: source.kind === "date_range" ? source.endDate : null, endTime: null,
                timeZone: source.timeZone, resolvedOffset: null }),
            precision: source.kind === "date_range" ? "range" : source.kind });
    }
    function calendarDateFor(schedule, displayTimeZone = "Asia/Tokyo") {
        if (schedule?.kind === "instant") { const parts = partsAt(Date.parse(schedule.canonicalStart), displayTimeZone);
            if (!parts) throw new TypeError("display_timezone_invalid"); return `${parts.year}-` +
                `${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`; }
        return schedule?.sourceLocal?.startDate || null;
    }
    function calendarDateIntervalFor(schedule, displayTimeZone = "Asia/Tokyo") {
        const start = calendarDateFor(schedule, displayTimeZone);
        if (!date(start)) throw new TypeError("schedule_calendar_date_invalid");
        const end = schedule?.kind === "date_range" ? schedule.sourceLocal?.endDate : start;
        if (!date(end) || end < start) throw new TypeError("schedule_calendar_interval_invalid");
        return Object.freeze({ start, end });
    }
    return Object.freeze({ resolveWallTime, canonicalize, calendarDateFor, calendarDateIntervalFor });
});
