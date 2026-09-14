(function (root, factory) {
    const presentation = typeof module === "object" && module.exports
        ? require("./strikeBarChartPresentation.js") : root?.OptionMapStrikeBarChartPresentation;
    const api = factory(presentation);
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriTimeTravelView = api;
})(typeof window !== "undefined" ? window : globalThis, function (presentation) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function create({ documentRef, ChartConstructor, readHistory, readIvHistory, stateApi, projectionApi,
        selectionApi, openWallHistory, optionColors, now = () => new Date().toISOString() } = {}) {
        const get = id => documentRef?.getElementById?.(id) || null;
        const dom = { panel: get("historicalQriPanel"), contract: get("historyContractSelect"),
            date: get("historyDateSelect"), prev: get("timeTravelPreviousDate"), next: get("timeTravelNextDate"),
            current: get("timeTravelReturnCurrent"), single: get("timeTravelSingleMode"),
            aggregate: get("timeTravelAggregateMode"), contracts: get("timeTravelAggregateContracts"),
            banner: get("timeTravelBanner"), bannerText: get("timeTravelBannerText"),
            state: get("historicalQriState"), content: get("historicalQriContent"),
            metadata: get("historicalQriMetadata"), topCall: get("timeTravelTopCall"),
            topPut: get("timeTravelTopPut"), comparison: get("timeTravelComparison"),
            coverage: get("timeTravelCoverage"), ivCoverage: get("timeTravelIvCoverage"),
            legend: get("historicalQriChartLegend"),
            chartContainer: get("historicalQriChartContainer"), plot: get("historicalQriChartPlot"),
            canvas: get("historicalQriOpenInterestChart"), developer: get("historicalQriDeveloperDetails") };
        let history = null, ivHistory = null, loading = null, chart = null, generation = 0, initialized = false;
        let pendingNavigation = null, navigationSourceRevision = null;
        const gesture = selectionApi?.createGestureGuard?.();
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
            li.textContent += item.iv?.status === "available" ? ` IV ${item.iv.value}` : " IV欠測";
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
            dom.ivCoverage.textContent = projection.ivCoverage.reason === "aggregate_not_applicable"
                ? "IV coverage：複数限月合算では対象外（IVは合成しません）"
                : `IV coverage：observed ${projection.ivCoverage.observed}/${projection.ivCoverage.eligible}` +
                    ` / missing ${projection.ivCoverage.missing}（完全一致のみ・補完なし）`;
            dom.metadata.textContent = `active revision：${Array.isArray(projection.selectedRevision)
                ? projection.selectedRevision.length + "限月" : projection.selectedRevision}`;
            if (navigationSourceRevision && navigationSourceRevision !== projection.selectedRevision)
                dom.metadata.textContent += " / 遷移元は旧revisionのためactive revisionで再表示";
            dom.developer.textContent = JSON.stringify({ identity: projection.identity,
                selectedRevision: projection.selectedRevision, quality: projection.quality }, null, 2);
            destroyChart(); presentation?.preparePlot?.({ container: dom.chartContainer, plot: dom.plot,
                strikeCount: projection.chartData.strikes.length }); chart = new ChartConstructor(dom.canvas, { type: "bar",
                data: { labels: projection.chartData.strikes.map(String), datasets: [
                    { label: "CALL建玉残", optionSide: "call", data: projection.chartData.callOpenInterest,
                        backgroundColor: optionColors.call, borderColor: optionColors.call, borderWidth: 1,
                        ...presentation.DATASET_OPTIONS }, { label: "PUT建玉残",
                        optionSide: "put", data: projection.chartData.putOpenInterest, backgroundColor: optionColors.put,
                        borderColor: optionColors.put, borderWidth: 1, ...presentation.DATASET_OPTIONS }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false,
                    scales: { x: { title: { display: true, text: "権利行使価格" } },
                        y: { beginAtZero: true, title: { display: true, text: "建玉残" } } },
                    plugins: { legend: { display: false } } } }); dom.chartContainer.hidden = false;
            presentation.renderLegend?.({ documentRef, legend: dom.legend, datasets: chart.data.datasets });
            return publish("available", null, projection);
        }
        function rebuild(patch = {}) { navigationSourceRevision = null;
            session = stateApi.transition(session, patch);
            return renderProjection(projectionApi.build({ history, ivHistory, state: session })); }
        async function ensureHistory() { if (history && ivHistory) return history; if (!loading) loading = Promise.all([
            history ? { status: "ready", history } : Promise.resolve().then(() => readHistory()),
            ivHistory ? { status: "ready", history: ivHistory } :
                Promise.resolve().then(() => readIvHistory?.()).catch(() => null)]).then(([oi, iv]) => {
                if (oi?.status !== "ready" || !oi.history) throw new Error("read_failed");
                history = clone(oi.history); ivHistory = iv?.status === "ready" && iv.history
                    ? clone(iv.history) : null; return history; }).finally(() => { loading = null; }); return loading; }
        async function open() { const own = ++generation; publish("loading"); try { await ensureHistory();
            if (own !== generation || !dom.panel.open) return publish("stale_ignored", "stale_render");
            const inv = projectionApi.inventory(history), contract = session.selectedContract || inv.contracts[0],
                date = session.selectedTradingDate || inv.dates.at(-1);
            const navigation = pendingNavigation; pendingNavigation = null;
            session = stateApi.transition(session, { mode: "historical", selectedContract: contract,
                selectedContracts: session.selectedContracts.length ? session.selectedContracts : [contract],
                selectedTradingDate: date, ...(navigation || {}),
                selectedRevision: { policy: "active", versionKey: null } });
            return renderProjection(projectionApi.build({ history, ivHistory, state: session }));
        } catch (error) { dom.state.textContent = "保存済みQRI履歴を読み込めませんでした";
            return publish("invalid", error.message); } }
        function close() { ++generation; pendingNavigation = null; navigationSourceRevision = null;
            destroyChart(); session = stateApi.returnLive(session);
            dom.banner.hidden = true; dom.content.hidden = true; return publish("closed"); }
        function onContract() { rebuild({ selectedContract: dom.contract.value }); }
        function onDate() { rebuild({ selectedTradingDate: dom.date.value }); }
        function move(offset) { const projection = projectionApi.build({ history, state: session }),
            dates = navigationDates(projection), index = dates.indexOf(session.selectedTradingDate), next = dates[index + offset];
            if (next) rebuild({ selectedTradingDate: next }); }
        function onAggregateContracts() { const selected = [...dom.contracts.querySelectorAll("input:checked")]
            .map(input => input.value); rebuild({ selectedContracts: selected }); }
        function historicalIdentity() { return { rendererKind: "formal", displayOnly: false,
            mode: "openInterest", contract: session.viewMode === "single_contract"
                ? session.selectedContract : null, generation: session.generation }; }
        function onChartClick(event) { if (gesture?.shouldSuppressClick?.() || session.viewMode !== "single_contract") return;
            const identity = historicalIdentity(), selected = selectionApi?.select?.({ chart, event,
                rendererIdentity: identity, currentIdentity: historicalIdentity() });
            if (!selected || typeof openWallHistory !== "function") return;
            const anchorTradingDate = session.selectedTradingDate, selectedRevision = current.projection?.selectedRevision;
            const ownChart = chart, ownSessionGeneration = session.generation;
            openWallHistory({ ...selected, anchorTradingDate, sourceRevision: selectedRevision,
                trigger: dom.canvas, isCurrent: () => dom.panel.open && chart === ownChart &&
                    session.generation === ownSessionGeneration });
        }
        function navigate(input = {}) { pendingNavigation = { viewMode: "single_contract",
            selectedTradingDate: input.selectedTradingDate, selectedContract: input.selectedContract,
            selectedContracts: [input.selectedContract], selectedRevision: { policy: "active", versionKey: null } };
            navigationSourceRevision = input.navigationSourceRevision || null;
            if (!dom.panel.open) { dom.panel.open = true; return getState(); } return open(); }
        function initialize() { if (initialized) return getState(); initialized = true;
            dom.panel.addEventListener("toggle", () => dom.panel.open ? void open() : close());
            dom.contract.addEventListener("change", onContract); dom.date.addEventListener("change", onDate);
            dom.prev.addEventListener("click", () => move(-1)); dom.next.addEventListener("click", () => move(1));
            dom.current.addEventListener("click", () => { dom.panel.open = false; close(); });
            dom.single.addEventListener("click", () => rebuild({ viewMode: "single_contract" }));
            dom.aggregate.addEventListener("click", () => rebuild({ viewMode: "aggregate" }));
            dom.canvas.addEventListener("pointerdown", event => gesture?.pointerDown?.(event));
            dom.canvas.addEventListener("pointermove", event => gesture?.pointerMove?.(event));
            dom.canvas.addEventListener("pointerup", event => gesture?.pointerUp?.(event));
            dom.canvas.addEventListener("pointercancel", event => gesture?.pointerUp?.(event));
            dom.canvas.addEventListener("click", onChartClick); return getState(); }
        return Object.freeze({ initialize, open, close, getState, selectContract: onContract,
            selectDate: onDate, previousDate: () => move(-1), nextDate: () => move(1), navigate });
    }
    return Object.freeze({ create });
});
