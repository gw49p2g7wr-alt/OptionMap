(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoricalAggregationView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    const ERROR_MESSAGES = Object.freeze({
        not_enough_contracts: "合算する保存済み限月を2つ以上選択してください",
        no_common_date: "選択した限月に共通する保存日はありません",
        snapshot_unavailable: "選択した保存snapshotを利用できません",
        snapshot_invalid: "保存snapshotの整合性を確認できません",
        trading_date_mismatch: "保存snapshotの取引日が一致しません",
        no_records: "合算できるCALL/PUT建玉がありません",
        duplicate_contract: "同じ限月が重複しているため合算できません",
        read_failed: "保存済みQRI履歴を読み込めませんでした"
    });

    function elements(documentRef) {
        const get = id => documentRef?.getElementById?.(id) || null;
        return {
            panel: get("historicalQriAggregationPanel"),
            contracts: get("historicalQriAggregationContracts"),
            date: get("historicalQriAggregationDate"),
            state: get("historicalQriAggregationState"),
            content: get("historicalQriAggregationContent"),
            metadata: get("historicalQriAggregationMetadata"),
            legend: get("historicalQriAggregationPartialLegend"),
            chartContainer: get("historicalQriAggregationChartContainer"),
            canvas: get("historicalQriAggregationChart"),
            developer: get("historicalQriAggregationDeveloperDetails")
        };
    }

    function createQriHistoricalAggregationView({ documentRef, ChartConstructor,
        readHistory, buildHistoricalViewModel, buildAggregation, optionColors,
        partialColors, now = () => new Date().toISOString() } = {}) {
        const dom = elements(documentRef);
        let historySnapshot = null;
        let loadPromise = null;
        let chart = null;
        let contractInputs = [];
        let readGeneration = 0;
        let renderGeneration = 0;
        let initialized = false;
        let lastActivity = {
            openedAt: null, closedAt: null, lastReadAt: null, lastRenderAt: null,
            readCount: 0, renderCount: 0, lastSelectedContracts: [],
            lastSelectedTradingDate: null, lastAggregationIdentity: null,
            lastAggregationStatus: null, lastHasPartialCoverage: false,
            lastChartRendered: false, lastStatus: null, lastReason: null
        };
        let current = deepFreeze({ status: "closed", reason: null, detailsOpen: false,
            loaded: false, selectedContracts: [], selectedTradingDate: null,
            aggregationIdentity: null, aggregationStatus: null,
            hasPartialCoverage: false, chartRendered: false, readCount: 0,
            renderCount: 0, readGeneration: 0, renderGeneration: 0,
            lastRenderedAt: null, errorCode: null, lastActivity: clone(lastActivity) });

        function publish(status, reason, aggregation = null, details = {}) {
            let renderedAt = current.lastRenderedAt;
            if (details.rendered) {
                renderedAt = now();
                lastActivity = { ...lastActivity, lastRenderAt: renderedAt,
                    renderCount: lastActivity.renderCount + 1,
                    lastSelectedContracts: clone(details.selectedContracts || []),
                    lastSelectedTradingDate: details.selectedTradingDate || null,
                    lastAggregationIdentity: aggregation?.aggregationIdentity || null,
                    lastAggregationStatus: aggregation?.status || null,
                    lastHasPartialCoverage:
                        aggregation?.notices?.hasPartialCoverage === true,
                    lastChartRendered: chart !== null, lastStatus: status,
                    lastReason: reason };
            }
            current = deepFreeze({ status, reason, detailsOpen: dom.panel?.open === true,
                loaded: historySnapshot !== null,
                selectedContracts: clone(details.selectedContracts || []),
                selectedTradingDate: details.selectedTradingDate || null,
                aggregationIdentity: aggregation?.aggregationIdentity || null,
                aggregationStatus: aggregation?.status || null,
                hasPartialCoverage: aggregation?.notices?.hasPartialCoverage === true,
                chartRendered: chart !== null, readCount: lastActivity.readCount,
                renderCount: lastActivity.renderCount, readGeneration, renderGeneration,
                lastRenderedAt: renderedAt, errorCode: details.errorCode || null,
                lastActivity: clone(lastActivity) });
            return current;
        }

        function getState() { return deepFreeze(clone(current)); }

        function destroyChart() {
            if (chart?.destroy) chart.destroy();
            chart = null;
        }

        function clearPresentation(message) {
            destroyChart();
            if (dom.state) { dom.state.hidden = false; dom.state.textContent = message || ""; }
            if (dom.content) dom.content.hidden = true;
            if (dom.metadata) dom.metadata.textContent = "";
            if (dom.legend) dom.legend.hidden = true;
            if (dom.chartContainer) dom.chartContainer.hidden = true;
            if (dom.developer) dom.developer.textContent = "";
        }

        function selectedContracts() {
            return contractInputs.filter(input => input.checked).map(input => input.value)
                .sort((a, b) => a.localeCompare(b));
        }

        function renderContractInputs(contracts, selected) {
            if (!dom.contracts || !documentRef?.createElement) return;
            const selectedSet = new Set(selected);
            contractInputs = contracts.map(contract => {
                const label = documentRef.createElement("label");
                const input = documentRef.createElement("input");
                const text = documentRef.createElement("span");
                input.type = "checkbox";
                input.value = contract;
                input.checked = selectedSet.has(contract);
                input.addEventListener?.("change", onContractChange);
                text.textContent = contract;
                label.append?.(input, text);
                return input;
            });
            const labels = contractInputs.map(input => input.parentNode).filter(Boolean);
            if (labels.length === contractInputs.length) dom.contracts.replaceChildren(...labels);
        }

        function setDateOptions(dates, selected) {
            if (!dom.date || !documentRef?.createElement) return;
            const options = dates.map(date => {
                const option = documentRef.createElement("option");
                option.value = date; option.textContent = date; option.selected = date === selected;
                return option;
            });
            dom.date.replaceChildren(...options);
            dom.date.value = selected || "";
            dom.date.disabled = dates.length === 0;
        }

        function availableContracts() {
            const view = buildHistoricalViewModel({ history: historySnapshot?.history });
            return Array.isArray(view?.contracts) ? [...view.contracts] : [];
        }

        function commonDates(contracts) {
            const lists = [];
            for (const contract of contracts) {
                const view = buildHistoricalViewModel({ history: historySnapshot.history,
                    selectedContract: contract });
                if (view?.status !== "available" || !Array.isArray(view.dates)) return null;
                lists.push(view.dates);
            }
            if (lists.length === 0) return [];
            return lists[0].filter(date => lists.every(list => list.includes(date)))
                .sort((a, b) => b.localeCompare(a));
        }

        function buildSnapshots(contracts, tradingDate) {
            const snapshots = [];
            for (const contract of contracts) {
                const view = buildHistoricalViewModel({ history: historySnapshot.history,
                    selectedContract: contract, selectedTradingDate: tradingDate });
                if (view?.status === "invalid") return { reason: "snapshot_invalid", snapshots: null };
                if (view?.status !== "available" || !view.snapshot) {
                    return { reason: "snapshot_unavailable", snapshots: null };
                }
                snapshots.push(view.snapshot);
            }
            return { reason: null, snapshots };
        }

        function coverageSummary(aggregation) {
            const sides = aggregation.points.flatMap(point => [point.call, point.put]);
            return `${sides.filter(side => side.complete).length}/${sides.length} strike-side 完全掲載`;
        }

        function renderMetadata(aggregation) {
            if (dom.metadata) dom.metadata.textContent = [
                `対象限月：${aggregation.contracts.join(" + ")}`,
                `共通取引日：${aggregation.tradingDate}`,
                `状態：${aggregation.status === "available" ? "完全" : "一部掲載"}`,
                `coverage：${coverageSummary(aggregation)}`,
                "保存済み履歴から計算",
                "現在値ではありません"
            ].join(" / ");
            if (dom.developer) dom.developer.textContent = JSON.stringify({
                aggregationIdentity: aggregation.aggregationIdentity,
                provenance: aggregation.provenance
            }, null, 2);
        }

        function tooltipLabel(aggregation, context) {
            const point = aggregation.points[context.dataIndex];
            const side = context.datasetIndex === 0 ? point.call : point.put;
            const name = context.datasetIndex === 0 ? "CALL" : "PUT";
            const total = side.total === null ? "未掲載" : `${side.total}枚`;
            return `${name} 合計 ${total} / coverage ${side.coverage.contributed}/${side.coverage.expected}限月`;
        }

        function renderChart(aggregation) {
            destroyChart();
            if (!dom.canvas || typeof ChartConstructor !== "function") return false;
            const colors = side => aggregation.points.map(point => point[side].complete
                ? optionColors?.[side] : partialColors?.[side]);
            chart = new ChartConstructor(dom.canvas, { type: "bar", data: {
                labels: aggregation.strikes.map(String), datasets: [
                    { label: "CALL合算", data: aggregation.points.map(point => point.call.total),
                        backgroundColor: colors("call"), borderColor: optionColors?.call,
                        borderWidth: 1 },
                    { label: "PUT合算", data: aggregation.points.map(point => point.put.total),
                        backgroundColor: colors("put"), borderColor: optionColors?.put,
                        borderWidth: 1 }
                ] }, options: { responsive: true, maintainAspectRatio: false, animation: false,
                scales: { x: { title: { display: true, text: "権利行使価格" } },
                    y: { beginAtZero: true, title: { display: true, text: "建玉残合計" } } },
                plugins: { legend: { display: true }, tooltip: { callbacks: {
                    label: context => tooltipLabel(aggregation, context)
                } } } } });
            if (dom.chartContainer) dom.chartContainer.hidden = false;
            return true;
        }

        function fail(reason, selected, date, ownGeneration, errorCode = null) {
            if (ownGeneration !== renderGeneration || dom.panel?.open !== true) {
                return publish("stale_ignored", "stale_render");
            }
            clearPresentation(ERROR_MESSAGES[reason] || "保存済みQRIを合算できません");
            return publish(reason === "not_enough_contracts" || reason === "no_common_date" ||
                reason === "snapshot_unavailable" || reason === "no_records"
                ? "unavailable" : "invalid", reason, null, { rendered: true,
                selectedContracts: selected, selectedTradingDate: date, errorCode });
        }

        function buildAndRender(preferredDate = null) {
            const ownGeneration = ++renderGeneration;
            const selected = selectedContracts();
            if (selected.length < 2) return fail("not_enough_contracts", selected, null, ownGeneration);
            let dates;
            try { dates = commonDates(selected); } catch (error) {
                return fail("snapshot_invalid", selected, null, ownGeneration,
                    error?.message || String(error));
            }
            if (!dates || dates.length === 0) {
                setDateOptions([], null);
                return fail(dates ? "no_common_date" : "snapshot_unavailable",
                    selected, null, ownGeneration);
            }
            const date = preferredDate && dates.includes(preferredDate) ? preferredDate : dates[0];
            setDateOptions(dates, date);
            let built;
            try { built = buildSnapshots(selected, date); } catch (error) {
                return fail("snapshot_invalid", selected, date, ownGeneration,
                    error?.message || String(error));
            }
            if (!built.snapshots) return fail(built.reason, selected, date, ownGeneration);
            let aggregation;
            try { aggregation = buildAggregation({ snapshots: built.snapshots }); } catch (error) {
                return fail("snapshot_invalid", selected, date, ownGeneration,
                    error?.message || String(error));
            }
            if (ownGeneration !== renderGeneration || dom.panel?.open !== true) {
                return publish("stale_ignored", "stale_render");
            }
            if (!aggregation || !["available", "partial"].includes(aggregation.status)) {
                return fail(aggregation?.reason || "snapshot_invalid", selected, date, ownGeneration);
            }
            if (dom.state) { dom.state.hidden = true; dom.state.textContent = ""; }
            if (dom.content) dom.content.hidden = false;
            if (dom.legend) dom.legend.hidden = aggregation.status !== "partial";
            renderMetadata(aggregation);
            renderChart(aggregation);
            return publish(aggregation.status, aggregation.reason, aggregation, {
                rendered: true, selectedContracts: selected, selectedTradingDate: date });
        }

        function ensureLoaded() {
            if (historySnapshot) return Promise.resolve(historySnapshot);
            if (loadPromise) return loadPromise;
            const ownRead = ++readGeneration;
            lastActivity = { ...lastActivity, lastReadAt: now(),
                readCount: lastActivity.readCount + 1 };
            publish("loading", null);
            loadPromise = Promise.resolve().then(() => readHistory()).then(value => {
                if (ownRead === readGeneration) historySnapshot = clone(value);
                return historySnapshot;
            }).catch(error => {
                if (ownRead === readGeneration) historySnapshot = { status: "read_failed",
                    history: null, errorCode: error?.message || String(error) };
                return historySnapshot;
            });
            return loadPromise;
        }

        async function open() {
            const ownGeneration = ++renderGeneration;
            lastActivity = { ...lastActivity, openedAt: now() };
            publish("loading", null);
            const loaded = await ensureLoaded();
            if (ownGeneration !== renderGeneration || dom.panel?.open !== true) {
                return publish("stale_ignored", "stale_render");
            }
            if (loaded?.status === "read_failed" || !loaded?.history) {
                return fail("read_failed", [], null, renderGeneration, loaded?.errorCode);
            }
            let contracts;
            try { contracts = availableContracts(); } catch (error) {
                return fail("snapshot_invalid", [], null, renderGeneration,
                    error?.message || String(error));
            }
            const defaults = contracts.slice(0, 2);
            renderContractInputs(contracts, defaults);
            return buildAndRender();
        }

        function close() {
            ++renderGeneration;
            destroyChart();
            if (dom.chartContainer) dom.chartContainer.hidden = true;
            lastActivity = { ...lastActivity, closedAt: now() };
            return publish("closed", null);
        }

        function onContractChange() {
            if (dom.panel?.open !== true || !historySnapshot) return getState();
            return buildAndRender(dom.date?.value || null);
        }
        function onDateChange() {
            if (dom.panel?.open !== true || !historySnapshot) return getState();
            return buildAndRender(dom.date?.value || null);
        }
        function onToggle() { return dom.panel?.open ? void open() : close(); }

        function initialize() {
            if (initialized) return getState();
            initialized = true;
            dom.panel?.addEventListener?.("toggle", onToggle);
            dom.date?.addEventListener?.("change", onDateChange);
            if (dom.panel?.open === true) void open();
            return getState();
        }

        return Object.freeze({ initialize, open, close, getState,
            selectContracts: onContractChange, selectDate: onDateChange });
    }

    return Object.freeze({ ERROR_MESSAGES, createQriHistoricalAggregationView });
});
