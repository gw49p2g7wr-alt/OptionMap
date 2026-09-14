(function (root, factory) {
    const presentation = typeof module === "object" && module.exports
        ? require("./strikeBarChartPresentation.js") : root?.OptionMapStrikeBarChartPresentation;
    const api = factory(presentation);
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriTimeTravelView = api;
})(typeof window !== "undefined" ? window : globalThis, function (presentation) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function create({ documentRef, ChartConstructor, readHistory, stateApi, projectionApi, optionColors,
        now = () => new Date().toISOString() } = {}) {
        const get = id => documentRef?.getElementById?.(id) || null;
        const dom = { panel: get("historicalQriPanel"), contract: get("historyContractSelect"),
            date: get("historyDateSelect"), prev: get("timeTravelPreviousDate"), next: get("timeTravelNextDate"),
            current: get("timeTravelReturnCurrent"), single: get("timeTravelSingleMode"),
            aggregate: get("timeTravelAggregateMode"), contracts: get("timeTravelAggregateContracts"),
            banner: get("timeTravelBanner"), bannerText: get("timeTravelBannerText"),
            state: get("historicalQriState"), content: get("historicalQriContent"),
            metadata: get("historicalQriMetadata"), topCall: get("timeTravelTopCall"),
            topPut: get("timeTravelTopPut"), comparison: get("timeTravelComparison"),
            coverage: get("timeTravelCoverage"), legend: get("historicalQriChartLegend"),
            chartContainer: get("historicalQriChartContainer"), plot: get("historicalQriChartPlot"),
            canvas: get("historicalQriOpenInterestChart"), developer: get("historicalQriDeveloperDetails") };
        let history = null, loading = null, chart = null, generation = 0, initialized = false;
        let session = stateApi.create(), current = Object.freeze({ status: "closed", session });
        const publish = (status, reason = null, projection = null) => { current = Object.freeze({ status, reason,
            session: stateApi.create(session), projection: projection ? clone(projection) : null,
            readOnly: true, renderedAt: projection ? now() : null }); return current; };
        const getState = () => Object.freeze(clone(current));
        function destroyChart() { chart?.destroy?.(); chart = null; }
        function option(select, value, label = value) { const node = documentRef.createElement("option");
            node.value = value; node.textContent = label; select.append(node); }
        function renderSelectors(projection) {
            const contracts = projection.contracts || []; dom.contract.replaceChildren();
            contracts.forEach(value => option(dom.contract, value)); dom.contract.value = session.selectedContract || "";
            dom.contract.disabled = contracts.length === 0;
            dom.date.min = projection.dates[0] || ""; dom.date.max = projection.dates.at(-1) || "";
            dom.date.value = session.selectedTradingDate || ""; dom.date.disabled = projection.dates.length === 0;
            dom.contracts.replaceChildren(...contracts.map(value => { const label = documentRef.createElement("label"),
                input = documentRef.createElement("input"); input.type = "checkbox"; input.value = value;
                input.checked = session.selectedContracts.includes(value); input.addEventListener("change", onAggregateContracts);
                label.append(input, documentRef.createTextNode(value)); return label; }));
            dom.single.setAttribute("aria-pressed", String(session.viewMode === "single_contract"));
            dom.aggregate.setAttribute("aria-pressed", String(session.viewMode === "aggregate"));
            dom.contract.hidden = session.viewMode === "aggregate"; dom.contracts.hidden = session.viewMode !== "aggregate";
            const dates = navigationDates(projection); const index = dates.indexOf(session.selectedTradingDate);
            dom.prev.disabled = index <= 0; dom.next.disabled = index < 0 || index >= dates.length - 1;
        }
        function navigationDates(projection) { const selected = session.viewMode === "aggregate"
            ? session.selectedContracts : [session.selectedContract]; return (projection.availability || [])
            .filter(item => selected.length && selected.every(c => item.contracts.includes(c)))
            .map(item => item.tradingDate); }
        function list(node, values) { node.replaceChildren(...values.map(item => { const li = documentRef.createElement("li");
            li.textContent = `${item.rank}位 ${item.strike.toLocaleString()}円・${item.oi.toLocaleString()}枚`;
            li.textContent += item.previousSavedObservationDelta === null ? "（前回比較なし）"
                : `（前回保存観測比 ${item.previousSavedObservationDelta >= 0 ? "+" : ""}` +
                    `${item.previousSavedObservationDelta.toLocaleString()}）`;
            return li; })); }
        function renderProjection(projection) {
            renderSelectors(projection); dom.banner.hidden = false; dom.bannerText.textContent =
                `過去表示：${session.selectedTradingDate}／${session.viewMode === "aggregate"
                    ? session.selectedContracts.join("＋") : `${session.selectedContract}限`}`;
            if (projection.status !== "available") { destroyChart(); dom.content.hidden = true;
                dom.state.hidden = false; dom.state.textContent = projection.reason === "snapshot_not_saved"
                    ? `${session.selectedTradingDate}の${projection.missingContracts.join("・")}限snapshotはありません。現在値では補完しません。`
                    : "選択した保存断面を表示できません。"; return publish("unavailable", projection.reason, projection); }
            dom.state.hidden = true; dom.content.hidden = false; list(dom.topCall, projection.top3.call);
            list(dom.topPut, projection.top3.put); dom.comparison.textContent = projection.previousTradingDate
                ? `前回保存観測比：${projection.previousTradingDate} → ${session.selectedTradingDate}`
                : "前回保存観測比：比較対象なし";
            dom.coverage.textContent = `coverage：observed ${projection.coverage.observed}/${projection.coverage.total}` +
                ` / notPublished ${projection.coverage.notPublished} / comparable ${projection.coverage.comparable}`;
            dom.metadata.textContent = `active revision：${Array.isArray(projection.selectedRevision)
                ? projection.selectedRevision.length + "限月" : projection.selectedRevision}`;
            dom.developer.textContent = JSON.stringify({ identity: projection.identity,
                selectedRevision: projection.selectedRevision, quality: projection.quality }, null, 2);
            destroyChart(); presentation?.preparePlot?.({ container: dom.chartContainer, plot: dom.plot,
                strikeCount: projection.chartData.strikes.length }); chart = new ChartConstructor(dom.canvas, { type: "bar",
                data: { labels: projection.chartData.strikes.map(String), datasets: [
                    { label: "CALL建玉残", data: projection.chartData.callOpenInterest,
                        backgroundColor: optionColors.call, borderColor: optionColors.call, borderWidth: 1,
                        ...presentation.DATASET_OPTIONS }, { label: "PUT建玉残",
                        data: projection.chartData.putOpenInterest, backgroundColor: optionColors.put,
                        borderColor: optionColors.put, borderWidth: 1, ...presentation.DATASET_OPTIONS }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false,
                    scales: { x: { title: { display: true, text: "権利行使価格" } },
                        y: { beginAtZero: true, title: { display: true, text: "建玉残" } } },
                    plugins: { legend: { display: false } } } }); dom.chartContainer.hidden = false;
            presentation.renderLegend?.({ documentRef, legend: dom.legend, datasets: chart.data.datasets });
            return publish("available", null, projection);
        }
        function rebuild(patch = {}) { session = stateApi.transition(session, patch);
            return renderProjection(projectionApi.build({ history, state: session })); }
        async function ensureHistory() { if (history) return history; if (!loading) loading = Promise.resolve(readHistory())
            .then(value => { if (value?.status !== "ready" || !value.history) throw new Error("read_failed");
                history = clone(value.history); return history; }).finally(() => { loading = null; }); return loading; }
        async function open() { const own = ++generation; publish("loading"); try { await ensureHistory();
            if (own !== generation || !dom.panel.open) return publish("stale_ignored", "stale_render");
            const inv = projectionApi.inventory(history), contract = session.selectedContract || inv.contracts[0],
                date = session.selectedTradingDate || inv.dates.at(-1);
            session = stateApi.transition(session, { mode: "historical", selectedContract: contract,
                selectedContracts: session.selectedContracts.length ? session.selectedContracts : [contract],
                selectedTradingDate: date }); return renderProjection(projectionApi.build({ history, state: session }));
        } catch (error) { dom.state.textContent = "保存済みQRI履歴を読み込めませんでした";
            return publish("invalid", error.message); } }
        function close() { ++generation; destroyChart(); session = stateApi.returnLive(session);
            dom.banner.hidden = true; dom.content.hidden = true; return publish("closed"); }
        function onContract() { rebuild({ selectedContract: dom.contract.value }); }
        function onDate() { rebuild({ selectedTradingDate: dom.date.value }); }
        function move(offset) { const projection = projectionApi.build({ history, state: session }),
            dates = navigationDates(projection), index = dates.indexOf(session.selectedTradingDate), next = dates[index + offset];
            if (next) rebuild({ selectedTradingDate: next }); }
        function onAggregateContracts() { const selected = [...dom.contracts.querySelectorAll("input:checked")]
            .map(input => input.value); rebuild({ selectedContracts: selected }); }
        function initialize() { if (initialized) return getState(); initialized = true;
            dom.panel.addEventListener("toggle", () => dom.panel.open ? void open() : close());
            dom.contract.addEventListener("change", onContract); dom.date.addEventListener("change", onDate);
            dom.prev.addEventListener("click", () => move(-1)); dom.next.addEventListener("click", () => move(1));
            dom.current.addEventListener("click", () => { dom.panel.open = false; close(); });
            dom.single.addEventListener("click", () => rebuild({ viewMode: "single_contract" }));
            dom.aggregate.addEventListener("click", () => rebuild({ viewMode: "aggregate" })); return getState(); }
        return Object.freeze({ initialize, open, close, getState, selectContract: onContract,
            selectDate: onDate, previousDate: () => move(-1), nextDate: () => move(1) });
    }
    return Object.freeze({ create });
});
