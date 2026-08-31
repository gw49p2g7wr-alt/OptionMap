(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsParticipantHistoricalView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    const ERROR_MESSAGES = Object.freeze({
        no_history: "保存済みJPX週次履歴はまだありません",
        no_participants: "公表掲載実績のある参加者がありません",
        participant_not_found: "選択した参加者の掲載履歴を確認できません",
        no_records: "選択期間にこの参加者の公表掲載記録はありません",
        invalid_option_type: "CALLまたはPUTを選択してください",
        invalid_period: "表示期間を確認できません",
        history_corrupted: "週次オプション履歴の整合性エラーを検出しました",
        adapter_error: "公表建玉推移の表示処理を開始できませんでした",
        read_failed: "保存済みJPX週次履歴を読み込めませんでした"
    });

    function elements(documentRef) {
        const get = id => documentRef?.getElementById?.(id) || null;
        return {
            panel: get("weeklyOptionsParticipantHistoricalPanel"),
            participant: get("weeklyOptionsParticipantSelect"),
            optionType: get("weeklyOptionsParticipantOptionType"),
            period: get("weeklyOptionsParticipantPeriod"),
            state: get("weeklyOptionsParticipantHistoricalState"),
            content: get("weeklyOptionsParticipantHistoricalContent"),
            metadata: get("weeklyOptionsParticipantHistoricalMetadata"),
            rename: get("weeklyOptionsParticipantHistoricalRename"),
            rolls: get("weeklyOptionsParticipantHistoricalRolls"),
            chartContainer: get("weeklyOptionsParticipantHistoricalChartContainer"),
            canvas: get("weeklyOptionsParticipantHistoricalChart"),
            developer: get("weeklyOptionsParticipantHistoricalDeveloper")
        };
    }

    function createWeeklyOptionsParticipantHistoricalView({
        documentRef,
        ChartConstructor,
        readHistory,
        listParticipants,
        buildViewModel,
        colors = {},
        now = () => new Date().toISOString()
    } = {}) {
        const dom = elements(documentRef);
        let historySnapshot = null;
        let loadPromise = null;
        let chart = null;
        let participants = [];
        let readGeneration = 0;
        let renderGeneration = 0;
        let initialized = false;
        let lastActivity = {
            openedAt: null,
            closedAt: null,
            lastReadAt: null,
            lastRenderedAt: null,
            readCount: 0,
            renderCount: 0,
            lastSelectedParticipantCode: null,
            lastSelectedParticipantName: null,
            lastSelectedOptionType: null,
            lastSelectedPeriod: null,
            lastPointCount: 0,
            lastRollBoundaryCount: 0,
            lastChartRendered: false,
            lastStatus: null,
            lastReason: null
        };
        let current = deepFreeze({
            status: "closed", reason: null, detailsOpen: false, loaded: false,
            selectedParticipantCode: null, selectedParticipantName: null,
            selectedOptionType: "call", selectedPeriod: "last20",
            pointCount: 0, rollBoundaryCount: 0, chartRendered: false,
            readGeneration: 0, renderGeneration: 0, lastRenderedAt: null,
            errorCode: null, lastActivity: clone(lastActivity)
        });

        function selectedParticipant(code) {
            return participants.find(item => item.participantCode === code) || null;
        }

        function publish(status, reason, model = null, details = {}) {
            const participantCode = details.participantCode ??
                model?.selectedParticipantCode ?? dom.participant?.value ?? null;
            const participant = selectedParticipant(participantCode);
            let renderedAt = current.lastRenderedAt;
            if (details.rendered) {
                renderedAt = now();
                lastActivity = {
                    ...lastActivity,
                    lastRenderedAt: renderedAt,
                    renderCount: lastActivity.renderCount + 1,
                    lastSelectedParticipantCode: participantCode || null,
                    lastSelectedParticipantName: participant?.displayName || null,
                    lastSelectedOptionType: model?.selectedOptionType ||
                        dom.optionType?.value || null,
                    lastSelectedPeriod: model?.period || dom.period?.value || null,
                    lastPointCount: model?.points?.length || 0,
                    lastRollBoundaryCount: model?.rollBoundaries?.length || 0,
                    lastChartRendered: chart !== null,
                    lastStatus: status,
                    lastReason: reason
                };
            }
            current = deepFreeze({
                status,
                reason,
                detailsOpen: dom.panel?.open === true,
                loaded: historySnapshot !== null,
                selectedParticipantCode: participantCode || null,
                selectedParticipantName: participant?.displayName || null,
                selectedOptionType: model?.selectedOptionType ||
                    dom.optionType?.value || "call",
                selectedPeriod: model?.period || dom.period?.value || "last20",
                pointCount: model?.points?.length || 0,
                rollBoundaryCount: model?.rollBoundaries?.length || 0,
                chartRendered: chart !== null,
                readGeneration,
                renderGeneration,
                lastRenderedAt: renderedAt,
                errorCode: details.errorCode || null,
                lastActivity: clone(lastActivity)
            });
            return current;
        }

        function getState() {
            return deepFreeze(clone(current));
        }

        function destroyChart() {
            if (chart?.destroy) chart.destroy();
            chart = null;
        }

        function clearPresentation(message) {
            destroyChart();
            if (dom.state) {
                dom.state.hidden = false;
                dom.state.textContent = message || "";
            }
            if (dom.content) dom.content.hidden = true;
            if (dom.metadata) dom.metadata.textContent = "";
            if (dom.rename) {
                dom.rename.hidden = true;
                dom.rename.textContent = "";
            }
            if (dom.rolls) dom.rolls.replaceChildren?.();
            if (dom.chartContainer) dom.chartContainer.hidden = true;
            if (dom.developer) dom.developer.textContent = "";
        }

        function setParticipantOptions(selectedCode = null) {
            if (!dom.participant || !documentRef?.createElement) return null;
            const selected = participants.some(item =>
                item.participantCode === selectedCode
            ) ? selectedCode : participants[0]?.participantCode || null;
            const options = participants.map(item => {
                const option = documentRef.createElement("option");
                option.value = item.participantCode;
                option.textContent = `${item.displayName}（${item.participantCode}）`;
                option.selected = item.participantCode === selected;
                return option;
            });
            dom.participant.replaceChildren(...options);
            dom.participant.value = selected || "";
            dom.participant.disabled = options.length === 0;
            return selected;
        }

        function renderMetadata(model, participant) {
            if (dom.metadata) {
                const summary = model.summary;
                dom.metadata.textContent = [
                    `参加者：${participant.displayName}`,
                    `participantCode：${participant.participantCode}`,
                    `種別：${model.selectedOptionType.toUpperCase()}`,
                    `期間：${model.period}`,
                    `観測週数：${summary.totalObservations}`,
                    `掲載週数：${summary.publishedObservations}`,
                    `非掲載週数：${summary.missingObservations}`,
                    `観測限月数：${summary.observedExpiryCount}`
                ].join(" / ");
            }
            if (dom.rename) {
                dom.rename.hidden = participant.nameVariation !== true;
                dom.rename.textContent = participant.nameVariation
                    ? "このparticipantCodeでは期間中に複数の名称表記が確認されています"
                    : "";
            }
            if (dom.developer) {
                dom.developer.textContent = [
                    `observedNames: ${participant.observedNames.join(" / ")}`,
                    `firstSeenDate: ${participant.firstSeenDate}`,
                    `lastSeenDate: ${participant.lastSeenDate}`,
                    `observationCount: ${participant.observationCount}`
                ].join("\n");
            }
        }

        function renderRolls(model) {
            if (!dom.rolls || !documentRef?.createElement) return;
            const rows = model.rollBoundaries.map(boundary => {
                const item = documentRef.createElement("li");
                item.textContent = `${boundary.sourceDate}：` +
                    `${boundary.fromExpiry} → ${boundary.toExpiry}`;
                return item;
            });
            dom.rolls.replaceChildren(...rows);
            dom.rolls.hidden = rows.length === 0;
        }

        function tooltipLabel(context, model) {
            const point = model.points[context.dataIndex];
            const side = context.datasetIndex === 0 ? "buy" : "sell";
            const observation = point?.[side];
            const label = side === "buy" ? "買い側" : "売り側";
            const value = observation?.published ? `${observation.total}枚` : "非掲載";
            return `${point.sourceDate} / ${point.expiry} / ` +
                `${model.selectedOptionType.toUpperCase()} / ${label} ${value} / ` +
                `掲載strike ${observation?.contributingStrikes || 0}`;
        }

        function renderChart(model) {
            destroyChart();
            if (!dom.canvas || typeof ChartConstructor !== "function") return false;
            chart = new ChartConstructor(dom.canvas, {
                type: "bar",
                data: {
                    labels: model.points.map(point => point.sourceDate),
                    datasets: [
                        {
                            label: "買い側 公表掲載枚数",
                            data: model.points.map(point =>
                                point.buy.published ? point.buy.total : null
                            ),
                            backgroundColor: colors.buy,
                            borderColor: colors.buyBorder || colors.buy,
                            borderWidth: 1,
                            spanGaps: false
                        },
                        {
                            label: "売り側 公表掲載枚数",
                            data: model.points.map(point =>
                                point.sell.published ? point.sell.total : null
                            ),
                            backgroundColor: colors.sell,
                            borderColor: colors.sellBorder || colors.sell,
                            borderWidth: 1,
                            spanGaps: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    scales: {
                        x: { title: { display: true, text: "JPX基準日" } },
                        y: { beginAtZero: true,
                            title: { display: true, text: "公表掲載枚数" } }
                    },
                    plugins: {
                        legend: { display: true },
                        tooltip: { callbacks: {
                            label: context => tooltipLabel(context, model)
                        } }
                    }
                }
            });
            if (dom.chartContainer) dom.chartContainer.hidden = false;
            return true;
        }

        async function render(ownGeneration = ++renderGeneration) {
            if (!historySnapshot || ownGeneration !== renderGeneration ||
                dom.panel?.open !== true) {
                return getState();
            }
            const participantCode = dom.participant?.value || null;
            let model;
            try {
                model = await buildViewModel({
                    history: historySnapshot.history,
                    selectedParticipantCode: participantCode,
                    selectedOptionType: dom.optionType?.value || "call",
                    period: dom.period?.value || "last20"
                });
            } catch (error) {
                if (ownGeneration !== renderGeneration) {
                    return getState();
                }
                clearPresentation(ERROR_MESSAGES.history_corrupted);
                return publish("invalid", "history_corrupted", null, {
                    rendered: true,
                    participantCode,
                    errorCode: error?.message || String(error)
                });
            }
            if (ownGeneration !== renderGeneration || dom.panel?.open !== true) {
                return getState();
            }
            if (model.status === "invalid" || model.status === "empty") {
                clearPresentation(ERROR_MESSAGES[model.reason] ||
                    "公表建玉推移を表示できません");
                return publish(model.status, model.reason, model, {
                    rendered: true,
                    participantCode
                });
            }
            const participant = selectedParticipant(participantCode);
            if (dom.state) {
                dom.state.hidden = true;
                dom.state.textContent = "";
            }
            if (dom.content) dom.content.hidden = false;
            renderMetadata(model, participant);
            renderRolls(model);
            renderChart(model);
            return publish(model.status, model.reason, model, {
                rendered: true,
                participantCode
            });
        }

        function ensureLoaded() {
            if (historySnapshot) return Promise.resolve(historySnapshot);
            if (loadPromise) return loadPromise;
            const ownRead = ++readGeneration;
            lastActivity = {
                ...lastActivity,
                lastReadAt: now(),
                readCount: lastActivity.readCount + 1
            };
            publish("loading", null);
            loadPromise = Promise.resolve().then(() => readHistory())
                .then(async value => {
                    if (ownRead !== readGeneration) return historySnapshot;
                    historySnapshot = clone(value);
                    let listed;
                    try {
                        listed = await listParticipants(historySnapshot.history);
                    } catch (error) {
                        historySnapshot.participantListStatus = "invalid";
                        historySnapshot.participantListReason = "adapter_error";
                        historySnapshot.participantListErrorCode =
                            error?.message || String(error);
                        return historySnapshot;
                    }
                    if (ownRead !== readGeneration) return historySnapshot;
                    participants = clone(listed?.participants || []);
                    historySnapshot.participantListStatus = listed?.status || "invalid";
                    historySnapshot.participantListReason = listed?.reason || null;
                    return historySnapshot;
                }).catch(error => {
                    if (ownRead === readGeneration) {
                        historySnapshot = {
                            status: "read_failed",
                            history: null,
                            errorCode: error?.message || String(error)
                        };
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
                return getState();
            }
            if (loaded?.status === "read_failed") {
                clearPresentation(ERROR_MESSAGES.read_failed);
                return publish("invalid", "read_failed", null, {
                    rendered: true,
                    errorCode: loaded.errorCode
                });
            }
            if (loaded?.participantListStatus !== "available") {
                const reason = loaded?.participantListReason ||
                    (loaded?.status === "empty" ? "no_history" : "no_participants");
                clearPresentation(ERROR_MESSAGES[reason] || ERROR_MESSAGES.no_participants);
                const invalid = ["history_corrupted", "adapter_error"].includes(reason);
                return publish(invalid ? "invalid" : "empty", reason, null, {
                    rendered: true,
                    errorCode: loaded?.participantListErrorCode || null
                });
            }
            setParticipantOptions(dom.participant?.value || null);
            return render(ownGeneration);
        }

        function close() {
            ++renderGeneration;
            destroyChart();
            if (dom.chartContainer) dom.chartContainer.hidden = true;
            lastActivity = { ...lastActivity, closedAt: now() };
            return publish("closed", null);
        }

        function select() {
            if (dom.panel?.open !== true || !historySnapshot) return getState();
            return render();
        }

        function onToggle() {
            return dom.panel?.open ? void open() : close();
        }

        function initialize() {
            if (initialized) return getState();
            initialized = true;
            dom.panel?.addEventListener?.("toggle", onToggle);
            dom.participant?.addEventListener?.("change", () => { void select(); });
            dom.optionType?.addEventListener?.("change", () => { void select(); });
            dom.period?.addEventListener?.("change", () => { void select(); });
            if (dom.panel?.open === true) void open();
            return getState();
        }

        return Object.freeze({ initialize, open, close, select, getState });
    }

    return Object.freeze({
        ERROR_MESSAGES,
        createWeeklyOptionsParticipantHistoricalView
    });
});
