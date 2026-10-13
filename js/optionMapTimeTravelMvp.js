(function (root, factory) {
    const model = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./timeTravel/optionMapHistoricalReadModel.js") : root?.OptionMapHistoricalReadModel;
    const api = factory(model);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapTimeTravelMvp = api;
})(typeof window !== "undefined" ? window : globalThis, function (readModel) {
    "use strict";
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
    const FINAL_OBSERVATION_MATCH_TOLERANCE_MS = 10;
    const SERIES_COLORS = Object.freeze(["#174f91", "#c77b1d", "#6f42c1", "#23856d", "#c83e3e"]);
    const jstTime = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(value)) : "時刻不明";
    const jstDateTime = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
        hourCycle: "h23"
    }).format(new Date(value)) : "時刻不明";
    const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
    function japaneseDate(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
        return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : value;
    }
    function direction(overall) {
        if (!overall?.available) return "利用不可";
        const score = number(overall.direction);
        if (score === null) return "判定なし";
        if (score >= 60) return "強い買い優勢";
        if (score >= 20) return "買い優勢";
        if (score <= -60) return "強い売り優勢";
        if (score <= -20) return "売り優勢";
        return "中立";
    }
    function component(value) {
        if (!value?.available) return "利用不可";
        const score = number(value.normalizedDirection ?? value.directionScore);
        return score === null ? "利用可能" : String(score);
    }
    function observationView(record) {
        if (!record) return null;
        return Object.freeze({ savedAt: record.observedAt, savedTime: jstTime(record.observedAt),
            marketDate: record.marketDate, tradingDate: record.qriReference?.tradingDate || null,
            calendarDay: record.session?.calendarDay || null, contract: record.currentPrice?.contract || null,
            priceReason: record.currentPrice?.reason || (record.currentPrice?.available === false ?
                "current_price_unavailable（詳細理由は未保存）" : null),
            direction: direction(record.overallV2), confidence: record.overallV2?.confidence ?? null,
            coverage: record.overallV2?.coverage ?? null,
            price: record.currentPrice?.available ? record.currentPrice.value : null,
            option: component(record.components?.option), weekly: component(record.components?.weekly),
            quality: record.dataQuality?.status || "unknown",
            warnings: Array.isArray(record.dataQuality?.warnings) ? record.dataQuality.warnings : [] });
    }
    function morningView(values) {
        return (values || []).map(item => ({ contract: item.contract,
            capturedAt: item.baseline.capturedAt, capturedTime: jstTime(item.baseline.capturedAt),
            direction: direction(item.baseline.overallV2),
            price: number(item.baseline.currentPrice?.value) }));
    }
    function append(document, parent, tag, className, text) {
        const node = document.createElement(tag); node.className = className; node.textContent = text;
        parent.appendChild(node); return node;
    }
    function metric(document, parent, label, value, className = "") {
        const item = append(document, parent, "div", `optionmap-historical-metric ${className}`.trim(), "");
        append(document, item, "span", "", label);
        append(document, item, "strong", "", value);
        return item;
    }
    function percentage(value) { return number(value) === null ? "—" : `${value}%`; }
    function price(value) { return number(value) === null ? "—" : `${value.toLocaleString("ja-JP")}円`; }
    function qualityLabel(value) {
        return ({ complete: "正常", partial: "一部不足", unavailable: "利用不可" })[value] || "確認できません";
    }
    function finalObservationSnapshot(snapshots, observation) {
        if (!observation?.currentPrice?.available || number(observation.currentPrice.value) === null ||
            !Number.isFinite(Date.parse(observation.observedAt))) return null;
        const matches = (snapshots || []).filter(item => item.marketDate === observation.marketDate &&
            item.price === observation.currentPrice.value && Number.isFinite(Date.parse(item.observedAt)) &&
            Math.abs(Date.parse(item.observedAt) - Date.parse(observation.observedAt)) <=
                FINAL_OBSERVATION_MATCH_TOLERANCE_MS);
        return matches.length === 1 ? matches[0] : null;
    }
    function priceChartModel(snapshots, latestObservation) {
        const valid = (snapshots || []).filter(item => validDate(item?.marketDate) &&
            Number.isFinite(Date.parse(item?.observedAt)) && number(item?.price) !== null &&
            typeof item?.contract === "string" && item.contract.trim()).slice()
            .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
                String(a.snapshotId).localeCompare(String(b.snapshotId)));
        const finalSnapshot = finalObservationSnapshot(valid, latestObservation), grouped = new Map();
        valid.forEach(item => { if (!grouped.has(item.contract)) grouped.set(item.contract, []);
            grouped.get(item.contract).push(item); });
        const series = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, "ja"))
            .map(([contract, values], index) => Object.freeze({ contract,
                color: SERIES_COLORS[index % SERIES_COLORS.length], showLine: values.length > 1,
                points: Object.freeze(values.map(item => Object.freeze({ x: Date.parse(item.observedAt),
                    y: item.price, observedAt: item.observedAt, snapshotId: item.snapshotId,
                    finalObservation: item.snapshotId === finalSnapshot?.snapshotId }))) }));
        const prices = valid.map(item => item.price);
        return Object.freeze({ count: valid.length, firstObservedAt: valid[0]?.observedAt || null,
            lastObservedAt: valid.at(-1)?.observedAt || null,
            minimumPrice: prices.length ? Math.min(...prices) : null,
            maximumPrice: prices.length ? Math.max(...prices) : null,
            finalObservationMatched: Boolean(finalSnapshot), series: Object.freeze(series) });
    }
    function renderPriceChart(panel, result, ChartConstructor) {
        const summary = panel.querySelector("#timeTravelPriceChartSummary"), range = panel.querySelector(
            "#timeTravelPriceChartRange"), empty = panel.querySelector("#timeTravelPriceChartEmpty"),
            container = panel.querySelector("#timeTravelPriceChartContainer"), canvas = panel.querySelector(
                "#timeTravelPriceChartCanvas"), model = priceChartModel(result.priceSnapshots, result.latestObservation);
        summary.textContent = ""; range.textContent = ""; empty.textContent = ""; container.hidden = true;
        if (!model.count) { empty.textContent = result.sections?.priceSnapshots?.status === "unavailable" ?
            "価格snapshot：unavailable（保存履歴を確認できません）" : "この日の価格snapshotは保存されていません";
            return { chart: null, model }; }
        summary.textContent = `保存点数：${model.count}点 ／ 最初：${jstDateTime(model.firstObservedAt)} JST ／ ` +
            `最後：${jstDateTime(model.lastObservedAt)} JST`;
        range.textContent = `保存snapshotの価格範囲：${price(model.minimumPrice)}〜${price(model.maximumPrice)}`;
        container.hidden = false;
        if (typeof ChartConstructor !== "function") { empty.textContent = "価格推移chartを表示できません";
            container.hidden = true; return { chart: null, model }; }
        const chart = new ChartConstructor(canvas, { type: "line", data: { datasets: model.series.map(series => ({
            label: series.contract, data: series.points, parsing: false, showLine: series.showLine,
            borderColor: series.color, backgroundColor: series.color, borderWidth: 2, tension: 0,
            pointRadius: context => context.raw?.finalObservation ? 7 : 4,
            pointHoverRadius: context => context.raw?.finalObservation ? 8 : 6,
            pointBackgroundColor: context => context.raw?.finalObservation ? "#fff" : series.color,
            pointBorderColor: series.color, pointBorderWidth: context => context.raw?.finalObservation ? 3 : 1
        })) }, options: { responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: "nearest", intersect: false },
            scales: { x: { type: "linear", title: { display: true, text: "保存時刻（JST）" },
                ticks: { callback: value => jstDateTime(new Date(Number(value)).toISOString()) } },
            y: { title: { display: true, text: "保存価格（円）" },
                ticks: { callback: value => Number(value).toLocaleString("ja-JP") } } },
            plugins: { tooltip: { callbacks: { title: items => items[0]?.raw?.observedAt ?
                `${jstDateTime(items[0].raw.observedAt)} JST` : "",
            label: context => `${context.dataset.label}：${price(context.raw?.y)}`,
            afterLabel: context => context.raw?.finalObservation ? "最終保存断面と同時刻・同価格" : "" } } }
        } });
        return { chart, model };
    }
    function render(panel, result, ChartConstructor = globalThis.Chart) {
        panel.querySelector("#timeTravelSelectedDate").textContent = japaneseDate(result.calendarDate);
        const observation = panel.querySelector("#timeTravelObservation"), morning = panel.querySelector(
            "#timeTravelMorning"), qri = panel.querySelector("#timeTravelQriStatus");
        const status = panel.querySelector("#timeTravelArchiveStatus");
        if (status) status.textContent = result.status === "partial" ? "一部保存済み（partial）：category別の保存状況を確認してください" :
            result.available ? "保存済みの履歴・現在値ではありません" :
                result.status === "unavailable" ? "unavailable：保存履歴を確認できません" : "保存データなし";
        observation.replaceChildren(); morning.replaceChildren();
        if (result.status === "schema_mismatch") {
            append(panel.ownerDocument, observation, "p", "time-travel-empty", "保存データの形式が一致しません");
        } else if (result.status === "unavailable") {
            append(panel.ownerDocument, observation, "p", "time-travel-empty", "保存データを読み込めませんでした");
        } else {
            const view = observationView(result.latestObservation);
            if (!view) append(panel.ownerDocument, observation, "p", "time-travel-empty", "最終保存断面：保存なし");
            else {
                append(panel.ownerDocument, observation, "h3", "", "最終保存断面");
                append(panel.ownerDocument, observation, "p", "optionmap-historical-saved-at", `保存時刻：${view.savedTime} JST`);
                append(panel.ownerDocument, observation, "p", "optionmap-historical-note",
                    `観測日：${view.calendarDay || result.calendarDate} ／ marketDate：${view.marketDate || "未保存"} ／ ` +
                    `tradingDate：${view.tradingDate || "未保存"} ／ 価格限月：${view.contract || "未保存"}`);
                if (view.priceReason) append(panel.ownerDocument, observation, "p", "time-travel-empty", view.priceReason);
                const summary = append(panel.ownerDocument, observation, "div", "optionmap-historical-metrics", "");
                metric(panel.ownerDocument, summary, "総合方向", view.direction, "optionmap-historical-direction");
                metric(panel.ownerDocument, summary, "方向スコア", number(result.latestObservation?.overallV2?.direction) === null ?
                    "—" : String(result.latestObservation.overallV2.direction));
                metric(panel.ownerDocument, summary, "信頼度", percentage(view.confidence));
                metric(panel.ownerDocument, summary, "データ充足率", percentage(view.coverage));
                metric(panel.ownerDocument, observation, "保存価格", price(view.price), "optionmap-historical-price");
                const components = append(panel.ownerDocument, observation, "div", "optionmap-historical-components", "");
                metric(panel.ownerDocument, components, "オプション市場", view.option);
                metric(panel.ownerDocument, components, "主要5社週次", view.weekly);
                append(panel.ownerDocument, observation, "p", "optionmap-historical-quality",
                    `データ品質：${qualityLabel(view.quality)}`);
                if (view.warnings.length) append(panel.ownerDocument, observation, "p", "optionmap-historical-warnings",
                    `注意事項：${view.warnings.join(" / ")}`);
            }
            const baselines = morningView(result.morningBaselines);
            append(panel.ownerDocument, morning, "h3", "", "Morning Baseline");
            if (!baselines.length) append(panel.ownerDocument, morning, "p", "time-travel-empty", "保存なし");
            else baselines.forEach(value => append(panel.ownerDocument, morning, "p", "",
                `${value.contract} ／ ${value.capturedTime} JST ／ 総合方向：${value.direction} ／ 保存価格：${price(value.price)}`));
        }
        const labels = { saved: "保存済み", missing: "保存なし", unavailable: "unavailable" };
        for (const [key, element] of [["observation", observation], ["morning", morning]]) {
            const section = result.sections?.[key];
            if (section) append(panel.ownerDocument, element, "p", "optionmap-historical-note",
                `${labels[section.status]}${section.reason ? `：${section.reason}` : ""}`);
        }
        const timeline = panel.querySelector("#timeTravelTimeline");
        if (timeline) {
            timeline.replaceChildren(); append(panel.ownerDocument, timeline, "h3", "", "この日の観測timeline");
            if (!result.observations?.length) append(panel.ownerDocument, timeline, "p", "time-travel-empty",
                result.sections?.observation?.status === "unavailable" ? "unavailable" : "保存なし");
            for (const record of result.observations || []) {
                const row = observationView(record);
                append(panel.ownerDocument, timeline, "p", "", `${row.savedTime} JST ／ ${price(row.price)} ／ ` +
                    `${row.direction} ／ marketDate ${row.marketDate || "未保存"}`);
            }
        }
        const calendar = panel.querySelector("#timeTravelCalendar");
        if (calendar) {
            calendar.replaceChildren(); append(panel.ownerDocument, calendar, "h3", "", "当時保存済みだった経済イベント");
            append(panel.ownerDocument, calendar, "p", "optionmap-historical-note", "選択日のJST終了時点で既知だった履歴。後日追加された情報は含みません。");
            const section = result.sections?.calendar;
            if (section?.status !== "saved") append(panel.ownerDocument, calendar, "p", "time-travel-empty",
                `${labels[section?.status] || "保存なし"}${section?.reason ? `：${section.reason}` : ""}`);
            for (const event of result.calendarEvents || []) append(panel.ownerDocument, calendar, "p", "",
                `${event.revision.title?.ja || event.revision.title?.en || event.revision.eventKey} ／ ` +
                `${event.revision.lifecycleStatus} ／ 保存開始 ${jstDateTime(event.revision.validFrom)} JST`);
        }
        qri.textContent = result.qri.available ? `保存済み限月：${result.qri.contracts.join("、")}。` +
            (result.qri.revisions || []).map(item => `${jstTime(item.revision.confirmedAt)} JST ／ ` +
                `sourceDateKey ${item.sourceDateKey} ／ ${item.revision.versionKey}`).join("、") :
            result.sections?.qri?.status === "unavailable" ? "QRI：unavailable" : "QRI：この日の保存なし";
        return renderPriceChart(panel, result, ChartConstructor);
    }
    function create({ document = globalThis.document, indexedDB = globalThis.indexedDB,
        localStorage = globalThis.localStorage, now = () => new Date(),
        read = readModel.read,
        ChartConstructor = globalThis.Chart } = {}) {
        const action = document.getElementById("marketCalendarTimeTravelAction"),
            actionStatus = document.getElementById("marketCalendarTimeTravelStatus"),
            button = document.getElementById("marketCalendarTimeTravelButton"),
            panel = document.getElementById("optionMapHistoricalView"),
            close = document.getElementById("timeTravelReturnToday");
        let selectedDate = null, availabilityGeneration = 0, viewGeneration = 0, priceChart = null;
        const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit" }).format(now());
        async function selected(event) {
            const date = event?.detail?.calendarDate;
            if (!validDate(date)) return;
            clearHistorical(); selectedDate = date; const own = ++availabilityGeneration; action.hidden = date >= today();
            button.hidden = true; actionStatus.textContent = "";
            if (action.hidden) return;
            actionStatus.textContent = "保存履歴を確認中…";
            const result = await safeRead(date);
            if (own !== availabilityGeneration || selectedDate !== date) return;
            if (result.available) { button.hidden = false; actionStatus.textContent = ""; }
            else actionStatus.textContent = result.status === "schema_mismatch" ?
                "保存データの形式が一致しません" : result.status === "unavailable" ?
                    "保存履歴を読み込めません（unavailable）" : "この日のOptionMap保存データはありません";
        }
        async function open() {
            const date = selectedDate; if (!date || date >= today() || button.hidden) return;
            const own = ++viewGeneration; button.disabled = true;
            const result = await safeRead(date);
            if (own !== viewGeneration || date !== selectedDate) return;
            button.disabled = false;
            if (!result.available) { actionStatus.textContent = result.status === "unavailable" ?
                "保存履歴を読み込めません（unavailable）" : "この日のOptionMap保存データはありません"; return; }
            priceChart?.destroy?.(); priceChart = render(panel, result, ChartConstructor).chart;
            panel.hidden = false; panel.scrollIntoView?.({ block: "start" });
        }
        async function safeRead(date) {
            try { return await read({ calendarDate: date, indexedDB, localStorage }); }
            catch (_error) { return { calendarDate: date, status: "unavailable", available: false }; }
        }
        function clearHistorical() {
            ++viewGeneration; priceChart?.destroy?.(); priceChart = null; panel.hidden = true; button.disabled = false;
            for (const id of ["timeTravelObservation", "timeTravelMorning", "timeTravelTimeline", "timeTravelCalendar"]) {
                panel.querySelector(`#${id}`)?.replaceChildren();
            }
            for (const id of ["timeTravelSelectedDate", "timeTravelArchiveStatus", "timeTravelQriStatus",
                "timeTravelPriceChartSummary", "timeTravelPriceChartRange", "timeTravelPriceChartEmpty"]) {
                const element = panel.querySelector(`#${id}`); if (element) element.textContent = "";
            }
            const container = panel.querySelector("#timeTravelPriceChartContainer"); if (container) container.hidden = true;
        }
        function returnToday() { ++availabilityGeneration; selectedDate = null; clearHistorical();
            button.hidden = true; action.hidden = true; actionStatus.textContent = "";
            document.getElementById("marketCalendarToday")?.click?.(); }
        document.addEventListener("optionmap:calendar-date-selected", selected);
        button.addEventListener("click", open); close.addEventListener("click", returnToday);
        for (const id of ["marketCalendarPreviousMonth", "marketCalendarNextMonth", "marketCalendarToday"]) {
            document.getElementById(id)?.addEventListener("click", () => {
                ++availabilityGeneration; selectedDate = null; clearHistorical();
                button.hidden = true; action.hidden = true; actionStatus.textContent = "";
            });
        }
        return Object.freeze({ selected, open, returnToday, get selectedDate() { return selectedDate; } });
    }
    if (typeof document !== "undefined") {
        const mount = () => create();
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
        else mount();
    }
    return Object.freeze({ FINAL_OBSERVATION_MATCH_TOLERANCE_MS, create, render, renderPriceChart,
        priceChartModel, finalObservationSnapshot, observationView, morningView, japaneseDate });
});
