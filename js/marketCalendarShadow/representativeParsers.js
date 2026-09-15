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
        parserVersion: context.parserVersion, rawContentHash: context.rawContentHash,
        requestId: context.requestId || null, runId: context.runId || null,
        httpMetadata: context.httpMetadata || null, ...values }; }
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
    const BEA_JSON_RELEASES = Object.freeze({ GDP: "Gross Domestic Product",
        PCE: "Personal Income and Outlays" });
    const BEA_GDP_EDITIONS = Object.freeze({ Advance: "advance_estimate",
        Second: "second_estimate", Third: "third_estimate" });
    const BEA_REVISION_CONTRACT = Object.freeze({ movedTimestamp: "same_logical_event_new_revision",
        omittedFromJson: "not_formalized_status_unknown", htmlTba: "not_formalized_status_unknown",
        restoredTimestamp: "same_logical_event_new_revision" });
    function beaLocalInstant(value) {
        if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(value) ||
            !Number.isFinite(Date.parse(value))) return null;
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            hourCycle: "h23" }).formatToParts(new Date(value)).filter(part => part.type !== "literal")
            .map(part => [part.type, part.value]));
        return { startDate: `${parts.year}-${parts.month}-${parts.day}`,
            startTime: `${parts.hour}:${parts.minute}` };
    }
    function beaGdpIdentity(title) {
        if (!/^(?:GDP|Gross Domestic Product)\b/.test(title) || /\bby (?:State|County|Metropolitan)|Puerto Rico/i.test(title))
            return null;
        if (/\bAnnual Update\b/i.test(title)) return null;
        const edition = title.match(/\b(Advance|Second|Third) Estimate\b/i), period = title.match(
            /\b([1-4])(?:st|nd|rd|th) Quarter(?: and Year)?[, ]+(20\d{2})\b/i);
        if (!edition || !period) return null;
        const label = edition[1][0].toUpperCase() + edition[1].slice(1).toLowerCase();
        return { edition: BEA_GDP_EDITIONS[label], referencePeriod: `${period[2]}-Q${period[1]}` };
    }
    function beaPceIdentity(title) {
        const match = title.match(/^Personal Income and Outlays,\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/i);
        if (!match) return null;
        const monthLabel = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
        return { edition: "initial", referencePeriod: `${match[2]}-${pad(MONTHS[monthLabel])}` };
    }
    function parseBea(jsonText, html, context) {
        const records = [], diagnostics = [], exclusions = []; let schedule;
        try { schedule = JSON.parse(jsonText); }
        catch (_error) { return { records: [], diagnostics: ["bea_json_invalid"], exclusions }; }
        if (!schedule || typeof schedule !== "object" || Array.isArray(schedule))
            return { records: [], diagnostics: ["bea_json_schema_invalid"], exclusions };
        const categories = {};
        for (const [kind, label] of Object.entries(BEA_JSON_RELEASES)) {
            const dates = schedule[label]?.release_dates;
            if (!Array.isArray(dates)) { diagnostics.push(`bea_json_release_missing:${label}`); continue; }
            categories[kind] = new Map();
            for (const value of dates) { const instant = beaLocalInstant(value);
                if (!instant) { diagnostics.push(`bea_json_datetime_invalid:${label}`); continue; }
                const key = `${instant.startDate}T${instant.startTime}`;
                if (categories[kind].has(key)) diagnostics.push(`bea_json_duplicate_datetime:${label}:${key}`);
                categories[kind].set(key, instant); }
        }
        const yearMatch = html.match(/<th[^>]*>\s*Year\s+(20\d{2})\s*<\/th>/i);
        if (!yearMatch) return { records: [], diagnostics: [...diagnostics, "bea_html_year_not_found"], exclusions };
        const year = Number(yearMatch[1]); let recognized = 0;
        for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
            const titleMatch = row[1].match(/<td[^>]*class="[^"]*release-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
            if (!titleMatch) continue;
            const title = strip(titleMatch[1]), gdp = beaGdpIdentity(title), pce = beaPceIdentity(title),
                relevant = /^(?:GDP|Gross Domestic Product|Personal Income and Outlays)\b/.test(title);
            if (!gdp && !pce) { if (relevant) exclusions.push({ label: title,
                reason: /^Personal Income and Outlays/.test(title) ? "non_monthly_pio_release" :
                    "non_standard_quarterly_gdp_release" }); continue; }
            recognized += 1;
            const date = row[1].match(/class="release-date"[^>]*>\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*</i),
                time = row[1].match(/class="text-muted"[^>]*>\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*</i);
            if (!date || !time) { diagnostics.push(`bea_release_datetime_missing:${title}`); continue; }
            let hour = Number(time[1]); if (time[3].toUpperCase() === "PM" && hour < 12) hour += 12;
            if (time[3].toUpperCase() === "AM" && hour === 12) hour = 0;
            const localDate = `${year}-${pad(MONTHS[date[1]])}-${pad(date[2])}`,
                localTime = `${pad(hour)}:${time[2]}`, kind = gdp ? "GDP" : "PCE",
                authoritative = categories[kind]?.get(`${localDate}T${localTime}`);
            if (!authoritative) { diagnostics.push(`bea_json_html_schedule_mismatch:${kind}:${localDate}T${localTime}`); continue; }
            const identity = gdp || pce;
            records.push(record(context, { eventType: gdp ? "US_GDP" : "US_PCE",
                authorityEventId: `${BEA_JSON_RELEASES[kind]}|${identity.referencePeriod}|${identity.edition}`,
                edition: identity.edition,
                scope: "national", sourceTitle: title, titleJa: gdp ? `米GDP ${identity.edition.replace("_", " ")}` : "米PCE",
                titleEn: gdp ? `U.S. GDP ${identity.edition.replace("_", " ")}` : "U.S. PCE",
                referencePeriod: identity.referencePeriod, releaseKind: gdp ? "quarterly_gdp_estimate" :
                    "monthly_personal_income_and_outlays_package", sourceLocalSchedule:
                    local("instant", authoritative.startDate, authoritative.startTime, "America/New_York") }));
        }
        if (!recognized && !diagnostics.length) diagnostics.push("bea_release_rows_not_found");
        return { records, diagnostics, exclusions };
    }
    function parseCensus(html, context) {
        const records = [], diagnostics = [], exclusions = [];
        const table = html.match(/<table[^>]*id=["']calendar["'][^>]*>([\s\S]*?)<\/table>/i);
        if (!table) return { records, diagnostics: ["census_calendar_table_not_found"], exclusions };
        for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(value => strip(value[1]));
            if (!cells.length) continue;
            if (cells[0] !== "Advance Monthly Sales for Retail and Food Services") {
                exclusions.push({ label: cells[0], reason: "non_retail_sales_economic_indicator" }); continue; }
            const date = cells[1]?.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})$/),
                time = cells[2]?.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i), period = cells[3]?.match(
                    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/);
            if (!date || !time || !period) { diagnostics.push("census_retail_sales_row_incomplete"); continue; }
            let hour = Number(time[1]); if (time[3].toUpperCase() === "PM" && hour < 12) hour += 12;
            if (time[3].toUpperCase() === "AM" && hour === 12) hour = 0;
            const referencePeriod = `${period[2]}-${pad(MONTHS[period[1]])}`;
            records.push(record(context, { eventType: "US_RETAIL_SALES", edition: "advance",
                scope: "national", authorityEventId: `Advance Monthly Sales for Retail and Food Services|${referencePeriod}|advance`,
                sourceTitle: cells[0], titleJa: "米小売売上高", titleEn: "U.S. Retail Sales",
                referencePeriod, releaseKind: "advance_monthly_retail_sales",
                sourceLocalSchedule: local("instant", `${date[3]}-${pad(MONTHS[date[1]])}-${pad(date[2])}`,
                    `${pad(hour)}:${time[2]}`, "America/New_York") }));
        }
        if (!records.length && !diagnostics.length) diagnostics.push("census_retail_sales_rows_not_found");
        return { records, diagnostics, exclusions };
    }
    function parseJpxMarketHolidays(html, context) {
        const records = [], diagnostics = [];
        const heading = html.indexOf('id="heading_7"');
        if (heading < 0) return { records, diagnostics: ["jpx_holiday_section_not_found"], exclusions: [] };
        const section = html.slice(heading), rows = [...section.matchAll(
            /<tr><td[^>]*>\s*(20\d{2})\/(\d{2})\/(\d{2})（[^）]+）<\/td[^>]*><td[^>]*>\s*([^<]+?)\s*<\/td><\/tr>/g)];
        for (const match of rows) { const date = `${match[1]}-${match[2]}-${match[3]}`,
            label = strip(match[4]);
            records.push(record(context, { eventType: "JPX_MARKET_HOLIDAY", edition: "regular",
                scope: "JPX_cash_markets", authorityEventId: `JPX market holiday|${date}`,
                sourceTitle: label, titleJa: `JPX休場（${label}）`, titleEn: "JPX Market Holiday",
                referencePeriod: date, releaseKind: "official_market_holiday",
                sourceLocalSchedule: local("all_day", date, null, "Asia/Tokyo") })); }
        if (!records.length) diagnostics.push("jpx_holiday_rows_not_found");
        return { records, diagnostics, exclusions: [] };
    }
    const CPI_SCOPES = Object.freeze({
        "全国": Object.freeze({ eventType: "JP_NATIONAL_CPI", edition: "initial", scope: "national",
            titleJa: "全国CPI", titleEn: "Japan National CPI" }),
        "東京都区部（中旬速報値）": Object.freeze({ eventType: "JP_TOKYO_CPI", edition: "preliminary",
            scope: "tokyo", titleJa: "東京都区部CPI", titleEn: "Tokyo CPI" })
    });
    function releaseKind(label) {
        const monthly = String(label).match(/^(20\d{2})年(\d{1,2})月分$/);
        if (monthly) return { formal: true, kind: "monthly", referencePeriod:
            `${monthly[1]}-${pad(monthly[2])}` };
        if (/年度平均/.test(label)) return { formal: false, kind: "fiscal_year_average" };
        if (/年平均/.test(label)) return { formal: false, kind: "calendar_year_average" };
        if (/基準|遡及|接続指数/.test(label)) return { formal: false, kind: "benchmark_or_retrospective" };
        return { formal: false, kind: "special_release" };
    }
    function parseStatCpiXml(xml, context) {
        const records = [], diagnostics = [], exclusions = [], scopePattern =
            /<class_1\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/class_1>/g;
        let scopeCount = 0;
        for (const scopeMatch of xml.matchAll(scopePattern)) { scopeCount += 1; const scopeLabel = scopeMatch[1],
            mapping = CPI_SCOPES[scopeLabel];
            if (!mapping) { diagnostics.push(`cpi_unknown_scope:${scopeLabel}`); continue; }
            const class2Pattern = /<class_2\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/class_2>/g;
            let releaseCount = 0;
            for (const releaseMatch of scopeMatch[2].matchAll(class2Pattern)) { releaseCount += 1;
                const label = releaseMatch[1], classification = releaseKind(label);
                if (!classification.formal) { exclusions.push({ scope: scopeLabel, label,
                    reason: classification.kind }); continue; }
                const value = tag => releaseMatch[2].match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1],
                    year = value("release_year"), month = value("release_month"), day = value("release_day"),
                    hour = value("release_hour"), minute = value("release_minute");
                if (![year, month, day, hour, minute].every(item => /^\d+$/.test(item || ""))) {
                    diagnostics.push(`cpi_monthly_release_incomplete:${scopeLabel}:${label}`); continue; }
                records.push(record(context, { eventType: mapping.eventType, edition: mapping.edition,
                    scope: mapping.scope, sourceTitle: `${scopeLabel} ${label}`, titleJa: mapping.titleJa,
                    titleEn: mapping.titleEn, referencePeriod: classification.referencePeriod,
                    releaseKind: classification.kind, sourceLocalSchedule: local("instant",
                        `${year}-${pad(month)}-${pad(day)}`, `${pad(hour)}:${pad(minute)}`, "Asia/Tokyo") })); }
            if (!releaseCount) diagnostics.push(`cpi_scope_hierarchy_malformed:${scopeLabel}`); }
        if (!scopeCount) diagnostics.push("cpi_class_1_hierarchy_not_found");
        return { records, diagnostics, exclusions };
    }
    const normalizedJapanesePeriod = value => String(value || "").normalize("NFKC").replace(/\s+/g, "");
    function laborReleaseKind(label) {
        const normalized = normalizedJapanesePeriod(label), monthly = normalized.match(
            /^基本集計[（(](20\d{2})年(\d{1,2})月分[）)]$/);
        if (monthly) return { formal: true, kind: "basic_monthly",
            referencePeriod: `${monthly[1]}-${pad(monthly[2])}` };
        if (/^基本集計[（(].+月期平均[）)]$/.test(normalized))
            return { formal: false, kind: "basic_quarterly_average" };
        if (/^基本集計[（(].+年度平均[）)]$/.test(normalized))
            return { formal: false, kind: "basic_fiscal_year_average" };
        if (/^基本集計[（(].+年平均[）)]$/.test(normalized))
            return { formal: false, kind: "basic_calendar_year_average" };
        if (/^詳細集計[（(].+月期平均[）)]$/.test(normalized))
            return { formal: false, kind: "detailed_quarterly_average" };
        if (/^詳細集計[（(].+年平均[）)]$/.test(normalized))
            return { formal: false, kind: "detailed_calendar_year_average" };
        return { formal: false, kind: "unknown" };
    }
    function parseStatLaborXml(xml, context) {
        const records = [], diagnostics = [], exclusions = [], outerPattern =
            /<class_1\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/class_1>/g;
        let outerCount = 0;
        for (const outer of xml.matchAll(outerPattern)) { outerCount += 1; const outerLabel =
            normalizedJapanesePeriod(outer[1]), outerPeriod = outerLabel.match(/^(20\d{2})年(\d{1,2})月分$/),
            innerPattern = /<class_2\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/class_2>/g;
            let innerCount = 0;
            for (const inner of outer[2].matchAll(innerPattern)) { innerCount += 1; const classification =
                laborReleaseKind(inner[1]);
                if (classification.kind === "unknown") {
                    diagnostics.push(`labor_unknown_release_kind:${inner[1]}`); continue; }
                if (!classification.formal) { exclusions.push({ periodGroup: outer[1], label: inner[1],
                    reason: classification.kind }); continue; }
                if (!outerPeriod || `${outerPeriod[1]}-${pad(outerPeriod[2])}` !== classification.referencePeriod) {
                    diagnostics.push(`labor_ambiguous_period:${outer[1]}:${inner[1]}`); continue; }
                const value = tag => inner[2].match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1],
                    year = value("release_year"), month = value("release_month"), day = value("release_day"),
                    hour = value("release_hour"), minute = value("release_minute");
                if (![year, month, day, hour, minute].every(item => /^\d+$/.test(item || ""))) {
                    diagnostics.push(`labor_monthly_release_incomplete:${inner[1]}`); continue; }
                records.push(record(context, { eventType: "JP_LABOR_FORCE", edition: "initial",
                    scope: "national", sourceTitle: inner[1], titleJa: "労働力調査（基本集計・月次）",
                    titleEn: "Labour Force Survey Basic Tabulation Monthly Results",
                    referencePeriod: classification.referencePeriod, releaseKind: classification.kind,
                    sourceLocalSchedule: local("instant", `${year}-${pad(month)}-${pad(day)}`,
                        `${pad(hour)}:${pad(minute)}`, "Asia/Tokyo") })); }
            if (!innerCount) diagnostics.push(`labor_hierarchy_malformed:${outer[1]}`); }
        if (!outerCount) diagnostics.push("labor_class_1_hierarchy_not_found");
        return { records, diagnostics, exclusions };
    }
    const cells = row => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(value => strip(value[1]));
    function parseEsriMachineryOrders(html, context) {
        const records = [], diagnostics = [], exclusions = [], table = html.match(
            /<table[^>]*>[\s\S]*?機械受注統計調査[\s\S]*?<\/table>/i);
        if (!table) return { records, exclusions, diagnostics: ["esri_machinery_table_not_found"] };
        let releaseYear = null, lastReleaseMonth = null, rowCount = 0;
        for (const row of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) { const values = cells(row[1]);
            if (values.length < 3) continue; const value = values[2], date = value.match(
                /(?:(?:令和)?(\d{1,2})年\s*)?(\d{1,2})月\s*(\d{1,2})日\s*\((\d{1,2})月分\)/);
            if (!date) { if (value && value !== "&nbsp;") exclusions.push({ label: value,
                reason: "non_monthly_or_empty_machinery_cell" }); continue; }
            rowCount += 1; const releaseMonth = Number(date[2]), referenceMonth = Number(date[4]);
            if (date[1]) releaseYear = 2018 + Number(date[1]);
            else if (releaseYear && lastReleaseMonth && releaseMonth < lastReleaseMonth) releaseYear += 1;
            if (!releaseYear) { diagnostics.push(`esri_machinery_year_context_missing:${value}`); continue; }
            lastReleaseMonth = releaseMonth; const referenceYear = referenceMonth > releaseMonth
                ? releaseYear - 1 : releaseYear;
            records.push(record(context, { eventType: "JP_MACHINERY_ORDERS", edition: "initial",
                scope: "national", sourceTitle: `機械受注統計調査 ${date[4]}月分`, titleJa: "機械受注",
                titleEn: "Machinery Orders", referencePeriod: `${referenceYear}-${pad(referenceMonth)}`,
                releaseKind: "monthly", sourceLocalSchedule: local("instant",
                    `${releaseYear}-${pad(releaseMonth)}-${pad(date[3])}`, "08:50", "Asia/Tokyo") })); }
        if (!rowCount) diagnostics.push("esri_machinery_monthly_rows_not_found");
        return { records, diagnostics, exclusions };
    }
    function parseEsriSna(html, context) {
        const records = [], diagnostics = [], exclusions = [], heading = html.indexOf("四半期別GDP速報"),
            nextHeading = html.indexOf("<h2", heading + 4), section = heading < 0 ? "" :
                html.slice(heading, nextHeading < 0 ? html.length : nextHeading), table = section.match(
                    /<table[^>]*>([\s\S]*?)<\/table>/i);
        if (!table) return { records, exclusions, diagnostics: ["esri_sna_gdp_table_not_found"] };
        for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) { const value = cells(row[1]);
            if (value.length !== 3) continue; const period = value[0].match(
                /^(20\d{2})年(\d{1,2})-(\d{1,2})月期（([12])次速報）$/), date = value[1].match(
                    /^(20\d{2})（令和\d+）年(\d{1,2})月(\d{1,2})日（[^）]+）$/), time = value[2].match(
                    /^(\d{1,2})時(\d{1,2})分$/);
            if (!period) { exclusions.push({ label: value[0], reason: "non_quarterly_gdp_release" }); continue; }
            if (!date || !time) { diagnostics.push(`esri_sna_gdp_row_incomplete:${value.join("|")}`); continue; }
            records.push(record(context, { eventType: "JP_GDP", edition: period[4] === "1"
                ? "first_preliminary" : "second_preliminary", scope: "national",
                sourceTitle: value[0], titleJa: `GDP ${period[4]}次速報`, titleEn:
                    `GDP ${period[4] === "1" ? "First" : "Second"} Preliminary`,
                referencePeriod: `${period[1]}-Q${Math.ceil(Number(period[3]) / 3)}`,
                releaseKind: "quarterly_preliminary", sourceLocalSchedule: local("instant",
                    `${date[1]}-${pad(date[2])}-${pad(date[3])}`, `${pad(time[1])}:${pad(time[2])}`,
                    "Asia/Tokyo") })); }
        if (!records.length && !diagnostics.length) diagnostics.push("esri_sna_gdp_rows_not_found");
        return { records, diagnostics, exclusions };
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
    return Object.freeze({ parseBoj, parseFed, parseBls, parseBea, parseCensus, parseJpxMarketHolidays,
        beaGdpIdentity, beaPceIdentity,
        BEA_JSON_RELEASES, BEA_GDP_EDITIONS, BEA_REVISION_CONTRACT,
        parseStatCpiXml, parseStatLaborXml,
        parseEsriMachineryOrders, parseEsriSna,
        releaseKind, laborReleaseKind,
        discoverJpxWorkbook, parseJpxWorkbook });
});
