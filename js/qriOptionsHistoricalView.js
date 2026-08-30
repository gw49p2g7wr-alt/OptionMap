(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoricalView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    const ERROR_MESSAGES = Object.freeze({
        no_history: "保存済みQRI履歴はまだありません",
        no_contracts: "表示できる保存済み限月がありません",
        no_dates: "この限月の保存日はありません",
        selection_not_found: "選択した保存履歴を確認できません",
        active_revision_missing: "保存履歴のrevisionを確認できないため表示できません",
        active_revision_ambiguous: "保存履歴のrevisionを確認できないため表示できません",
        snapshot_invalid: "保存履歴の整合性を確認できないため表示できません",
        oi_unavailable: "保存snapshotに利用可能なCALL/PUT建玉がありません",
        records_unavailable: "保存snapshotに利用可能なCALL/PUT建玉がありません",
        corrupted_history: "履歴の整合性エラーを検出したため表示できません",
        read_failed: "保存済みQRI履歴を読み込めませんでした"
    });

    function elements(documentRef) {
        const get = id => documentRef?.getElementById?.(id) || null;
        return {
            panel: get("historicalQriPanel"),
            contract: get("historyContractSelect"),
            date: get("historyDateSelect"),
            state: get("historicalQriState"),
            content: get("historicalQriContent"),
            metadata: get("historicalQriMetadata"),
            chartContainer: get("historicalQriChartContainer"),
            canvas: get("historicalQriOpenInterestChart"),
            developer: get("historicalQriDeveloperDetails")
        };
    }

    function createQriOptionsHistoricalView({ documentRef, ChartConstructor,
        readHistory, buildViewModel, optionColors,
        now = () => new Date().toISOString() } = {}) {
        const dom = elements(documentRef);
        let historySnapshot = null;
        let loadPromise = null;
        let chart = null;
        let readGeneration = 0;
        let renderGeneration = 0;
        let initialized = false;
        let lastActivity = {
            openedAt: null, closedAt: null, lastReadAt: null, lastRenderAt: null,
            readCount: 0, renderCount: 0, lastSelectedContract: null,
            lastSelectedTradingDate: null, lastEntryKey: null,
            lastActiveVersionKey: null, lastChartRendered: false,
            lastStatus: null, lastReason: null
        };
        let current = deepFreeze({ status: "closed", reason: null, loaded: false,
            selectedContract: null, selectedTradingDate: null, entryKey: null,
            activeVersionKey: null, chartRendered: false, readGeneration: 0,
            renderGeneration: 0, lastRenderedAt: null, errorCode: null,
            lastActivity: clone(lastActivity) });

        function publish(status, reason, viewModel = null, details = {}) {
            let renderedAt = current.lastRenderedAt;
            if (details.rendered) {
                renderedAt = now();
                lastActivity = { ...lastActivity, lastRenderAt: renderedAt,
                    renderCount: lastActivity.renderCount + 1,
                    lastSelectedContract: viewModel?.selection?.contract ||
                        lastActivity.lastSelectedContract,
                    lastSelectedTradingDate: viewModel?.selection?.tradingDate ||
                        lastActivity.lastSelectedTradingDate,
                    lastEntryKey: viewModel?.selection?.entryKey || lastActivity.lastEntryKey,
                    lastActiveVersionKey: viewModel?.selection?.activeVersionKey ||
                        lastActivity.lastActiveVersionKey,
                    lastChartRendered: chart !== null, lastStatus: status,
                    lastReason: reason };
            }
            current = deepFreeze({ status, reason, loaded: historySnapshot !== null,
                selectedContract: viewModel?.selection?.contract || details.selectedContract || null,
                selectedTradingDate: viewModel?.selection?.tradingDate ||
                    details.selectedTradingDate || null,
                entryKey: viewModel?.selection?.entryKey || null,
                activeVersionKey: viewModel?.selection?.activeVersionKey || null,
                chartRendered: chart !== null, readGeneration, renderGeneration,
                lastRenderedAt: renderedAt, errorCode: details.errorCode || null,
                lastActivity: clone(lastActivity) });
            return current;
        }

        function getState() { return deepFreeze(clone(current)); }

        function destroyChart() {
            if (chart?.destroy) chart.destroy();
            chart = null;
        }

        function setOptions(select, values, selected) {
            if (!select || !documentRef?.createElement) return;
            const options = values.map(value => {
                const option = documentRef.createElement("option");
                option.value = value;
                option.textContent = value;
                option.selected = value === selected;
                return option;
            });
            select.replaceChildren(...options);
            select.value = selected || "";
            select.disabled = values.length === 0;
        }

        function clearPresentation(message) {
            destroyChart();
            if (dom.state) { dom.state.hidden = false; dom.state.textContent = message || ""; }
            if (dom.content) dom.content.hidden = true;
            if (dom.metadata) dom.metadata.textContent = "";
            if (dom.developer) dom.developer.textContent = "";
            if (dom.chartContainer) dom.chartContainer.hidden = true;
        }

        function renderMetadata(metadata) {
            if (!dom.metadata) return;
            dom.metadata.textContent = [
                `${metadata.contract}限月`,
                `取引日：${metadata.tradingDate}`,
                `QRIページ更新：${metadata.pageUpdatedAt || "不明"}`,
                `OptionMap取得：${metadata.fetchedAt || "不明"}`,
                `履歴保存確認：${metadata.confirmedAt || "不明"}`,
                `OI状態：${metadata.openInterestStatus === "available"
                    ? "CALL/PUT掲載あり" : metadata.openInterestStatus || "不明"}`
            ].join(" / ");
            if (dom.developer) dom.developer.textContent = [
                `source: ${metadata.source || "不明"}`,
                `sourceUrl: ${metadata.sourceUrl || "不明"}`,
                `activeVersionKey: ${metadata.activeVersionKey || "不明"}`,
                `signature: ${metadata.signatureShort || "不明"}`,
                `parser/schema/history: ${metadata.parserVersion}/${metadata.schemaVersion}/${metadata.historyVersion}`
            ].join("\n");
        }

        function renderChart(viewModel) {
            destroyChart();
            if (!dom.canvas || typeof ChartConstructor !== "function") return false;
            chart = new ChartConstructor(dom.canvas, {
                type: "bar",
                data: { labels: viewModel.chartData.strikes.map(String), datasets: [
                    { label: "CALL建玉残", data: [...viewModel.chartData.callOpenInterest],
                        backgroundColor: optionColors?.call, borderColor: optionColors?.call,
                        borderWidth: 1 },
                    { label: "PUT建玉残", data: [...viewModel.chartData.putOpenInterest],
                        backgroundColor: optionColors?.put, borderColor: optionColors?.put,
                        borderWidth: 1 }
                ] },
                options: { responsive: true, maintainAspectRatio: false, animation: false,
                    scales: { x: { title: { display: true, text: "権利行使価格" } },
                        y: { beginAtZero: true, title: { display: true, text: "建玉残" } } },
                    plugins: { legend: { display: true }, tooltip: { enabled: true } } }
            });
            if (dom.chartContainer) dom.chartContainer.hidden = false;
            return true;
        }

        function renderViewModel(viewModel, ownGeneration) {
            if (ownGeneration !== renderGeneration || dom.panel?.open !== true) {
                return publish("stale_ignored", "stale_render");
            }
            if (viewModel?.status !== "available") {
                clearPresentation(ERROR_MESSAGES[viewModel?.reason] ||
                    "保存済みQRI履歴を表示できません");
                setOptions(dom.contract, viewModel?.contracts || [], null);
                setOptions(dom.date, viewModel?.dates || [], null);
                return publish(viewModel?.status || "invalid",
                    viewModel?.reason || "snapshot_invalid", viewModel, { rendered: true });
            }
            setOptions(dom.contract, viewModel.contracts, viewModel.selection.contract);
            setOptions(dom.date, viewModel.dates, viewModel.selection.tradingDate);
            if (dom.state) { dom.state.hidden = true; dom.state.textContent = ""; }
            if (dom.content) dom.content.hidden = false;
            renderMetadata(viewModel.metadata);
            renderChart(viewModel);
            return publish("available", null, viewModel, { rendered: true });
        }

        function buildAndRender(selectedContract = null, selectedTradingDate = null) {
            const ownGeneration = ++renderGeneration;
            if (!historySnapshot) {
                clearPresentation(ERROR_MESSAGES.read_failed);
                return publish("invalid", "read_failed", null, { rendered: true });
            }
            if (historySnapshot.status === "corrupted") {
                clearPresentation(ERROR_MESSAGES.corrupted_history);
                return publish("invalid", "corrupted_history", null, { rendered: true });
            }
            let viewModel;
            try {
                viewModel = buildViewModel({ history: historySnapshot.history,
                    selectedContract, selectedTradingDate });
            } catch (error) {
                clearPresentation(ERROR_MESSAGES.snapshot_invalid);
                return publish("invalid", "snapshot_invalid", null,
                    { rendered: true, errorCode: error?.message || String(error) });
            }
            return renderViewModel(viewModel, ownGeneration);
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
                if (ownRead === readGeneration) {
                    historySnapshot = { status: "read_failed", history: null,
                        errorCode: error?.message || String(error) };
                }
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
            if (loaded?.status === "read_failed") {
                clearPresentation(ERROR_MESSAGES.read_failed);
                return publish("invalid", "read_failed", null,
                    { rendered: true, errorCode: loaded.errorCode });
            }
            return buildAndRender();
        }

        function close() {
            ++renderGeneration;
            destroyChart();
            if (dom.chartContainer) dom.chartContainer.hidden = true;
            lastActivity = { ...lastActivity, closedAt: now() };
            return publish("closed", null);
        }

        function onToggle() { return dom.panel?.open ? void open() : close(); }
        function onContractChange() {
            if (dom.panel?.open !== true || !historySnapshot) return getState();
            return buildAndRender(dom.contract?.value || null, null);
        }
        function onDateChange() {
            if (dom.panel?.open !== true || !historySnapshot) return getState();
            return buildAndRender(dom.contract?.value || null, dom.date?.value || null);
        }

        function initialize() {
            if (initialized) return getState();
            initialized = true;
            dom.panel?.addEventListener?.("toggle", onToggle);
            dom.contract?.addEventListener?.("change", onContractChange);
            dom.date?.addEventListener?.("change", onDateChange);
            if (dom.panel?.open === true) void open();
            return getState();
        }

        return Object.freeze({ initialize, open, close, getState,
            selectContract: onContractChange, selectDate: onDateChange });
    }

    return Object.freeze({ ERROR_MESSAGES, createQriOptionsHistoricalView });
});
