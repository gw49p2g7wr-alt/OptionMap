(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapWallHistoryDrawerView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const text = (documentRef, id, value) => { const node = documentRef.getElementById(id);
        if (node) node.textContent = value == null ? "—" : String(value); };
    const number = value => Number.isFinite(value) ? value.toLocaleString("ja-JP") : "—";
    const signed = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${number(value)}` : "—";
    function create({ documentRef, ChartConstructor } = {}) {
        const drawer = documentRef?.getElementById("wallHistoryDrawer"), backdrop =
            documentRef?.getElementById("wallHistoryDrawerBackdrop");
        let oiChart = null, ivChart = null, referenceChart = null, returnFocus = null;
        function destroyCharts() { [oiChart, ivChart, referenceChart].forEach(chart => chart?.destroy?.());
            oiChart = null; ivChart = null; referenceChart = null; }
        function close() { if (!drawer || drawer.hidden) return false; destroyCharts(); drawer.hidden = true;
            if (backdrop) backdrop.hidden = true; documentRef.body?.classList?.remove("wall-history-open");
            const focusTarget = returnFocus; returnFocus = null; focusTarget?.focus?.(); return true; }
        function openLoading(trigger) { if (!drawer) return false; returnFocus = trigger || documentRef.activeElement;
            drawer.hidden = false; if (backdrop) backdrop.hidden = false;
            documentRef.body?.classList?.add("wall-history-open");
            text(documentRef, "wallHistoryDrawerStatus", "Wall Historyを読み込み中…");
            documentRef.getElementById("wallHistoryDrawerContent")?.setAttribute("hidden", "");
            documentRef.getElementById("wallHistoryDrawerClose")?.focus?.(); return true; }
        function renderTable(model) {
            const body = documentRef.getElementById("wallHistoryObservationBody"); if (!body) return;
            const rows = model.observations.map(item => { const row = documentRef.createElement("tr");
                [item.tradingDate, item.state, number(item.openInterest), signed(item.previousObservationDelta),
                    number(item.rank), signed(item.rankChange), item.shrinkState, item.zeroState,
                    item.ivStatus === "available" ? number(item.iv) : item.ivStatus,
                    item.sourceRevision || "—"].forEach(value => { const cell = documentRef.createElement("td");
                    cell.textContent = value; row.appendChild(cell); }); return row; });
            body.replaceChildren(...rows);
        }
        function lineChart(canvasId, labels, datasets, yTitle) { const canvas = documentRef.getElementById(canvasId);
            if (!canvas || typeof ChartConstructor !== "function") return null;
            return new ChartConstructor(canvas, { type: "line", data: { labels, datasets }, options: {
                responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
                interaction: { mode: "index", intersect: false }, plugins: { legend: { display: true } },
                scales: { y: { title: { display: true, text: yTitle } } } } }); }
        function render(model) {
            destroyCharts(); text(documentRef, "wallHistoryDrawerTitle",
                `${model.contract} ${number(model.strike)} ${model.side.toUpperCase()}`);
            text(documentRef, "wallHistoryIdentity", model.wallIdentity);
            text(documentRef, "wallHistoryFirstSeen", model.firstSeenDate);
            text(documentRef, "wallHistoryMax", `${number(model.maxOi)}枚 / ${model.maxOiDate || "—"}`);
            text(documentRef, "wallHistoryLatestDelta", signed(model.latestObserved?.previousObservationDelta));
            text(documentRef, "wallHistoryLatestRank", model.latestObserved ?
                `${number(model.latestObserved.rank)}（変化 ${signed(model.latestObserved.rankChange)}）` : "—");
            text(documentRef, "wallHistoryLatestState", model.latestObserved ?
                `${model.latestObserved.shrinkState} / ${model.latestObserved.zeroState}` : "—");
            text(documentRef, "wallHistoryCoverage", `observed ${model.coverage.observedCount || 0} / ` +
                `missing ${model.coverage.missingCount || 0} / notPublished ${model.coverage.notPublishedCount || 0} / ` +
                `gap ${model.coverage.gapEventCount || 0}`);
            text(documentRef, "wallHistoryIvCoverage", `${model.coverage.ivObservedCount || 0} / ` +
                `${model.coverage.observationCount || 0}`);
            text(documentRef, "wallHistoryQuality", model.quality.complete ? "complete" :
                `incomplete（${model.quality.gapBasis || "欠測あり"}）`);
            text(documentRef, "wallHistoryUnavailableFacts", model.unavailableFacts.map(item =>
                `${item.name}: ${item.note}`).join(" / "));
            const gapList = documentRef.getElementById("wallHistoryGapList");
            if (gapList) gapList.textContent = model.gaps.length ? model.gaps.map(gap =>
                `${gap.afterTradingDate} → ${gap.beforeTradingDate}: ${gap.candidateDates.join(", ")}`).join("\n") : "gapなし";
            renderTable(model);
            const labels = model.observations.map(item => item.tradingDate);
            oiChart = lineChart("wallHistoryOiChart", labels, [{ label: "OI", data: model.observations.map(item =>
                item.state === "observed" ? item.openInterest : null), borderColor: "#5468ff",
                backgroundColor: "rgba(84,104,255,.14)", pointRadius: 3 }], "枚");
            const ivSection = documentRef.getElementById("wallHistoryIvSection");
            if (ivSection) ivSection.hidden = false;
            const ivUnavailable = documentRef.getElementById("wallHistoryIvUnavailable");
            if (ivUnavailable) ivUnavailable.hidden = model.coverage.ivObservedCount > 0;
            const ivCanvas = documentRef.getElementById("wallHistoryIvChart");
            if (ivCanvas?.parentElement) ivCanvas.parentElement.hidden = model.coverage.ivObservedCount === 0;
            if (model.coverage.ivObservedCount > 0) ivChart = lineChart("wallHistoryIvChart", labels,
                [{ label: "IV", data: model.observations.map(item => item.ivStatus === "available" ? item.iv : null),
                    borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.12)", pointRadius: 3 }], "IV");
            const referenceSection = documentRef.getElementById("wallHistoryReferenceSection");
            if (referenceSection) referenceSection.hidden = !model.reference;
            if (model.reference) referenceChart = lineChart("wallHistoryReferenceChart",
                model.reference.observations.map(item => item.tradingDate), [{ label: "reference価格",
                    data: model.reference.observations.map(item => item.price), borderColor: "#0f9d74",
                    pointRadius: 3 }], "価格");
            text(documentRef, "wallHistoryDrawerStatus", "");
            documentRef.getElementById("wallHistoryDrawerContent")?.removeAttribute("hidden");
        }
        function showError(message) { destroyCharts(); text(documentRef, "wallHistoryDrawerStatus", message);
            documentRef.getElementById("wallHistoryDrawerContent")?.setAttribute("hidden", ""); }
        return Object.freeze({ openLoading, render, showError, close, isOpen: () => drawer?.hidden === false });
    }
    return Object.freeze({ create });
});
