(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const consumer = commonJs ? require("./marketCalendarHistory/readOnlyCalendarConsumer.js") :
        root?.OptionMapMarketCalendarReadOnlyConsumer;
    const dates = commonJs ? require("./calendarDate/calendarDate.js") : root?.OptionMapCalendarDate;
    const navigation = commonJs ? require("./calendarDate/calendarDateNavigation.js") :
        root?.OptionMapCalendarDateNavigation;
    const schedule = commonJs ? require("./marketCalendar/marketEventSchedule.js") : root?.OptionMapMarketEventSchedule;
    const presentation = commonJs ? require("./marketCalendar/marketEventPresentation.js") :
        root?.OptionMapMarketEventPresentation;
    const runtimeStore = commonJs ? require("./storage/marketCalendarRuntimeStateStore.js") :
        root?.OptionMapCalendarRuntimeStateStore;
    const api = factory(consumer, dates, navigation, schedule, presentation, runtimeStore);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarMvp = api;
})(typeof window !== "undefined" ? window : globalThis, function (consumer, dates, navigation, schedule,
    presentation, runtimeStore) {
    "use strict";
    const SOURCE_NAMES = Object.freeze({
        "jp-boj-calendar": "日本銀行", "jp-stat-cpi": "総務省統計局・消費者物価指数",
        "jp-stat-labor": "総務省統計局・労働力調査",
        "jp-esri-machinery-orders-calendar": "内閣府・機械受注",
        "jp-esri-sna-calendar": "内閣府・国民経済計算",
        "us-fed-fomc-calendar": "米連邦準備制度", "us-bls-calendar": "米労働統計局",
        "us-bea-calendar": "米経済分析局", "us-census-calendar": "米国勢調査局",
        "jp-jpx-derivatives-calendar": "日本取引所・デリバティブ",
        "jp-jpx-market-holidays": "日本取引所・休場日",
        "us-nyse-market-holidays": "ニューヨーク証券取引所",
        "jp-mof-jgb-auction-calendar": "財務省・国債入札"
    });
    const IMPORTANCE_NAMES = Object.freeze({ critical: "最重要", high: "重要", medium: "通常" });
    const SHORT_NAMES = Object.freeze({ BOJ_MPM: "日銀会合", BOJ_POLICY_DECISION: "日銀政策決定",
        BOJ_GOVERNOR_PRESS_CONFERENCE: "日銀総裁会見", JP_NATIONAL_CPI: "全国CPI",
        JP_TOKYO_CPI: "東京CPI", JP_GDP: "日本GDP", JP_LABOR_FORCE: "労働力調査",
        JP_MACHINERY_ORDERS: "機械受注", JP_TANKAN: "日銀短観", US_CPI: "米CPI",
        US_PPI: "米PPI", US_EMPLOYMENT_SITUATION: "米雇用統計",
        US_FOMC_MEETING: "FOMC会合", US_FOMC_POLICY_DECISION: "FOMC声明",
        US_FED_CHAIR_PRESS_CONFERENCE: "FRB議長会見", US_PCE: "米PCE",
        US_GDP: "米GDP", US_RETAIL_SALES: "米小売売上高", US_JOLTS: "米JOLTS",
        JPX_NIKKEI225_SQ: "日経225 SQ", JPX_NIKKEI225_MAJOR_SQ: "日経225 MSQ",
        JPX_NIKKEI225_LAST_TRADING_DAY: "日経225取引最終日",
        JPX_MARKET_HOLIDAY: "日本市場休場", US_NYSE_MARKET_HOLIDAY: "NYSE休場",
        US_NYSE_EARLY_CLOSE: "NYSE短縮取引", JP_JGB_AUCTION: "国債入札" });
    const EDITION_NAMES = Object.freeze({ advance: "速報", second: "改定", third: "確報" });
    function todayJst(now = new Date()) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)
            .map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    }
    function monthGrid(year, month) {
        return navigation.buildMonth({ year, month, weekStartsOn: "sunday", displayTimeZone: "Asia/Tokyo" });
    }
    function monthRange(grid) {
        return { startDate: grid.cells[0].calendarDate, endDate: grid.cells.at(-1).calendarDate };
    }
    function shiftMonth(year, month, offset) {
        const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
        return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
    }
    function jstTime(instant) {
        if (!Number.isFinite(Date.parse(instant))) throw new TypeError("instant_invalid");
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant))
            .map(part => [part.type, part.value]));
        return `${parts.hour}:${parts.minute}`;
    }
    function selectedDateHeading(calendarDate) {
        if (!dates.isValid(calendarDate)) throw new TypeError("calendar_date_invalid");
        const month = Number(calendarDate.slice(5, 7)), day = Number(calendarDate.slice(8, 10));
        const weekday = "日月火水木金土"[new Date(`${calendarDate}T00:00:00.000Z`).getUTCDay()];
        return `${month}月${day}日（${weekday}）の予定`;
    }
    function viewModel(revision) {
        const basic = presentation.build(revision), interval = schedule.calendarDateIntervalFor(
            revision.schedule, "Asia/Tokyo"), kind = revision.schedule.kind;
        if (!SOURCE_NAMES[revision.sourceId]) throw new TypeError("source_unknown");
        const shortBase = revision.logical.eventType === "JP_JGB_AUCTION" ?
            `${revision.logical.auctionIdentity.maturity.slice(0, -1)}年${SHORT_NAMES.JP_JGB_AUCTION}` :
            SHORT_NAMES[revision.logical.eventType] || basic.title;
        const edition = revision.logical.edition, shortTitle = edition && EDITION_NAMES[edition] &&
            ["US_GDP", "JP_GDP"].includes(revision.logical.eventType) ?
            `${shortBase}・${EDITION_NAMES[edition]}` : shortBase;
        return Object.freeze({ eventKey: revision.eventKey, calendarDate: interval.start,
            dateLabel: kind === "date_range" ? `${interval.start}〜${interval.end}` : interval.start,
            timeLabel: kind === "instant" ? jstTime(revision.schedule.canonicalStart) :
                kind === "date_only" ? "時刻未定" :
                kind === "all_day" ? "終日" : "期間", title: basic.title, shortTitle,
            importance: basic.importance, importanceLabel: IMPORTANCE_NAMES[basic.importance],
            sourceId: revision.sourceId, sourceLabel: SOURCE_NAMES[revision.sourceId] });
    }
    function appendText(parent, tag, className, value) {
        const node = parent.ownerDocument.createElement(tag); node.className = className;
        node.textContent = value; parent.appendChild(node); return node;
    }
    function eventsForDate(events, calendarDate) {
        return events.filter(event => event.calendarDateStart <= calendarDate &&
            calendarDate <= event.calendarDateEnd);
    }
    function coverageViewModel(result) {
        const unavailable = (state, statusText) => Object.freeze({ state, statusText, issues: [] });
        if (result?.status === "absent")
            return unavailable("absent", "保存済みカレンダー：まだありません");
        if (["schema_mismatch", "invalid"].includes(result?.status))
            return unavailable("invalid", "保存済みカレンダーを確認できません（形式または整合性エラー）");
        if (result?.status !== "available" || !result.coverage)
            return unavailable("unavailable", "保存済みカレンダーを読み込めませんでした");
        const projected = result.coverage;
        if (projected.completeness === "invalid")
            return unavailable("invalid", "保存済みカレンダーを確認できません（形式または整合性エラー）");
        if (projected.formalAvailability === "absent")
            return unavailable("absent", "保存済みカレンダー：まだありません");
        const issues = projected.sources.flatMap(source => {
            const label = SOURCE_NAMES[source.sourceId] || "不明なsource";
            if (source.formalState === "formal_absent") return [source.runtimeState === "runtime_failed" ?
                `${label}：現在確認できません` : `${label}：未保存`];
            if (source.formalState === "formal_present" && source.runtimeState === "runtime_failed")
                return [`${label}：保存済みデータあり／最新取得は失敗`];
            return [];
        });
        return Object.freeze({ state: projected.completeness === "complete" ? "full" : "partial",
            statusText: `保存済みカレンダー：${projected.coverageCount} / ${projected.expectedCount} source`,
            issues: Object.freeze(issues) });
    }
    function renderCoverage(panel, result) {
        const region = panel.querySelector("#marketCalendarCoverage"), status = panel.querySelector(
            "#marketCalendarCoverageStatus"), message = panel.querySelector(
            "#marketCalendarCoverageMessage"), list = panel.querySelector("#marketCalendarCoverageSources"),
            view = coverageViewModel(result);
        if (!region || !status || !message || !list) return view;
        region.dataset.state = view.state; status.textContent = view.statusText;
        message.hidden = true; message.textContent = ""; list.hidden = true;
        list.replaceChildren();
        if (view.issues.length === 1) {
            message.textContent = view.issues[0]; message.hidden = false;
        } else if (view.issues.length > 1) {
            for (const issue of view.issues) appendText(list, "li", "market-calendar-coverage-source", issue);
            list.hidden = false;
        }
        return view;
    }
    function renderMonth(panel, result, grid, selectedDate, today, onSelect) {
        const status = panel.querySelector("#marketCalendarStatus"), container = panel.querySelector(
            "#marketCalendarGrid");
        container.replaceChildren();
        const available = result.status === "available";
        status.textContent = available ? `${grid.year}年${grid.month}月の経済イベント` :
            result.status === "schema_mismatch" ? "保存データの形式が一致しません" :
                result.status === "absent" ? "この環境にカレンダーデータがありません" :
                    "Market Calendar を読み込めませんでした";
        for (const cell of grid.cells) {
            const button = panel.ownerDocument.createElement("button"), date = cell.calendarDate;
            const revisions = available ? eventsForDate(result.events, date) : [];
            let rows;
            try { rows = revisions.map(viewModel); }
            catch (_error) { rows = []; status.textContent = "Market Calendar の表示データを確認できません"; }
            const rank = { critical: 0, high: 1, medium: 2 };
            rows.sort((a, b) => rank[a.importance] - rank[b.importance] ||
                a.timeLabel.localeCompare(b.timeLabel) || a.eventKey.localeCompare(b.eventKey));
            button.type = "button";
            button.className = "market-calendar-day" + (cell.inMonth ? "" : " is-outside") +
                (date === today ? " is-today" : "") + (date === selectedDate ? " is-selected" : "");
            button.dataset.calendarDate = date;
            button.setAttribute("aria-label", `${date}、${rows.length}件`);
            button.setAttribute("aria-pressed", String(date === selectedDate));
            if (date === today) button.setAttribute("aria-current", "date");
            appendText(button, "span", "market-calendar-day-number", String(Number(date.slice(-2))));
            const previews = panel.ownerDocument.createElement("span");
            previews.className = "market-calendar-day-previews";
            for (const row of rows.slice(0, 2)) {
                const preview = panel.ownerDocument.createElement("span");
                preview.className = "market-calendar-preview";
                appendText(preview, "span", `market-calendar-marker importance-${row.importance}`, "●");
                const label = row.timeLabel === "期間" || row.timeLabel === "終日" ||
                    row.timeLabel === "時刻未定" ? row.shortTitle : `${row.timeLabel} ${row.shortTitle}`;
                appendText(preview, "span", "market-calendar-preview-label", label);
                previews.appendChild(preview);
            }
            if (rows.length > 2) appendText(previews, "span", "market-calendar-more",
                `＋${rows.length - 2}件`);
            button.appendChild(previews);
            if (rows.length) appendText(button, "span", `market-calendar-mobile-count importance-${rows[0].importance}`,
                `● ${rows.length}件`);
            button.addEventListener("click", () => onSelect(date));
            container.appendChild(button);
        }
    }
    function renderDetail(panel, result, selectedDate) {
        const status = panel.querySelector("#marketCalendarDetailStatus"), list = panel.querySelector(
            "#marketCalendarEvents");
        list.replaceChildren();
        panel.querySelector("#marketCalendarDetailTitle").textContent = selectedDateHeading(selectedDate);
        if (result.status !== "available") {
            status.textContent = result.status === "schema_mismatch" ? "保存データの形式が一致しません" :
                result.status === "absent" ? "この環境にカレンダーデータがありません" :
                    "Market Calendar を読み込めませんでした";
            return;
        }
        let rows;
        try { rows = result.events.map(viewModel); }
        catch (_error) { status.textContent = "Market Calendar の表示データを確認できません"; return; }
        status.textContent = rows.length ? `${rows.length}件の予定` : "予定なし";
        for (const row of rows) {
            const item = panel.ownerDocument.createElement("li"); item.className = "market-calendar-event";
            appendText(item, "span", "market-calendar-date", row.dateLabel);
            appendText(item, "span", "market-calendar-time", row.timeLabel);
            appendText(item, "strong", "market-calendar-title", row.title);
            appendText(item, "span", `market-calendar-importance importance-${row.importance}`,
                row.importanceLabel);
            appendText(item, "span", "market-calendar-source", row.sourceLabel);
            list.appendChild(item);
        }
    }
    function mount({ document = globalThis.document, indexedDB = globalThis.indexedDB,
        keyRange = globalThis.IDBKeyRange, readRuntimeStates } = {}) {
        const panel = document?.getElementById("marketCalendarPanel"); if (!panel) return null;
        let selectedDate = todayJst(), year = Number(selectedDate.slice(0, 4)),
            month = Number(selectedDate.slice(5, 7)), monthSequence = 0, daySequence = 0,
            coverageSequence = 0, currentGrid = null, monthResult = null;
        if (typeof readRuntimeStates !== "function") {
            try { const store = runtimeStore.createRuntimeStateStore({ indexedDB,
                targetEnvironment: "browser_runtime" }); readRuntimeStates = () => store.readAll(); }
            catch (_error) { readRuntimeStates = async () => ({ status: "unavailable", value: [] }); }
        }
        async function refreshCoverage() {
            const requestId = ++coverageSequence, status = panel.querySelector(
                "#marketCalendarCoverageStatus");
            if (status) status.textContent = "保存済みカレンダーを確認中…";
            let runtimeStates = [];
            try { const runtime = await readRuntimeStates();
                if (runtime?.status === "ok" && Array.isArray(runtime.value)) runtimeStates = runtime.value; }
            catch (_error) {}
            const result = await consumer.readCoverage({ indexedDB, runtimeStates });
            if (requestId === coverageSequence) renderCoverage(panel, result);
            return result;
        }
        async function refreshSelected() {
            const requestId = ++daySequence, date = selectedDate;
            panel.querySelector("#marketCalendarDetailStatus").textContent = "経済イベントを読み込み中…";
            const result = await consumer.query({ indexedDB, keyRange, startDate: date, endDate: date });
            if (requestId === daySequence && date === selectedDate) {
                renderDetail(panel, result, date);
                document.dispatchEvent(new CustomEvent("optionmap:calendar-date-selected",
                    { detail: { calendarDate: date } }));
            }
        }
        function selectDate(date) {
            selectedDate = date;
            if (date.slice(0, 7) !== `${year}-${String(month).padStart(2, "0")}`) {
                year = Number(date.slice(0, 4)); month = Number(date.slice(5, 7)); refreshMonth(); return;
            }
            if (currentGrid && monthResult) renderMonth(panel, monthResult, currentGrid,
                selectedDate, todayJst(), selectDate);
            refreshSelected();
        }
        async function refreshMonth() {
            const requestId = ++monthSequence, grid = monthGrid(year, month);
            currentGrid = grid; monthResult = null;
            panel.querySelector("#marketCalendarMonthTitle").textContent = `${year}年${month}月`;
            panel.querySelector("#marketCalendarStatus").textContent = "経済イベントを読み込み中…";
            const result = await consumer.query({ indexedDB, keyRange, ...monthRange(grid) });
            if (requestId !== monthSequence) return;
            monthResult = result;
            renderMonth(panel, result, grid, selectedDate, todayJst(), selectDate);
            refreshCoverage();
            refreshSelected();
        }
        function move(offset) { const next = shiftMonth(year, month, offset);
            year = next.year; month = next.month;
            selectedDate = `${year}-${String(month).padStart(2, "0")}-01`;
            refreshMonth(); }
        panel.querySelector("#marketCalendarPreviousMonth").addEventListener("click", () => move(-1));
        panel.querySelector("#marketCalendarNextMonth").addEventListener("click", () => move(1));
        panel.querySelector("#marketCalendarToday").addEventListener("click", () => {
            selectedDate = todayJst(); year = Number(selectedDate.slice(0, 4));
            month = Number(selectedDate.slice(5, 7)); refreshMonth(); });
        document.addEventListener("optionmap:calendar-formal-updated", refreshMonth);
        document.addEventListener("optionmap:calendar-runtime-state-updated", refreshCoverage);
        refreshMonth(); return Object.freeze({ refreshMonth, refreshCoverage, selectDate });
    }
    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount());
        else mount();
    }
    return Object.freeze({ SOURCE_NAMES, IMPORTANCE_NAMES, todayJst, monthGrid, monthRange,
        shiftMonth, selectedDateHeading, eventsForDate, viewModel, coverageViewModel,
        renderCoverage, renderMonth, renderDetail, mount });
});
