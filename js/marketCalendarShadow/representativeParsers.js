(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarRepresentativeParsers = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const MONTHS = Object.freeze({ January: 1, February: 2, March: 3, April: 4, May: 5,
        June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 });
    const pad = value => String(value).padStart(2, "0");
    const strip = value => String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const local = (kind, startDate, startTime, timeZone, endDate = null) => ({ kind, startDate,
        startTime, endDate, endTime: null, timeZone, precision: kind === "instant" ? "exact"
            : kind === "date_range" ? "range" : kind });
    function record(context, values) { return { sourceId: context.sourceId, authorityEventId: null,
        edition: values.edition || "initial", sourceStatus: values.sourceStatus || "scheduled",
        sourcePublishedAt: context.sourcePublishedAt || null, sourceUpdatedAt: context.sourceUpdatedAt || null,
        sourceUrl: context.sourceUrl, fetchedAt: context.fetchedAt, parserId: context.parserId,
        parserVersion: context.parserVersion, rawContentHash: context.rawContentHash, ...values }; }
    function parseBoj(html, context) {
        const diagnostics = [], records = [];
        const meeting = html.match(/id="p02"[\s\S]*?<p>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日[^、]*、\s*(\d{1,2})日/);
        if (!meeting) diagnostics.push("boJ_meeting_schedule_not_found");
        else { const year = Number(meeting[1]), month = Number(meeting[2]), start = Number(meeting[3]), end = Number(meeting[4]);
            const period = `${year}-${pad(month)}-meeting`, startDate = `${year}-${pad(month)}-${pad(start)}`,
                endDate = `${year}-${pad(month)}-${pad(end)}`;
            records.push(record(context, { eventType: "BOJ_MPM", sourceTitle: "金融政策決定会合",
                titleJa: "日銀金融政策決定会合", titleEn: "BOJ Monetary Policy Meeting",
                referencePeriod: period, scope: "national", sourceLocalSchedule:
                    local("date_range", startDate, null, "Asia/Tokyo", endDate) }));
            records.push(record(context, { eventType: "BOJ_POLICY_DECISION", sourceTitle: "金融政策決定会合の決定内容",
                titleJa: "日銀政策発表", titleEn: "BOJ Policy Decision", referencePeriod: period,
                scope: "national", sourceLocalSchedule: local("date_only", endDate, null, "Asia/Tokyo") })); }
        const conference = html.match(/id="p03"[\s\S]*?<p>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日[^\d]+(\d{1,2}):(\d{2})/);
        if (!conference) diagnostics.push("boJ_press_conference_not_found");
        else { const date = `${conference[1]}-${pad(conference[2])}-${pad(conference[3])}`;
            records.push(record(context, { eventType: "BOJ_GOVERNOR_PRESS_CONFERENCE",
                sourceTitle: "総裁定例記者会見", titleJa: "日銀総裁会見",
                titleEn: "BOJ Governor Press Conference", referencePeriod: `${conference[1]}-${pad(conference[2])}-meeting`,
                scope: "national", sourceLocalSchedule: local("instant", date,
                    `${pad(conference[4])}:${conference[5]}`, "Asia/Tokyo") })); }
        return { records, diagnostics };
    }
    function parseFed(html, context) {
        const year = Number(context.fetchedAt.slice(0, 4)), anchor = html.indexOf(`${year} FOMC Meetings`);
        if (anchor < 0) return { records: [], diagnostics: ["fed_current_year_not_found"] };
        const section = html.slice(anchor, html.indexOf("panel-footer", anchor) + 200), records = [];
        const pattern = /fomc-meeting__month[^>]*><strong>([A-Za-z]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)/g;
        for (const match of section.matchAll(pattern)) { const month = MONTHS[match[1]], days = match[2]
            .replace(/\*/g, "").trim().split("-").map(Number);
            if (!month || days.some(value => !Number.isInteger(value))) continue;
            const startDate = `${year}-${pad(month)}-${pad(days[0])}`, endDate = `${year}-${pad(month)}-${pad(days.at(-1))}`;
            const referencePeriod = `${year}-${pad(month)}-meeting`;
            records.push(record(context, { eventType: "US_FOMC_MEETING", sourceTitle: "FOMC Meeting",
                titleJa: "FOMC会合", titleEn: "FOMC Meeting", referencePeriod, edition: "regular",
                scope: "federal", sourceLocalSchedule: local("date_range", startDate, null,
                    "America/New_York", endDate) }));
            records.push(record(context, { eventType: "US_FOMC_POLICY_DECISION", sourceTitle: "FOMC Policy Statement",
                titleJa: "FOMC政策発表", titleEn: "FOMC Policy Decision", referencePeriod, edition: "regular",
                scope: "federal", sourceLocalSchedule: local("instant", endDate, "14:00", "America/New_York") }));
            records.push(record(context, { eventType: "US_FED_CHAIR_PRESS_CONFERENCE", sourceTitle: "FOMC Press Conference",
                titleJa: "FRB議長会見", titleEn: "Federal Reserve Chair Press Conference", referencePeriod,
                edition: "regular", scope: "federal", sourceLocalSchedule:
                    local("instant", endDate, "14:30", "America/New_York") })); }
        return { records, diagnostics: records.length ? [] : ["fed_meetings_not_parsed"] };
    }
    const BLS_TYPES = Object.freeze({ "Consumer Price Index": "US_CPI", "Producer Price Index": "US_PPI",
        "Employment Situation": "US_EMPLOYMENT_SITUATION", "Job Openings and Labor Turnover Survey": "US_JOLTS" });
    function parseBls(html, context) {
        const records = [], diagnostics = [];
        const heading = html.match(/<h1[^>]*>\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\s*<\/h1>/i);
        if (!heading) return { records: [], diagnostics: ["bls_month_heading_not_found"] };
        const calendarMonth = MONTHS[heading[1][0].toUpperCase() + heading[1].slice(1).toLowerCase()],
            calendarYear = Number(heading[2]);
        for (const cell of html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)) {
            const id = cell[1].match(/\bid=["']d(\d{2})(\d{2})["']/i);
            if (!id || Number(id[1]) !== calendarMonth) continue;
            for (const paragraph of cell[2].matchAll(/<p(?![^>]*class=["']day["'])[^>]*>([\s\S]*?)<\/p>/gi)) {
                const titleMatch = paragraph[1].match(/<strong[^>]*>([\s\S]*?)<\/strong>/i),
                    kind = titleMatch && Object.entries(BLS_TYPES).find(([label]) => strip(titleMatch[1]) === label);
                if (!kind) continue;
                const body = strip(paragraph[1].replace(titleMatch[0], " ")),
                    timeMatch = body.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i),
                    periodText = body.replace(timeMatch?.[0] || "", "").trim(),
                    period = periodText.match(/^((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})$/i);
                if (!timeMatch || !period) { diagnostics.push(`bls_release_incomplete:${kind[1]}`); continue; }
            let hour = Number(timeMatch[1]); if (timeMatch[3].toUpperCase() === "PM" && hour < 12) hour += 12;
            if (timeMatch[3].toUpperCase() === "AM" && hour === 12) hour = 0;
            const periodParts = period[1].split(" "), periodMonth = MONTHS[periodParts[0][0].toUpperCase() + periodParts[0].slice(1).toLowerCase()];
            records.push(record(context, { eventType: kind[1], sourceTitle: kind[0], titleJa: kind[0],
                titleEn: kind[0], referencePeriod: `${periodParts[1]}-${pad(periodMonth)}`, scope: "national",
                sourceLocalSchedule: local("instant", `${calendarYear}-${pad(calendarMonth)}-${id[2]}`,
                    `${pad(hour)}:${timeMatch[2]}`, "America/New_York") })); } }
        return { records, diagnostics: records.length ? diagnostics : diagnostics.length ? diagnostics
            : ["bls_release_rows_not_parsed"] };
    }
    function discoverJpxWorkbook(html, year, baseUrl) {
        const match = html.match(new RegExp(`href="([^"]*${year}_indexfutures_options_1_j\\.xlsx)"`));
        return match ? new URL(match[1], baseUrl).href : null;
    }
    function parseJpxWorkbook(rows, context) {
        const records = [], diagnostics = [];
        for (const row of rows.slice(1).filter(value => value?.[0] === "日経225オプション")) {
            const contract = String(row[1] || "").match(/(20\d{2})年(\d{1,2})月限月/),
                last = String(row[4] || "").match(/(20\d{2})\/(\d{2})\/(\d{2})/),
                sq = String(row[5] || "").match(/(20\d{2})\/(\d{2})\/(\d{2})/);
            if (!contract || !last || !sq) { diagnostics.push("jpx_option_row_incomplete"); continue; }
            const period = `${contract[1]}-${pad(contract[2])}`, quarter = [3, 6, 9, 12].includes(Number(contract[2]));
            const values = [["JPX_NIKKEI225_LAST_TRADING_DAY", "日経225限月最終取引日", last],
                [quarter ? "JPX_NIKKEI225_MAJOR_SQ" : "JPX_NIKKEI225_SQ",
                    quarter ? "日経225メジャーSQ" : "日経225SQ", sq]];
            for (const [eventType, title, value] of values) records.push(record(context, { eventType,
                sourceTitle: title, titleJa: title, titleEn: null, referencePeriod: period, scope: "OSE",
                sourceLocalSchedule: local("all_day", `${value[1]}-${value[2]}-${value[3]}`, null, "Asia/Tokyo") })); }
        return { records, diagnostics: records.length ? diagnostics : ["jpx_nikkei225_options_not_parsed"] };
    }
    return Object.freeze({ parseBoj, parseFed, parseBls, discoverJpxWorkbook, parseJpxWorkbook });
});
