(function (root, factory) {
    const model = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./timeTravel/optionMapHistoricalReadModel.js") : root?.OptionMapHistoricalReadModel;
    const api = factory(model);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapTimeTravelMvp = api;
})(typeof window !== "undefined" ? window : globalThis, function (readModel) {
    "use strict";
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
    const jstTime = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
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
            price: item.baseline.currentPrice?.available ? item.baseline.currentPrice.value : null }));
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
    function render(panel, result) {
        panel.querySelector("#timeTravelSelectedDate").textContent = japaneseDate(result.calendarDate);
        const observation = panel.querySelector("#timeTravelObservation"), morning = panel.querySelector(
            "#timeTravelMorning"), qri = panel.querySelector("#timeTravelQriStatus");
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
        qri.textContent = result.qri.available ? `保存済み限月：${result.qri.contracts.join("、")}。下のQRI Time Travelに表示します。` :
            "QRI Time Travel：この日の保存なし";
    }
    function create({ document = globalThis.document, indexedDB = globalThis.indexedDB,
        localStorage = globalThis.localStorage, now = () => new Date(),
        openQri = input => globalThis.openQriTimeTravel?.(input), read = readModel.read } = {}) {
        const action = document.getElementById("marketCalendarTimeTravelAction"),
            actionStatus = document.getElementById("marketCalendarTimeTravelStatus"),
            button = document.getElementById("marketCalendarTimeTravelButton"),
            panel = document.getElementById("optionMapHistoricalView"),
            close = document.getElementById("timeTravelReturnToday");
        let selectedDate = null, availabilityGeneration = 0, viewGeneration = 0;
        const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit" }).format(now());
        async function selected(event) {
            const date = event?.detail?.calendarDate;
            if (!validDate(date)) return;
            selectedDate = date; const own = ++availabilityGeneration; action.hidden = date >= today();
            button.hidden = true; actionStatus.textContent = "";
            if (action.hidden) return;
            actionStatus.textContent = "保存履歴を確認中…";
            const result = await read({ calendarDate: date, indexedDB, localStorage });
            if (own !== availabilityGeneration || selectedDate !== date) return;
            if (result.available) { button.hidden = false; actionStatus.textContent = ""; }
            else actionStatus.textContent = result.status === "schema_mismatch" ?
                "保存データの形式が一致しません" : "この日のOptionMap保存データはありません";
        }
        async function open() {
            const date = selectedDate; if (!date) return;
            const own = ++viewGeneration; button.disabled = true;
            const result = await read({ calendarDate: date, indexedDB, localStorage });
            if (own !== viewGeneration || date !== selectedDate) return;
            button.disabled = false;
            if (!result.available) { actionStatus.textContent = "この日のOptionMap保存データはありません"; return; }
            render(panel, result); panel.hidden = false; panel.scrollIntoView?.({ block: "start" });
            if (result.qri.available) openQri({ selectedTradingDate: date,
                selectedContract: result.qri.selectedContract });
        }
        function returnToday() { ++viewGeneration; panel.hidden = true;
            document.getElementById("marketCalendarToday")?.click?.(); }
        document.addEventListener("optionmap:calendar-date-selected", selected);
        button.addEventListener("click", open); close.addEventListener("click", returnToday);
        return Object.freeze({ selected, open, returnToday, get selectedDate() { return selectedDate; } });
    }
    if (typeof document !== "undefined") {
        const mount = () => create();
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
        else mount();
    }
    return Object.freeze({ create, render, observationView, morningView, japaneseDate });
});
