console.log("script.js 読み込み成功！");

const CHART_TEXT_SIZE = Object.freeze({
    axis: 14,
    axisTitle: 14,
    legend: 14,
    tooltip: 14
});

const PARTICIPANT_CUMULATIVE_COLORS = Object.freeze({
    estimatedBuy: Object.freeze({
        day: "rgba(255, 99, 132, 0.85)",
        night: "rgba(255, 99, 132, 0.35)"
    }),
    estimatedSell: Object.freeze({
        day: "rgba(54, 162, 235, 0.85)",
        night: "rgba(54, 162, 235, 0.35)"
    }),
    unconfirmed: Object.freeze({
        day: "rgba(140, 140, 140, 0.60)",
        night: "rgba(180, 180, 180, 0.30)"
    })
});

const TRADE_DIRECTION_CHART_COLORS = Object.freeze({
    buy: Object.freeze({
        fill: "rgba(255, 99, 132, 0.75)",
        border: "rgba(255, 99, 132, 1)"
    }),
    sell: Object.freeze({
        fill: "rgba(54, 162, 235, 0.75)",
        border: "rgba(54, 162, 235, 1)"
    })
});

const TRADE_DIRECTION_MARKERS = Object.freeze({
    buy: "🔴",
    sell: "🔵",
    neutral: "○"
});

const OPTION_SIDE_CHART_COLORS = Object.freeze({
    call: Object.freeze({
        soft: "rgba(255, 99, 132, 0.45)",
        strong: "rgba(220, 20, 60, 0.95)",
        border: "rgba(255, 99, 132, 1)"
    }),
    put: Object.freeze({
        soft: "rgba(74, 144, 226, 0.45)",
        strong: "rgba(0, 82, 204, 0.95)",
        border: "rgba(74, 144, 226, 1)"
    })
});

function readableLegendOptions(display = true) {
    return {
        display,
        labels: {
            font: { size: CHART_TEXT_SIZE.legend },
            padding: 16
        }
    };
}

function readableTooltipOptions(callbacks = undefined) {
    return {
        enabled: true,
        titleFont: { size: CHART_TEXT_SIZE.tooltip },
        bodyFont: { size: CHART_TEXT_SIZE.tooltip },
        padding: 10,
        ...(callbacks ? { callbacks } : {})
    };
}

function readableAxisTitle(text) {
    return {
        display: true,
        text,
        font: { size: CHART_TEXT_SIZE.axisTitle, weight: "600" },
        padding: 8
    };
}

const FETCH_STATUS = Object.freeze({
    IDLE: "idle",
    LOADING: "loading",
    SUCCESS: "success",
    PARTIAL: "partial",
    UNAVAILABLE: "unavailable",
    FAILED: "failed"
});

const createFetchDetailState = () => ({
    status: FETCH_STATUS.IDLE,
    startedAt: null,
    fetchedAt: null,
    sourceUrl: null,
    error: null
});

const createFetchSourceState = details => ({
    status: FETCH_STATUS.IDLE,
    startedAt: null,
    fetchedAt: null,
    sourceDate: null,
    sourceUrl: null,
    error: null,
    requestId: null,
    details
});

const dataFetchState = {
    qri: createFetchSourceState({
        html: createFetchDetailState(),
        referencePrice: createFetchDetailState(),
        optionRows: createFetchDetailState(),
        openInterest: createFetchDetailState(),
        volume: createFetchDetailState()
    }),
    participant: createFetchSourceState({
        dayRegular: createFetchDetailState(),
        dayJnet: createFetchDetailState(),
        nightRegular: createFetchDetailState(),
        nightJnet: createFetchDetailState()
    }),
    weeklyFutures: {
        ...createFetchSourceState({}),
        signature: null,
        metadata: null,
        isNew: null
    },
    weeklyOptions: {
        ...createFetchSourceState({}),
        signature: null,
        metadata: null,
        isNew: null
    }
};

const createWeeklyDataState = () => ({
    status: null,
    sourceDate: null,
    versionKey: null,
    signature: null,
    origin: null,
    remoteCheckStatus: "pending",
    observedLatestTradeDate: null
});

const weeklyFuturesDataState = createWeeklyDataState();
const weeklyOptionsDataState = createWeeklyDataState();
const participantDataState = {
    sourceDate: null,
    versionKey: null,
    signature: null,
    origin: null,
    dataStatus: null,
    remoteCheckStatus: "pending",
    observedLatestDate: null
};
const participantHistoryState = {
    status: "empty",
    entryCount: 0,
    latestSourceDate: null,
    earliestSourceDate: null,
    revisionCount: 0,
    lastSavedAt: null,
    error: null
};
let participantActivityHistory = null;
let formalWeeklyFuturesHistory = null;

window.setWeeklyFuturesJudgmentHistory = async history => {
    if (
        !window.OptionMapWeeklyFuturesHistory ||
        !(await window.OptionMapWeeklyFuturesHistory.validateHistory(history))
    ) {
        return false;
    }
    formalWeeklyFuturesHistory = history;
    if (typeof renderSavedSnapshots === "function") {
        try {
            await renderSavedSnapshots();
        } catch (error) {
            console.warn("正式週次historyの判定表示に失敗しました:", error);
        }
    }
    return true;
};

function updateParticipantDataState(patch) {
    if (!patch || typeof patch !== "object") return participantDataState;
    Object.assign(participantDataState, patch);
    scheduleRenderDataFetchStatus();
    renderParticipantFetchDisplayState();
    return participantDataState;
}

window.participantDataState = participantDataState;
window.updateParticipantDataState = updateParticipantDataState;

function updateParticipantHistoryState(patch) {
    if (!patch || typeof patch !== "object") return participantHistoryState;
    Object.assign(participantHistoryState, patch);
    renderParticipantHistoryState();
    renderParticipantActivityHistory();
    return participantHistoryState;
}

window.participantHistoryState = participantHistoryState;
window.updateParticipantHistoryState = updateParticipantHistoryState;

function getWeeklyDataState(source) {
    if (source === "weeklyFutures") {
        return weeklyFuturesDataState;
    }

    if (source === "weeklyOptions") {
        return weeklyOptionsDataState;
    }

    return null;
}

function updateWeeklyDataState(source, patch) {
    const state = getWeeklyDataState(source);

    if (!state || !patch || typeof patch !== "object") {
        return null;
    }

    Object.assign(state, patch);
    scheduleRenderDataFetchStatus();

    if (
        source === "weeklyFutures" &&
        typeof renderSavedSnapshots === "function"
    ) {
        setTimeout(() => renderSavedSnapshots(), 0);
    }
    return state;
}

window.weeklyFuturesDataState = weeklyFuturesDataState;
window.weeklyOptionsDataState = weeklyOptionsDataState;
window.updateWeeklyDataState = updateWeeklyDataState;

const FETCH_STATUS_PRESENTATION = Object.freeze({
    [FETCH_STATUS.IDLE]: {
        label: "未取得",
        icon: "○",
        className: "is-idle"
    },
    [FETCH_STATUS.LOADING]: {
        label: "取得中",
        icon: "…",
        className: "is-loading"
    },
    [FETCH_STATUS.SUCCESS]: {
        label: "取得済み",
        icon: "✓",
        className: "is-success"
    },
    [FETCH_STATUS.PARTIAL]: {
        label: "一部取得",
        icon: "△",
        className: "is-partial"
    },
    [FETCH_STATUS.UNAVAILABLE]: {
        label: "未提供",
        icon: "—",
        className: "is-unavailable"
    },
    [FETCH_STATUS.FAILED]: {
        label: "取得失敗",
        icon: "!",
        className: "is-failed"
    }
});

function getFetchStatusPresentation(status) {
    return FETCH_STATUS_PRESENTATION[status] || {
        label: "状態不明",
        icon: "?",
        className: "is-unknown"
    };
}

function parseFetchDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatFetchDateTime(value) {
    const date = parseFetchDate(value);

    if (!date) {
        return null;
    }

    return new Intl.DateTimeFormat("ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(date);
}

function formatParticipantSourceDate(value) {
    const match = String(value || "").match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
    );

    if (match) {
        return `${match[1]}/${match[2].padStart(2, "0")}/${match[3].padStart(2, "0")}`;
    }

    const date = parseFetchDate(value);

    return date
        ? new Intl.DateTimeFormat("ja-JP", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(date)
        : null;
}

function createFetchSourceViewModel(source, sourceState) {
    const definitions = {
        qri: { label: "QRIオプション", dateLabel: "データ日時" },
        participant: { label: "参加者別", dateLabel: "対象日" },
        weeklyFutures: { label: "週次先物", dateLabel: "データ日" },
        weeklyOptions: { label: "週次オプション", dateLabel: "データ日" }
    };
    const definition = definitions[source];
    let presentation = getFetchStatusPresentation(sourceState?.status);
    const notes = [];
    let meta = null;

    if (sourceState?.sourceDate) {
        const formattedSourceDate = [
            "participant",
            "weeklyFutures",
            "weeklyOptions"
        ].includes(source)
            ? formatParticipantSourceDate(sourceState.sourceDate)
            : formatFetchDateTime(sourceState.sourceDate);

        if (formattedSourceDate) {
            meta = `${definition.dateLabel}：${formattedSourceDate}`;
        }
    }

    if (
        !meta &&
        (source === "weeklyFutures" || source === "weeklyOptions") &&
        [
            FETCH_STATUS.SUCCESS,
            FETCH_STATUS.PARTIAL,
            FETCH_STATUS.UNAVAILABLE
        ].includes(sourceState?.status)
    ) {
        const completedAt = formatFetchDateTime(sourceState?.fetchedAt);

        if (completedAt) {
            meta = `取得完了：${completedAt}`;
        }
    }

    if (
        source === "qri" &&
        sourceState?.details?.openInterest?.status === FETCH_STATUS.UNAVAILABLE
    ) {
        notes.push({
            label: "建玉残",
            status: FETCH_STATUS.UNAVAILABLE
        });

    }

    if (
        source === "qri" &&
        qriOpenInterestDataState.status === "waiting_update" &&
        qriOpenInterestDataState.usingFallback === true
    ) {
        notes.push({
            text: "分析建玉：直近正常値を使用中"
        });

        const fallbackSourceDate = formatFetchDateTime(
            qriOpenInterestDataState.sourceDate
        );

        if (fallbackSourceDate) {
            notes.push({
                text: `建玉取得元ページ日時：${fallbackSourceDate}`
            });
        }
    }

    if (
        source === "participant" &&
        [FETCH_STATUS.PARTIAL, FETCH_STATUS.FAILED].includes(sourceState?.status)
    ) {
        if (
            Number.isSafeInteger(sourceState?.successCount) &&
            sourceState.successCount > 0
        ) {
            notes.push({ text: `${sourceState.successCount}/4取得` });
        }
        const participantDetails = {
            dayRegular: "日中立会",
            dayJnet: "日中J-NET",
            nightRegular: "夜間立会",
            nightJnet: "夜間J-NET"
        };

        Object.entries(participantDetails).forEach(([detail, label]) => {
            const detailStatus = sourceState?.details?.[detail]?.status;

            if (detailStatus && detailStatus !== FETCH_STATUS.SUCCESS) {
                notes.push({ label, status: detailStatus });
            }
        });
    }

    if (source === "participant") {
        const activeDate = formatParticipantSourceDate(
            participantDataState.sourceDate
        );
        const observedDate = formatParticipantSourceDate(
            participantDataState.observedLatestDate
        );

        if (
            participantDataState.origin === "cache" &&
            participantDataState.remoteCheckStatus === "pending" &&
            sourceState?.status === FETCH_STATUS.IDLE
        ) {
            presentation = getFetchStatusPresentation(FETCH_STATUS.LOADING);
        }

        if (
            participantDataState.origin === "cache" &&
            participantDataState.remoteCheckStatus === "pending"
        ) {
            notes.push({ text: "分析データ：前回確認済み版を表示中" });
        } else if (participantDataState.dataStatus === "waiting_update") {
            notes.push({ text: "分析データ：直近正常版を表示中" });
        } else if (participantDataState.dataStatus === "partial") {
            notes.push({ text: "分析データ：一部データのみ" });
        }

        if (activeDate) {
            notes.push({ text: `分析データ対象日：${activeDate}` });
        }

        if (participantDataState.remoteCheckStatus === "pending") {
            notes.push({ text: "最新版を確認中" });
        } else if (
            participantDataState.dataStatus === "latest" &&
            participantDataState.remoteCheckStatus === "current"
        ) {
            notes.push({ text: "状態：最新確認済み" });
        } else if (
            participantDataState.remoteCheckStatus === "newer_available"
        ) {
            notes.push({
                text: observedDate
                    ? `新版：${observedDate}を確認済み`
                    : "新版を確認済み"
            });
        } else if (participantDataState.remoteCheckStatus === "failed") {
            notes.push({ text: "最新版の確認に失敗" });
        }
    }

    if (source === "weeklyFutures" || source === "weeklyOptions") {
        const weeklyDataState = getWeeklyDataState(source);
        const dataSourceDate = formatParticipantSourceDate(
            weeklyDataState?.sourceDate
        );

        if (
            weeklyDataState?.origin === "cache" &&
            weeklyDataState?.remoteCheckStatus === "pending" &&
            sourceState?.status === FETCH_STATUS.IDLE
        ) {
            presentation = getFetchStatusPresentation(
                FETCH_STATUS.LOADING
            );
        }

        if (weeklyDataState?.origin === "cache") {
            notes.push({
                text: weeklyDataState.remoteCheckStatus === "pending"
                    ? "分析データ：前回確認済み版を表示中"
                    : "分析データ：直近正常版を使用中"
            });
        }

        if (dataSourceDate) {
            notes.push({
                text: `分析データ基準日：${dataSourceDate}`
            });
        }

        if (weeklyDataState?.remoteCheckStatus === "pending") {
            notes.push({ text: "最新版を確認中" });
        } else if (
            weeklyDataState?.status === "latest" &&
            weeklyDataState?.remoteCheckStatus === "current"
        ) {
            notes.push({ text: "状態：最新確認済み" });
        } else if (
            weeklyDataState?.status === "waiting_update" &&
            weeklyDataState?.remoteCheckStatus === "newer_available"
        ) {
            const observedDate = formatParticipantSourceDate(
                weeklyDataState.observedLatestTradeDate
            );
            notes.push({
                text: observedDate
                    ? `新版：${observedDate}を確認済み`
                    : "新版を確認済み"
            });
        } else if (
            weeklyDataState?.remoteCheckStatus === "failed" &&
            weeklyDataState?.sourceDate
        ) {
            notes.push({ text: "最新版の確認に失敗" });
        }

        if (
            sourceState?.status === FETCH_STATUS.FAILED &&
            !weeklyDataState?.sourceDate
        ) {
            notes.push({
                text: "分析データ：利用可能な正常版なし"
            });
        }
    }

    return {
        label: definition.label,
        presentation,
        meta,
        notes
    };
}

function renderDataFetchStatus(state = dataFetchState) {
    const grid = document.getElementById("dataFetchStatusGrid");
    const lastUpdated = document.getElementById("dataFetchLastUpdated");

    if (!grid || !lastUpdated) {
        return;
    }

    const sources = [
        "qri",
        "participant",
        "weeklyFutures",
        "weeklyOptions"
    ];
    const fragment = document.createDocumentFragment();

    sources.forEach(source => {
        const viewModel = createFetchSourceViewModel(source, state[source]);
        const card = document.createElement("article");
        const title = document.createElement("h3");
        const status = document.createElement("span");

        card.className = `data-fetch-status-card ${viewModel.presentation.className}`;
        title.textContent = viewModel.label;
        status.className = `data-fetch-status-badge ${viewModel.presentation.className}`;
        status.textContent = `${viewModel.presentation.icon} ${viewModel.presentation.label}`;
        card.append(title, status);

        if (viewModel.meta) {
            const meta = document.createElement("p");
            meta.className = "data-fetch-status-meta";
            meta.textContent = viewModel.meta;
            card.append(meta);
        }

        viewModel.notes.forEach(note => {
            if (note.text) {
                const noteElement = document.createElement("p");
                noteElement.className = "data-fetch-status-note";
                noteElement.textContent = note.text;
                card.append(noteElement);
                return;
            }

            const notePresentation = getFetchStatusPresentation(note.status);
            const noteElement = document.createElement("p");
            noteElement.className = `data-fetch-status-note ${notePresentation.className}`;
            noteElement.textContent = `${note.label}：${notePresentation.label}`;
            card.append(noteElement);
        });

        fragment.append(card);
    });

    grid.replaceChildren(fragment);

    const latestFetchedAt = sources
        .map(source => parseFetchDate(state[source]?.fetchedAt))
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime())[0];

    lastUpdated.textContent = latestFetchedAt
        ? `最終取得完了：${formatFetchDateTime(latestFetchedAt)}`
        : "最終取得完了：未取得";
}

let dataFetchStatusRenderScheduled = false;

function scheduleRenderDataFetchStatus() {
    if (dataFetchStatusRenderScheduled) {
        return;
    }

    dataFetchStatusRenderScheduled = true;
    queueMicrotask(() => {
        dataFetchStatusRenderScheduled = false;
        renderDataFetchStatus(dataFetchState);
    });
}

function updateFetchState(source, patch) {
    const sourceState = dataFetchState[source];

    if (!sourceState || !patch || typeof patch !== "object") {
        return null;
    }

    Object.assign(sourceState, patch);
    scheduleRenderDataFetchStatus();

    if (source === "qri") {
        updateOpenInterestDataStatus();
        window.refreshCurrentPriceSavedUi?.();
    }

    return sourceState;
}

function updateFetchDetail(source, detail, patch) {
    const detailState = dataFetchState[source]?.details?.[detail];

    if (!detailState || !patch || typeof patch !== "object") {
        return null;
    }

    Object.assign(detailState, patch);
    scheduleRenderDataFetchStatus();
    return detailState;
}

function createFetchRequestId(source) {
    return [
        source,
        Date.now(),
        Math.random().toString(36).slice(2, 10)
    ].join("-");
}

window.FETCH_STATUS = FETCH_STATUS;
window.dataFetchState = dataFetchState;
window.updateFetchState = updateFetchState;
window.updateFetchDetail = updateFetchDetail;
window.createFetchRequestId = createFetchRequestId;
window.renderDataFetchStatus = renderDataFetchStatus;

const LAST_VALID_QRI_OPEN_INTEREST_STORAGE_KEY =
    "optionMapLastValidQriOpenInterest";
const QRI_OPEN_INTEREST_CACHE_VERSION = 1;
const QRI_OPEN_INTEREST_CACHE_SOURCE =
    "qri-nikkei225-options";
const QRI_OPEN_INTEREST_SOURCE_DATE_KIND =
    "qri_page_last_updated";

let lastValidQriOpenInterestCache = null;

const qriOpenInterestDataState = {
    status: null,
    sourceDate: null,
    sourceDateKind: null,
    fetchedAt: null,
    usingFallback: false,
    origin: null
};

renderDataFetchStatus(dataFetchState);

function isPlainObject(value) {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isValidIsoDateTime(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return false;
    }

    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/
    );

    if (!match) {
        return false;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const daysInMonth = new Date(
        Date.UTC(year, month, 0)
    ).getUTCDate();

    return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth &&
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59 &&
        second >= 0 &&
        second <= 59 &&
        !Number.isNaN(new Date(value).getTime())
    );
}

function isValidQriOpenInterestCache(value) {
    if (!isPlainObject(value)) {
        return false;
    }

    if (
        value.version !== QRI_OPEN_INTEREST_CACHE_VERSION ||
        value.source !== QRI_OPEN_INTEREST_CACHE_SOURCE ||
        value.sourceUrl !== "https://svc.qri.jp/jpx/nkopm/" ||
        value.sourceDateKind !==
            QRI_OPEN_INTEREST_SOURCE_DATE_KIND ||
        !isValidIsoDateTime(value.sourceDate) ||
        !isValidIsoDateTime(value.fetchedAt) ||
        value.officialAsOf !== null ||
        value.contract !== null ||
        !Array.isArray(value.positions) ||
        value.positions.length === 0
    ) {
        return false;
    }

    const strikes = new Set();
    let totalOpenInterest = 0;

    for (const position of value.positions) {
        if (!isPlainObject(position)) {
            return false;
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                position,
                "callOpenInterest"
            ) ||
            !Object.prototype.hasOwnProperty.call(
                position,
                "putOpenInterest"
            )
        ) {
            return false;
        }

        const {
            strike,
            callOpenInterest,
            putOpenInterest
        } = position;

        if (
            !Number.isFinite(strike) ||
            strike <= 0 ||
            !Number.isFinite(callOpenInterest) ||
            !Number.isSafeInteger(callOpenInterest) ||
            callOpenInterest < 0 ||
            !Number.isFinite(putOpenInterest) ||
            !Number.isSafeInteger(putOpenInterest) ||
            putOpenInterest < 0 ||
            strikes.has(strike)
        ) {
            return false;
        }

        strikes.add(strike);
        totalOpenInterest += callOpenInterest + putOpenInterest;

        if (!Number.isSafeInteger(totalOpenInterest)) {
            return false;
        }
    }

    return totalOpenInterest > 0;
}

function loadLastValidQriOpenInterestCache() {
    try {
        const serialized = localStorage.getItem(
            LAST_VALID_QRI_OPEN_INTEREST_STORAGE_KEY
        );

        if (!serialized) {
            return null;
        }

        const parsed = JSON.parse(serialized);
        return isValidQriOpenInterestCache(parsed)
            ? parsed
            : null;
    } catch (error) {
        console.warn(
            "最後の正常QRI建玉キャッシュを読み込めませんでした:",
            error
        );
        return null;
    }
}

function createQriOpenInterestCache({
    sourceUrl,
    sourceDate,
    fetchedAt,
    labels,
    callOpenInterest,
    putOpenInterest
}) {
    if (
        !Array.isArray(labels) ||
        !Array.isArray(callOpenInterest) ||
        !Array.isArray(putOpenInterest) ||
        labels.length !== callOpenInterest.length ||
        labels.length !== putOpenInterest.length
    ) {
        return null;
    }

    const cache = {
        version: QRI_OPEN_INTEREST_CACHE_VERSION,
        source: QRI_OPEN_INTEREST_CACHE_SOURCE,
        sourceUrl,
        sourceDate,
        sourceDateKind: QRI_OPEN_INTEREST_SOURCE_DATE_KIND,
        officialAsOf: null,
        fetchedAt,
        contract: null,
        positions: labels.map((label, index) => ({
            strike: Number(String(label).replace(/,/g, "")),
            callOpenInterest: callOpenInterest[index],
            putOpenInterest: putOpenInterest[index]
        }))
    };

    return isValidQriOpenInterestCache(cache)
        ? cache
        : null;
}

function saveLastValidQriOpenInterest(input) {
    const cache = createQriOpenInterestCache(input || {});

    if (!cache) {
        return null;
    }

    lastValidQriOpenInterestCache = cache;
    Object.assign(qriOpenInterestDataState, {
        status: "latest",
        sourceDate: cache.sourceDate,
        sourceDateKind: cache.sourceDateKind,
        fetchedAt: cache.fetchedAt,
        usingFallback: false,
        origin: "live"
    });
    updateQriOpenInterestUiState();

    try {
        localStorage.setItem(
            LAST_VALID_QRI_OPEN_INTEREST_STORAGE_KEY,
            JSON.stringify(cache)
        );
    } catch (error) {
        console.warn(
            "最後の正常QRI建玉キャッシュを保存できませんでした:",
            error
        );
    }

    return cache;
}

lastValidQriOpenInterestCache =
    loadLastValidQriOpenInterestCache();

window.saveLastValidQriOpenInterest =
    saveLastValidQriOpenInterest;

function getCurrentQriOpenInterestSourceDate() {
    return isValidIsoDateTime(qriOpenInterestDataState.sourceDate)
        ? qriOpenInterestDataState.sourceDate
        : null;
}

function setQriOpenInterestDataUnavailable() {
    Object.assign(qriOpenInterestDataState, {
        status: null,
        sourceDate: null,
        sourceDateKind: null,
        fetchedAt: null,
        usingFallback: false,
        origin: null
    });
    updateQriOpenInterestUiState();
}

function applyFallbackQriOpenInterest({
    volumeLabels,
    callVolumes,
    putVolumes
} = {}) {
    const cache = lastValidQriOpenInterestCache;

    if (!isValidQriOpenInterestCache(cache)) {
        return { applied: false, reason: "invalid_cache" };
    }

    if (
        !Array.isArray(volumeLabels) ||
        !Array.isArray(callVolumes) ||
        !Array.isArray(putVolumes) ||
        volumeLabels.length !== callVolumes.length ||
        volumeLabels.length !== putVolumes.length
    ) {
        return { applied: false, reason: "invalid_volume_data" };
    }

    const positions = [...cache.positions]
        .sort((left, right) => left.strike - right.strike);
    const openInterestLabels = positions.map(position =>
        position.strike.toLocaleString("ja-JP")
    );
    const callOpenInterest = positions.map(position =>
        position.callOpenInterest
    );
    const putOpenInterest = positions.map(position =>
        position.putOpenInterest
    );

    if (openInterestLabels.length === 0) {
        return { applied: false, reason: "empty_positions" };
    }

    Object.assign(qriOpenInterestDataState, {
        status: "waiting_update",
        sourceDate: cache.sourceDate,
        sourceDateKind: cache.sourceDateKind,
        fetchedAt: cache.fetchedAt,
        usingFallback: true,
        origin: "cache"
    });

    window.drawJpxPriceChart(
        volumeLabels,
        callOpenInterest,
        putOpenInterest,
        callVolumes,
        putVolumes,
        {
            openInterestAvailable: true,
            openInterestLabels
        }
    );
    updateQriOpenInterestUiState();

    return {
        applied: true,
        reason: "fallback_applied",
        sourceDate: cache.sourceDate
    };
}

window.applyFallbackQriOpenInterest =
    applyFallbackQriOpenInterest;
window.setQriOpenInterestDataUnavailable =
    setQriOpenInterestDataUnavailable;

const refreshAllMarketDataButton =
    document.getElementById("refreshAllMarketDataButton");

async function handleRefreshAllMarketDataClick() {
    if (
        !refreshAllMarketDataButton ||
        refreshAllMarketDataButton.disabled
    ) {
        return null;
    }

    if (typeof window.refreshAllMarketData !== "function") {
        console.error("refreshAllMarketData が見つかりません");
        return null;
    }

    refreshAllMarketDataButton.disabled = true;
    refreshAllMarketDataButton.textContent = "更新中…";

    try {
        return await window.refreshAllMarketData();
    } catch (error) {
        console.error("市場データの一括更新に失敗:", error);
        return null;
    } finally {
        refreshAllMarketDataButton.disabled = false;
        refreshAllMarketDataButton.textContent = "🔄 すべて更新";
    }
}

if (refreshAllMarketDataButton) {
    refreshAllMarketDataButton.addEventListener(
        "click",
        handleRefreshAllMarketDataClick
    );
}

let myChart = null;
let futureOpenInterestChart = null;
let latestFutureOpenInterestResult = null;
window.setLatestFutureOpenInterestResult = function (result) {
    console.log("★ setter受信 =", result);
    latestFutureOpenInterestResult = result;

    updateFutureOpenInterestExpiryOptions(
        futureOpenInterestProduct.value
    );

    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );

    console.log(
        "週次先物データをグラフへ反映:",
        latestFutureOpenInterestResult
    );
};


let latestBrokerLabels = [];
let latestBrokerValues = [];
let latestParticipantMetadata = null;
let participantFetchDisplayState = null;
let latestNightBrokerData = {};
let latestDayBrokerData = {};
let latestOptionBrokerData = {};
let priceChart = null;
let combinedPriceChart = null;
let latestJpxLabels = [];
let latestCallValues = [];
let latestPutValues = [];
let optionMap = {};
let latestWeeklyOptionsResult = null;
window.setWeeklyOptionMap = function (result) {
    latestWeeklyOptionsResult = result || null;
    optionMap = result?.optionMap || {};

    console.log(
        "週次オプションを価格帯マップへ反映:",
        optionMap
    );

    drawOptionTable();
    showMaxPosition(result?.priceTotals || {});
    showPriceRanking();
};

function createLegacyWeeklyOptionsDisplayData(canonical) {
    const optionMapResult = {};
    const priceTotals = {};
    const brokerTotals = {};

    for (const record of canonical?.records || []) {
        // Preserve the existing rank-1/mixed display without contaminating raw.
        if (record?.published !== true || record.rank !== 1) continue;
        const price = Number(record.strike);
        const volume = Number(record.value);
        const broker = companyNames[record.broker] || record.broker;
        if (!Number.isFinite(price) || !Number.isSafeInteger(volume) || !broker) {
            continue;
        }
        optionMapResult[price] ||= {};
        optionMapResult[price][broker] =
            (optionMapResult[price][broker] || 0) + volume;
        priceTotals[price] = (priceTotals[price] || 0) + volume;
        brokerTotals[broker] = (brokerTotals[broker] || 0) + volume;
    }

    return {
        derivation: "legacy-rank1-mixed-option-type-and-side",
        optionMap: optionMapResult,
        priceTotals,
        brokerTotals
    };
}

window.createLegacyWeeklyOptionsDisplayData =
    createLegacyWeeklyOptionsDisplayData;
let allJpxLabels = [];
let allJpxCallValues = [];
let allJpxPutValues = [];
let allJpxCallVolumes = [];
let allJpxPutVolumes = [];
let allJpxOpenInterestLabels = [];
let jpxOpenInterestAvailable = null;
let currentChartMode = "openInterest";
let qriContractDisplayData = null;
let qriChartRendererIdentity = null;
let qriChartRendererGeneration = 0;

function setQriChartRendererIdentity({ rendererKind, sourceKind, displayOnly,
    displayGeneration = null } = {}) {
    qriChartRendererIdentity = Object.freeze({ rendererKind, sourceKind,
        displayOnly, generation: ++qriChartRendererGeneration,
        displayGeneration: Number.isSafeInteger(displayGeneration)
            ? displayGeneration : null,
        renderedAt: new Date().toISOString() });
}

function clearQriChartRendererIdentity() {
    qriChartRendererIdentity = null;
}
let lastJpxFetchedAt = null;
let currentPrice = 70000;
let currentPriceState = {
    value: currentPrice,
    source: "qri-nikkei225-futures",
    contract: null,
    quotedAt: null,
    fetchedAt: null,
    mode: "automatic"
};
let weeklyOptionsShadowCanonical = null;
let weeklyOptionsShadowSourceMetadata = null;
let previousWeeklyOptionsShadowCanonical = null;
let previousWeeklyOptionsShadowSourceMetadata = null;
let weeklyOptionsShadowSignalState = Object.freeze({
    status: "empty",
    calculatedAt: null,
    signal: null,
    sourceMetadata: null
});
let weeklyOptionsShadowChangesState = Object.freeze({
    status: "waiting_previous",
    calculatedAt: null,
    changes: null,
    previousSourceMetadata: null,
    currentSourceMetadata: null
});
let weeklyOptionsFormalHistoryComparisonState = null;

function weeklyOptionsViewElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
}

function appendWeeklyOptionsCards(parent, items, className) {
    if (!items?.length) return;
    const grid = weeklyOptionsViewElement("div", className);
    for (const item of items) {
        const card = weeklyOptionsViewElement("div", className.replace("-grid", "-item"));
        card.append(
            weeklyOptionsViewElement("span", null, item.label),
            weeklyOptionsViewElement("strong", null, item.value)
        );
        if (item.detail) {
            card.append(weeklyOptionsViewElement("small", null, item.detail));
        }
        grid.append(card);
    }
    parent.append(grid);
}

function appendWeeklyOptionsTable(parent, title, rows) {
    if (!rows?.length) return;
    parent.append(weeklyOptionsViewElement("h3", null, title));
    const table = weeklyOptionsViewElement("table", "weekly-options-change-table");
    const header = weeklyOptionsViewElement("tr");
    for (const label of ["区分", "前週", "今週", "変化"]) {
        header.append(weeklyOptionsViewElement("th", null, label));
    }
    const head = weeklyOptionsViewElement("thead");
    head.append(header);
    const body = weeklyOptionsViewElement("tbody");
    for (const row of rows) {
        const tr = weeklyOptionsViewElement("tr");
        for (const value of [row.label, row.previous, row.current, row.change]) {
            tr.append(weeklyOptionsViewElement("td", null, value));
        }
        body.append(tr);
    }
    table.append(head, body);
    parent.append(table);
}

function appendWeeklyOptionsList(parent, title, items, className) {
    if (!items?.length) return;
    parent.append(weeklyOptionsViewElement("h3", null, title));
    const list = weeklyOptionsViewElement("ul", className);
    items.forEach(item => list.append(
        weeklyOptionsViewElement("li", null, item)
    ));
    parent.append(list);
}

function renderWeeklyOptionsChangesPanel() {
    const container = document.getElementById("weeklyOptionsChangesPanelContent");
    const formalFormatter = window.OptionMapWeeklyOptionsHistoryComparisonView;
    if (container && weeklyOptionsFormalHistoryComparisonState &&
        formalFormatter?.createHistoryComparisonView) {
        const model = formalFormatter.createHistoryComparisonView(
            weeklyOptionsFormalHistoryComparisonState
        );
        const fragment = document.createDocumentFragment();
        fragment.append(
            weeklyOptionsViewElement("p", "weekly-options-shadow-notice", model.sourceNotice),
            weeklyOptionsViewElement("p", "weekly-options-shadow-notice", model.predictionNotice)
        );
        appendWeeklyOptionsCards(fragment, model.metadata, "weekly-options-meta-grid");
        if (model.message) fragment.append(weeklyOptionsViewElement(
            "p", model.state === "roll_transition"
                ? "weekly-options-partial-reason" : "weekly-options-empty", model.message
        ));
        if (model.coverageRows?.length) {
            appendWeeklyOptionsCards(fragment, model.coverageRows,
                "weekly-options-summary-grid");
        }
        appendWeeklyOptionsTable(fragment, "大きなstrike別変化", model.strikeRows);
        if (model.strikeMessage) fragment.append(weeklyOptionsViewElement(
            "p", "weekly-options-partial-reason", model.strikeMessage
        ));
        appendWeeklyOptionsList(fragment, "新規掲載", model.newlyPublished,
            "weekly-options-label-list");
        appendWeeklyOptionsList(fragment, "掲載から消失", model.disappeared,
            "weekly-options-label-list");
        appendWeeklyOptionsList(fragment, "注意事項", model.warnings,
            "weekly-options-warning-list");
        container.replaceChildren(fragment);
        return;
    }
    const formatter = window.OptionMapWeeklyOptionsChangesView;
    if (!container || !formatter?.createWeeklyOptionsChangesView) return;
    const model = formatter.createWeeklyOptionsChangesView(
        weeklyOptionsShadowChangesState,
        weeklyOptionsShadowSignalState
    );
    const fragment = document.createDocumentFragment();
    fragment.append(weeklyOptionsViewElement(
        "p", "weekly-options-shadow-notice", "方向予測には未使用"
    ));
    appendWeeklyOptionsCards(fragment, model.metadata, "weekly-options-meta-grid");
    if (model.message) {
        fragment.append(weeklyOptionsViewElement(
            "p", "weekly-options-empty", model.message
        ));
    }
    if (model.partialReason) {
        fragment.append(weeklyOptionsViewElement(
            "p", "weekly-options-partial-reason", model.partialReason
        ));
    }
    appendWeeklyOptionsCards(
        fragment, model.summaries, "weekly-options-summary-grid"
    );
    appendWeeklyOptionsCards(
        fragment, model.candidates, "weekly-options-candidate-grid"
    );
    appendWeeklyOptionsTable(
        fragment, "公表参加者breadth", model.breadthRows
    );
    appendWeeklyOptionsTable(
        fragment, "participant concentration（HHI）",
        model.participantConcentrationRows
    );
    appendWeeklyOptionsTable(
        fragment, "strike concentration（HHI）",
        model.strikeConcentrationRows
    );
    appendWeeklyOptionsList(
        fragment, "観測ラベル", model.labels, "weekly-options-label-list"
    );
    appendWeeklyOptionsList(
        fragment, "注意事項", model.warnings, "weekly-options-warning-list"
    );
    container.replaceChildren(fragment);
}

window.setWeeklyOptionsFormalHistoryComparison = function (comparison) {
    weeklyOptionsFormalHistoryComparisonState = comparison
        ? (typeof structuredClone === "function"
            ? structuredClone(comparison) : JSON.parse(JSON.stringify(comparison)))
        : null;
    renderWeeklyOptionsChangesPanel();
};

function calculateWeeklyOptionsShadowSignal() {
    if (
        !weeklyOptionsShadowCanonical ||
        !window.OptionMapWeeklyOptionsSignals?.deriveWeeklyOptionsSignals
    ) {
        return weeklyOptionsShadowSignalState;
    }
    const signal = window.OptionMapWeeklyOptionsSignals
        .deriveWeeklyOptionsSignals(weeklyOptionsShadowCanonical, {
            currentPrice: currentPriceState.value,
            sourceMetadata: weeklyOptionsShadowSourceMetadata
        });
    weeklyOptionsShadowSignalState = Object.freeze({
        status: signal.available ? "available" : "insufficient",
        calculatedAt: new Date().toISOString(),
        signal,
        sourceMetadata: weeklyOptionsShadowSourceMetadata
            ? { ...weeklyOptionsShadowSourceMetadata }
            : null
    });
    window.weeklyOptionsShadowSignalState = weeklyOptionsShadowSignalState;
    return weeklyOptionsShadowSignalState;
}

function calculateWeeklyOptionsShadowChanges() {
    if (
        !previousWeeklyOptionsShadowCanonical ||
        !weeklyOptionsShadowCanonical ||
        !window.OptionMapWeeklyOptionsChanges?.compareWeeklyOptions
    ) {
        weeklyOptionsShadowChangesState = Object.freeze({
            status: "waiting_previous",
            calculatedAt: null,
            changes: null,
            previousSourceMetadata: null,
            currentSourceMetadata: weeklyOptionsShadowSourceMetadata
                ? { ...weeklyOptionsShadowSourceMetadata } : null
        });
        window.weeklyOptionsShadowChangesState =
            weeklyOptionsShadowChangesState;
        renderWeeklyOptionsChangesPanel();
        return weeklyOptionsShadowChangesState;
    }
    const changes = window.OptionMapWeeklyOptionsChanges.compareWeeklyOptions(
        previousWeeklyOptionsShadowCanonical,
        weeklyOptionsShadowCanonical
    );
    weeklyOptionsShadowChangesState = Object.freeze({
        status: changes.status,
        calculatedAt: new Date().toISOString(),
        changes,
        previousSourceMetadata: previousWeeklyOptionsShadowSourceMetadata
            ? { ...previousWeeklyOptionsShadowSourceMetadata } : null,
        currentSourceMetadata: weeklyOptionsShadowSourceMetadata
            ? { ...weeklyOptionsShadowSourceMetadata } : null
    });
    window.weeklyOptionsShadowChangesState = weeklyOptionsShadowChangesState;
    renderWeeklyOptionsChangesPanel();
    return weeklyOptionsShadowChangesState;
}

window.setWeeklyOptionsShadowCanonical = function (canonical, sourceMetadata = {}) {
    if (!window.OptionMapWeeklyOptions?.validateWeeklyOptionsData?.(canonical)) {
        weeklyOptionsShadowCanonical = null;
        weeklyOptionsShadowSourceMetadata = null;
        previousWeeklyOptionsShadowCanonical = null;
        previousWeeklyOptionsShadowSourceMetadata = null;
        weeklyOptionsShadowSignalState = Object.freeze({
            status: "invalid",
            calculatedAt: new Date().toISOString(),
            signal: null,
            sourceMetadata: null
        });
        window.weeklyOptionsShadowSignalState = weeklyOptionsShadowSignalState;
        weeklyOptionsShadowChangesState = Object.freeze({
            status: "invalid",
            calculatedAt: new Date().toISOString(),
            changes: null,
            previousSourceMetadata: null,
            currentSourceMetadata: null
        });
        window.weeklyOptionsShadowChangesState =
            weeklyOptionsShadowChangesState;
        renderWeeklyOptionsChangesPanel();
        return weeklyOptionsShadowSignalState;
    }
    if (
        weeklyOptionsShadowCanonical &&
        canonical.sourceDate > weeklyOptionsShadowCanonical.sourceDate
    ) {
        previousWeeklyOptionsShadowCanonical = weeklyOptionsShadowCanonical;
        previousWeeklyOptionsShadowSourceMetadata =
            weeklyOptionsShadowSourceMetadata;
    } else if (
        weeklyOptionsShadowCanonical &&
        canonical.sourceDate < weeklyOptionsShadowCanonical.sourceDate
    ) {
        return weeklyOptionsShadowSignalState;
    }
    weeklyOptionsShadowCanonical = canonical;
    weeklyOptionsShadowSourceMetadata = { ...sourceMetadata };
    const signalState = calculateWeeklyOptionsShadowSignal();
    calculateWeeklyOptionsShadowChanges();
    return signalState;
};

window.getWeeklyOptionsShadowSignal = function () {
    return typeof structuredClone === "function"
        ? structuredClone(weeklyOptionsShadowSignalState)
        : JSON.parse(JSON.stringify(weeklyOptionsShadowSignalState));
};
window.getWeeklyOptionsShadowChanges = function () {
    return typeof structuredClone === "function"
        ? structuredClone(weeklyOptionsShadowChangesState)
        : JSON.parse(JSON.stringify(weeklyOptionsShadowChangesState));
};
window.weeklyOptionsShadowSignalState = weeklyOptionsShadowSignalState;
window.weeklyOptionsShadowChangesState = weeklyOptionsShadowChangesState;
renderWeeklyOptionsChangesPanel();
let priceTotals = {};
let comparisonSnapshot = null;
let comparisonSelectionMode = "none";
let comparisonSelectionCurrentSourceDate = null;
let latestNightFutureTotals = null;
let latestDayFutureTotals = null;
let latestParsedDayData = null;

const companyNames = {
    "ＡＢＮクリアリン証券": "ABN",
    "ソシエテＧ証券": "SG",
    "バークレイズ証券": "Barclays",
    "ＳＢＩ証券": "SBI",
    "楽天証券": "Rakuten",
    "ＪＰモルガン証券": "JPM",
    "ゴールドマン証券": "Goldman",
    "ビーオブエー証券": "BofA",
    "日産証券": "Nissan",
    "フィリップ証券": "Phillip",
    "松井証券": "Matsui",
    "みずほ証券": "Mizuho",
    "野村証券": "Nomura",
    "モルガンＭＵＦＧ証券": "MorganMUFG",
    "マネックス証券": "Monex",
    "インタラクティブ証券": "IB",
    "ＵＢＳ証券": "UBS",
    "シティグループ証券": "Citi",
    "ＨＳＢＣ証券": "HSBC",
    "ドイツ証券": "Deutsche",
    "ＢＮＰパリバ証券": "BNP",
    "三菱ＵＦＪ証券": "MUFG",
    "光世証券": "Kosei",
    "ＳＭＢＣ日興証券": "SMBC"
};

const button = document.getElementById("analyzeButton");
const nightData = document.getElementById("nightData");
const dayData = document.getElementById("dayData");
const optionData = document.getElementById("optionData");
const futureOpenInterestData =
  document.getElementById("futureOpenInterestData");
const futureOpenInterestProduct =
  document.getElementById("futureOpenInterestProduct");
const futureOpenInterestExpiry =
  document.getElementById("futureOpenInterestExpiry");
const brokerProductSelect =
  document.getElementById("brokerProductSelect");
const brokerMarketSelect =
  document.getElementById("brokerMarketSelect");
const brokerTemplate =
    document.getElementById("brokerTemplate");
const directionTemplate =
    document.getElementById("directionTemplate");
const saveAiTemplateButton =
    document.getElementById("saveAiTemplateButton");
const defaultAiTemplates = {
        broker:
            "主要証券会社では買い姿勢が目立つ一方、市場全体では売り姿勢が優勢となっており、市場参加者の見方が分かれています。",
   
        direction:
            "方向感が出るまで、建玉の変化を観察しましょう。"
    };    


nightData.value = localStorage.getItem("optionMapNightData") || "";
dayData.value = localStorage.getItem("optionMapDayData") || "";
optionData.value = localStorage.getItem("optionMapOptionData") || "";
futureOpenInterestData.value =
localStorage.getItem("optionMapFutureOpenInterestData") || "";
let savedAiTemplates = null;

try {
    savedAiTemplates = JSON.parse(
        localStorage.getItem("optionMapAiTemplates")
    );
} catch (error) {
    console.warn(
        "AIコメント設定の読み込みに失敗しました:",
        error
    );
}

const aiTemplates = {
    ...defaultAiTemplates,
    ...(savedAiTemplates || {})
};

brokerTemplate.value = aiTemplates.broker;
directionTemplate.value = aiTemplates.direction;

futureOpenInterestProduct.addEventListener("change", () => {
    updateFutureOpenInterestExpiryOptions(
        futureOpenInterestProduct.value
    );

    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );
});
function updateFutureOpenInterestExpiryOptions(productName) {
    if (
        !latestFutureOpenInterestResult ||
        !latestFutureOpenInterestResult.products[productName]
    ) {
        return;
    }

    const productData =
        latestFutureOpenInterestResult.products[productName];

    const expirySet = new Set();

    Object.values(productData.brokers).forEach(position => {
        console.log(position.expiries);
        Object.keys(position.expiries || {}).forEach(expiry => {
            expirySet.add(expiry);
        });
    });

    const expiries = Array.from(expirySet).sort();

    futureOpenInterestExpiry.innerHTML =
        '<option value="all">全限月</option>';

    expiries.forEach(expiry => {
        const option = document.createElement("option");
        option.value = expiry;
        option.textContent = expiry;
        futureOpenInterestExpiry.appendChild(option);
    });
}

futureOpenInterestExpiry.addEventListener("change", () => {
    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );
});

const clearInputButton =
    document.getElementById("clearInputButton");
const clearWeeklyButton =
    document.getElementById("clearWeeklyButton");    

if (clearInputButton) {
    clearInputButton.addEventListener("click", () => {
        const shouldClear = confirm(
            "夜間・日中・オプションの入力データを消しますか？"
        );

        if (!shouldClear) {
            return;
        }

        nightData.value = "";
        dayData.value = "";
       
        

        localStorage.removeItem("optionMapNightData");
        localStorage.removeItem("optionMapDayData");
        
        
    });
}

if (clearWeeklyButton) {
    clearWeeklyButton.addEventListener("click", () => {

        const ok = confirm("週次データを消しますか？");

        if (!ok) return;

        optionData.value = "";
        futureOpenInterestData.value = "";

        localStorage.removeItem("optionMapOptionData");
        localStorage.removeItem("optionMapFutureOpenInterestData");

        alert("週次データを削除しました。");
    });
}

nightData.addEventListener("input", () => {
    localStorage.setItem("optionMapNightData", nightData.value);
});

dayData.addEventListener("input", () => {
    localStorage.setItem("optionMapDayData", dayData.value);
});

optionData.addEventListener("input", () => {
    localStorage.setItem("optionMapOptionData", optionData.value);
});

futureOpenInterestData.addEventListener("input", () => {
    localStorage.setItem(
      "optionMapFutureOpenInterestData",
      futureOpenInterestData.value
    );
  });

  brokerProductSelect.addEventListener("change", () => {
    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    } else {
        updateBrokerChartFromSelection();
    }
});
  
brokerMarketSelect.addEventListener("change", () => {
    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    } else {
        updateBrokerChartFromSelection();
    }
});  

button.addEventListener("click", function () {
    setTimeout(function () {
        const nightText = nightData.value.trim();
        const dayText = dayData.value.trim();
        const optionText = optionData.value.trim();
        const futureOpenInterestText =
            futureOpenInterestData.value.trim();
        const hasNightData = nightText.length > 0;
        const hasDayData = dayText.length > 0;
        const hasOptionData = optionText.length > 0;
        const hasFutureOpenInterestData =
            futureOpenInterestText.length > 0;

        if (
            !hasNightData &&
            !hasDayData &&
            !hasOptionData &&
            !hasFutureOpenInterestData
        ) {
            console.log(
                "復旧用手動解析：入力がないため既存状態を維持します"
            );
            return;
        }

        const selectedProduct = brokerProductSelect.value;
        const selectedMarket = brokerMarketSelect.value;

        if (hasNightData) {
            latestNightFutureTotals =
                analyzeFutureData(nightText);
            latestNightBrokerData = {
                ...(
                    latestNightFutureTotals[selectedProduct]
                        ?.[selectedMarket] || {}
                )
            };
        }

        if (hasDayData) {
            latestDayFutureTotals =
                analyzeFutureData(dayText);
            latestDayBrokerData = {
                ...(
                    latestDayFutureTotals[selectedProduct]
                        ?.[selectedMarket] || {}
                )
            };
        }

        if (hasNightData || hasDayData) {
            updateBrokerChartFromSelection();
        }

        if (hasOptionData) {
            optionMap = {};
            const optionResult = analyzeOptionData(optionText);

            optionMap = optionResult.optionMap;
            latestOptionBrokerData = {
                ...optionResult.brokerTotals
            };

            drawOptionTable();
            showMaxPosition(optionResult.priceTotals);
            showPriceRanking();

            console.log(
                "復旧用週次オプション解析結果:",
                optionResult
            );
        }

        if (hasFutureOpenInterestData) {
            latestFutureOpenInterestResult =
                analyzeFutureOpenInterestData(
                    futureOpenInterestText
                );
            updateFutureOpenInterestExpiryOptions(
                futureOpenInterestProduct.value
            );
            drawFutureOpenInterestChart(
                futureOpenInterestProduct.value,
                futureOpenInterestExpiry.value
            );

            console.log(
                "復旧用週次指数先物解析結果:",
                latestFutureOpenInterestResult
            );
        }

    }, 1000);

});

function showMaxPosition(priceTotals) {
    const result = document.getElementById("maxPosition");

    if (!result) return;

    let maxPrice = "";
    let maxValue = 0;

    for (const price in priceTotals) {
        const value = Number(priceTotals[price]) || 0;

        if (value > maxValue) {
            maxValue = value;
            maxPrice = price;
        }
    }

    result.innerHTML = `
        <p><strong>価格帯</strong></p>
        <h2>${Number(maxPrice || 0).toLocaleString()}円</h2>

        <p><strong>建玉</strong></p>
        <h2>${maxValue.toLocaleString()}枚</h2>
    `;
}

function analyzeFutureData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");


    const products = {
        NK225F: {
          auction: {},
          jnet: {},
          combined: {}
        },
        NK225M: {
          auction: {},
          jnet: {},
          combined: {}
        },
        TOPIXF: {
          auction: {},
          jnet: {},
          combined: {}
        }
      };
      
      let currentMarket = "auction";
    

    for (const line of lines) {

        if (line.includes("（J-NET）") || line.includes("(J-NET)")) {
            currentMarket = "jnet";
            console.log("区分を検出: J-NET");
            continue;
          }
          
          if (line.includes("（立会）") || line.includes("(立会)")) {
            currentMarket = "auction";
            console.log("区分を検出: 立会");
            continue;
          }

        const words = line.trim().split(/\s+/);

     if (words.length < 8) continue;

        const company = words.find(word => word.includes("証券"));
        const rawProduct = words.find(word =>
            ["NK225F", "NK225MF", "TOPIXF"].includes(word)
          );
          
          const product =
            rawProduct === "NK225MF"
              ? "NK225M"
              : rawProduct;
        const volume = Number(words[words.length - 1].replace(/,/g, ""));

        console.log(JSON.stringify(line));

       
        if (!line.includes("証券")) continue;

      
        console.log(words);
        console.log(product);
        console.log(company);
        console.log(volume);

        if (!product || !company || isNaN(volume)) continue;

        const marketData = products[product][currentMarket];

        if (!marketData[company]) {
          marketData[company] = 0;
        }
        
        marketData[company] += volume;
        
        if (!products[product].combined[company]) {
          products[product].combined[company] = 0;
        }
        
        products[product].combined[company] += volume;

    }
    console.log("商品別取引高:", products);
    return products;

}



function analyzeOptionData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");

    const totals = {};
    const priceTotals = {};

    let currentPrice = "";

    for (const line of lines) {

        console.log(JSON.stringify(line));

        const priceMatch = line.match(/(\d{2},\d{3})\s*円/);

        if (priceMatch) {

            currentPrice = priceMatch[1].replace(",", "");

            console.log("価格帯:", currentPrice);


        }

        if (!line.includes("証券")) continue;

        if (currentPrice === "") {
            console.log("価格が空！", line);
        }

        const words = line.trim().split(/\s+/);

        const company = words.find(word => word.includes("証券"));

        const volumeText = words[words.length - 1];
        const volume = Number(volumeText.replace(/,/g, ""));

        console.log(words);
        console.log(company);
        console.log(volumeText);
        console.log(volume);

        if (!company || isNaN(volume)) continue;

        if (currentPrice === "") {
            console.log("価格が空！！", line);
        }

        if (!totals[company]) {
            totals[company] = 0;
        }

        totals[company] += volume;

        if (!priceTotals[currentPrice]) {
            priceTotals[currentPrice] = 0;
        }

        priceTotals[currentPrice] += volume;

        if (!optionMap[currentPrice]) {
            optionMap[currentPrice] = {};
        }

        if (!optionMap[currentPrice][company]) {
            optionMap[currentPrice][company] = 0;
        }

        optionMap[currentPrice][company] += volume;

    }
    console.log(optionMap);
    return {
        brokerTotals: totals,
        priceTotals: priceTotals,
        optionMap: optionMap
    };

}

function analyzeFutureOpenInterestData(text) {
    console.log("指数先物建玉の解析開始");
  
    const lines = text.split(/\r?\n/);
  
    const products = {};
    let currentProduct = "";
  
    const normalizeText = (value) =>
      String(value || "")
        .replace(/["“”]/g, "")
        .replace(/\u3000/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  
    const toNumber = (value) => {
      const cleaned = String(value || "")
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "");
  
      const number = Number(cleaned);
      return Number.isFinite(number) ? number : 0;
    };
  
    const normalizeProductName = (value) => {
      const name = normalizeText(value)
        .replace(/[＜<]/g, "")
        .replace(/[＞>]/g, "");
  
      if (name.includes("日経225mini") || name.includes("日経225ミニ")) {
        return "日経225mini";
      }
  
      if (name.includes("日経225先物")) {
        return "日経225先物";
      }
  
      if (name.includes("TOPIX")) {
        return "TOPIX先物";
      }
  
      if (name.includes("JPX日経400")) {
        return "JPX日経400先物";
      }
  
      return name;
    };
  
    const ensureProduct = (productName) => {
      if (!products[productName]) {
        products[productName] = {
          brokers: {},
          sellTotal: 0,
          buyTotal: 0,
        };
      }
  
      return products[productName];
    };
  
    const addBrokerPosition = (
      productName,
      brokerName,
      side,
      volume,
      expiry
    ) => {
      const broker = normalizeText(brokerName);
  
      if (!productName || !broker || volume <= 0) {
        return;
      }
  
      const product = ensureProduct(productName);
  
      if (!product.brokers[broker]) {
        product.brokers[broker] = {
          sell: 0,
          buy: 0,
          net: 0,
          expiries: {},
        };
      }
  
      const brokerData = product.brokers[broker];
  
      brokerData[side] += volume;
  
      if (side === "sell") {
        product.sellTotal += volume;
      } else {
        product.buyTotal += volume;
      }
  
      console.log(productName, expiry);
      if (expiry) {
        if (!brokerData.expiries[expiry]) {
          brokerData.expiries[expiry] = {
            sell: 0,
            buy: 0,
            net: 0,
          };
        }
  
        brokerData.expiries[expiry][side] += volume;
  
        brokerData.expiries[expiry].net =
          brokerData.expiries[expiry].buy -
          brokerData.expiries[expiry].sell;
      }
  
      brokerData.net = brokerData.buy - brokerData.sell;

      console.log({
        broker,
        side,
        sell: brokerData.sell,
        buy: brokerData.buy,
        net: brokerData.net,
        expiry
    });
    };
  
    for (const rawLine of lines) {
      const line = rawLine.trim();
  
      if (!line) {
        continue;
      }
  
      // ＜日経225先物＞などの商品見出し
      const productMatch = line.match(/[＜<]([^＞>]+)[＞>]/);
  
      if (productMatch) {
        currentProduct = normalizeProductName(productMatch[1]);
        ensureProduct(currentProduct);
  
        console.log("商品を検出:", currentProduct);
        continue;
      }
  
      if (!currentProduct) {
        continue;
      }
  
      // Excelから貼り付けたタブ区切りを維持
      const cells = rawLine.split("\t").map(normalizeText);

console.log(
    "週次建玉行:",
    currentProduct,
    cells
);


  
      // 順位で始まらない行は、見出しなどとして除外
      if (!/^\d+$/.test(cells[0] || "")) {
        continue;
      }
  
      /*
        想定される列：
        0 順位
        1 売り側の限月
        2 売り建玉
        3 売り参加者
        4 買い建玉
        5 買い側の限月
        6 買い参加者
      */
  
        const expiryPattern = /^20\d{2}年\d{1,2}月限月$/;

        cells.forEach((cell, expiryIndex) => {
            const expiry = cell || "";
        
            if (!expiryPattern.test(expiry)) {
                return;
            }
        
            const sellVolume = toNumber(cells[expiryIndex + 1]);
            const sellBroker = cells[expiryIndex + 2] || "";
        
            const buyVolume = toNumber(cells[expiryIndex + 3]);
            const buyBroker = cells[expiryIndex + 5] || "";
        
            addBrokerPosition(
                currentProduct,
                sellBroker,
                "sell",
                sellVolume,
                expiry
            );
        
            addBrokerPosition(
                currentProduct,
                buyBroker,
                "buy",
                buyVolume,
                expiry
            );
        });
  
    }

    // 全商品を合算した証券会社別データ
    const brokerTotals = {};
  
    for (const productData of Object.values(products)) {
      for (const [broker, position] of Object.entries(productData.brokers)) {
        if (!brokerTotals[broker]) {
          brokerTotals[broker] = {
            sell: 0,
            buy: 0,
            net: 0,
          };
        }
  
        brokerTotals[broker].sell += position.sell;
        brokerTotals[broker].buy += position.buy;
        brokerTotals[broker].net =
          brokerTotals[broker].buy -
          brokerTotals[broker].sell;
      }
    }
  
    console.log("指数先物建玉・商品別:", products);
    console.log("指数先物建玉・証券会社別合計:", brokerTotals);
  
    return {
      products,
      brokerTotals,
    };
  }

  function analyzeFutureOpenInterestJson(rows) {
    if (!window.OptionMapWeeklyFutures) {
        throw new Error("週次先物parserを初期化できません");
    }
    const result = window.OptionMapWeeklyFutures
        .parseWeeklyFuturesRows(rows);
    console.log("週次先物・正式schema解析結果:", result);
    return result;
}

function drawChart(labels, values) {
    latestBrokerLabels = [...labels];
    latestBrokerValues = [...values];

    const ctx = document.getElementById("myChart");
    const statusElement =
        document.getElementById("brokerChartStatus");

    if (!ctx) {
        console.error("myChartのcanvasが見つかりません");
        return;
    }

    ctx.hidden = false;

    if (statusElement && !participantFetchDisplayState) {
        statusElement.hidden = true;
        statusElement.textContent = "";
    }

    const existingChart = Chart.getChart(ctx);

    if (existingChart) {
        existingChart.destroy();
    }

    myChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "取引枚数",
                data: values,
            
                backgroundColor: values.map(value => {
                    if (value >= 50000) return "#ff4d4d";   // 赤
                    if (value >= 30000)  return "#ff9933";   // オレンジ
                    if (value >= 10000)  return "#ffd966";   // 黄色
                    return "#b6d7a8";                      // 緑
                }),
            
                borderColor: "#2f6fb6",
                borderWidth: 1,
            
                barPercentage: 0.95,
                categoryPercentage: 0.9
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
          
            interaction: {
              mode: "index",
              intersect: false
            },
          
            plugins: {
              legend: readableLegendOptions(),
              tooltip: readableTooltipOptions({
                  label: (context) => {
                    const value = Number(context.raw || 0);
                    return `取引枚数: ${value.toLocaleString("ja-JP")}枚`;
                  }
                })
            },
            scales: {
              x: {
                ticks: {
                  autoSkip: false,
                  minRotation: labels.length > 8 ? 35 : 0,
                  maxRotation: 55,
                  padding: 6,
                  font: { size: CHART_TEXT_SIZE.axis }
                }
              },
              y: {
                beginAtZero: true,
                ticks: {
                  padding: 6,
                  font: { size: CHART_TEXT_SIZE.axis },
                  callback: value => Number(value).toLocaleString("ja-JP")
                }
              }
            }
          }
    });

}

function drawPriceChart(labels, values) {

    const ctx = document.getElementById("priceChart");

    if (!ctx) {
        console.error("priceChartのcanvasが見つかりません");
        return;
    }
    
    const existingChart = Chart.getChart(ctx);
    
    if (existingChart) {
        existingChart.destroy();
    }
    priceChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "価格帯建玉",
                data: values,

                backgroundColor: values.map(value => {

                    if (value >= 3000) return "#ff4d4d";   // 赤
                    if (value >= 500)  return "#ff9933";   // オレンジ
                    if (value >= 100)  return "#ffd966";   // 黄色

                    return "#b6d7a8";                      // 緑
                }),

                borderColor: "#2f6fb6",
                borderWidth: 1,

                barPercentage: 0.95,
                categoryPercentage: 0.9

            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });


}

function drawFutureOpenInterestChart(
    productName,
    selectedExpiry = "all"
) {
 
    console.log(
        "週次商品キー一覧:",
        Object.keys(latestFutureOpenInterestResult.products || {})
    );
    
    console.log(
        "選択中の商品名:",
        productName
    );

    const productData =
      latestFutureOpenInterestResult.products[productName];
  
    if (!productData) {
      console.warn("指数先物建玉の商品データがありません:", productName);
      return;
    }
  
    const allRows = Object.entries(productData.brokers)
    .map(([broker, position]) => {
        const source =
            selectedExpiry === "all"
                ? position
                : position.expiries?.[selectedExpiry];

        return {
            broker,
            sell: source?.sell || 0,
            buy: source?.buy || 0,
        };
    });

const topBuyRows = [...allRows]
    .filter(row => row.buy > 0)
    .sort((a, b) => b.buy - a.buy)
    .slice(0, 5);

const topSellRows = [...allRows]
    .filter(row => row.sell > 0)
    .sort((a, b) => b.sell - a.sell)
    .slice(0, 5);

const rowMap = new Map();

[...topBuyRows, ...topSellRows].forEach(row => {
    rowMap.set(row.broker, row);
});

const rows = Array.from(rowMap.values());
    const labels = rows.map((row) => companyNames[row.broker] || row.broker);
    const sellValues = rows.map((row) => row.sell);
    const buyValues = rows.map((row) => row.buy);
  
    const canvas = document.getElementById("futureOpenInterestChart");
  
    if (!canvas) {
      console.error("futureOpenInterestChart が見つかりません");
      return;
    }
  
    const existingChart = Chart.getChart(canvas);
  
    if (existingChart) {
      existingChart.destroy();
    }
  
    futureOpenInterestChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "売り建玉",
            data: sellValues,
            backgroundColor: TRADE_DIRECTION_CHART_COLORS.sell.fill,
            borderColor: TRADE_DIRECTION_CHART_COLORS.sell.border,
            borderWidth: 1,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
          },
          {
            label: "買い建玉",
            data: buyValues,
            backgroundColor: TRADE_DIRECTION_CHART_COLORS.buy.fill,
            borderColor: TRADE_DIRECTION_CHART_COLORS.buy.border,
            borderWidth: 1,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
  
        interaction: {
          mode: "index",
          intersect: false,
        },
  
        scales: {
          x: {
            stacked: false,
            offset: true,
            ticks: {
              maxRotation: 45,
              minRotation: labels.length > 6 ? 30 : 0,
              autoSkip: false,
              padding: 6,
              font: { size: CHART_TEXT_SIZE.axis },
            },
          },
  
          y: {
            beginAtZero: true,
            ticks: {
              padding: 6,
              font: { size: CHART_TEXT_SIZE.axis },
              callback: (value) => Number(value).toLocaleString("ja-JP"),
            },
            title: readableAxisTitle("建玉枚数"),
          },
        },
  
        plugins: {
          legend: readableLegendOptions(),
          tooltip: readableTooltipOptions({
              label: (context) => {
                const value = Number(context.raw || 0).toLocaleString("ja-JP");
                return `${context.dataset.label}: ${value}枚`;
              },
            }),
        },
      },
    });
  

    
    const ranking = document.getElementById("futureOpenInterestRanking");

    const buyRanking = [...rows]
       .filter(r => r.buy > 0)
       .sort((a,b)=>b.buy-a.buy)
       .slice(0,5);
    
    const sellRanking = [...rows]
        .filter(r => r.sell > 0)
        .sort((a,b)=>b.sell-a.sell)
        .slice(0,5);
    
    ranking.innerHTML = `
    <div class="ranking-columns">
    
    <div>
    <h3>📈 買い建玉 TOP5</h3>
    <ol>
    ${buyRanking.map(r=>`
    <li>${companyNames[r.broker] || r.broker}
    （${r.buy.toLocaleString()}枚）
    </li>`).join("")}
    </ol>
    </div>
    
    <div>
    <h3>📉 売り建玉 TOP5</h3>
    <ol>
    ${sellRanking.map(r=>`
    <li>${companyNames[r.broker] || r.broker}
    （${r.sell.toLocaleString()}枚）
    </li>`).join("")}
    </ol>
    </div>
    
    </div>
    `;

    console.log("指数先物建玉グラフ作成成功:", productName);
  }


  function updateBrokerChartFromSelection() {

    console.log("★ broker初回描画");
    console.log("★ latestNightFutureTotals =", latestNightFutureTotals);
    console.log("★ latestDayFutureTotals =", latestDayFutureTotals);

    if (!latestNightFutureTotals || !latestDayFutureTotals) {
      return;
    }
  
    const selectedProduct = brokerProductSelect.value;
    const selectedMarket = brokerMarketSelect.value;
  
    const selectedNightTotals =
      latestNightFutureTotals[selectedProduct]?.[selectedMarket] || {};
  
    const selectedDayTotals =
      latestDayFutureTotals[selectedProduct]?.[selectedMarket] || {};
  
      console.log("★ selectedProduct =", selectedProduct);
      console.log("★ selectedMarket =", selectedMarket);
      console.log("★ selectedNightTotals =", selectedNightTotals);
      console.log("★ selectedDayTotals =", selectedDayTotals);

      console.log(
        "★ night NK225Fの区分キー =",
        Object.keys(latestNightFutureTotals[selectedProduct] || {})
    );
    
    console.log(
        "★ day NK225Fの区分キー =",
        Object.keys(latestDayFutureTotals[selectedProduct] || {})
    );

    latestNightBrokerData = { ...selectedNightTotals };
    latestDayBrokerData = { ...selectedDayTotals };
  
    const combinedBrokerTotals = {};
  
    for (const company in selectedNightTotals) {
      combinedBrokerTotals[company] = selectedNightTotals[company];
    }
  
    for (const company in selectedDayTotals) {
      if (combinedBrokerTotals[company] === undefined) {
        combinedBrokerTotals[company] = 0;
      }
  
      combinedBrokerTotals[company] += selectedDayTotals[company];
    }
  
    const sortedEntries = Object.entries(combinedBrokerTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  
    const labels = sortedEntries.map(
      ([company]) => companyNames[company] || company
    );
  
    const values = sortedEntries.map(([, volume]) => volume);
  
    drawChart(labels, values);
  
    console.log("証券会社別グラフを切替:", {
      selectedProduct,
      selectedMarket,
      combinedBrokerTotals
    });
  }

  function updateBrokerChartFromExcel(records) {
    if (!Array.isArray(records) || records.length === 0) {
        console.warn("Excel由来の証券会社データがありません");

        latestBrokerLabels = [];
        latestBrokerValues = [];

        const canvas = document.getElementById("myChart");
        const statusElement =
            document.getElementById("brokerChartStatus");
        const existingChart = canvas
            ? Chart.getChart(canvas)
            : null;

        if (existingChart) {
            existingChart.destroy();
        }

        myChart = null;

        if (canvas) {
            canvas.hidden = true;
        }

        if (statusElement) {
            statusElement.textContent =
                "選択商品のデータがありません";
            statusElement.hidden = false;
        }

        return;
    }

    const top10 = [...records]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

    const labels = top10.map(item => item.company);
    const values = top10.map(item => item.volume);

    console.log("Excelデータから証券会社グラフを更新:", top10);

    drawChart(labels, values);
}

function mergeBrokerRecords(auctionRecords, jnetRecords) {
    const map = new Map();

    function add(records) {
        if (!Array.isArray(records)) return;

        for (const item of records) {
            const key = item.company;

            if (!map.has(key)) {
                map.set(key, {
                    ...item,
                    volume: 0
                });
            }

            map.get(key).volume += item.volume;
        }
    }

    add(auctionRecords);
    add(jnetRecords);

    return [...map.values()];
}

function updateBrokerChartByProduct(parsedDayData) {
    const product = brokerProductSelect.value;
    const market = brokerMarketSelect.value;

    const getProductRecords = data => {
        if (!data) return [];

        if (product === "NK225F") {
            return data.large?.records || [];
        }

        if (product === "NK225M") {
            return data.mini?.records || [];
        }

        if (product === "TOPIXF") {
            return data.topix?.records || [];
        }

        console.warn("未対応の商品です:", product);
        return [];
    };

    const dayAuctionRecords = getProductRecords(
        parsedDayData.dayAuction
    );

    const dayJnetRecords = getProductRecords(
        parsedDayData.dayJnet
    );

    const nightAuctionRecords = getProductRecords(
        parsedDayData.nightAuction
    );

    const nightJnetRecords = getProductRecords(
        parsedDayData.nightJnet
    );

    let records = [];

    if (market === "auction") {
        records = mergeBrokerRecords(
            dayAuctionRecords,
            nightAuctionRecords
        );
    } else if (market === "jnet") {
        records = mergeBrokerRecords(
            dayJnetRecords,
            nightJnetRecords
        );

    } else if (market === "combined") {
        const auctionRecords = mergeBrokerRecords(
            dayAuctionRecords,
            nightAuctionRecords
        );

        const jnetRecords = mergeBrokerRecords(
            dayJnetRecords,
            nightJnetRecords
        );

        records = mergeBrokerRecords(
            auctionRecords,
            jnetRecords
        );
    }

    updateBrokerChartFromExcel(records);
}

function renderParticipantFetchDisplayState() {
    const statusElement = document.getElementById("brokerChartStatus");
    if (!statusElement) return;

    if (!participantFetchDisplayState && !participantDataState.sourceDate) {
        statusElement.hidden = true;
        statusElement.textContent = "";
        return;
    }

    const { status, successCount, fileCount } =
        participantFetchDisplayState || {};
    const sourceDate = participantDataState.sourceDate;

    if (participantDataState.dataStatus === "waiting_update") {
        statusElement.textContent = sourceDate
            ? `対象日：${sourceDate}　直近正常版を表示中／新版取得待ち`
            : "新版取得待ち";
    } else if (participantDataState.dataStatus === "partial") {
        statusElement.textContent =
            `一部データのみ（${successCount}/${fileCount}、対象日 ${sourceDate || "不明"}）`;
    } else if (status === FETCH_STATUS.FAILED) {
        statusElement.textContent = latestParsedDayData
            ? "今回の取得に失敗しました（前回取得データを表示中）"
            : "参加者別データの取得に失敗しました";
    } else if (sourceDate) {
        const stateLabel = participantDataState.dataStatus === "latest"
            ? "最新確認済み"
            : participantDataState.remoteCheckStatus === "pending"
                ? "最新版を確認中"
                : "直近正常版";
        statusElement.textContent = `対象日：${sourceDate}　${stateLabel}`;
    } else {
        statusElement.hidden = true;
        statusElement.textContent = "";
        return;
    }

    statusElement.hidden = false;
}

function renderParticipantHistoryState() {
    const element = document.getElementById("participantHistoryStatus");
    if (!element) return;

    if (participantHistoryState.status === "invalid") {
        element.textContent = "参加者別履歴　履歴データを利用できません";
        return;
    }
    if (participantHistoryState.status === "save_failed") {
        element.textContent = "参加者別履歴　履歴保存に失敗しました";
        return;
    }
    if (participantHistoryState.entryCount === 0) {
        element.textContent = "参加者別履歴　蓄積：0日";
        return;
    }

    const earliest = formatParticipantSourceDate(
        participantHistoryState.earliestSourceDate
    );
    const latest = formatParticipantSourceDate(
        participantHistoryState.latestSourceDate
    );
    element.textContent =
        `参加者別履歴　蓄積：${participantHistoryState.entryCount}日` +
        (latest ? `　最新：${latest}` : "") +
        (earliest && latest ? `　期間：${earliest} ～ ${latest}` : "");
}

function formatParticipantActivityNumber(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString("ja-JP") : "—";
}

function formatParticipantActivityRatio(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function formatParticipantActivityPercent(value) {
    if (!Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function clearParticipantActivityChart() {
    if (window.participantActivityChartInstance) {
        window.participantActivityChartInstance.destroy();
        window.participantActivityChartInstance = null;
    }
}

function renderParticipantActivityChart(series) {
    const canvas = document.getElementById("participantActivityChart");
    if (!canvas || typeof Chart !== "function") return;

    clearParticipantActivityChart();
    window.participantActivityChartInstance = new Chart(canvas, {
        type: "line",
        data: {
            labels: series.map(point => point.sourceDate),
            datasets: [{
                label: "公表上位volume",
                data: series.map(point => point.value),
                borderColor: "rgba(75, 104, 140, 0.95)",
                backgroundColor: "rgba(75, 104, 140, 0.15)",
                pointBackgroundColor: "rgba(75, 104, 140, 0.95)",
                tension: 0.2,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: readableLegendOptions(),
                tooltip: readableTooltipOptions()
            },
            scales: {
                x: {
                    title: readableAxisTitle("sourceDate"),
                    ticks: {
                        autoSkip: true,
                        maxTicksLimit: 12,
                        minRotation: 30,
                        maxRotation: 45,
                        padding: 6,
                        font: { size: CHART_TEXT_SIZE.axis }
                    }
                },
                y: {
                    beginAtZero: true,
                    title: readableAxisTitle("公表上位行の取引高合計"),
                    ticks: {
                        padding: 6,
                        font: { size: CHART_TEXT_SIZE.axis },
                        callback: value => Number(value).toLocaleString("ja-JP")
                    }
                }
            }
        }
    });
}

function renderParticipantActivityHistory() {
    const statusElement = document.getElementById("participantActivityStatus");
    const comparisonElement = document.getElementById("participantActivityComparison");
    const warningElement = document.getElementById("participantActivityContractWarning");
    const productSelect = document.getElementById("participantActivityProduct");
    if (!statusElement || !comparisonElement || !warningElement || !productSelect) {
        return;
    }

    const metricElements = {
        total: document.getElementById("participantActivityTotal"),
        change: document.getElementById("participantActivityChange"),
        day: document.getElementById("participantActivityDay"),
        night: document.getElementById("participantActivityNight"),
        nightDayRatio: document.getElementById("participantActivityNightDayRatio"),
        jnetRatio: document.getElementById("participantActivityJnetRatio")
    };
    const clearMetrics = () => Object.values(metricElements)
        .forEach(element => { if (element) element.textContent = "—"; });

    if (
        participantHistoryState.status === "invalid" ||
        !participantActivityHistory && participantHistoryState.status !== "empty"
    ) {
        statusElement.textContent = "履歴データを利用できません";
        comparisonElement.textContent = "前回比較なし";
        warningElement.hidden = true;
        clearMetrics();
        clearParticipantActivityChart();
        return;
    }

    if (!window.OptionMapParticipantActivity || !participantActivityHistory) {
        statusElement.textContent = "正式履歴がまだありません";
        comparisonElement.textContent = "前回比較なし";
        warningElement.hidden = true;
        clearMetrics();
        clearParticipantActivityChart();
        return;
    }

    const viewModel = window.OptionMapParticipantActivity
        .createActivityViewModel(
            participantActivityHistory,
            productSelect.value || "mini"
        );

    if (viewModel.status === "invalid") {
        statusElement.textContent = "履歴データを利用できません";
        comparisonElement.textContent = "前回比較なし";
        warningElement.hidden = true;
        clearMetrics();
        clearParticipantActivityChart();
        return;
    }
    if (viewModel.status === "empty") {
        statusElement.textContent = "正式履歴がまだありません";
        comparisonElement.textContent = "前回比較なし";
        warningElement.hidden = true;
        clearMetrics();
        clearParticipantActivityChart();
        return;
    }

    const current = viewModel.current;
    const comparison = viewModel.comparison;
    statusElement.textContent = viewModel.status === "one_entry"
        ? `1日分蓄積済み（対象日：${formatParticipantSourceDate(current.sourceDate)}）`
        : `${viewModel.entryCount}日分蓄積済み`;
    comparisonElement.textContent = comparison.available
        ? `比較：${formatParticipantSourceDate(comparison.currentSourceDate)} vs ` +
            `${formatParticipantSourceDate(comparison.previousSourceDate)}（前回保存日比・暦日差${comparison.dayGap}日）`
        : "前回比較なし";

    if (metricElements.total) {
        metricElements.total.textContent = formatParticipantActivityNumber(
            current.disclosedVolumeTotal
        );
    }
    if (metricElements.change) {
        metricElements.change.textContent = comparison.available
            ? `${formatParticipantActivityNumber(comparison.absoluteChange)} ` +
                `(${formatParticipantActivityPercent(comparison.percentChange)})`
            : "—";
    }
    if (metricElements.day) {
        metricElements.day.textContent = formatParticipantActivityNumber(current.dayVolume);
    }
    if (metricElements.night) {
        metricElements.night.textContent = formatParticipantActivityNumber(current.nightVolume);
    }
    if (metricElements.nightDayRatio) {
        metricElements.nightDayRatio.textContent = formatParticipantActivityRatio(
            current.nightDayRatio
        );
    }
    if (metricElements.jnetRatio) {
        metricElements.jnetRatio.textContent = Number.isFinite(current.disclosedJnetRatio)
            ? `${(current.disclosedJnetRatio * 100).toFixed(1)}%`
            : "—";
    }

    warningElement.hidden = !comparison.contractCompositionChanged;
    warningElement.textContent = comparison.contractCompositionChanged
        ? "限月構成が変化しているため単純比較に注意"
        : "";
    renderParticipantActivityChart(viewModel.series);
}

function setParticipantActivityHistory(history) {
    participantActivityHistory = history || null;
    renderParticipantActivityHistory();
}

window.setParticipantActivityHistory = setParticipantActivityHistory;

const participantActivityProduct =
    document.getElementById("participantActivityProduct");
if (participantActivityProduct) {
    participantActivityProduct.addEventListener(
        "change",
        renderParticipantActivityHistory
    );
}

function setParticipantFetchDisplayState(metadata) {
    participantFetchDisplayState = metadata || null;
    renderParticipantFetchDisplayState();
}

function setLatestParsedDayData(data, metadata = null) {
    latestParsedDayData = data;
    latestParticipantMetadata = metadata;

    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    
        console.log(

            "🔵 自動取得 parsedDayData =",

            latestParsedDayData

        );

    } else {
        updateBrokerChartFromExcel([]);
    }
}

window.setLatestParsedDayData = setLatestParsedDayData;
window.setParticipantFetchDisplayState = setParticipantFetchDisplayState;
window.getLatestParticipantMetadata = () => latestParticipantMetadata;

function createBarColors(values, normalColor, strongColor) {

    const positiveValues = values
        .filter(value => value > 0)
        .sort((a, b) => b - a);

    const thirdLargest = positiveValues[2] || positiveValues[0] || 0;

    return values.map((value, index) => {

        // 建玉上位3か所
        if (value >= thirdLargest && value > 0) {
            return strongColor;
        }

        const isEdge = index === 0 || index === values.length - 1;

        const previous = values[index - 1] || 0;
        const next = values[index + 1] || 0;
        const nearbyAverage = (previous + next) / 2;
        
        // 前後平均より50%以上大きい価格帯
        if (
            !isEdge &&
            value > 0 &&
            nearbyAverage > 0 &&
            value >= nearbyAverage * 1.5
        ) {
            return "rgba(255, 165, 0, 0.95)";
        }

        return normalColor;
    });
}



const currentPriceLinePlugin = {
    id: "currentPriceLine",

    afterDatasetsDraw(chart) {

        const labels = chart.data.labels;

        let priceIndex = -1;
let smallestDifference = Infinity;

labels.forEach((label, index) => {

    const strike =
        Number(String(label).replace(/,/g, ""));

    const difference =
        Math.abs(strike - currentPrice);

    if (difference < smallestDifference) {
        smallestDifference = difference;
        priceIndex = index;
    }
});
        if (priceIndex === -1) {
            return;
        }

        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const x = xScale.getPixelForValue(priceIndex);
        const nearestStrike =
    Number(
        String(labels[priceIndex]).replace(/,/g, "")
    );

        const ctx = chart.ctx;

        ctx.save();

        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);

        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.setLineDash([6, 4]);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";

        ctx.fillText(
            "現在値 " + currentPrice.toLocaleString() + "円",
            x,
            yScale.top + 16
        );
        
        ctx.font = "12px sans-serif";
        
        ctx.fillText(
            "最寄り " + nearestStrike.toLocaleString() + "円",
            x,
            yScale.top + 34
        );

        ctx.restore();
    }
};

const currentPriceInput =
    document.getElementById("currentPriceInput");

const updateCurrentPriceButton =
    document.getElementById("updateCurrentPriceButton");

const currentPriceStatus =
    document.getElementById("currentPriceStatus");

const currentPriceMetadata =
    document.getElementById("currentPriceMetadata");

const priceSource =
    document.getElementById("priceSource");

function applyCurrentPrice({
    value,
    source = "manual",
    contract = null,
    quotedAt = null,
    fetchedAt = null,
    mode = "manual",
    persist = true,
    invalidateOnChange = true,
    redraw = true
}) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return {
            success: false,
            changed: false,
            error: "invalid_price"
        };
    }

    const changed = currentPrice !== numericValue;
    currentPrice = numericValue;
    currentPriceState = {
        value: currentPrice,
        source,
        contract,
        quotedAt,
        fetchedAt,
        mode
    };
    window.refreshCurrentPriceSavedUi?.();
    calculateWeeklyOptionsShadowSignal();

    if (currentPriceInput) {
        currentPriceInput.value = String(currentPrice);
    }

    if (currentPriceStatus) {
        currentPriceStatus.textContent =
            "現在値：" +
            currentPrice.toLocaleString() +
            "円";
    }

    if (currentPriceMetadata) {
        currentPriceMetadata.textContent =
            mode === "automatic"
                ? [
                    "自動取得：日経225先物",
                    contract,
                    quotedAt ? `価格時刻 ${quotedAt}` : null
                ].filter(Boolean).join(" / ")
                : "手動入力";
    }

    if (
        priceSource &&
        source &&
        [...priceSource.options].some(option =>
            option.value === source
        )
    ) {
        priceSource.value = source;
    }

    if (persist) {
        localStorage.setItem(
            "optionMapCurrentPrice",
            String(currentPrice)
        );
        localStorage.setItem(
            "optionMapPriceSource",
            source
        );
        localStorage.setItem(
            "optionMapPriceMode",
            mode
        );

        if (contract) {
            localStorage.setItem(
                "optionMapPriceContract",
                String(contract)
            );
        } else {
            localStorage.removeItem("optionMapPriceContract");
        }

        if (quotedAt) {
            localStorage.setItem(
                "optionMapPriceQuotedAt",
                String(quotedAt)
            );
        } else {
            localStorage.removeItem("optionMapPriceQuotedAt");
        }

        if (fetchedAt) {
            localStorage.setItem(
                "optionMapPriceFetchedAt",
                String(fetchedAt)
            );
        } else {
            localStorage.removeItem("optionMapPriceFetchedAt");
        }
    }

    if (changed && invalidateOnChange) {
        invalidateOptionMarketJudgment();
    }

    if (redraw && allJpxLabels.length > 0) {
        window.drawJpxPriceChart(
            allJpxLabels,
            allJpxCallValues,
            allJpxPutValues,
            allJpxCallVolumes,
            allJpxPutVolumes,
            {
                openInterestAvailable: jpxOpenInterestAvailable === true,
                openInterestLabels: allJpxOpenInterestLabels
            }
        );
    }

    return {
        success: true,
        changed,
        value: currentPrice,
        source,
        contract,
        quotedAt,
        fetchedAt,
        mode
    };
}

function normalizeQriFuturesPrice(priceData) {
    const value = Number(priceData?.value);
    const source = priceData?.source;
    const contract =
        typeof priceData?.contract === "string"
            ? priceData.contract.trim()
            : "";
    const quotedAt =
        typeof priceData?.quotedAt === "string"
            ? priceData.quotedAt.trim()
            : "";
    const fetchedAt =
        typeof priceData?.fetchedAt === "string"
            ? priceData.fetchedAt.trim()
            : "";

    if (
        !Number.isFinite(value) ||
        value <= 0 ||
        source !== "qri-nikkei225-futures" ||
        !contract ||
        !quotedAt ||
        !fetchedAt
    ) {
        return null;
    }

    return {
        value,
        source,
        contract,
        quotedAt,
        fetchedAt
    };
}

function saveLastQriFuturesPrice(priceData) {
    const normalizedPrice =
        normalizeQriFuturesPrice(priceData);

    if (!normalizedPrice) return null;

    localStorage.setItem(
        "optionMapLastQriFuturesPrice",
        JSON.stringify(normalizedPrice)
    );

    return normalizedPrice;
}

function loadLastQriFuturesPrice() {
    try {
        return normalizeQriFuturesPrice(
            JSON.parse(
                localStorage.getItem(
                    "optionMapLastQriFuturesPrice"
                ) || "null"
            )
        );
    } catch (error) {
        console.warn(
            "最後のQRI先物価格を読み込めませんでした:",
            error
        );
        return null;
    }
}

function restoreLastQriFuturesPrice() {
    const lastQriPrice = loadLastQriFuturesPrice();

    if (!lastQriPrice) {
        if (currentPriceMetadata) {
            currentPriceMetadata.textContent =
                "利用できるQRI価格がありません";
        }

        if (priceSource) {
            priceSource.value = currentPriceState.source;
        }

        return {
            success: false,
            changed: false,
            error: "qri_futures_price_unavailable"
        };
    }

    return applyCurrentPrice({
        ...lastQriPrice,
        mode: "automatic"
    });
}

function applyQriNikkei225FuturesPrice(
    referencePrices,
    fetchedAt = new Date().toISOString(),
    { redraw = true } = {}
) {
    const futures = referencePrices?.nikkei225Futures;
    const price = Number(futures?.price);
    const contract =
        typeof futures?.contract === "string"
            ? futures.contract.trim()
            : "";
    const quotedAt =
        typeof futures?.quotedAt === "string"
            ? futures.quotedAt.trim()
            : "";

    if (
        futures?.available !== true ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !contract ||
        !quotedAt
    ) {
        return {
            success: false,
            changed: false,
            error: "qri_futures_price_unavailable"
        };
    }

    const latestQriPrice = saveLastQriFuturesPrice({
        value: price,
        source: "qri-nikkei225-futures",
        contract,
        quotedAt,
        fetchedAt
    });

    if (!latestQriPrice) {
        return {
            success: false,
            changed: false,
            error: "qri_futures_price_unavailable"
        };
    }

    if (currentPriceState.mode === "manual") {
        return {
            success: true,
            changed: false,
            applied: false,
            reason: "manual_mode",
            latestQriPrice
        };
    }

    return applyCurrentPrice({
        ...latestQriPrice,
        mode: "automatic",
        redraw
    });
}

window.applyCurrentPrice = applyCurrentPrice;
window.applyQriNikkei225FuturesPrice =
    applyQriNikkei225FuturesPrice;


// 保存してある現在値を読み込む
const savedPrice =
    localStorage.getItem("optionMapCurrentPrice");

if (savedPrice) {
    const storedMode =
        localStorage.getItem("optionMapPriceMode");
    const savedMode =
        storedMode === "automatic"
            ? "automatic"
            : "manual";
    const restoredSource =
        savedMode === "automatic"
            ? "qri-nikkei225-futures"
            : "manual";

    applyCurrentPrice({
        value: savedPrice,
        source: restoredSource,
        contract:
            localStorage.getItem("optionMapPriceContract"),
        quotedAt:
            localStorage.getItem("optionMapPriceQuotedAt"),
        fetchedAt:
            localStorage.getItem("optionMapPriceFetchedAt"),
        mode: savedMode,
        persist: false,
        invalidateOnChange: false,
        redraw: false
    });
}

if (priceSource) {
    priceSource.addEventListener("change", function () {
        if (priceSource.value === "qri-nikkei225-futures") {
            restoreLastQriFuturesPrice();
        }
    });
}


// 「現在値を反映」ボタン
if (updateCurrentPriceButton && currentPriceInput) {

    updateCurrentPriceButton.addEventListener("click", function () {
        if (priceSource?.value === "qri-nikkei225-futures") {
            restoreLastQriFuturesPrice();
            return;
        }

        const result = applyCurrentPrice({
            value: currentPriceInput.value,
            source: "manual",
            contract: null,
            quotedAt: null,
            fetchedAt: new Date().toISOString(),
            mode: "manual"
        });

        if (!result.success) {
            alert("正しい現在値を入力してください");
            return;
        }

        console.log("現在値を変更:", currentPrice);
        void window.OptionMapMobileSummaryPreview?.update();
    });
}
function updateWallCandidates(labels, callValues, putValues) {

    const callWallResult =
        document.getElementById("callWallResult");

    const putWallResult =
        document.getElementById("putWallResult");

    const callCandidates = [];
    const putCandidates = [];

    labels.forEach((label, index) => {

        const strike =
            Number(String(label).replace(/,/g, ""));

        const callValue =
            Number(callValues[index]) || 0;

        const putValue =
            Number(putValues[index]) || 0;

        // 現在値より上のCALL候補
        if (strike > currentPrice && callValue > 0) {
            callCandidates.push({
                strike: strike,
                value: callValue
            });
        }

        // 現在値より下のPUT候補
        if (strike < currentPrice && putValue > 0) {
            putCandidates.push({
                strike: strike,
                value: putValue
            });
        }
    });

    // 建玉が多い順
    callCandidates.sort((a, b) => b.value - a.value);
    putCandidates.sort((a, b) => b.value - a.value);

    const topCallWalls = callCandidates.slice(0, 3);
    const topPutWalls = putCandidates.slice(0, 3);

    if (callWallResult) {

        if (topCallWalls.length === 0) {
            callWallResult.textContent =
                "候補が見つかりません";
        } else {
            callWallResult.innerHTML =
                topCallWalls
                    .map((item, index) =>
                        `${index + 1}位　` +
                        `${item.strike.toLocaleString()}円・` +
                        `${item.value.toLocaleString()}枚`
                    )
                    .join("<br>");
        }
    }

    if (putWallResult) {

        if (topPutWalls.length === 0) {
            putWallResult.textContent =
                "候補が見つかりません";
        } else {
            putWallResult.innerHTML =
                topPutWalls
                    .map((item, index) =>
                        `${index + 1}位　` +
                        `${item.strike.toLocaleString()}円・` +
                        `${item.value.toLocaleString()}枚`
                    )
                    .join("<br>");
        }
    }
}



const combinedWallRankPlugin = {
    id: "combinedWallRankPlugin",

    afterDatasetsDraw(chart) {

        const labels = chart.data.labels;
        const ctx = chart.ctx;

        ctx.save();

        chart.data.datasets.forEach((dataset, datasetIndex) => {

            const candidates = [];

            labels.forEach((label, index) => {

                const strike =
                    Number(String(label).replace(/,/g, ""));

                const value =
                    Math.abs(Number(dataset.data[index]) || 0);

                const isCallCandidate =
                    datasetIndex === 0 &&
                    strike > currentPrice;

                const isPutCandidate =
                    datasetIndex === 1 &&
                    strike < currentPrice;

                if (
                    value > 0 &&
                    (isCallCandidate || isPutCandidate)
                ) {
                    candidates.push({
                        index: index,
                        value: value
                    });
                }
            });

            candidates.sort((a, b) => b.value - a.value);

            const topThree = candidates.slice(0, 3);
            const meta = chart.getDatasetMeta(datasetIndex);

            topThree.forEach((item, rankIndex) => {

                const bar = meta.data[item.index];

                if (!bar) return;

                const x = bar.x;

                let y;

                if (datasetIndex === 0) {
                    // CALLは棒の上
                    y = Math.max(
                        chart.chartArea.top + 13,
                        bar.y - 14
                    );
                } else {
                    // PUTは棒の下
                    y = Math.min(
                        chart.chartArea.bottom - 13,
                        bar.y + 14 + rankIndex * 25
                    );
                }

                ctx.beginPath();
                ctx.arc(x, y, 11, 0, Math.PI * 2);

                ctx.fillStyle =
                    datasetIndex === 0
                        ? OPTION_SIDE_CHART_COLORS.call.strong
                        : OPTION_SIDE_CHART_COLORS.put.strong;

                ctx.fill();

                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 12px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";

                ctx.fillText(
                    String(rankIndex + 1),
                    x,
                    y
                );
            });
        });

        ctx.restore();
    }
};

function updateMarketInfo(startStrike, endStrike) {

    const priceElement =
        document.getElementById("marketCurrentPrice");

    const rangeElement =
        document.getElementById("marketDisplayRange");

    const fetchedAtElement =
        document.getElementById("marketFetchedAt");

    if (priceElement) {
        priceElement.textContent =
            currentPrice.toLocaleString() + "円";
    }

    if (rangeElement) {
        rangeElement.textContent =
            startStrike.toLocaleString() +
            "円 ～ " +
            endStrike.toLocaleString() +
            "円";
    }

    if (fetchedAtElement && lastJpxFetchedAt) {
        fetchedAtElement.textContent =
            lastJpxFetchedAt.toLocaleString(
                "ja-JP",
                {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                }
            );
    }
}

window.setJpxSourceTime = function (date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        console.error("JPX元データ日時が正しくありません");
        return;
    }

    lastJpxFetchedAt = date;

    const fetchedAtElement =
        document.getElementById("marketFetchedAt");

    if (fetchedAtElement) {
        fetchedAtElement.textContent =
            lastJpxFetchedAt.toLocaleString("ja-JP", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            });
    }

    console.log("JPX元データ日時:", lastJpxFetchedAt);
};

const showOpenInterestButton =
    document.getElementById(
        "showOpenInterestButton"
    );

const showVolumeButton =
    document.getElementById(
        "showVolumeButton"
    );

function switchChartMode(mode) {

    currentChartMode = mode;

    if (showOpenInterestButton) {
        showOpenInterestButton.classList.toggle(
            "active",
            mode === "openInterest"
        );
    }

    if (showVolumeButton) {
        showVolumeButton.classList.toggle(
            "active",
            mode === "volume"
        );
    }

    if (qriContractDisplayData) {
        renderQriContractDisplayChart();
    } else if (allJpxLabels.length > 0) {
        window.drawJpxPriceChart(
            allJpxLabels,
            allJpxCallValues,
            allJpxPutValues,
            allJpxCallVolumes,
            allJpxPutVolumes,
            {
                openInterestAvailable: jpxOpenInterestAvailable === true,
                openInterestLabels: allJpxOpenInterestLabels
            }
        );
    }
}

function updateOpenInterestDataStatus() {
    const statusElement =
        document.getElementById("openInterestDataStatus");

    if (!statusElement) return;

    const usingFallback =
        qriOpenInterestDataState.status === "waiting_update" &&
        qriOpenInterestDataState.usingFallback === true;
    const unavailable = jpxOpenInterestAvailable === false;

    statusElement.hidden = !unavailable && !usingFallback;

    if (usingFallback) {
        const sourceDate = formatFetchDateTime(
            qriOpenInterestDataState.sourceDate
        );
        const fetchLead =
            dataFetchState.qri.status === FETCH_STATUS.FAILED
                ? "今回のQRI取得は失敗しました。"
                : dataFetchState.qri.status === FETCH_STATUS.LOADING
                    ? "QRIデータを更新中です。"
                    : "今回のQRI建玉残は未提供です。";
        statusElement.textContent =
            fetchLead +
            "建玉表示・分析には直近正常値を使用しています。" +
            "本日の取引高は最新取得値です。" +
            (sourceDate
                ? ` 建玉取得元ページ日時：${sourceDate}`
                : "");
        return;
    }

    statusElement.textContent = unavailable
        ? "QRI建玉残データ未提供（本日の取引高は利用できます）"
        : "";
}

function updateQriOpenInterestUiState() {
    const usingFallback =
        qriOpenInterestDataState.status === "waiting_update" &&
        qriOpenInterestDataState.usingFallback === true;

    updateOpenInterestDataStatus();

    if (saveJpxSnapshotButton) {
        saveJpxSnapshotButton.disabled = usingFallback;
        saveJpxSnapshotButton.title = usingFallback
            ? "直近正常建玉を使用中のため、スナップショットを保存できません"
            : "";
    }

    scheduleRenderDataFetchStatus();
}

if (showOpenInterestButton) {
    showOpenInterestButton.addEventListener(
        "click",
        function () {
            switchChartMode("openInterest");
        }
    );
}

if (showVolumeButton) {
    showVolumeButton.addEventListener(
        "click",
        function () {
            switchChartMode("volume");
        }
    );
}

const saveJpxSnapshotButton =
    document.getElementById("saveJpxSnapshotButton");

const snapshotSaveStatus =
    document.getElementById("snapshotSaveStatus");

    const savedSnapshotList =
    document.getElementById("savedSnapshotList");

    function updateIntelligenceCard(savedSnapshots) {

        const snapshotCountElement =
            document.getElementById(
                "intelligenceSnapshotCount"
            );
    
        const dayCountElement =
            document.getElementById(
                "intelligenceDayCount"
            );
    
        const levelElement =
            document.getElementById(
                "intelligenceLevel"
            );
    
        const starsElement =
            document.getElementById(
                "intelligenceStars"
            );
    
        const messageElement =
            document.getElementById(
                "intelligenceMessage"
            );
    
        const progressBar =
            document.getElementById("intelligenceProgressBar");
        
        const progressText =
            document.getElementById("intelligenceProgressText");

        const validSnapshots =
            Array.isArray(savedSnapshots)
                ? savedSnapshots
                : [];
    
        const uniqueDays = new Set();
    
        validSnapshots.forEach(snapshot => {
    
            const date =
                new Date(snapshot.sourceDate);
    
            if (Number.isNaN(date.getTime())) {
                return;
            }
    
            const dayKey = [
                date.getFullYear(),
                String(date.getMonth() + 1)
                    .padStart(2, "0"),
                String(date.getDate())
                    .padStart(2, "0")
            ].join("-");
    
            uniqueDays.add(dayKey);
        });
    
        const snapshotCount =
            validSnapshots.length;
    
        const dayCount =
            uniqueDays.size;
        
        let level = 1;
        let starCount = 1;
        let message =
            "データの蓄積を始めたばかりです。";
            let nextLevelDays = 7;
        if (dayCount >= 180) {
            confidence = "★★★★★";
            level = 5;
            starCount = 5;
            nextLevelDays = 0;

            message =
                "長期分析に使えるデータが十分に蓄積されています。";
        } else if (dayCount >= 90) {
            confidence = "★★★★★";
            level = 4;
            starCount = 4;
            nextLevelDays = 180;

            message =
                "季節やSQ前後の傾向を調べられる量になってきました。";
        } else if (dayCount >= 30) {
            confidence = "★★★★★";
            level = 3;
            starCount = 3;
            nextLevelDays = 90;

            message =
                "月単位の変化や繰り返しを確認できる段階です。";
        } else if (dayCount >= 7) {
            confidence = "★★☆☆☆";
            level = 2;
            starCount = 2;
            nextLevelDays = 30;

            message =
                "短期的な建玉変化を比較できる量になってきました。";
        }
    
        const progressPercent =
        nextLevelDays > 0
            ? Math.min((dayCount / nextLevelDays) * 100, 100)
            : 100;
    
    if (progressBar) {
        progressBar.style.width = `${progressPercent}%`;
    }
    
    if (progressText) {
        progressText.textContent =
            nextLevelDays > 0
                ? `${dayCount}日 / ${nextLevelDays}日`
                : `${dayCount}日 / MAX`;
    }

        const stars =
            "★".repeat(starCount) +
            "☆".repeat(5 - starCount);
    
        if (snapshotCountElement) {
            snapshotCountElement.textContent =
                snapshotCount.toLocaleString() +
                "件";
        }
    
        if (dayCountElement) {
            dayCountElement.textContent =
                dayCount.toLocaleString() +
                "日";
        }
    
        if (levelElement) {
            levelElement.textContent =
                "Lv." + level;
        }
    
        if (starsElement) {
            starsElement.textContent =
                stars;
        }
    
        if (messageElement) {

            if (nextLevelDays === 0) {
        
                messageElement.textContent =
                    "🎉 Intelligence MAX Lv に到達しました！";
        
            }
            else {
        
                const remain =
                    nextLevelDays - dayCount;
        
                messageElement.textContent =
                    message +
                    "　次のレベルまであと " +
                    remain +
                    " 日";
        
            }
        
        }
    }

const weeklyBrokerConfig = window.OptionMapWeeklyBrokerConfig;
const weeklyBrokerParticipants = weeklyBrokerConfig.PARTICIPANTS;
const weeklyBrokerMap = weeklyBrokerConfig.BROKER_MAP;

function initializeWeeklyBrokerConfigUi() {
    const selector = document.getElementById("cumulativeBrokerSelect");
    if (selector) {
        const chartGroups =
            window.OptionMapParticipantTwelveGroupChartAdapter
                ?.SELECTOR_DEFINITIONS || weeklyBrokerParticipants.map(
                    participant => ({
                        key: participant.key,
                        displayName: participant.displayName
                    })
                );
        selector.replaceChildren(...chartGroups.map(participant => {
            const option = document.createElement("option");
            option.value = participant.key;
            option.textContent = participant.displayName;
            return option;
        }));
    }

    const summary = document.getElementById("weeklyBrokerSummary");
    if (summary) {
        summary.replaceChildren(...weeklyBrokerParticipants.map(participant => {
            const row = document.createElement("div");
            const status = document.createElement("strong");
            row.append(`${participant.displayName}：`, status);
            status.id = participant.statusElementId;
            status.textContent = "未確定";
            return row;
        }));
    }
}

initializeWeeklyBrokerConfigUi();

const weeklyJudgmentScoreMap = Object.freeze({
    "強い買い優勢": 2,
    "買い優勢": 1,
    "方向感薄い": 0,
    "売り優勢": -1,
    "強い売り優勢": -2
});

const optionMarketJudgmentScoreMap = Object.freeze({
    "強気": 2,
    "やや強気": 1,
    "中立": 0,
    "やや弱気": -1,
    "弱気": -2
});

const optionMapJudgmentState = {
    weekly: {
        available: false,
        judgment: null,
        metadata: null
    },
    option: {
        available: false,
        judgment: null,
        metadata: null
    }
};

function calculateOptionMapOverallJudgment(state) {
    const hasOwnScore = (scoreMap, label) =>
        Object.prototype.hasOwnProperty.call(scoreMap, label);

    const weeklyLabel =
        state?.weekly?.judgment?.direction;

    const optionLabel =
        state?.option?.judgment?.marketLevel;

    const weeklyValid =
        state?.weekly?.available === true &&
        hasOwnScore(weeklyJudgmentScoreMap, weeklyLabel);

    const optionValid =
        state?.option?.available === true &&
        hasOwnScore(optionMarketJudgmentScoreMap, optionLabel);

    const weeklyComponent = {
        available: weeklyValid,
        label: weeklyValid ? weeklyLabel : null,
        score: weeklyValid
            ? weeklyJudgmentScoreMap[weeklyLabel]
            : null,
        metadata: state?.weekly?.metadata || null
    };

    const optionComponent = {
        available: optionValid,
        label: optionValid ? optionLabel : null,
        score: optionValid
            ? optionMarketJudgmentScoreMap[optionLabel]
            : null,
        metadata: state?.option?.metadata || null
    };

    const missingSources = [];
    const invalidSources = [];

    if (!weeklyValid) {
        missingSources.push("weekly");

        if (
            state?.weekly?.available === true &&
            !hasOwnScore(weeklyJudgmentScoreMap, weeklyLabel)
        ) {
            invalidSources.push("weekly");
        }
    }

    if (!optionValid) {
        missingSources.push("option");

        if (
            state?.option?.available === true &&
            !hasOwnScore(optionMarketJudgmentScoreMap, optionLabel)
        ) {
            invalidSources.push("option");
        }
    }

    if (!weeklyValid || !optionValid) {
        return {
            available: false,
            status: invalidSources.length > 0
                ? "invalid_input"
                : "insufficient_data",
            totalScore: null,
            judgment: null,
            components: {
                weekly: weeklyComponent,
                option: optionComponent
            },
            missingSources,
            invalidSources
        };
    }

    const totalScore =
        weeklyComponent.score + optionComponent.score;

    let judgment = "中立";

    if (totalScore >= 3) {
        judgment = "強い買いアドバンテージ";
    } else if (totalScore >= 1) {
        judgment = "買いアドバンテージ";
    } else if (totalScore <= -3) {
        judgment = "強い売りアドバンテージ";
    } else if (totalScore <= -1) {
        judgment = "売りアドバンテージ";
    }

    return {
        available: true,
        status: "complete",
        totalScore,
        judgment,
        components: {
            weekly: weeklyComponent,
            option: optionComponent
        },
        missingSources: [],
        invalidSources: []
    };
}

function renderOptionMapOverallJudgment() {
    const result =
        calculateOptionMapOverallJudgment(optionMapJudgmentState);

    const summaryElement =
        document.getElementById("optionMapOverallSummary");
    const judgmentElement =
        document.getElementById("optionMapOverallJudgment");
    const weeklyElement =
        document.getElementById("optionMapWeeklyComponent");
    const optionElement =
        document.getElementById("optionMapOptionComponent");
    const scoreElement =
        document.getElementById("optionMapOverallScore");

    if (
        !summaryElement ||
        !judgmentElement ||
        !weeklyElement ||
        !optionElement ||
        !scoreElement
    ) {
        return;
    }

    const formatScore = score =>
        score > 0 ? `+${score}` : String(score);

    const formatComponent = (component, invalid) => {
        if (invalid) return "判定エラー";
        if (!component.available) return "データ不足";

        return `${component.label}（${formatScore(component.score)}）`;
    };

    const weeklyInvalid =
        result.invalidSources.includes("weekly");
    const optionInvalid =
        result.invalidSources.includes("option");

    weeklyElement.textContent = formatComponent(
        result.components.weekly,
        weeklyInvalid
    );
    optionElement.textContent = formatComponent(
        result.components.option,
        optionInvalid
    );

    summaryElement.classList.remove(
        "is-buy",
        "is-sell",
        "is-neutral",
        "is-insufficient",
        "is-invalid"
    );

    if (result.status === "invalid_input") {
        judgmentElement.textContent = "判定材料エラー";
        scoreElement.textContent = "算出不可";
        summaryElement.classList.add("is-invalid");
        return;
    }

    if (result.status === "insufficient_data") {
        judgmentElement.textContent = "判定材料不足";
        scoreElement.textContent = "算出不可";
        summaryElement.classList.add("is-insufficient");
        return;
    }

    judgmentElement.textContent = result.judgment;
    scoreElement.textContent =
        `${formatScore(result.totalScore)} / +4`;

    if (result.judgment.includes("買い")) {
        summaryElement.classList.add("is-buy");
    } else if (result.judgment.includes("売り")) {
        summaryElement.classList.add("is-sell");
    } else {
        summaryElement.classList.add("is-neutral");
    }
}

const OPTION_MAP_V2_ENABLED = true;
const OPTION_MAP_V2_OPTION_QUALITY = Object.freeze({
    live: 1.00,
    fallback: 0.70
});
const OPTION_MAP_V2_WEEKLY_QUALITY = Object.freeze({
    liveCurrent: 1.00,
    cacheCurrent: 0.95,
    waitingUpdate: 0.50,
    remoteFailed: 0.70,
    pending: 0.70
});

const optionMapJudgmentStateV2 = {
    result: null,
    weeklyCandidate: null,
    lastError: null
};
let weeklyTwelveGroupFormalPairContext = null;

window.optionMapJudgmentStateV2 = optionMapJudgmentStateV2;

function createOptionComponentInputV2() {
    const source = optionMapJudgmentState.option;
    const judgment = source?.judgment;
    const metadata = source?.metadata || {};
    const sourceDate =
        metadata.currentOpenInterestSourceDate || metadata.currentSourceDate;

    if (source?.available !== true || !sourceDate) {
        return {
            available: false,
            reason: source?.available === true
                ? "QRI建玉の基準日を確認できません"
                : "オプション市場データが利用できません"
        };
    }

    const scoreDifference = Number(judgment?.scoreDifference);
    const confidenceScore = Number(judgment?.confidenceScore);
    const usingFallback = metadata.usingFallback === true;
    const notes = [];

    if (usingFallback) {
        notes.push("QRI建玉は直近正常値を使用中");
    }

    if (currentPriceState?.mode === "manual") {
        notes.push("現在値は手動入力です");
    }

    return {
        available: true,
        normalizedDirection: window.OptionMapOverallJudgmentV2.clamp(
            scoreDifference /
                window.OptionMapOverallJudgmentV2.CONFIG.optionNormalizationBase,
            -1,
            1
        ),
        qualityFactor: usingFallback
            ? OPTION_MAP_V2_OPTION_QUALITY.fallback
            : OPTION_MAP_V2_OPTION_QUALITY.live,
        evidenceFactor: confidenceScore / 5,
        notes,
        metadata: {
            marketLevel: judgment?.marketLevel || null,
            bullishScore: judgment?.bullishScore ?? null,
            bearishScore: judgment?.bearishScore ?? null,
            scoreDifference,
            confidenceScore,
            confidence: judgment?.confidence || null,
            confidenceReason: judgment?.confidenceReason || null,
            usingFallback,
            origin: metadata.openInterestOrigin || null,
            sourceDate,
            comparisonSourceDate: metadata.comparisonSourceDate || null,
            currentPrice: metadata.currentPrice ?? currentPriceState?.value ?? null,
            currentPriceMode: currentPriceState?.mode || null,
            currentPriceSource: currentPriceState?.source || null,
            currentPriceQuotedAt: currentPriceState?.quotedAt || null,
            currentPriceFetchedAt: currentPriceState?.fetchedAt || null
        }
    };
}

function getWeeklyQualityV2(metadata) {
    const dataStatus = metadata?.dataStatus;
    const remoteCheckStatus = metadata?.remoteCheckStatus;
    const origin = metadata?.origin;

    if (
        origin === "weekly_futures_history" &&
        dataStatus === "formal_history"
    ) {
        return OPTION_MAP_V2_WEEKLY_QUALITY.liveCurrent;
    }

    if (
        dataStatus === "waiting_update" ||
        remoteCheckStatus === "newer_available"
    ) {
        return OPTION_MAP_V2_WEEKLY_QUALITY.waitingUpdate;
    }

    if (remoteCheckStatus === "failed") {
        return OPTION_MAP_V2_WEEKLY_QUALITY.remoteFailed;
    }

    if (remoteCheckStatus === "pending") {
        return OPTION_MAP_V2_WEEKLY_QUALITY.pending;
    }

    if (dataStatus === "latest" && remoteCheckStatus === "current") {
        return origin === "cache"
            ? OPTION_MAP_V2_WEEKLY_QUALITY.cacheCurrent
            : OPTION_MAP_V2_WEEKLY_QUALITY.liveCurrent;
    }

    return 0;
}

function createWeeklyComponentInputV2() {
    const candidate = optionMapJudgmentStateV2.weeklyCandidate;

    if (!candidate?.available) {
        return {
            available: false,
            reason: candidate?.reason || "主要5社週次データが利用できません"
        };
    }

    const scoreDiff = Number(candidate.judgment?.scoreDiff);
    const qualityFactor = getWeeklyQualityV2(candidate.metadata);
    const normalizedDirection = window.OptionMapOverallJudgmentV2.clamp(
        scoreDiff /
            window.OptionMapOverallJudgmentV2.CONFIG.weeklyNormalizationBase,
        -1,
        1
    );
    const notes = [];

    if (
        candidate.metadata.dataStatus === "waiting_update" ||
        candidate.metadata.remoteCheckStatus === "newer_available"
    ) {
        notes.push("週次データは新版確認済み・取得待ちです");
    } else if (candidate.metadata.remoteCheckStatus === "failed") {
        notes.push("週次データの最新版確認に失敗しました");
    } else if (candidate.metadata.remoteCheckStatus === "pending") {
        notes.push("週次データの最新版を確認中です");
    } else if (candidate.metadata.origin === "cache") {
        notes.push("週次データは確認済みキャッシュを使用中");
    } else if (
        candidate.metadata.origin === "weekly_futures_history"
    ) {
        notes.push("週次データは検証済み正式historyを使用中");
    }

    if (qualityFactor <= 0) {
        return {
            available: false,
            reason: "週次データの品質状態を確認できません"
        };
    }

    return {
        available: true,
        normalizedDirection,
        qualityFactor,
        evidenceFactor: Math.min(1, Math.abs(normalizedDirection)),
        notes,
        metadata: {
            ...candidate.metadata,
            buyScore: candidate.judgment.buyScore,
            sellScore: candidate.judgment.sellScore,
            scoreDiff,
            direction: candidate.judgment.direction
        }
    };
}

function calculateOptionMapOverallJudgmentV2() {
    if (!window.OptionMapOverallJudgmentV2) {
        return {
            status: "invalid_input",
            direction: null,
            directionLabel: null,
            confidence: 0,
            components: {},
            metadata: {
                calculatedAt: new Date().toISOString(),
                availableComponentCount: 0,
                plannedComponentCount: 2,
                coverage: 0,
                timeHorizon: { code: "multi_day", label: "1日～数日" },
                warnings: ["v2計算モジュールを読み込めません"]
            }
        };
    }

    return window.OptionMapOverallJudgmentV2.calculateOverallJudgmentV2({
        option: createOptionComponentInputV2(),
        weekly: createWeeklyComponentInputV2()
    });
}

function formatOptionMapV2SignedScore(value) {
    if (!Number.isFinite(value)) return "算出不可";
    const rounded = Math.round(value);
    return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function formatOptionMapV2Date(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleDateString("ja-JP", {
        month: "2-digit",
        day: "2-digit"
    });
}

function formatOptionMapV2Status(value) {
    return ({ complete: "完全", partial: "一部データ不足",
        unavailable: "利用不可", invalid_input: "入力不正" })[value] || "状態不明";
}

function formatOptionMapV2Warning(value) {
    return ({
        "週次データは検証済み正式historyを使用中": "週次データ：検証済みの正式履歴を使用"
    })[value] || value;
}

function renderOptionMapOverallJudgmentV2Internal() {
    const summaryElement = document.getElementById("optionMapOverallSummaryV2");
    if (!summaryElement) return;

    summaryElement.hidden = !OPTION_MAP_V2_ENABLED;
    if (!OPTION_MAP_V2_ENABLED) return;

    const result = calculateOptionMapOverallJudgmentV2();
    optionMapJudgmentStateV2.result = result;
    optionMapJudgmentStateV2.lastError = null;
    const formalPublication = publishFormalIdentityEnvelopesV2(result);

    const directionElement = document.getElementById("optionMapV2Direction");
    const scoreElement = document.getElementById("optionMapV2DirectionScore");
    const confidenceElement = document.getElementById("optionMapV2Confidence");
    const statusElement = document.getElementById("optionMapV2Status");
    const optionElement = document.getElementById("optionMapV2OptionComponent");
    const weeklyElement = document.getElementById("optionMapV2WeeklyComponent");
    const warningsElement = document.getElementById("optionMapV2Warnings");

    if (
        !directionElement || !scoreElement || !confidenceElement ||
        !statusElement || !optionElement || !weeklyElement || !warningsElement
    ) {
        return formalPublication;
    }

    directionElement.textContent = result.directionLabel ||
        (result.status === "invalid_input" ? "判定材料エラー" : "判定材料不足");
    scoreElement.textContent = Number.isFinite(result.direction)
        ? `${formatOptionMapV2SignedScore(result.direction)} / 100`
        : "算出不可";
    confidenceElement.textContent = `${result.confidence}%`;
    statusElement.textContent =
        `材料 ${result.metadata.availableComponentCount} / ` +
        `${result.metadata.plannedComponentCount}（${formatOptionMapV2Status(result.status)}）`;

    const formatComponent = (component, label) => {
        if (!component?.available) return `${label}：未利用`;
        return `${label}：${formatOptionMapV2SignedScore(component.directionScore)} ` +
            `／ 品質 ${Math.round(component.qualityFactor * 100)}%`;
    };

    optionElement.textContent = formatComponent(
        result.components.option,
        "オプション市場"
    );
    weeklyElement.textContent = formatComponent(
        result.components.weekly,
        "主要5社週次"
    );

    const warnings = [...result.metadata.warnings];
    const weeklyMetadata = result.components.weekly?.metadata;
    if (weeklyMetadata?.previous?.sourceDate && weeklyMetadata?.current?.sourceDate) {
        warnings.push(
            `週次比較：${formatOptionMapV2Date(weeklyMetadata.current.sourceDate)}` +
            `現在 vs ${formatOptionMapV2Date(weeklyMetadata.previous.sourceDate)}現在`
        );
    }

    warningsElement.replaceChildren();
    if (warnings.length === 0) {
        const item = document.createElement("li");
        item.textContent = "データ注意なし";
        warningsElement.appendChild(item);
    } else {
        [...new Set(warnings)].forEach(warning => {
            const item = document.createElement("li");
            item.textContent = formatOptionMapV2Warning(warning);
            warningsElement.appendChild(item);
        });
    }

    summaryElement.classList.remove(
        "is-buy", "is-sell", "is-neutral", "is-insufficient", "is-invalid"
    );
    if (result.status === "invalid_input") {
        summaryElement.classList.add("is-invalid");
    } else if (result.status === "unavailable") {
        summaryElement.classList.add("is-insufficient");
    } else if (result.direction > 19) {
        summaryElement.classList.add("is-buy");
    } else if (result.direction < -19) {
        summaryElement.classList.add("is-sell");
    } else {
        summaryElement.classList.add("is-neutral");
    }
    return formalPublication;
}

async function publishFormalIdentityEnvelopesV2(result) {
    const candidate = optionMapJudgmentStateV2.weeklyCandidate;
    const previous = candidate?.metadata?.previous;
    const current = candidate?.metadata?.current;
    const qriFact = window.getQriFormalIdentityFact?.()?.fact || null;
    const requestId = qriFact?.requestId || candidate?.metadata?.requestId || null;
    if (candidate?.available === true && result?.components?.weekly?.available === true) {
        await window.publishWeeklyFormalIdentityFact?.({ sourceClass: "formal_history",
            previous, current, activeVersionKey: candidate.metadata.activeVersionKey,
            activeVersionMatched: candidate.metadata.activeVersionMatched,
            candidateComplete: true, requestId,
            requestContext: { requestId, marketRefreshRequestId: requestId },
            component: result.components.weekly
        }, { isCurrentRequest: () =>
            optionMapJudgmentStateV2.weeklyCandidate?.metadata?.current?.versionKey ===
                current?.versionKey });
    } else {
        window.markWeeklyFormalIdentityUnavailable?.("formal_component_unavailable");
        window.invalidateWeeklyFuturesTwelveGroupDualRun?.(
            "weekly_formal_identity_unavailable"
        );
        renderWeeklyTwelveGroupReference();
    }
    const weeklyFormalIdentity = window.getWeeklyFormalIdentityFact?.() || null;
    const weeklyFact = weeklyFormalIdentity?.fact || null;
    const pairContext = weeklyTwelveGroupFormalPairContext;
    if (
        weeklyFormalIdentity?.status === "available" && weeklyFact &&
        pairContext && candidate?.available === true &&
        result?.components?.weekly?.available === true
    ) {
        window.invalidateWeeklyFuturesTwelveGroupDualRun?.(
            "weekly_formal_identity_changed"
        );
        renderWeeklyTwelveGroupReference();
        const formalPair = {
            previous: {
                ...pairContext.previous,
                activeVersionKey: pairContext.previous.versionKey
            },
            current: {
                ...pairContext.current,
                activeVersionKey: pairContext.current.versionKey
            },
            formalContext: {
                sourceClass: "formal_history",
                activeVersionMatched: candidate.metadata.activeVersionMatched,
                requestId: weeklyFact.requestId,
                generation: weeklyFormalIdentity.publicationGeneration,
                generationFingerprint: weeklyFact.sourceFingerprint
            }
        };
        const major5PairIdentity = {
            previous: {
                ...candidate.metadata.previous,
                activeVersionKey: candidate.metadata.previous.versionKey
            },
            current: {
                ...candidate.metadata.current,
                activeVersionKey: candidate.metadata.current.versionKey
            },
            activeVersionMatched: candidate.metadata.activeVersionMatched
        };
        const expected = {
            requestId: weeklyFact.requestId,
            generation: weeklyFormalIdentity.publicationGeneration,
            sourceFingerprint: weeklyFact.sourceFingerprint,
            previousVersionKey: candidate.metadata.previous.versionKey,
            previousSignature: candidate.metadata.previous.signature,
            currentVersionKey: candidate.metadata.current.versionKey,
            currentSignature: candidate.metadata.current.signature
        };
        await window.publishWeeklyFuturesTwelveGroupDualRun?.({
            formalPair,
            major5: {
                formalApplied: true,
                available: true,
                direction: candidate.judgment.direction,
                normalizedDirection: result.components.weekly.normalizedDirection,
                qualityFactor: result.components.weekly.qualityFactor,
                eligibleBrokerCount: candidate.judgment.eligibleBrokerCount,
                requiredBrokerCount: candidate.judgment.requiredBrokerCount,
                pairIdentity: major5PairIdentity,
                requestId: weeklyFact.requestId,
                sourceFingerprint: weeklyFact.sourceFingerprint
            },
            weeklyFormalIdentity
        }, { isCurrentPublication: () => {
            const latest = window.getWeeklyFormalIdentityFact?.() || null;
            return latest.status === "available" &&
                latest.publicationGeneration === expected.generation &&
                latest.fact?.requestId === expected.requestId &&
                latest.fact?.sourceFingerprint === expected.sourceFingerprint &&
                optionMapJudgmentStateV2.weeklyCandidate?.metadata?.previous
                    ?.versionKey === expected.previousVersionKey &&
                optionMapJudgmentStateV2.weeklyCandidate?.metadata?.previous
                    ?.signature === expected.previousSignature &&
                optionMapJudgmentStateV2.weeklyCandidate?.metadata?.current
                    ?.versionKey === expected.currentVersionKey &&
                optionMapJudgmentStateV2.weeklyCandidate?.metadata?.current
                    ?.signature === expected.currentSignature &&
                weeklyTwelveGroupFormalPairContext?.previous?.versionKey ===
                    expected.previousVersionKey &&
                weeklyTwelveGroupFormalPairContext?.previous?.signature ===
                    expected.previousSignature &&
                weeklyTwelveGroupFormalPairContext?.current?.versionKey ===
                    expected.currentVersionKey &&
                weeklyTwelveGroupFormalPairContext?.current?.signature ===
                    expected.currentSignature;
        } });
        renderWeeklyTwelveGroupReference();
    } else if (candidate?.available === true &&
        result?.components?.weekly?.available === true) {
        window.invalidateWeeklyFuturesTwelveGroupDualRun?.(
            "weekly_formal_pair_unavailable"
        );
        renderWeeklyTwelveGroupReference();
    }
    await window.publishOverallV2FormalEnvelope?.({
        logicVersion: window.OptionMapOverallV2FormalEnvelopeRuntime
            ?.OVERALL_V2_LOGIC_VERSION,
        requestId, result, qriFact, weeklyFact
    }, { isCurrentRequest: () => {
        const latestQri = window.getQriFormalIdentityFact?.()?.fact || null;
        const latestWeekly = window.getWeeklyFormalIdentityFact?.()?.fact || null;
        return latestQri?.canonicalVersionKey === qriFact?.canonicalVersionKey &&
            latestWeekly?.currentVersionKey === weeklyFact?.currentVersionKey;
    } });
    await window.evaluateMorningBaselineV4Applicability?.();
    if (!window.isMarketRefreshInProgress?.()) {
        await window.publishMorningComparisonV4Runtime?.();
        window.OptionMapMobileSummaryPreview?.renderFormalComparisonV4?.();
    }
}

function renderWeeklyTwelveGroupReference() {
    const adapter = window.OptionMapWeeklyFuturesTwelveGroupReferenceView;
    const container = document.getElementById("weeklyTwelveGroupReference");
    if (!adapter?.createViewModel || !container) return;

    const state = window.getWeeklyFuturesTwelveGroupDualRun?.() || null;
    const model = adapter.createViewModel(state);
    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };
    setText("weeklyTwelveGroupReferenceStatus", model.status);
    setText("weeklyTwelveGroupDirection", model.direction);
    setText("weeklyTwelveGroupStrength", model.normalizedDirection);
    setText("weeklyTwelveGroupDelta", model.delta);
    setText("weeklyTwelveGroupAgreement", model.agreement);
    setText("weeklyTwelveGroupDominant", model.dominant);
    setText("weeklyTwelveGroupCoverage", model.coverage);
    setText("weeklyTwelveGroupMissing", model.missing);
    setText("weeklyTwelveGroupQuality", model.quality);
    setText("weeklyTwelveGroupDeltaExplanation", model.deltaExplanation);
    setText("weeklyTwelveGroupUnavailableReason", model.reason || "");

    const facts = document.getElementById("weeklyTwelveGroupReferenceFacts");
    const reason = document.getElementById("weeklyTwelveGroupUnavailableReason");
    const details = document.getElementById("weeklyTwelveGroupDetails");
    const detailRows = document.getElementById("weeklyTwelveGroupDetailRows");
    if (facts) facts.hidden = model.available !== true;
    if (reason) reason.hidden = model.available === true;
    if (detailRows) {
        detailRows.replaceChildren(...model.detailRows.map(row => {
            const tableRow = document.createElement("tr");
            const group = document.createElement("td");
            const classification = document.createElement("td");
            const direction = document.createElement("td");
            group.textContent = row.group;
            if (row.dominant) {
                const dominant = document.createElement("small");
                dominant.className = "weekly-twelve-group-dominant";
                dominant.textContent = "最大寄与";
                group.append(" ", dominant);
            }
            classification.textContent = row.classification;
            direction.textContent = row.contributionDirection;
            tableRow.append(group, classification, direction);
            return tableRow;
        }));
    }
    if (details) {
        details.hidden = model.available !== true || model.detailRows.length === 0;
        if (details.hidden) details.open = false;
    }
    container.dataset.state = model.available ? "available" : "unavailable";
}

renderWeeklyTwelveGroupReference();

function safeRenderOptionMapOverallJudgmentV2() {
    if (!OPTION_MAP_V2_ENABLED) return Promise.resolve(null);

    try {
        return Promise.resolve(renderOptionMapOverallJudgmentV2Internal()).catch(error => {
            optionMapJudgmentStateV2.lastError = error;
            console.error("OptionMap総合判断 v2 の正式公開に失敗しました:", error);
            return null;
        });
    } catch (error) {
        optionMapJudgmentStateV2.lastError = error;
        console.error("OptionMap総合判断 v2 の描画に失敗しました:", error);
        return Promise.resolve(null);
    }
}

function updateWeeklyCandidateV2(selection) {
    const versions = selection?.versions;
    const previous = Array.isArray(versions) ? versions.at(-2) : null;
    const current = Array.isArray(versions) ? versions.at(-1) : null;
    if (
        !previous?.sourceDate || !previous?.versionKey ||
        !current?.sourceDate || !current?.versionKey
    ) {
        weeklyTwelveGroupFormalPairContext = null;
        optionMapJudgmentStateV2.weeklyCandidate = {
            available: false,
            reason: "検証済みの正式週次2版を利用できません"
        };
        safeRenderOptionMapOverallJudgmentV2();
        return;
    }

    const judgment = calculateWeeklyBrokerJudgment(previous, current);
    if (!judgment.available) {
        weeklyTwelveGroupFormalPairContext = null;
        optionMapJudgmentStateV2.weeklyCandidate = {
            available: false,
            reason: "主要5社の公表比較データが不足しています"
        };
        safeRenderOptionMapOverallJudgmentV2();
        return;
    }

    weeklyTwelveGroupFormalPairContext = {
        previous: {
            sourceDate: previous.sourceDate,
            versionKey: previous.versionKey,
            signature: previous.signature,
            canonicalData: previous.futureOpenInterest || previous.data
        },
        current: {
            sourceDate: current.sourceDate,
            versionKey: current.versionKey,
            signature: current.signature,
            canonicalData: current.futureOpenInterest || current.data
        }
    };
    optionMapJudgmentStateV2.weeklyCandidate = {
        available: true,
        judgment,
        metadata: {
            previous: {
                sourceDate: previous.sourceDate,
                versionKey: previous.versionKey,
                signature: previous.signature
            },
            current: {
                sourceDate: current.sourceDate,
                versionKey: current.versionKey,
                signature: current.signature
            },
            activeVersionKey: current.versionKey,
            activeVersionMatched: true,
            origin: "weekly_futures_history",
            dataStatus: "formal_history",
            remoteCheckStatus: null,
            requestId: window.dataFetchState?.weeklyFutures?.requestId || null
        }
    };
    safeRenderOptionMapOverallJudgmentV2();
}

window.calculateOptionMapOverallJudgmentV2 =
    calculateOptionMapOverallJudgmentV2;
window.renderOptionMapOverallJudgmentV2 =
    safeRenderOptionMapOverallJudgmentV2;
window.getMobileSummaryRendererState = function () {
    const clone = value => value == null
        ? value : JSON.parse(JSON.stringify(value));
    const result = optionMapJudgmentStateV2.result ||
        calculateOptionMapOverallJudgmentV2();
    return {
        overallV2: clone(result),
        weeklyCandidate: clone(optionMapJudgmentStateV2.weeklyCandidate),
        currentPrice: clone(currentPriceState),
        qriOpenInterest: clone(qriOpenInterestDataState),
        freshness: {
            weeklyFuturesAt:
                window.dataFetchState?.weeklyFutures?.fetchedAt || null,
            weeklyOptionsAt:
                window.dataFetchState?.weeklyOptions?.fetchedAt || null,
            participantAt:
                window.dataFetchState?.participant?.fetchedAt || null
        }
    };
};

function invalidateOptionMarketJudgment() {
    optionMapJudgmentState.option = {
        available: false,
        judgment: null,
        metadata: null
    };

    renderOptionMapOverallJudgment();
    safeRenderOptionMapOverallJudgmentV2();
}

function syncOptionMarketJudgmentOpenInterestMetadata() {
    if (
        optionMapJudgmentState.option.available !== true ||
        !isPlainObject(optionMapJudgmentState.option.metadata)
    ) {
        return;
    }

    Object.assign(optionMapJudgmentState.option.metadata, {
        currentSourceDate:
            getCurrentQriOpenInterestSourceDate(),
        currentOpenInterestSourceDate:
            getCurrentQriOpenInterestSourceDate(),
        currentOpenInterestSourceDateKind:
            qriOpenInterestDataState.sourceDateKind,
        openInterestOrigin:
            qriOpenInterestDataState.origin,
        usingFallback:
            qriOpenInterestDataState.usingFallback === true,
        qriPageSourceDate:
            lastJpxFetchedAt instanceof Date &&
            !Number.isNaN(lastJpxFetchedAt.getTime())
                ? lastJpxFetchedAt.toISOString()
                : null
    });

    renderOptionMapOverallJudgment();
    safeRenderOptionMapOverallJudgmentV2();
}

function areJudgmentSourceArraysEqual(left, right) {
    return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function isValidOptionSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
        return false;
    }

    if (snapshot.openInterestAvailable === false) {
        return false;
    }

    const sourceDate = new Date(snapshot.sourceDate);

    if (Number.isNaN(sourceDate.getTime())) {
        return false;
    }

    const {
        labels,
        callOpenInterest,
        putOpenInterest
    } = snapshot;

    if (
        !Array.isArray(labels) ||
        !Array.isArray(callOpenInterest) ||
        !Array.isArray(putOpenInterest) ||
        labels.length === 0 ||
        labels.length !== callOpenInterest.length ||
        labels.length !== putOpenInterest.length
    ) {
        return false;
    }

    const hasValue = value =>
        value !== null &&
        value !== undefined &&
        String(value).trim() !== "";

    return labels.every((label, index) => {
        const callOpenInterestValue = callOpenInterest[index];
        const putOpenInterestValue = putOpenInterest[index];

        if (
            !hasValue(label) ||
            !hasValue(callOpenInterestValue) ||
            !hasValue(putOpenInterestValue)
        ) {
            return false;
        }

        const strike = Number(
            String(label).replace(/,/g, "")
        );
        const callValue = Number(callOpenInterestValue);
        const putValue = Number(putOpenInterestValue);

        return (
            Number.isFinite(strike) &&
            strike > 0 &&
            Number.isFinite(callValue) &&
            Number.isFinite(putValue)
        );
    });
}

function isCurrentQriOpenInterestDataValid() {
    if (
        jpxOpenInterestAvailable !== true ||
        !getCurrentQriOpenInterestSourceDate() ||
        !Array.isArray(allJpxOpenInterestLabels) ||
        !Array.isArray(allJpxCallValues) ||
        !Array.isArray(allJpxPutValues) ||
        allJpxOpenInterestLabels.length === 0 ||
        allJpxOpenInterestLabels.length !== allJpxCallValues.length ||
        allJpxOpenInterestLabels.length !== allJpxPutValues.length
    ) {
        return false;
    }

    const strikes = new Set();
    let totalOpenInterest = 0;

    return allJpxOpenInterestLabels.every((label, index) => {
        const strike = Number(String(label).replace(/,/g, ""));
        const callValue = Number(allJpxCallValues[index]);
        const putValue = Number(allJpxPutValues[index]);

        if (
            !Number.isFinite(strike) ||
            strike <= 0 ||
            strikes.has(strike) ||
            !Number.isSafeInteger(callValue) ||
            callValue < 0 ||
            !Number.isSafeInteger(putValue) ||
            putValue < 0
        ) {
            return false;
        }

        strikes.add(strike);
        totalOpenInterest += callValue + putValue;

        return Number.isSafeInteger(totalOpenInterest);
    }) && totalOpenInterest > 0;
}

function selectLatestValidComparisonSnapshot(
    snapshots,
    currentSourceDate
) {
    if (!Array.isArray(snapshots)) {
        return null;
    }

    const currentDate = new Date(currentSourceDate);
    const currentTime = currentDate.getTime();

    if (Number.isNaN(currentTime)) {
        return null;
    }

    return snapshots
        .filter(snapshot => {
            if (!isValidOptionSnapshot(snapshot)) {
                return false;
            }

            return new Date(snapshot.sourceDate).getTime() < currentTime;
        })
        .sort(
            (a, b) =>
                new Date(b.sourceDate).getTime() -
                new Date(a.sourceDate).getTime()
        )[0] || null;
}

function resetComparisonSelection(
    statusText,
    currentSourceDate = null
) {
    comparisonSnapshot = null;
    comparisonSelectionMode = "none";
    comparisonSelectionCurrentSourceDate = currentSourceDate;

    invalidateOptionMarketJudgment();

    const comparisonStatusElement =
        document.getElementById("comparisonSnapshotStatus");

    if (comparisonStatusElement) {
        comparisonStatusElement.textContent = statusText;
    }

    const marketSummaryElement =
        document.getElementById("marketSummary");

    if (marketSummaryElement) {
        marketSummaryElement.textContent = statusText;
    }

    [
        "maxCallIncrease",
        "maxCallDecrease",
        "maxPutIncrease",
        "maxPutDecrease",
        "callIncreaseResult",
        "callDecreaseResult",
        "putIncreaseResult",
        "putDecreaseResult"
    ].forEach(elementId => {
        const element = document.getElementById(elementId);

        if (element) {
            element.textContent = statusText;
        }
    });
}

function applyComparisonSnapshot(
    snapshot,
    { selectionMode = "manual" } = {}
) {
    if (!isCurrentQriOpenInterestDataValid()) {
        resetComparisonSelection(
            "建玉残データ未提供のため市場診断を算出できません"
        );
        return false;
    }

    if (!isValidOptionSnapshot(snapshot)) {
        return false;
    }

    invalidateOptionMarketJudgment();
    comparisonSnapshot = snapshot;
    comparisonSelectionMode =
        selectionMode === "automatic"
            ? "automatic"
            : "manual";
    comparisonSelectionCurrentSourceDate =
        getCurrentQriOpenInterestSourceDate();

    const comparisonStatusElement =
        document.getElementById("comparisonSnapshotStatus");
    const comparisonDate = new Date(snapshot.sourceDate);

    if (comparisonStatusElement) {
        const selectionLabel =
            comparisonSelectionMode === "automatic"
                ? "自動選択"
                : "手動選択";

        comparisonStatusElement.textContent =
            comparisonDate.toLocaleString("ja-JP", {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            }) + `（${selectionLabel}）`;
    }

    console.log(
        `${comparisonSelectionMode}で比較対象に選択:`,
        comparisonSnapshot
    );

    const futureOpenInterestText =
        futureOpenInterestData.value;

    if (futureOpenInterestText.trim()) {
        latestFutureOpenInterestResult =
            analyzeFutureOpenInterestData(
                futureOpenInterestText
            );
    }

    const callDifferenceData =
        createDifferenceData(
            allJpxOpenInterestLabels,
            allJpxCallValues,
            comparisonSnapshot.labels,
            comparisonSnapshot.callOpenInterest
        );

    const putDifferenceData =
        createDifferenceData(
            allJpxOpenInterestLabels,
            allJpxPutValues,
            comparisonSnapshot.labels,
            comparisonSnapshot.putOpenInterest
        );

    console.log("CALL建玉差分:", callDifferenceData);
    console.log("PUT建玉差分:", putDifferenceData);

    renderDifferenceRankings(
        callDifferenceData,
        putDifferenceData
    );

    return true;
}

function autoSelectComparisonSnapshot() {
    const openInterestSourceDate =
        getCurrentQriOpenInterestSourceDate();

    if (!isCurrentQriOpenInterestDataValid()) {
        resetComparisonSelection(
            "建玉残データ未提供のため市場診断を算出できません",
            openInterestSourceDate
        );
        return null;
    }

    if (
        !openInterestSourceDate
    ) {
        resetComparisonSelection("比較データ不足");
        return null;
    }

    const currentSourceDate = openInterestSourceDate;

    if (
        comparisonSelectionCurrentSourceDate ===
        currentSourceDate
    ) {
        return comparisonSnapshot;
    }

    let savedSnapshots = [];

    try {
        savedSnapshots = JSON.parse(
            localStorage.getItem("optionMapJpxSnapshots") || "[]"
        );
    } catch (error) {
        console.error(
            "自動比較用の保存データを読み込めませんでした:",
            error
        );
    }

    const selectedSnapshot =
        selectLatestValidComparisonSnapshot(
            savedSnapshots,
            currentSourceDate
        );

    if (!selectedSnapshot) {
        resetComparisonSelection(
            "比較データ不足",
            currentSourceDate
        );
        return null;
    }

    applyComparisonSnapshot(selectedSnapshot, {
        selectionMode: "automatic"
    });

    return selectedSnapshot;
}

window.autoSelectComparisonSnapshot =
    autoSelectComparisonSnapshot;

function calculateWeeklyBrokerJudgment(
    previousWeekly,
    currentWeekly
) {
    if (!window.OptionMapWeeklyFutures) {
        return {
            available: false,
            reason: "weekly_parser_unavailable",
            brokerDiffs: {},
            buyScore: null,
            sellScore: null,
            scoreDiff: null,
            direction: null
        };
    }
    return window.OptionMapWeeklyFutures.calculateWeeklyBrokerJudgment(
        previousWeekly,
        currentWeekly,
        weeklyBrokerMap
    );
}

async function getConfirmedWeeklyFuturesSnapshotCandidates(snapshots) {
    if (
        !Array.isArray(snapshots) ||
        typeof window.validateWeeklyFuturesSnapshotMetadata !== "function"
    ) {
        return [];
    }

    const candidates = [];
    let metadataSnapshotCount = 0;
    let invalidMetadataCount = 0;
    let legacySnapshotCount = 0;

    for (const snapshot of snapshots) {
        if (
            snapshot?.futureOpenInterest &&
            !snapshot?.weeklyFutures
        ) {
            legacySnapshotCount += 1;
        }

        if (
            !snapshot?.futureOpenInterest ||
            !snapshot?.weeklyFutures
        ) {
            continue;
        }

        metadataSnapshotCount += 1;

        let valid = false;

        try {
            valid = await window.validateWeeklyFuturesSnapshotMetadata(
                snapshot.weeklyFutures,
                snapshot.futureOpenInterest
            );
        } catch (error) {
            console.warn("週次先物snapshotの検証に失敗:", error);
        }

        if (!valid) {
            invalidMetadataCount += 1;
            continue;
        }

        candidates.push({
            date: snapshot.weeklyFutures.sourceDate,
            sourceDate: snapshot.weeklyFutures.sourceDate,
            signature: snapshot.weeklyFutures.signature,
            versionKey: snapshot.weeklyFutures.versionKey,
            listingUpdatedAt:
                snapshot.weeklyFutures.listingUpdatedAt,
            savedAt: snapshot.savedAt || null,
            futureOpenInterest: snapshot.futureOpenInterest,
            weeklyFutures: {
                ...snapshot.weeklyFutures,
                dateEvidence: {
                    ...snapshot.weeklyFutures.dateEvidence
                }
            }
        });
    }

    Object.assign(candidates, {
        metadataSnapshotCount,
        invalidMetadataCount,
        legacySnapshotCount
    });

    return candidates;
}

async function getFormalWeeklyFuturesHistoryCandidates() {
    if (
        !formalWeeklyFuturesHistory ||
        !window.OptionMapWeeklyFuturesHistory
    ) return [];
    return window.OptionMapWeeklyFuturesHistory.getActiveVersions(
        formalWeeklyFuturesHistory
    );
}

function selectLatestTwoConfirmedWeeklyFuturesVersions(candidates) {
    if (!Array.isArray(candidates)) {
        return {
            versions: [],
            allVersions: [],
            confirmedVersionCount: 0,
            ambiguousSourceDates: [],
            metadataSnapshotCount: 0,
            invalidMetadataCount: 0,
            legacySnapshotCount: 0
        };
    }

    const byVersionKey = new Map();

    candidates.forEach(candidate => {
        const existing = byVersionKey.get(candidate.versionKey);
        const candidateSavedAt = new Date(candidate.savedAt).getTime();
        const existingSavedAt = new Date(existing?.savedAt).getTime();

        if (
            !existing ||
            (Number.isFinite(candidateSavedAt) &&
                (!Number.isFinite(existingSavedAt) ||
                    candidateSavedAt >= existingSavedAt))
        ) {
            byVersionKey.set(candidate.versionKey, candidate);
        }
    });

    const bySourceDate = new Map();

    [...byVersionKey.values()].forEach(candidate => {
        const versions = bySourceDate.get(candidate.sourceDate) || [];
        versions.push(candidate);
        bySourceDate.set(candidate.sourceDate, versions);
    });

    const resolvedVersions = [];
    const ambiguousSourceDates = [];

    bySourceDate.forEach((versions, sourceDate) => {
        if (versions.length === 1) {
            resolvedVersions.push(versions[0]);
            return;
        }

        const sorted = [...versions].sort((left, right) => {
            const listingDifference =
                new Date(right.listingUpdatedAt).getTime() -
                new Date(left.listingUpdatedAt).getTime();

            if (listingDifference !== 0) return listingDifference;

            return (
                new Date(right.savedAt).getTime() -
                new Date(left.savedAt).getTime()
            );
        });
        const first = sorted[0];
        const second = sorted[1];
        const firstListing = new Date(first.listingUpdatedAt).getTime();
        const secondListing = new Date(second.listingUpdatedAt).getTime();
        const firstSaved = new Date(first.savedAt).getTime();
        const secondSaved = new Date(second.savedAt).getTime();

        if (
            !Number.isFinite(firstListing) ||
            !Number.isFinite(secondListing) ||
            (firstListing === secondListing &&
                (!Number.isFinite(firstSaved) ||
                    !Number.isFinite(secondSaved) ||
                    firstSaved === secondSaved))
        ) {
            ambiguousSourceDates.push(sourceDate);
            return;
        }

        resolvedVersions.push(first);
    });

    resolvedVersions.sort((left, right) =>
        left.sourceDate.localeCompare(right.sourceDate)
    );

    return {
        versions: resolvedVersions.slice(-2),
        allVersions: [...resolvedVersions],
        confirmedVersionCount: resolvedVersions.length,
        ambiguousSourceDates,
        metadataSnapshotCount:
            Number(candidates.metadataSnapshotCount) || 0,
        invalidMetadataCount:
            Number(candidates.invalidMetadataCount) || 0,
        legacySnapshotCount:
            Number(candidates.legacySnapshotCount) || 0
    };
}

function getWeeklyJudgmentAvailability(selection) {
    if (selection.versions.length < 2) {
        return {
            available: false,
            reason: "distinct_confirmed_versions_required"
        };
    }
    return { available: true, reason: null };
}

function formatWeeklyVersionDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}/${match[2]}/${match[3]}` : "----/--/--";
}

function renderWeeklyBrokerVersionStatus(selection, availability) {
    const element = document.getElementById(
        "weeklyBrokerVersionStatus"
    );

    if (!element) return;

    if (availability.available) {
        const [previous, current] = selection.versions;
        element.textContent =
            `比較：${formatWeeklyVersionDate(previous.sourceDate)} → ` +
            formatWeeklyVersionDate(current.sourceDate);
        return;
    }

    const reasonMessages = {
        remote_check_pending: "最新版確認中のため週次判定を保留",
        remote_check_failed: "最新版確認失敗のため週次判定を保留",
        waiting_for_newer_version:
            weeklyFuturesDataState.observedLatestTradeDate
                ? `新版 ${formatWeeklyVersionDate(
                    weeklyFuturesDataState.observedLatestTradeDate
                )} を確認済み・取得待ち`
                : "新版を確認済み・取得待ち",
        active_version_mismatch:
            "現在の正式週次版と保存履歴が一致していません",
        ambiguous_revision:
            "同日訂正版の順序を確認できないため週次判定を保留",
        invalid_metadata:
            "週次版metadataを検証できないため正式比較不可",
        legacy_snapshot_only:
            "旧形式データのみのため正式比較不可",
        insufficient_broker_observations:
            "主要5社の公表比較データが不足しています"
    };

    if (
        availability.reason ===
            "distinct_confirmed_versions_required" &&
        selection.confirmedVersionCount === 1
    ) {
        element.textContent = "正式週次版が1週分のみ";
        return;
    }

    element.textContent = reasonMessages[availability.reason] ||
        "正式な異なる2週分のデータ待ち";
}

let weeklySnapshotRenderRequestId = 0;

async function renderSavedSnapshots() {

    if (!savedSnapshotList) {
        return;
    }

    const storageKey = "optionMapJpxSnapshots";

    let savedSnapshots = [];

    const renderRequestId = ++weeklySnapshotRenderRequestId;

    try {
        savedSnapshots = JSON.parse(
            localStorage.getItem(storageKey) || "[]"
        );

        const weeklySnapshots =
            await getFormalWeeklyFuturesHistoryCandidates();

        if (renderRequestId !== weeklySnapshotRenderRequestId) {
            return;
        }
    
    console.log(
        "📚 保存済み週次建玉一覧 =",
        weeklySnapshots
    );

    const weeklyCheck = weeklySnapshots.map(item => {
        const nikkei225 =
            item.futureOpenInterest?.products?.["日経225先物"];
    
        return {
            date: item.date,
            sellTotal: nikkei225?.sellTotal ?? null,
            buyTotal: nikkei225?.buyTotal ?? null
        };
    });
    
    console.log(
        "🔍 週次建玉内容確認 =",
        weeklyCheck
    );
    
    const weeklySelection =
        selectLatestTwoConfirmedWeeklyFuturesVersions(
            weeklySnapshots
        );
    const uniqueWeeklySnapshots = weeklySelection.versions;
    const allConfirmedWeeklySnapshots = weeklySelection.allVersions;
    let weeklyAvailability =
        getWeeklyJudgmentAvailability(weeklySelection);

    if (weeklyAvailability.available && uniqueWeeklySnapshots.length >= 2) {
        const observationJudgment = calculateWeeklyBrokerJudgment(
            uniqueWeeklySnapshots.at(-2),
            uniqueWeeklySnapshots.at(-1)
        );
        if (!observationJudgment.available) {
            weeklyAvailability = {
                available: false,
                reason: "insufficient_broker_observations",
                eligibleBrokerCount: observationJudgment.eligibleBrokerCount,
                requiredBrokerCount: observationJudgment.requiredBrokerCount
            };
        }
    }

    updateWeeklyCandidateV2(weeklySelection);

    renderWeeklyBrokerVersionStatus(
        weeklySelection,
        weeklyAvailability
    );
    
    console.log(
        "✨ 重複除外した週次建玉 =",
        uniqueWeeklySnapshots.map(item => ({
            date: item.date,
            sellTotal:
                item.futureOpenInterest
                    ?.products?.["日経225先物"]
                    ?.sellTotal ?? null,
            buyTotal:
                item.futureOpenInterest
                    ?.products?.["日経225先物"]
                    ?.buyTotal ?? null
        }))
    );

    let weeklyBrokerDiffs = {};
    let weeklyBrokerHistory = [];

    optionMapJudgmentState.weekly = {
        available: false,
        judgment: null,
        metadata: null
    };

    renderOptionMapOverallJudgment();

    const weeklyBrokerCommentElement =
        document.getElementById("weeklyBrokerComment");

    if (weeklyBrokerCommentElement) {
        weeklyBrokerCommentElement.textContent =
            "比較できる週次データが不足しています。";
    }

    const weeklyStatusIds = Object.fromEntries(
        weeklyBrokerParticipants.map(participant => [
            participant.key,
            participant.statusElementId
        ])
    );

    Object.values(weeklyStatusIds).forEach(elementId => {
        const element = document.getElementById(elementId);
        if (element) element.textContent = "○ 未確定";
    });

    const weeklyDirectionElement =
        document.getElementById("weeklyBrokerDirection");

    if (weeklyDirectionElement) {
        weeklyDirectionElement.textContent = "判定待ち";
    }

    const brokerMap = weeklyBrokerMap;

    const weeklyDirectionChangeElement =
        document.getElementById("weeklyBrokerDirectionChange");

    if (weeklyDirectionChangeElement) {
        weeklyDirectionChangeElement.textContent =
            "比較データ不足";
    }
    
    if (
        uniqueWeeklySnapshots.length >= 2 &&
        weeklyAvailability.available
    ) {
        const previousWeekly =
            uniqueWeeklySnapshots[uniqueWeeklySnapshots.length - 2];

        const currentWeekly =
            uniqueWeeklySnapshots[uniqueWeeklySnapshots.length - 1];

        const currentWeeklyJudgment =
            calculateWeeklyBrokerJudgment(
                previousWeekly,
                currentWeekly
            );

        optionMapJudgmentState.weekly = {
            available: true,
            judgment: currentWeeklyJudgment,
            metadata: {
                status: "complete",
                previous: {
                    sourceDate: previousWeekly.sourceDate,
                    versionKey: previousWeekly.versionKey,
                    signature: previousWeekly.signature
                },
                current: {
                    sourceDate: currentWeekly.sourceDate,
                    versionKey: currentWeekly.versionKey,
                    signature: currentWeekly.signature
                },
                activeVersionKey: currentWeekly.versionKey,
                activeVersionMatched: true,
                origin: "weekly_futures_history",
                dataStatus: "formal_history",
                remoteCheckStatus: null
            }
        };

        renderOptionMapOverallJudgment();

        weeklyBrokerDiffs =
            currentWeeklyJudgment.brokerDiffs;
    
        console.log(
            "📊 主要5社 週次差分 =",
            weeklyBrokerDiffs
        );

        const weeklyStatusLabels = {
            estimatedBuy: `${TRADE_DIRECTION_MARKERS.buy} 買い推定`,
            estimatedSell: `${TRADE_DIRECTION_MARKERS.sell} 売り推定`,
            reducedBuy: `${TRADE_DIRECTION_MARKERS.buy}↘️ 買い縮小`,
            reducedSell: `${TRADE_DIRECTION_MARKERS.sell}↗️ 売り縮小`,
            unconfirmed: `${TRADE_DIRECTION_MARKERS.neutral} 未確定`
        };
        
        if (weeklyDirectionElement) {
            const {
                buyScore,
                sellScore,
                scoreDiff,
                direction: weeklyDirection
            } = currentWeeklyJudgment;
        
            if (weeklyDirection === "強い買い優勢") {
                weeklyDirectionElement.textContent =
                    `${TRADE_DIRECTION_MARKERS.buy} 強い買い優勢`;
            } else if (weeklyDirection === "買い優勢") {
                weeklyDirectionElement.textContent =
                    `${TRADE_DIRECTION_MARKERS.buy} 買い優勢`;
            } else if (weeklyDirection === "強い売り優勢") {
                weeklyDirectionElement.textContent =
                    `${TRADE_DIRECTION_MARKERS.sell} 強い売り優勢`;
            } else if (weeklyDirection === "売り優勢") {
                weeklyDirectionElement.textContent =
                    `${TRADE_DIRECTION_MARKERS.sell} 売り優勢`;
            } else {
                weeklyDirectionElement.textContent =
                    `${TRADE_DIRECTION_MARKERS.neutral} 方向感薄い`;
            }

            if (weeklyBrokerCommentElement) {
                const displayBrokerNames = Object.fromEntries(
                    weeklyBrokerParticipants.map(participant => [
                        participant.key,
                        participant.displayName
                    ])
                );

                const brokerKeysByStatus = status =>
                    Object.entries(weeklyBrokerDiffs)
                        .filter(([, item]) => item?.status === status)
                        .map(([key]) => displayBrokerNames[key] || key);

                const estimatedBuyBrokers =
                    brokerKeysByStatus("estimatedBuy");
                const estimatedSellBrokers =
                    brokerKeysByStatus("estimatedSell");
                const reducedBuyBrokers =
                    brokerKeysByStatus("reducedBuy");
                const reducedSellBrokers =
                    brokerKeysByStatus("reducedSell");
                const unconfirmedBrokers =
                    brokerKeysByStatus("unconfirmed");

                const details = [];

                if (reducedBuyBrokers.length > 0) {
                    details.push(
                        `${reducedBuyBrokers.join("・")}は買い縮小`
                    );
                }

                if (reducedSellBrokers.length > 0) {
                    details.push(
                        `${reducedSellBrokers.join("・")}は売り縮小`
                    );
                }

                if (unconfirmedBrokers.length > 0) {
                    details.push(
                        `${unconfirmedBrokers.join("・")}は未確定`
                    );
                }

                const buyCount = estimatedBuyBrokers.length;
                const sellCount = estimatedSellBrokers.length;

                let conclusion = "";

                if (
                    buyCount > sellCount &&
                    weeklyDirection.includes("売り優勢")
                ) {
                    conclusion =
                        "買い推定の社数が上回っていますが、" +
                        "売り方向の変化率が相対的に大きく、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    sellCount > buyCount &&
                    weeklyDirection.includes("買い優勢")
                ) {
                    conclusion =
                        "売り推定の社数が上回っていますが、" +
                        "買い方向の変化率が相対的に大きく、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    buyCount === sellCount &&
                    weeklyDirection.includes("買い優勢")
                ) {
                    conclusion =
                        "買い推定と売り推定の社数は同数ですが、" +
                        "買い方向の変化率が上回っており、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    buyCount === sellCount &&
                    weeklyDirection.includes("売り優勢")
                ) {
                    conclusion =
                        "買い推定と売り推定の社数は同数ですが、" +
                        "売り方向の変化率が上回っており、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (weeklyDirection === "強い買い優勢") {
                    conclusion =
                        "買い方向への変化が強く、" +
                        "週次では強い買い優勢と判断します。";
                } else if (weeklyDirection === "買い優勢") {
                    conclusion =
                        "買い方向の変化率が上回っており、" +
                        "週次では買い優勢と判断します。";
                } else if (weeklyDirection === "強い売り優勢") {
                    conclusion =
                        "売り方向への変化が強く、" +
                        "週次では強い売り優勢と判断します。";
                } else if (weeklyDirection === "売り優勢") {
                    conclusion =
                        "売り方向の変化率が上回っており、" +
                        "週次では売り優勢と判断します。";
                } else if (buyCount !== sellCount) {
                    conclusion =
                        "推定社数には偏りがありますが、" +
                        "買い・売りの変化率スコア差は小さく、" +
                        "週次では方向感が薄いと判断します。";
                } else {
                    conclusion =
                        "買い・売りの変化率スコア差が小さく、" +
                        "週次では方向感が薄いと判断します。";
                }

                const detailText =
                    details.length > 0
                        ? `${details.join("、")}となっています。`
                        : "";

                weeklyBrokerCommentElement.textContent =
                    `主要5社では買い推定が${buyCount}社、` +
                    `売り推定が${sellCount}社です。` +
                    detailText +
                    conclusion;
            }
        
            console.log("🧭 週次総合スコア =", {
                buyScore,
                sellScore,
                scoreDiff
            });
        }

        if (
            weeklyDirectionChangeElement &&
            allConfirmedWeeklySnapshots.length >= 3
        ) {
            const previousWeeklyJudgment =
                calculateWeeklyBrokerJudgment(
                    allConfirmedWeeklySnapshots[
                        allConfirmedWeeklySnapshots.length - 3
                    ],
                    previousWeekly
                );

            weeklyDirectionChangeElement.textContent =
                previousWeeklyJudgment.direction ===
                currentWeeklyJudgment.direction
                    ? `${currentWeeklyJudgment.direction}を維持`
                    : `${previousWeeklyJudgment.direction} → ` +
                        currentWeeklyJudgment.direction;
        }

        for (const [key, elementId] of Object.entries(weeklyStatusIds)) {
            const element = document.getElementById(elementId);
        
            if (!element) continue;
        
            const status =
                weeklyBrokerDiffs[key]?.status || "unconfirmed";
        
            element.textContent =
                weeklyStatusLabels[status] || "○ 未確定";
        }

    }

    if (!weeklyAvailability.available) {
        optionMapJudgmentState.weekly = {
            available: false,
            judgment: null,
            metadata: {
                status: "insufficient_data",
                reason: weeklyAvailability.reason,
                confirmedVersionCount:
                    weeklySelection.confirmedVersionCount,
                origin: "weekly_futures_history",
                dataStatus: "formal_history",
                remoteCheckStatus: null
            }
        };
        renderOptionMapOverallJudgment();
    }

    if (allConfirmedWeeklySnapshots.length >= 2) {
        for (let i = 1; i < allConfirmedWeeklySnapshots.length; i++) {
            const previousWeekly =
                allConfirmedWeeklySnapshots[i - 1];
    
            const currentWeekly =
                allConfirmedWeeklySnapshots[i];
    
                const intervalJudgment = calculateWeeklyBrokerJudgment(
                    previousWeekly,
                    currentWeekly
                );
                const intervalBrokers = Object.fromEntries(
                    Object.entries(intervalJudgment.brokerDiffs).map(
                        ([key, item]) => [key, {
                            brokerName: item.brokerName,
                            delta: item.delta,
                            status: item.status
                        }]
                    )
                );
                
                weeklyBrokerHistory.push({
                    from: previousWeekly.date,
                    to: currentWeekly.date,
                    brokers: intervalBrokers
                });
        }
    }
    
    console.log(
        "🗂 週次判定区間一覧 =",
        weeklyBrokerHistory
    );


        updateIntelligenceCard(
            savedSnapshots
        );

        console.log("📈 累積グラフ用 savedSnapshots =", savedSnapshots);

        const cumulativeDates = savedSnapshots.map(snapshot =>
            snapshot.sourceDate.slice(0, 10)
        );
        
        console.log("📅 日付一覧 =", cumulativeDates);

        const latestSnapshotsByDay = [];


        
const snapshotMap = new Map();

savedSnapshots.forEach(snapshot => {
    const day = snapshot.sourceDate.slice(0, 10);
    snapshotMap.set(day, snapshot);
});

snapshotMap.forEach(snapshot => {
    latestSnapshotsByDay.push(snapshot);
});

const testSnapshot =
  latestSnapshotsByDay[latestSnapshotsByDay.length - 1];

  
console.log("snapshotの中身", testSnapshot);

const cumulativeCompanySelect =
  document.getElementById("cumulativeBrokerSelect");

const participantChartAdapter =
  window.OptionMapParticipantTwelveGroupChartAdapter;

const selectedBrokerKey =
    cumulativeCompanySelect?.value || "JPM";

  const companyName =
    weeklyBrokerMap[selectedBrokerKey] ||
    weeklyBrokerParticipants[0].brokerName;

const dayAuctionRecords =
  testSnapshot?.parsedDayData?.dayAuction?.large?.records || [];

const dayJnetRecords =
  testSnapshot?.parsedDayData?.dayJnet?.large?.records || [];

const nightAuctionRecords =
  testSnapshot?.parsedDayData?.nightAuction?.large?.records || [];

const nightJnetRecords =
  testSnapshot?.parsedDayData?.nightJnet?.large?.records || [];

const findCompanyVolume = (records, companyName) => {
  return records
    .filter(item => item.company === companyName)
    .reduce((sum, item) => sum + (Number(item.volume) || 0), 0);
};

console.log(
    "🏢 会社名一覧 =",
    [...new Set([
      ...dayAuctionRecords,
      ...dayJnetRecords,
      ...nightAuctionRecords,
      ...nightJnetRecords
    ].map(item => item.company))]
  );

const jpmDayVolume =
  findCompanyVolume(dayAuctionRecords, companyName) +
  findCompanyVolume(dayJnetRecords, companyName);

const jpmNightVolume =
  findCompanyVolume(nightAuctionRecords, companyName) +
  findCompanyVolume(nightJnetRecords, companyName);

console.log("📊 JPMテスト =", {
  date: testSnapshot?.sourceDate?.slice(0, 10),
  day: jpmDayVolume,
  night: jpmNightVolume
});

const cumulativePeriodSelect =
    document.getElementById("cumulativePeriodSelect");

const selectedPeriod =
    cumulativePeriodSelect?.value || "20";

// parsedDayData がある営業日だけ
const validCumulativeSnapshots =
    latestSnapshotsByDay.filter(
        snapshot => snapshot?.parsedDayData
    );

let displaySnapshots = [...validCumulativeSnapshots];

if (selectedPeriod === "20") {

    // 直近20営業日
    displaySnapshots =
        validCumulativeSnapshots.slice(-20);

} else if (
    selectedPeriod === "1m" ||
    selectedPeriod === "3m"
) {

    // 最新データの日付を基準にする
    const latestSnapshot =
        validCumulativeSnapshots[
            validCumulativeSnapshots.length - 1
        ];

    if (latestSnapshot) {
        const latestDate =
            new Date(latestSnapshot.sourceDate);

        const cutoffDate =
            new Date(latestDate);

        cutoffDate.setMonth(
            cutoffDate.getMonth() -
            (selectedPeriod === "1m" ? 1 : 3)
        );

        displaySnapshots =
            validCumulativeSnapshots.filter(
                snapshot =>
                    new Date(snapshot.sourceDate) >= cutoffDate
            );
    }
}

console.log(
    "📊 累積グラフ表示期間 =",
    selectedPeriod,
    displaySnapshots.map(
        snapshot => snapshot.sourceDate.slice(0, 10)
    )
);

const selectedWeeklyStatus =
    weeklyBrokerDiffs[selectedBrokerKey]?.status || "unconfirmed";

console.log(
    "🎨 累積グラフ判定 =",
    selectedBrokerKey,
    selectedWeeklyStatus
);

const getStatusForDate = date => {
    const interval = weeklyBrokerHistory.find(item =>
        date > item.from &&
        date <= item.to
    );

    if (!interval) {
        return "unconfirmed";
    }

    return (
        interval.brokers?.[selectedBrokerKey]?.status ||
        "unconfirmed"
    );
};

const createExistingMajor5Series = () => displaySnapshots
  .filter(snapshot => snapshot?.parsedDayData)
  .map(snapshot => {
    const dayAuctionRecords =
      snapshot.parsedDayData?.dayAuction?.large?.records || [];

    const dayJnetRecords =
      snapshot.parsedDayData?.dayJnet?.large?.records || [];

    const nightAuctionRecords =
      snapshot.parsedDayData?.nightAuction?.large?.records || [];

    const nightJnetRecords =
      snapshot.parsedDayData?.nightJnet?.large?.records || [];

    const day =
      findCompanyVolume(dayAuctionRecords, companyName) +
      findCompanyVolume(dayJnetRecords, companyName);

    const night =
      findCompanyVolume(nightAuctionRecords, companyName) +
      findCompanyVolume(nightJnetRecords, companyName);

      const date =
      snapshot.sourceDate.slice(0, 10);
  
      const status = getStatusForDate(date);

    
  return {
    date,
    day,
    night,
    status
};
  });

const additionalClassificationHistory =
  participantChartAdapter?.isAdditionalGroup?.(selectedBrokerKey)
    ? participantChartAdapter.createAdditionalClassificationHistory(
        allConfirmedWeeklySnapshots,
        selectedBrokerKey
      )
    : [];

const additionalSeries =
  participantChartAdapter?.isAdditionalGroup?.(selectedBrokerKey)
    ? participantChartAdapter.createAdditionalSeries(
        displaySnapshots,
        selectedBrokerKey,
        additionalClassificationHistory
      )
    : null;

const companyDailySeries = additionalSeries?.points ||
  createExistingMajor5Series();

console.log("📈 JPM日付別シリーズ =", companyDailySeries);

const cumulativeCanvas = document.getElementById("cumulativeChart");

if (cumulativeCanvas) {
  if (window.cumulativeChartInstance) {
    window.cumulativeChartInstance.destroy();
  }

  window.cumulativeChartInstance = new Chart(cumulativeCanvas, {
    type: "bar",
    data: {
      labels: companyDailySeries.map(item => item.date),
      datasets: [
        {
            label: "日中",
            data: companyDailySeries.map(item => item.day),
            backgroundColor: companyDailySeries.map(item => {
                const colors =
                    PARTICIPANT_CUMULATIVE_COLORS[item.status] ||
                    PARTICIPANT_CUMULATIVE_COLORS.unconfirmed;
                return colors.day;
            })
        },
        {
            label: "夜間",
            data: companyDailySeries.map(item => item.night),
            backgroundColor: companyDailySeries.map(item => {
                const colors =
                    PARTICIPANT_CUMULATIVE_COLORS[item.status] ||
                    PARTICIPANT_CUMULATIVE_COLORS.unconfirmed;
                return colors.night;
            })
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: readableAxisTitle("日付"),
          ticks: {
            autoSkip: true,
            maxTicksLimit: 12,
            minRotation: 30,
            maxRotation: 45,
            padding: 6,
            font: { size: CHART_TEXT_SIZE.axis }
          }
        },
        y: {
          beginAtZero: true,
          title: readableAxisTitle("取引枚数"),
          ticks: {
            padding: 6,
            font: { size: CHART_TEXT_SIZE.axis },
            callback: value => Number(value).toLocaleString("ja-JP")
          }
        }
      },
      plugins: {
        legend: readableLegendOptions(),
        tooltip: readableTooltipOptions()
      }
    }
  });
}

console.log(
    "📦 日毎最新データ =",
    latestSnapshotsByDay
);

const jpmData = latestSnapshotsByDay.map(snapshot => {
    return {
        date: snapshot.sourceDate.slice(0, 10),
        brokerData: snapshot.brokerData
    };
});

const jpmLargeData = latestSnapshotsByDay.map(snapshot => ({
    date: snapshot.sourceDate.slice(0, 10),
    large: snapshot.brokerData?.night?.JPM?.large
}));

console.log(
    "🔍 brokerData中身 =",
    latestSnapshotsByDay[24].brokerData
);

console.log("🏦 JPMラージ =", jpmLargeData);

console.log("🏦 JPM抽出前データ =", jpmData);

    } catch (error) {
        console.error(
            "保存済みJPXデータを読み込めませんでした:",
            error
        );

        savedSnapshotList.textContent =
            "保存データの読み込みに失敗しました";

        return;
    }

    savedSnapshotList.innerHTML = "";

    if (savedSnapshots.length === 0) {
        savedSnapshotList.textContent =
            "保存済みデータはありません";
        return;
    }

    // 新しいデータを上に表示
    const newestFirst = [...savedSnapshots].sort(
        (a, b) =>
            new Date(b.sourceDate) -
            new Date(a.sourceDate)
    );

    newestFirst.forEach((snapshot, index) => {

        const item =
            document.createElement("div");

        item.className =
            "saved-snapshot-item";

        const date =
            new Date(snapshot.sourceDate);

        const savedAt =
            new Date(snapshot.savedAt);

        const dataCount =
            Array.isArray(snapshot.labels)
                ? snapshot.labels.length
                : 0;

                item.innerHTML = `
                <div>
                    <div class="saved-snapshot-date">
                        ${index + 1}.　
                        ${date.toLocaleString("ja-JP", {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                    </div>
            
                <div class="snapshot-tags">
                         ${(snapshot.tags || [])
                             .map(tag => `<span class="snapshot-tag">${tag}</span>`)
                             .join("")}
                </div>

                ${snapshot.memo ? `
                    <div class="snapshot-memo">
                        📝 ${snapshot.memo}
                    </div>
                ` : ""}
                
                <button
                    type="button"
                    class="edit-snapshot-memo-button"
                    data-index="${index}"
                >
                    メモを編集
                </button>

                    <div class="saved-snapshot-detail">
                        ${dataCount.toLocaleString()}価格帯
                        ・保存：
                        ${savedAt.toLocaleString("ja-JP", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                    </div>
                </div>
            
                <button
                    type="button"
                    class="show-snapshot-button"
                >
                    表示
                </button>
        
                <button
                    type="button"
                    class="compare-snapshot-button"
                >
                    比較
</button>

`;

            

    const showButton =
    item.querySelector(".show-snapshot-button");

if (showButton) {
    showButton.addEventListener(
        "click",
        function () {
    resetComparisonSelection("まだ選択されていません");

    const snapshotDate =
    new Date(snapshot.sourceDate);

    nightData.value = snapshot.nightData || "";
    dayData.value = snapshot.dayData || "";
    optionData.value = snapshot.optionData || "";
    localStorage.setItem("optionMapNightData", nightData.value);
    localStorage.setItem("optionMapDayData", dayData.value);
    localStorage.setItem("optionMapOptionData", optionData.value);

// 保存データを現在の表示用データにする
allJpxLabels =
    Array.isArray(snapshot.labels)
        ? [...snapshot.labels]
        : [];

jpxOpenInterestAvailable =
    snapshot.openInterestAvailable !== false &&
    Array.isArray(snapshot.callOpenInterest) &&
    Array.isArray(snapshot.putOpenInterest) &&
    snapshot.callOpenInterest.length === allJpxLabels.length &&
    snapshot.putOpenInterest.length === allJpxLabels.length;

allJpxOpenInterestLabels = jpxOpenInterestAvailable
    ? [...allJpxLabels]
    : [];

allJpxCallValues =
    Array.isArray(snapshot.callOpenInterest)
        ? [...snapshot.callOpenInterest]
        : [];

allJpxPutValues =
    Array.isArray(snapshot.putOpenInterest)
        ? [...snapshot.putOpenInterest]
        : [];

allJpxCallVolumes =
    Array.isArray(snapshot.callVolume)
        ? [...snapshot.callVolume]
        : [];

allJpxPutVolumes =
    Array.isArray(snapshot.putVolume)
        ? [...snapshot.putVolume]
        : [];

// データ日時も保存日のものへ変更
if (
    typeof window.setJpxSourceTime === "function" &&
    !Number.isNaN(snapshotDate.getTime())
) {
    window.setJpxSourceTime(snapshotDate);
}

// グラフと壁候補を再描画
window.drawJpxPriceChart(
    allJpxLabels,
    allJpxCallValues,
    allJpxPutValues,
    allJpxCallVolumes,
    allJpxPutVolumes,
    {
        openInterestAvailable: jpxOpenInterestAvailable,
        openInterestLabels: allJpxOpenInterestLabels
    }
);

console.log(
    "保存済みJPXデータを表示:",
    snapshot
);
        }
    );
}


const editMemoButton =
    item.querySelector(".edit-snapshot-memo-button");

if (editMemoButton) {
    editMemoButton.addEventListener("click", function () {
        const existingEditor =
            item.querySelector(".snapshot-memo-editor");

        if (existingEditor) {
            existingEditor.remove();
            return;
        }

        const editor = document.createElement("div");
        editor.className = "snapshot-memo-editor";

        const textarea = document.createElement("textarea");
        textarea.value = snapshot.memo || "";
        textarea.rows = 8;
        textarea.style.width = "100%";

        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.textContent = "変更を保存";

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.textContent = "キャンセル";

        editor.appendChild(textarea);
        editor.appendChild(saveButton);
        editor.appendChild(cancelButton);

        editMemoButton.insertAdjacentElement(
            "afterend",
            editor
        );

        saveButton.addEventListener("click", function () {
            snapshot.memo = textarea.value;

            localStorage.setItem(
                storageKey,
                JSON.stringify(savedSnapshots)
            );

            renderSavedSnapshots();
        });

        cancelButton.addEventListener("click", function () {
            editor.remove();
        });
    });
}

const compareButton =
    item.querySelector(".compare-snapshot-button");

if (compareButton) {
    compareButton.addEventListener(
        "click",
        function () {
            applyComparisonSnapshot(snapshot, {
                selectionMode: "manual"
            });
        }
    );
}

        savedSnapshotList.appendChild(item);
    });
}

const cumulativeBrokerSelect =
  document.getElementById("cumulativeBrokerSelect");

if (cumulativeBrokerSelect) {
  cumulativeBrokerSelect.addEventListener("change", () => {
    renderSavedSnapshots();
  });
}

const cumulativePeriodSelect =
    document.getElementById("cumulativePeriodSelect");

if (cumulativePeriodSelect) {
    cumulativePeriodSelect.addEventListener(
        "change",
        renderSavedSnapshots
    );
}

    async function saveCurrentJpxSnapshot() {

    if (qriOpenInterestDataState.usingFallback === true) {
        const message =
            "直近正常建玉を使用中のため、スナップショットを保存できません";

        if (snapshotSaveStatus) {
            snapshotSaveStatus.textContent = message;
        }
        alert(message);
        return;
    }

    if (
        allJpxLabels.length === 0
    ) {
        alert("保存できるJPXデータがありません");
        return;
    }

    const sourceDate =
        lastJpxFetchedAt instanceof Date &&
        !Number.isNaN(lastJpxFetchedAt.getTime())
            ? lastJpxFetchedAt
            : new Date();

    let weeklyFuturesMetadata = null;

    if (
        latestFutureOpenInterestResult &&
        typeof window.getActiveWeeklyFuturesSnapshotMetadata ===
            "function" &&
        typeof window.validateWeeklyFuturesSnapshotMetadata ===
            "function"
    ) {
        try {
            const candidateMetadata =
                await window.getActiveWeeklyFuturesSnapshotMetadata();
            const validMetadata = candidateMetadata &&
                await window.validateWeeklyFuturesSnapshotMetadata(
                    candidateMetadata,
                    latestFutureOpenInterestResult
                );

            if (validMetadata) {
                weeklyFuturesMetadata = {
                    ...candidateMetadata,
                    dateEvidence: {
                        ...candidateMetadata.dateEvidence
                    }
                };
            }
        } catch (error) {
            console.warn(
                "週次先物metadataをsnapshotへ追加できませんでした:",
                error
            );
        }
    }

    const snapshot = {
        sourceDate: sourceDate.toISOString(),
        savedAt: new Date().toISOString(),
        tags: [],
        memo:
        document.getElementById("snapshotMemo")?.value.trim() || "",

        nightData: nightData.value,
        dayData: dayData.value,
        optionData: optionData.value,

        brokerData: {
            night: { ...latestNightBrokerData },
            day: { ...latestDayBrokerData },
            option: { ...latestOptionBrokerData }
        },

        parsedDayData: latestParsedDayData,

        participant: latestParticipantMetadata
            ? {
                metadataVersion: latestParticipantMetadata.versionKey ? 2 : 1,
                sourceDate: participantDataState.sourceDate ||
                    latestParticipantMetadata.sourceDate,
                status: latestParticipantMetadata.status,
                fileStatuses: {
                    ...latestParticipantMetadata.fileStatuses
                },
                ...(latestParticipantMetadata.versionKey ? {
                    versionKey: latestParticipantMetadata.versionKey,
                    signature: latestParticipantMetadata.signature,
                    origin: participantDataState.origin,
                    dataStatus: participantDataState.dataStatus
                } : {})
            }
            : null,

        futureBrokerData: {
            night: latestNightFutureTotals,
            day: latestDayFutureTotals
        },
       
        labels: [...allJpxLabels],

        openInterestAvailable:
            jpxOpenInterestAvailable === true,
        callOpenInterest:
            jpxOpenInterestAvailable === true
                ? [...allJpxCallValues]
                : [],
        putOpenInterest:
            jpxOpenInterestAvailable === true
                ? [...allJpxPutValues]
                : [],

        callVolume: [...allJpxCallVolumes],
        putVolume: [...allJpxPutVolumes],
        futureOpenInterest: latestFutureOpenInterestResult,
    };

    if (weeklyFuturesMetadata) {
        snapshot.weeklyFutures = weeklyFuturesMetadata;
    }

    console.log("保存直前snapshot =", snapshot);
    console.log("🟣 保存直前 parsedDayData =", latestParsedDayData);
    console.log("🚀 保存前 futureBrokerData =", snapshot.futureBrokerData);

    const storageKey = "optionMapJpxSnapshots";

    const savedSnapshots =
        JSON.parse(
            localStorage.getItem(storageKey) || "[]"
        );

    // 同じ元データ日時なら重複保存せず更新
    const existingIndex =
        savedSnapshots.findIndex(item =>
            item.sourceDate === snapshot.sourceDate
        );

    if (
        existingIndex >= 0 &&
        jpxOpenInterestAvailable === false
    ) {
        const existingSnapshot =
            savedSnapshots[existingIndex];

        if (
            isValidOptionSnapshot(existingSnapshot)
        ) {
            const currentVolumeByStrike = new Map(
                snapshot.labels.map((label, index) => [
                    String(label).replace(/,/g, ""),
                    {
                        callVolume:
                            snapshot.callVolume[index] ?? 0,
                        putVolume:
                            snapshot.putVolume[index] ?? 0
                    }
                ])
            );

            snapshot.labels = [...existingSnapshot.labels];
            snapshot.openInterestAvailable = true;
            snapshot.callOpenInterest = [
                ...existingSnapshot.callOpenInterest
            ];
            snapshot.putOpenInterest = [
                ...existingSnapshot.putOpenInterest
            ];
            snapshot.callVolume = snapshot.labels.map(
                (label, index) =>
                    currentVolumeByStrike.get(
                        String(label).replace(/,/g, "")
                    )?.callVolume ??
                    existingSnapshot.callVolume?.[index] ??
                    0
            );
            snapshot.putVolume = snapshot.labels.map(
                (label, index) =>
                    currentVolumeByStrike.get(
                        String(label).replace(/,/g, "")
                    )?.putVolume ??
                    existingSnapshot.putVolume?.[index] ??
                    0
            );
        }
    }

    if (existingIndex >= 0) {
        savedSnapshots[existingIndex] = snapshot;
    } else {
        savedSnapshots.push(snapshot);
    }

    savedSnapshots.sort((a, b) =>
        new Date(a.sourceDate) -
        new Date(b.sourceDate)
    );

    localStorage.setItem(
        storageKey,
        JSON.stringify(savedSnapshots)
    );

    if (snapshotSaveStatus) {
        snapshotSaveStatus.textContent =
            sourceDate.toLocaleString("ja-JP") +
            " のデータを保存しました";
    }

    renderSavedSnapshots();

    const memoElement = document.getElementById("snapshotMemo");

    if (memoElement) {
    
        memoElement.value = "";
    
    }

    console.log(
        "JPXスナップショット保存:",
        snapshot
    );
}

if (saveJpxSnapshotButton) {
    saveJpxSnapshotButton.addEventListener(
        "click",
        saveCurrentJpxSnapshot
    );
}



function renderQriContractDisplayChart() {
    if (!qriContractDisplayData || qriContractDisplayData.unavailable) return false;
    const isVolumeMode = currentChartMode === "volume";
    const source = qriContractDisplayData;
    const labels = source.labels;
    const callSource = isVolumeMode ? source.callVolumes : source.callOpenInterest;
    const putSource = isVolumeMode ? source.putVolumes : source.putOpenInterest;
    const valuesByStrike = new Map(labels.map((label, index) => [
        Number(String(label).replace(/,/g, "")),
        { call: Number(callSource[index]) || 0, put: Number(putSource[index]) || 0 }
    ]));
    const startStrike = Math.ceil((currentPrice - 12000) / 125) * 125;
    const endStrike = Math.floor((currentPrice + 22000) / 125) * 125;
    const visible = [];
    for (let strike = startStrike; strike <= endStrike; strike += 125) {
        const item = valuesByStrike.get(strike) || { call: 0, put: 0 };
        visible.push({ label: strike.toLocaleString(), ...item });
    }
    const numericCallValues = visible.map(item => item.call);
    const numericPutValues = visible.map(item => item.put);
    const maxCall = Math.max(...numericCallValues, 1);
    const maxPut = Math.max(...numericPutValues, 1);
    const canvas = document.getElementById("combinedPriceChart");
    if (!canvas) return false;
    if (combinedPriceChart) {
        combinedPriceChart.destroy();
        clearQriChartRendererIdentity();
    }
    const title = document.getElementById("combinedChartTitleText");
    if (title) title.textContent = isVolumeMode ? "CALL・PUT 本日の取引高" : "CALL・PUT建玉残";
    combinedPriceChart = new Chart(canvas, {
        type: "bar",
        plugins: [currentPriceLinePlugin],
        data: { labels: visible.map(item => item.label), datasets: [
            { label: isVolumeMode ? "CALL取引高" : "CALL建玉残",
                data: numericCallValues.map(value => value / maxCall * 100),
                backgroundColor: createBarColors(numericCallValues,
                    OPTION_SIDE_CHART_COLORS.call.soft,
                    OPTION_SIDE_CHART_COLORS.call.strong),
                borderColor: OPTION_SIDE_CHART_COLORS.call.border, borderWidth: 1 },
            { label: isVolumeMode ? "PUT取引高" : "PUT建玉残",
                data: numericPutValues.map(value => -(value / maxPut * 100)),
                backgroundColor: createBarColors(numericPutValues,
                    OPTION_SIDE_CHART_COLORS.put.soft,
                    OPTION_SIDE_CHART_COLORS.put.strong),
                borderColor: OPTION_SIDE_CHART_COLORS.put.border, borderWidth: 1 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
            scales: { x: { ticks: { autoSkip: true, maxTicksLimit: 16, maxRotation: 45,
                minRotation: 35, font: { size: CHART_TEXT_SIZE.axis } } },
            y: { min: -115, max: 115, ticks: { stepSize: 100,
                font: { size: CHART_TEXT_SIZE.axis, weight: "600" },
                callback: value => value === 100 ? "CALL" : value === -100 ? "PUT" : value === 0 ? "0" : "" } } },
            plugins: { legend: { ...readableLegendOptions() }, tooltip: { ...readableTooltipOptions(),
                callbacks: { label(context) { const values = context.datasetIndex === 0
                    ? numericCallValues : numericPutValues; const type = context.datasetIndex === 0 ? "CALL" : "PUT";
                    return `${type}${isVolumeMode ? "取引高" : "建玉残"}：${values[context.dataIndex].toLocaleString()}枚`; } } } }
        }
    });
    setQriChartRendererIdentity({ rendererKind: "display_only",
        sourceKind: source.sourceKind || (source.legacyDisplayOnly ? "legacy" : "unknown"),
        displayOnly: true, displayGeneration: source.displayGeneration });
    return true;
}

window.setQriContractDisplayData = function (data) {
    if (!data || !Array.isArray(data.labels) || data.labels.length === 0 ||
        ![data.callOpenInterest, data.putOpenInterest, data.callVolumes, data.putVolumes]
            .every(values => Array.isArray(values) && values.length === data.labels.length)) return false;
    qriContractDisplayData = JSON.parse(JSON.stringify(data));
    return renderQriContractDisplayChart();
};

window.clearQriContractDisplayData = function ({ redraw = true } = {}) {
    qriContractDisplayData = null;
    if (!redraw) return true;
    if (allJpxLabels.length === 0) return false;
    window.drawJpxPriceChart(allJpxLabels, allJpxCallValues, allJpxPutValues,
        allJpxCallVolumes, allJpxPutVolumes, { openInterestAvailable: jpxOpenInterestAvailable === true,
            openInterestLabels: allJpxOpenInterestLabels });
    return true;
};

window.setQriContractDisplayUnavailable = function (contract) {
    qriContractDisplayData = { unavailable: true, contract };
    if (combinedPriceChart) {
        combinedPriceChart.destroy();
        combinedPriceChart = null;
        clearQriChartRendererIdentity();
    }
    return true;
};

window.getQriContractDisplayState = function () {
    return qriContractDisplayData ? JSON.parse(JSON.stringify(qriContractDisplayData)) : null;
};

window.getQriChartRendererIdentity = function () {
    return qriChartRendererIdentity
        ? JSON.parse(JSON.stringify(qriChartRendererIdentity)) : null;
};

window.getQriOptionsFormalDiagnosticsSnapshot = function () {
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const wallText = id => document.getElementById(id)?.textContent || null;
    return clone({
        sourceIdentity: {
            available: jpxOpenInterestAvailable === true,
            origin: qriOpenInterestDataState.origin || null,
            status: qriOpenInterestDataState.status || null,
            sourceDate: qriOpenInterestDataState.sourceDate || null,
            sourceDateKind: qriOpenInterestDataState.sourceDateKind || null,
            fetchedAt: qriOpenInterestDataState.fetchedAt || null,
            usingFallback: qriOpenInterestDataState.usingFallback === true,
            pageFetchedAt: lastJpxFetchedAt instanceof Date &&
                !Number.isNaN(lastJpxFetchedAt.getTime())
                ? lastJpxFetchedAt.toISOString() : null
        },
        formalGlobals: { openInterestLabels: allJpxOpenInterestLabels,
            callValues: allJpxCallValues, putValues: allJpxPutValues,
            openInterestAvailable: jpxOpenInterestAvailable },
        wallState: { call: wallText("callWallResult"),
            put: wallText("putWallResult") },
        judgmentState: optionMapJudgmentState,
        overallV2State: optionMapJudgmentStateV2,
        fetchState: window.dataFetchState?.qri || null
    });
};

window.drawJpxPriceChart = function (
    labels,
    callValues,
    putValues,
    callVolumes,
    putVolumes,
    sourceAvailability = {}
) {    
    const previousOpenInterestAvailability =
        jpxOpenInterestAvailable;
    const hasExplicitOpenInterestAvailability =
        typeof sourceAvailability.openInterestAvailable === "boolean";

    if (hasExplicitOpenInterestAvailability) {
        jpxOpenInterestAvailable =
            sourceAvailability.openInterestAvailable;
    }

    const openInterestLabels =
        Array.isArray(sourceAvailability.openInterestLabels)
            ? sourceAvailability.openInterestLabels
            : labels;

    callVolumes = Array.isArray(callVolumes)
    ? callVolumes
    : labels.map(() => 0);

putVolumes = Array.isArray(putVolumes)
    ? putVolumes
    : labels.map(() => 0);

const optionSourceDataChanged =
    (
        jpxOpenInterestAvailable === true &&
        (
            !areJudgmentSourceArraysEqual(
                openInterestLabels,
                allJpxOpenInterestLabels
            ) ||
            !areJudgmentSourceArraysEqual(
                callValues,
                allJpxCallValues
            ) ||
            !areJudgmentSourceArraysEqual(
                putValues,
                allJpxPutValues
            )
        )
    ) ||
    previousOpenInterestAvailability !==
        jpxOpenInterestAvailable;

if (optionSourceDataChanged) {
    invalidateOptionMarketJudgment();
}


       // 新しく読み込んだJPXデータで毎回更新
allJpxLabels = [...labels];
allJpxCallVolumes = [...callVolumes];
allJpxPutVolumes = [...putVolumes];

if (jpxOpenInterestAvailable !== false) {
    allJpxOpenInterestLabels = [...openInterestLabels];
    allJpxCallValues = [...callValues];
    allJpxPutValues = [...putValues];
} else {
    resetComparisonSelection(
        "建玉残データ未提供のため市場診断を算出できません"
    );
}

syncOptionMarketJudgmentOpenInterestMetadata();
updateOpenInterestDataStatus();

console.log(
    "JPX全データ更新:",
    allJpxLabels.length,
    "最小:",
    allJpxLabels[0],
    "最大:",
    allJpxLabels[allJpxLabels.length - 1]
);

const isVolumeMode =
    currentChartMode === "volume";

const chartTitle =
    document.getElementById("combinedChartTitleText");

const callWallTitle =
    document.getElementById("callWallTitleText");

const putWallTitle =
    document.getElementById("putWallTitleText");

if (chartTitle) {
    chartTitle.textContent =
        isVolumeMode
            ? "CALL・PUT 本日の取引高"
            : "CALL・PUT建玉残";
}

if (callWallTitle) {
    callWallTitle.textContent =
        isVolumeMode
            ? "上側のCALL取引高上位"
            : "上側のCALL壁候補";
}

if (putWallTitle) {
    putWallTitle.textContent =
        isVolumeMode
            ? "下側のPUT取引高上位"
            : "下側のPUT壁候補";
}

const selectedCallValues =
    isVolumeMode
        ? callVolumes
        : jpxOpenInterestAvailable === false
            ? labels.map(() => 0)
            : callValues;

const selectedPutValues =
    isVolumeMode
        ? putVolumes
        : jpxOpenInterestAvailable === false
            ? labels.map(() => 0)
            : putValues;

const selectedLabels =
    isVolumeMode
        ? labels
        : jpxOpenInterestAvailable === false
            ? labels
            : openInterestLabels;

        const minStrike = currentPrice - 12000;
        const maxStrike = currentPrice + 22000;
    
        // 元データを価格ごとに検索できる形にする
const dataByStrike = new Map();

selectedLabels.forEach((label, index) => {

    const strike = Number(
        String(label).replace(/,/g, "")
    );

    dataByStrike.set(strike, {
        callValue:
            Number(selectedCallValues[index]) || 0,
    
        putValue:
            Number(selectedPutValues[index]) || 0
    });
});

// 横軸を125円刻みに統一
const strikeStep = 125;

const startStrike =
    Math.ceil(minStrike / strikeStep) * strikeStep;

const endStrike =
    Math.floor(maxStrike / strikeStep) * strikeStep;

    updateMarketInfo(
        startStrike,
        endStrike
    );

const visibleData = [];

for (
    let strike = startStrike;
    strike <= endStrike;
    strike += strikeStep
) {

    const originalData = dataByStrike.get(strike);

    visibleData.push({
        label: strike.toLocaleString(),
        strike: strike,
        callValue: originalData
            ? originalData.callValue
            : 0,
        putValue: originalData
            ? originalData.putValue
            : 0
    });
}

console.log(

    "visibleData先頭10件:",

    visibleData.slice(0, 10)

);

        labels = visibleData.map(item => item.label);
        callValues = visibleData.map(item => item.callValue);
        putValues = visibleData.map(item => item.putValue);
    
        latestJpxLabels = labels;
        latestCallValues = callValues;
        latestPutValues = putValues;

    
    const canvas =
        document.getElementById("combinedPriceChart");

    if (!canvas) {
        console.error(
            "combinedPriceChartのcanvasが見つかりません"
        );
        return;
    }

    if (combinedPriceChart) {
        combinedPriceChart.destroy();
        clearQriChartRendererIdentity();
    }

    const numericCallValues =
        callValues.map(value => Number(value) || 0);

    const numericPutValues =
        putValues.map(value => Number(value) || 0);

    const maxCall =
        Math.max(...numericCallValues, 1);

    const maxPut =
        Math.max(...numericPutValues, 1);

    // CALLは上方向へ0〜100
    const normalizedCallValues =
        numericCallValues.map(value =>
            value / maxCall * 100
        );

    // PUTは下方向へ0〜-100
    const normalizedPutValues =
        numericPutValues.map(value =>
            -(value / maxPut * 100)
        );

    combinedPriceChart = new Chart(canvas, {
        type: "bar",

        plugins: [
            currentPriceLinePlugin,
            combinedWallRankPlugin
        ],

        data: {
            labels: labels,

            datasets: [
                {
                    label: isVolumeMode
                        ? "CALL取引高"
                        : "CALL建玉残",
                    data: normalizedCallValues,

                    backgroundColor: createBarColors(
                        numericCallValues,
                        OPTION_SIDE_CHART_COLORS.call.soft,
                        OPTION_SIDE_CHART_COLORS.call.strong
                    ),

                    borderColor:
                        OPTION_SIDE_CHART_COLORS.call.border,

                    borderWidth: 1
                },
                {
                    label: isVolumeMode
                        ? "PUT取引高"
                        : "PUT建玉残",
                    data: normalizedPutValues,

                    backgroundColor: createBarColors(
                        numericPutValues,
                        OPTION_SIDE_CHART_COLORS.put.soft,
                        OPTION_SIDE_CHART_COLORS.put.strong
                    ),

                    borderColor:
                        OPTION_SIDE_CHART_COLORS.put.border,

                    borderWidth: 1
                }
            ]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: {

                padding: {
        
                    left: 10,
        
                    right: 25,
        
                    top: 10,
        
                    bottom: 5
        
                }
        
            },
            scales: {
                x: {
                    stacked: false,

                    ticks: {
                        autoSkip: true,
                        maxTicksLimit: 16,
                        maxRotation: 45,
                        minRotation: 35,
                        padding: 6,
                        font: { size: CHART_TEXT_SIZE.axis }
                    }
                },

                y: {
                    min: -115,
                    max: 115,

                    ticks: {
                        stepSize: 100,
                        padding: 6,
                        font: {
                            size: CHART_TEXT_SIZE.axis,
                            weight: "600"
                        },
                    
                        callback: function (value) {
                    
                            if (value === 100) {
                                return "CALL";
                            }
                    
                            if (value === 0) {
                                return "0";
                            }
                    
                            if (value === -100) {
                                return "PUT";
                            }
                    
                            return "";
                        }
                    },

                    grid: {
                        color: function (context) {

                            if (context.tick.value === 0) {
                                return "rgba(0, 0, 0, 0.75)";
                            }

                            return "rgba(0, 0, 0, 0.1)";
                        },

                        lineWidth: function (context) {

                            return context.tick.value === 0
                                ? 2
                                : 1;
                        }
                    }
                }
            },

            plugins: {
                legend: {
                    ...readableLegendOptions()
                },

                tooltip: {
                    ...readableTooltipOptions(),
                    callbacks: {
                        label: function (context) {

                            const index =
                                context.dataIndex;

                            if (
                                context.datasetIndex === 0
                            ) {
                                return (
                                    (isVolumeMode

                                        ? "CALL取引高："
                                
                                        : "CALL建玉残：")  +
                                    numericCallValues[index]
                                        .toLocaleString() +
                                    "枚"
                                );
                            }

                            return (
                                (isVolumeMode

                                     ? "PUT取引高："

                                     : "PUT建玉残：") +
                                numericPutValues[index]
                                    .toLocaleString() +
                                "枚"
                            );
                        }
                    }
                }
            }
        }
    });
    setQriChartRendererIdentity({ rendererKind: "formal",
        sourceKind: sourceAvailability.rendererSourceKind || "formal",
        displayOnly: false });

    updateWallCandidates(
        labels,
        numericCallValues,
        numericPutValues
    );

    console.log(
        "CALL・PUT統合グラフ作成成功"
    );
};


function showOptionMap() {

    const result = document.getElementById("optionMapResult");

    result.innerHTML = "";

    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const title = document.createElement("h3");
        title.textContent = Number(price).toLocaleString() + " 円";
        result.appendChild(title);

        const ul = document.createElement("ul");

        const companies = optionMap[price];

        for (const company in companies) {

            const li = document.createElement("li");

            li.textContent =
                (companyNames[company] || company) +
                " : " +
                companies[company] +
                "枚";

            ul.appendChild(li);
        }

        result.appendChild(ul);

    }

}

function drawOptionTable() {

    const companies = [
        "BNP",
        "JPM",
        "ABN",
        "UBS",
        "Barclays",
        "SG",
        "Goldman",
        "Rakuten",
        "Matsui",
        "MorganMUFG"
    ];

    const table = document.getElementById("optionMapTable");
    table.innerHTML = "";

    // ヘッダー
    const header = document.createElement("tr");

    const thPrice = document.createElement("th");
    thPrice.textContent = "価格";
    header.appendChild(thPrice);

    const thTotal = document.createElement("th");
    thTotal.textContent = "合計";
    header.appendChild(thTotal);

    for (const company of companies) {

        const th = document.createElement("th");
        th.textContent = company;
        header.appendChild(th);

    }

    table.appendChild(header);

    // データ行
    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const tr = document.createElement("tr");

        // 価格
        const tdPrice = document.createElement("td");
        tdPrice.textContent = Number(price).toLocaleString() + "円";
        tdPrice.style.fontWeight = "bold";
        tdPrice.style.textAlign = "center";
        tr.appendChild(tdPrice);

        // 合計を計算
        let total = 0;

        for (const company of companies) {
            total += optionMap[price][company] || 0;
        }

        // 合計セル
        const tdTotal = document.createElement("td");
        tdTotal.textContent = total.toLocaleString();
        tdTotal.style.fontWeight = "bold";
        tdTotal.style.textAlign = "center";



        if (total >= 3000) {
            tdTotal.style.backgroundColor = "#ff4d4d";
        }
        else if (total >= 500) {
            tdTotal.style.backgroundColor = "#ff9933";
        }
        else if (total >= 100) {
            tdTotal.style.backgroundColor = "#ffd966";
        }
        else if (total >= 1) {
            tdTotal.style.backgroundColor = "#b6d7a8";
        }

        tr.appendChild(tdTotal);

        // 各会社
        for (const company of companies) {

            const td = document.createElement("td");

            const value = optionMap[price][company] || 0;

            td.textContent = value.toLocaleString();
            td.style.textAlign = "center";
            td.style.fontWeight = "bold";

            if (value >= 3000) {
                td.style.backgroundColor = "#ff4d4d";
            }
            else if (value >= 500) {
                td.style.backgroundColor = "#ff9933";
            }
            else if (value >= 100) {
                td.style.backgroundColor = "#ffd966";
            }
            else if (value >= 1) {
                td.style.backgroundColor = "#b6d7a8";
            }

            if (value === 0) {
                td.style.color = "#cccccc";
            }

            tr.appendChild(td);

        }

        table.appendChild(tr);

    }

}

function showMaxPosition(priceTotals) {

    let maxPrice = "";
    let maxValue = 0;

    for (const price in priceTotals) {

        const value = priceTotals[price];

        if (value > maxValue) {

            maxValue = value;
            maxPrice = price;

        }

    }



const result = document.getElementById("maxPosition");


result.innerHTML = `
    <p><strong>価格帯</strong></p>
    <h2>${Number(maxPrice).toLocaleString()}円</h2>

   
    <p><strong>建玉</strong></p>
    <h2>${maxValue.toLocaleString()}枚</h2>
`;    

}

function showPriceRanking() {

    const ranking = [];

    for (const price in optionMap) {

        let total = 0;

        for (const company in optionMap[price]) {
            total += optionMap[price][company];
        }

        ranking.push({
            price: price,
            total: total

        });

    }

    ranking.sort((a, b) => b.total - a.total);

    const result = document.getElementById("priceRanking");

    result.innerHTML = "";

    for (const item of ranking) {

        result.innerHTML += `
        <p>${Number(item.price).toLocaleString()}円 : ${item.total.toLocaleString()}枚</p>
        `;

    }
}

function createDifferenceData(
    currentLabels,
    currentValues,
    compareLabels,
    compareValues
) {
    const currentMap = new Map();
    const compareMap = new Map();

    currentLabels.forEach((label, index) => {
        const strike = Number(
            String(label).replace(/,/g, "")
        );

        if (!Number.isFinite(strike)) return;

        currentMap.set(
            strike,
            Number(currentValues[index]) || 0
        );
    });

    compareLabels.forEach((label, index) => {
        const strike = Number(
            String(label).replace(/,/g, "")
        );

        if (!Number.isFinite(strike)) return;

        compareMap.set(
            strike,
            Number(compareValues[index]) || 0
        );
    });

    // 今日か比較対象のどちらかにある価格帯をすべて対象にする
    const allStrikes = [
        ...new Set([
            ...currentMap.keys(),
            ...compareMap.keys()
        ])
    ].sort((a, b) => a - b);

    return allStrikes.map(strike => {
        const current =
            currentMap.get(strike) || 0;

        const previous =
            compareMap.get(strike) || 0;

        return {
            strike,
            current,
            previous,
            diff: current - previous
        };
    });
}

function createDiagnosisSentence(reasons, marketLevel) {
    // 文字列とオブジェクトの両方に対応
    const reasonTexts = reasons
        .filter(reason => reason)
        .sort((a, b) => {
            const priorityA =
                typeof a === "object" ? a.priority ?? 0 : 0;

            const priorityB =
                typeof b === "object" ? b.priority ?? 0 : 0;

            return priorityB - priorityA;
        })
        .map(reason => {
            return typeof reason === "object"
                ? reason.text
                : reason;
        })
        .filter(text => typeof text === "string" && text.trim() !== "");

    // 同じ理由が重複した場合は1つにする
    const uniqueReasons = [...new Set(reasonTexts)]
        .slice(0, 3);

    if (uniqueReasons.length === 0) {
        if (marketLevel.includes("強気")) {
            return "強気材料がやや優勢ですが、明確な決め手はまだ確認できません。";
        }

        if (marketLevel.includes("弱気")) {
            return "弱気材料がやや優勢ですが、明確な決め手はまだ確認できません。";
        }

        return "強気材料と弱気材料が拮抗しており、方向感はまだ明確ではありません。";
    }

    // 表示用に少し自然な表現へ整える
    const formattedReasons = uniqueReasons.map(text => {
        return text
            .replace(
                "現在値付近でCALL建玉が増加",
                "現在値付近でのCALL建玉増加"
            )
            .replace(
                "現在値付近でPUT建玉が減少",
                "現在値付近でのPUT建玉減少"
            )
            .replace(
                "現在値付近でPUT建玉が増加",
                "現在値付近でのPUT建玉増加"
            )
            .replace(
                "現在値付近でCALL建玉が減少",
                "現在値付近でのCALL建玉減少"
            )
            .replace(
                "CALL建玉が大きく増加",
                "CALL建玉の大幅な増加"
            )
            .replace(
                "PUT建玉が大きく増加",
                "PUT建玉の大幅な増加"
            )
            .replace(
                "CALL建玉が大きく減少",
                "CALL建玉の大幅な減少"
            )
            .replace(
                "PUT建玉が大きく減少",
                "PUT建玉の大幅な減少"
            )
            .replace(
                "CALL建玉増加",
                "CALL建玉の増加"
            )
            .replace(
                "PUT建玉増加",
                "PUT建玉の増加"
            )
            .replace(
                "CALL建玉減少",
                "CALL建玉の減少"
            )
            .replace(
                "PUT建玉減少",
                "PUT建玉の減少"
            );
    });

    let joinedReasons = "";

    if (formattedReasons.length === 1) {
        joinedReasons = formattedReasons[0];
    }
    else if (formattedReasons.length === 2) {
        joinedReasons =
            `${formattedReasons[0]}と${formattedReasons[1]}`;
    }
    else {
        joinedReasons =
            `${formattedReasons[0]}、${formattedReasons[1]}、` +
            `${formattedReasons[2]}`;
    }

    if (marketLevel.includes("強気")) {
        return `${joinedReasons}が確認され、上方向への意識がやや強まっています。`;
    }

    if (marketLevel.includes("弱気")) {
        return `${joinedReasons}が確認され、下方向への警戒がやや強まっています。`;
    }

    return `${joinedReasons}が確認されていますが、強弱材料が混在しており、方向感はまだ明確ではありません。`;
}

function createAIComment(
    bullishReasons,
    bearishReasons,
    marketLevel,
    futureOpenInterest
) {
    const normalizeReasons = reasons =>
        reasons
            .filter(reason => reason)
            .map(reason => {
                if (typeof reason === "object") {
                    return reason;
                }

                return {
                    text: reason,
                    priority: 0,
                    optionType: "",
                    changeType: "",
                    strike: null,
                    diff: null,
                    distance: null
                };
            });

    const bullishItems =
        normalizeReasons(bullishReasons);

    const bearishItems =
        normalizeReasons(bearishReasons);

    const allItems = [
        ...bullishItems,
        ...bearishItems
    ];

    const weeklyOpenInterestComments = [];

    if (
        futureOpenInterest &&
        futureOpenInterest.brokerTotals
    ) {
        const brokerEntries = Object.entries(
            futureOpenInterest.brokerTotals
        );
    
        const topBuyers = brokerEntries
            .filter(([, values]) => values.buy > 0)
            .sort((a, b) => b[1].buy - a[1].buy)
            .slice(0, 3);
    
        const topSellers = brokerEntries
            .filter(([, values]) => values.sell > 0)
            .sort((a, b) => b[1].sell - a[1].sell)
            .slice(0, 3);

        const topBuyTotal = topBuyers.reduce(
            (sum, [, values]) => sum + values.buy,
                0
            );
            
        const topSellTotal = topSellers.reduce(
            (sum, [, values]) => sum + values.sell,
                0
            );    
    
        if (topBuyers.length > 0) {
            const buyerText = topBuyers
                .map(
                    ([broker, values]) =>
                        `${broker} ${values.buy.toLocaleString()}枚`
                )
                .join("、");
    
        }
    
        if (topSellers.length > 0) {
            const sellerText = topSellers
                .map(
                    ([broker, values]) =>
                        `${broker} ${values.sell.toLocaleString()}枚`
                )
                .join("、");

        }
    
        const totalBuy = brokerEntries.reduce(
            (sum, [, values]) => sum + (values.buy || 0),
            0
        );
        
        const totalSell = brokerEntries.reduce(
            (sum, [, values]) => sum + (values.sell || 0),
            0
        );

        const leadingBuyer =
            topBuyers.length > 0
                ? topBuyers[0]
                : null;

        const leadingSeller =
            topSellers.length > 0
                ? topSellers[0]
                : null;
        
        const balanceDifference = totalBuy - totalSell;

        const topDifference =
            topBuyTotal - topSellTotal;
        
        let weeklyInterpretation = "";

        let leaderComment = "";

        if (leadingBuyer && topBuyers.length >= 2) {
            const buyerName =
                leadingBuyer[0];

            const secondBuyerName =
                topBuyers[1][0];

            const buyerAmount =
                leadingBuyer[1].buy;

            const secondBuyerAmount =
                topBuyers[1][1].buy;

            const buyerLead =
                buyerAmount - secondBuyerAmount;

        if (buyerLead >= 5000) {
            leaderComment =
    `・注目機関：${buyerName}が買いトップで、2位の${secondBuyerName}を${buyerLead.toLocaleString()}枚上回っています。`;
    }
        else {
            leaderComment =
               "・注目機関：買い上位は複数社に分散しており、特定の1社だけが突出している状態ではありません。";
    }
}
        
if (
    topDifference > 5000 &&
    balanceDifference > 10000
) {
    weeklyInterpretation =
        "・勢力図：買い建玉を多く保有する主要証券会社が目立ち、市場全体でも買い建玉が優勢です。比較的買いポジションが集まっています。";
}
else if (
    topDifference > 5000 &&
    balanceDifference < -10000
) {
    weeklyInterpretation =
        "・勢力図：主要証券会社では買い姿勢が目立つ一方、市場全体では売り姿勢が優勢となっており、市場参加者の見方が分かれています。";
}
else if (
    topDifference < -5000 &&
    balanceDifference > 10000
) {
    weeklyInterpretation =
        "・勢力図：売り建玉を多く保有する主要証券会社が目立つ一方、市場全体では買い建玉が優勢です。参加者全体のポジションには違いが見られます。";
}
else if (
    topDifference < -5000 &&
    balanceDifference < -10000
) {
    weeklyInterpretation =
        "・勢力図：売り建玉を多く保有する主要証券会社が目立ち、市場全体でも売り建玉が優勢です。比較的売りポジションが集まっています。";
}
else if (
    Math.abs(topDifference) <= 5000 &&
    Math.abs(balanceDifference) <= 10000
) {
    weeklyInterpretation =
        "・勢力図：買い建玉と売り建玉のバランスが比較的均衡しており、明確な偏りは見られません。";
}
else {
    weeklyInterpretation =
        "・勢力図：主要証券会社と市場全体では建玉の傾向に違いが見られ、参加者の見方はまだ一致していません。";
}
        
        if (leaderComment) {
            weeklyOpenInterestComments.push(
                leaderComment
            );
        }

        weeklyOpenInterestComments.push(
            weeklyInterpretation
        );
    
    }

    const findReason = (
        optionType,
        changeType
    ) =>
        allItems
            .filter(reason =>
                reason.optionType === optionType &&
                reason.changeType === changeType
            )
            .sort((a, b) => {
                const priorityDifference =
                    (b.priority ?? 0) -
                    (a.priority ?? 0);

                if (priorityDifference !== 0) {
                    return priorityDifference;
                }

                return (
                    Math.abs(b.diff ?? 0) -
                    Math.abs(a.diff ?? 0)
                );
            })[0] || null;

    const callIncrease =
        findReason("CALL", "increase");

    const callDecrease =
        findReason("CALL", "decrease");

    const putIncrease =
        findReason("PUT", "increase");

    const putDecrease =
        findReason("PUT", "decrease");

    const formatReason = reason => {
        if (
            !reason ||
            !Number.isFinite(reason.strike) ||
            !Number.isFinite(reason.diff)
        ) {
            return "";
        }

        const changeText =
            reason.changeType === "increase"
                ? "増加"
                : "減少";

        const absoluteDifference =
            Math.abs(reason.diff);

        let distanceText = "";

        if (Number.isFinite(reason.distance)) {
            if (reason.distance <= 250) {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円と非常に近い位置です`;
            }
            else if (reason.distance <= 500) {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円と近い位置です`;
            }
            else {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円離れています`;
            }
        }

        return (
            `${reason.strike.toLocaleString()}円` +
            `${reason.optionType}では` +
            `${absoluteDifference.toLocaleString()}枚の建玉${changeText}が確認され、` +
            distanceText
        );
    };

    const sentences = [];

    if (callIncrease && putDecrease) {
        sentences.push(
            `${formatReason(callIncrease)}。`
        );

        sentences.push(
            `${formatReason(putDecrease)}。`
        );

        sentences.push(
            "CALL増加とPUT減少が重なっており、上方向を意識した建玉変化です。"
        );
    }
    else if (callDecrease && putIncrease) {
        sentences.push(
            `${formatReason(callDecrease)}。`
        );

        sentences.push(
            `${formatReason(putIncrease)}。`
        );

        sentences.push(
            "CALL減少とPUT増加が重なっており、下方向への警戒を示す建玉変化です。"
        );
    }
    else if (callIncrease && putIncrease) {
        sentences.push(
            `${formatReason(callIncrease)}。`
        );

        sentences.push(
            `${formatReason(putIncrease)}。`
        );

        sentences.push(
            "CALL・PUTともに増加しているため、市場参加者の見方が分かれています。"
        );
    }
    else if (callDecrease && putDecrease) {
        sentences.push(
            `${formatReason(callDecrease)}。`
        );

        sentences.push(
            `${formatReason(putDecrease)}。`
        );

        sentences.push(
            "CALL・PUTともに減少しており、ポジション整理が進んでいる可能性があります。"
        );
    }
    else {
        const strongestReason =
            [...allItems]
                .filter(reason =>
                    Number.isFinite(reason.strike) &&
                    Number.isFinite(reason.diff)
                )
                .sort((a, b) =>
                    Math.abs(b.diff) -
                    Math.abs(a.diff)
                )[0];

        if (strongestReason) {
            sentences.push(
                `${formatReason(strongestReason)}。`
            );
        }

        sentences.push(
            "建玉には変化が見られますが、明確な方向性を示す組み合わせではありません。"
        );
    }

    if (marketLevel === "強気") {
        sentences.push(
            "複数の強気材料が重なっているため、現時点では強気と判断します。"
        );
    }
    else if (marketLevel === "やや強気") {
        sentences.push(
            "ただし決定的な偏りではないため、現時点ではやや強気と判断します。"
        );
    }
    else if (marketLevel === "弱気") {
        sentences.push(
            "複数の弱気材料が重なっているため、現時点では弱気と判断します。"
        );
    }
    else if (marketLevel === "やや弱気") {
        sentences.push(
            "ただし決定的な偏りではないため、現時点ではやや弱気と判断します。"
        );
    }
    else {
        sentences.push(
            "強気材料と弱気材料が混在しているため、現時点では中立と判断します。"
        );
    }

    const weeklyCommentText =
    weeklyOpenInterestComments.length > 0
        ? `\n\n【週次指数先物建玉】\n${weeklyOpenInterestComments.join("\n")}`
        : "";

return (
    sentences
        .filter(sentence => sentence)
        .join("") +
    weeklyCommentText
);
}

function calculateOptionMarketJudgment({
    nearbyCallIncrease,
    nearbyCallDecrease,
    nearbyPutIncrease,
    nearbyPutDecrease,
    currentPrice
}) {
    const numericCurrentPrice = Number(currentPrice) || 0;
    let marketLevel = "中立";
    let confidenceScore = 1;
    let marketIcon = "🟡";
    let bullishScore = 0;
    let bearishScore = 0;
    const bullishReasons = [];
    const bearishReasons = [];

    const addDistanceScore = item => {
        if (!item) return 0;

        const distance =
            Math.abs(item.strike - numericCurrentPrice);

        if (distance <= 100) return 2;
        if (distance <= 300) return 1;

        return 0;
    };

    if (nearbyCallIncrease?.diff > 1000) {
        bullishScore += 2;
        bullishReasons.push({
            text: "CALL建玉が大きく増加",
            priority: 4,
            optionType: "CALL",
            changeType: "increase",
            strike: nearbyCallIncrease.strike,
            diff: nearbyCallIncrease.diff,
            distance: Math.abs(
                nearbyCallIncrease.strike - numericCurrentPrice
            )
        });
    } else if (nearbyCallIncrease?.diff > 500) {
        bullishScore += 1;
        bullishReasons.push({
            text: "CALL建玉増加",
            priority: 3,
            optionType: "CALL",
            changeType: "increase",
            strike: nearbyCallIncrease.strike,
            diff: nearbyCallIncrease.diff,
            distance: Math.abs(
                nearbyCallIncrease.strike - numericCurrentPrice
            )
        });
    }

    if (nearbyCallIncrease?.diff > 500) {
        const callDistanceScore =
            addDistanceScore(nearbyCallIncrease);

        bullishScore += callDistanceScore;

        if (callDistanceScore > 0) {
            bullishReasons.push({
                text: "現在値付近でCALL建玉増加",
                priority: 5,
                optionType: "CALL",
                changeType: "increase",
                strike: nearbyCallIncrease.strike,
                diff: nearbyCallIncrease.diff,
                distance: Math.abs(
                    nearbyCallIncrease.strike - numericCurrentPrice
                )
            });
        }
    }

    if (nearbyPutDecrease?.diff < -1000) {
        bullishScore += 2;
        bullishReasons.push({
            text: "PUT建玉が大きく減少",
            priority: 4,
            optionType: "PUT",
            changeType: "decrease",
            strike: nearbyPutDecrease.strike,
            diff: nearbyPutDecrease.diff,
            distance: Math.abs(
                nearbyPutDecrease.strike - numericCurrentPrice
            )
        });
    } else if (nearbyPutDecrease?.diff < 0) {
        bullishScore += 1;
        bullishReasons.push({
            text: "PUT建玉が減少",
            priority: 3,
            optionType: "PUT",
            changeType: "decrease",
            strike: nearbyPutDecrease.strike,
            diff: nearbyPutDecrease.diff,
            distance: Math.abs(
                nearbyPutDecrease.strike - numericCurrentPrice
            )
        });
    }

    if (nearbyPutDecrease?.diff < 0) {
        const putDecreaseDistanceScore =
            addDistanceScore(nearbyPutDecrease);

        bullishScore += putDecreaseDistanceScore;

        if (putDecreaseDistanceScore > 0) {
            bullishReasons.push({
                text: "現在値付近でPUT建玉が減少",
                priority: 5,
                optionType: "PUT",
                changeType: "decrease",
                strike: nearbyPutDecrease.strike,
                diff: nearbyPutDecrease.diff,
                distance: Math.abs(
                    nearbyPutDecrease.strike - numericCurrentPrice
                )
            });
        }
    }

    if (nearbyPutIncrease?.diff > 1000) {
        bearishScore += 2;
        bearishReasons.push({
            text: "PUT建玉が大きく増加",
            priority: 4,
            optionType: "PUT",
            changeType: "increase",
            strike: nearbyPutIncrease.strike,
            diff: nearbyPutIncrease.diff,
            distance: Math.abs(
                nearbyPutIncrease.strike - numericCurrentPrice
            )
        });
    } else if (nearbyPutIncrease?.diff > 500) {
        bearishScore += 1;
        bearishReasons.push({
            text: "PUT建玉増加",
            priority: 3,
            optionType: "PUT",
            changeType: "increase",
            strike: nearbyPutIncrease.strike,
            diff: nearbyPutIncrease.diff,
            distance: Math.abs(
                nearbyPutIncrease.strike - numericCurrentPrice
            )
        });
    }

    if (nearbyPutIncrease?.diff > 500) {
        const putIncreaseDistanceScore =
            addDistanceScore(nearbyPutIncrease);

        bearishScore += putIncreaseDistanceScore;

        if (putIncreaseDistanceScore > 0) {
            bearishReasons.push({
                text: "現在値付近でPUT建玉が増加",
                priority: 5,
                optionType: "PUT",
                changeType: "increase",
                strike: nearbyPutIncrease.strike,
                diff: nearbyPutIncrease.diff,
                distance: Math.abs(
                    nearbyPutIncrease.strike - numericCurrentPrice
                )
            });
        }
    }

    if (nearbyCallDecrease?.diff < -1000) {
        bearishScore += 2;
        bearishReasons.push({
            text: "CALL建玉が大きく減少",
            priority: 4,
            optionType: "CALL",
            changeType: "decrease",
            strike: nearbyCallDecrease.strike,
            diff: nearbyCallDecrease.diff,
            distance: Math.abs(
                nearbyCallDecrease.strike - numericCurrentPrice
            )
        });
    } else if (nearbyCallDecrease?.diff < 0) {
        bearishScore += 1;
        bearishReasons.push({
            text: "CALL建玉減少",
            priority: 3,
            optionType: "CALL",
            changeType: "decrease",
            strike: nearbyCallDecrease.strike,
            diff: nearbyCallDecrease.diff,
            distance: Math.abs(
                nearbyCallDecrease.strike - numericCurrentPrice
            )
        });
    }

    if (nearbyCallDecrease?.diff < 0) {
        const callDecreaseDistanceScore =
            addDistanceScore(nearbyCallDecrease);

        bearishScore += callDecreaseDistanceScore;

        if (callDecreaseDistanceScore > 0) {
            bearishReasons.push({
                text: "現在値付近でCALL建玉が減少",
                priority: 5,
                optionType: "CALL",
                changeType: "decrease",
                strike: nearbyCallDecrease.strike,
                diff: nearbyCallDecrease.diff,
                distance: Math.abs(
                    nearbyCallDecrease.strike - numericCurrentPrice
                )
            });
        }
    }

    let diagnosisReason =
        "CALL・PUTの勢力が拮抗しています。";
    let marketAdvice =
        "• 方向感が出るまで、建玉の変化を観察しましょう。";

    if (
        nearbyCallIncrease?.diff > 1000 &&
        nearbyPutDecrease?.diff < -1000
    ) {
        marketLevel = "強気";
        marketIcon = "🟢";
        diagnosisReason =
            "CALL増加とPUT減少が同時に確認され、上方向への期待が強まっています。";
        marketAdvice =
            "• 押し目を探しながら、上値での建玉変化にも注目しましょう。";
    } else if (
        nearbyPutIncrease?.diff > 1000 &&
        nearbyCallDecrease?.diff < -1000
    ) {
        marketLevel = "弱気";
        marketIcon = "🔴";
        diagnosisReason =
            "PUT増加とCALL減少が同時に確認され、下方向への警戒が強まっています。";
        marketAdvice =
            "• 戻り売りが入りやすい場面か確認しながら、下値支持を見極めましょう。";
    } else if (
        nearbyCallIncrease?.diff > 500 &&
        nearbyPutDecrease?.diff < 0
    ) {
        marketLevel = "中立";
        marketIcon = "🟡";
        diagnosisReason =
            "強い上昇シグナルには届いていませんが、CALL増加とPUT減少が見られ、やや強気寄りです。";
        marketAdvice =
            "• 上方向への変化が続くか、次の建玉更新を確認しましょう。";
    } else if (
        nearbyPutIncrease?.diff > 500 &&
        nearbyCallDecrease?.diff < 0
    ) {
        marketLevel = "中立";
        marketIcon = "🟡";
        diagnosisReason =
            "強い下落シグナルには届いていませんが、PUT増加とCALL減少が見られ、やや弱気寄りです。";
        marketAdvice =
            "• 下方向への変化が続くか、次の建玉更新を確認しましょう。";
    }

    const scoreDifference = bullishScore - bearishScore;

    const topBullishReasons = bullishReasons
        .filter(reason => reason && typeof reason === "object")
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 3)
        .map(reason => reason.text);

    const topBearishReasons = bearishReasons
        .filter(reason => reason && typeof reason === "object")
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 3)
        .map(reason => reason.text);

    if (scoreDifference >= 5) {
        marketLevel = "強気";
        marketIcon = "🟢";
        diagnosisReason =
            topBullishReasons.length > 0
                ? topBullishReasons.join("・")
                : `強気材料が弱気材料を${scoreDifference}点上回っています。`;
        marketAdvice =
            "• 押し目を探しながら、上方向への変化が続くか確認しましょう。";
    } else if (scoreDifference >= 2) {
        marketLevel = "やや強気";
        marketIcon = "🟢";
        diagnosisReason =
            topBullishReasons.length > 0
                ? topBullishReasons.join("・")
                : `強気材料がやや優勢です。（+${scoreDifference}点）`;
        marketAdvice =
            "• 上方向への変化が続くか、次の建玉更新を確認しましょう。";
    } else if (scoreDifference <= -5) {
        marketLevel = "弱気";
        marketIcon = "🔴";
        diagnosisReason =
            topBearishReasons.length > 0
                ? topBearishReasons.join("・")
                : `弱気材料が強気材料を${Math.abs(scoreDifference)}点上回っています。`;
        marketAdvice =
            "• 戻り売りが入りやすい場面か確認しながら、下値支持を見極めましょう。";
    } else if (scoreDifference <= -2) {
        marketLevel = "やや弱気";
        marketIcon = "🔴";
        diagnosisReason =
            topBearishReasons.length > 0
                ? topBearishReasons.join("・")
                : `弱気材料がやや優勢です。（${scoreDifference}点）`;
        marketAdvice =
            "• 下方向への変化が続くか、次の建玉更新を確認しましょう。";
    } else {
        marketLevel = "中立";
        marketIcon = "🟡";
        diagnosisReason =
            "強気・弱気材料がほぼ拮抗しています。";
        marketAdvice =
            "• 方向感が出るまで、建玉の変化を観察しましょう。";
    }

    let selectedDiagnosisReasons = [];

    if (marketLevel.includes("強気")) {
        selectedDiagnosisReasons = bullishReasons;
    } else if (marketLevel.includes("弱気")) {
        selectedDiagnosisReasons = bearishReasons;
    } else {
        selectedDiagnosisReasons = [
            ...bullishReasons,
            ...bearishReasons
        ];
    }

    diagnosisReason = createDiagnosisSentence(
        selectedDiagnosisReasons,
        marketLevel
    );

    const sameStrikeCandidate =
        nearbyCallIncrease?.strike != null &&
        nearbyPutIncrease?.strike != null &&
        nearbyCallIncrease.strike === nearbyPutIncrease.strike
            ? nearbyCallIncrease.strike
            : null;

    const confidenceCandidates = [
        nearbyCallIncrease,
        nearbyCallDecrease,
        nearbyPutIncrease,
        nearbyPutDecrease
    ].filter(item => item?.strike != null);

    const strongestDifference =
        confidenceCandidates.length > 0
            ? Math.max(
                ...confidenceCandidates.map(
                    item => Math.abs(item.diff ?? 0)
                )
            )
            : 0;

    const nearestDistance =
        confidenceCandidates.length > 0
            ? Math.min(
                ...confidenceCandidates.map(
                    item => Math.abs(
                        item.strike - numericCurrentPrice
                    )
                )
            )
            : Infinity;

    if (marketLevel !== "中立") {
        confidenceScore += 1;
    }

    if (sameStrikeCandidate != null) {
        confidenceScore += 1;
    }

    if (strongestDifference >= 1000) {
        confidenceScore += 1;
    }

    if (nearestDistance <= 500) {
        confidenceScore += 1;
    }

    confidenceScore = Math.min(5, confidenceScore);

    const confidence =
        "★".repeat(confidenceScore) +
        "☆".repeat(5 - confidenceScore);

    let confidenceReason = "";

    if (confidenceScore >= 5) {
        confidenceReason =
            "複数の重要シグナルが一致し、高い信頼性があります。";
    } else if (confidenceScore === 4) {
        confidenceReason =
            "複数の条件が揃い、信頼性は高めです。";
    } else if (confidenceScore === 3) {
        confidenceReason =
            "いくつかの条件が揃っていますが、慎重な判断も必要です。";
    } else if (confidenceScore === 2) {
        confidenceReason =
            "根拠はありますが、まだ方向感は十分ではありません。";
    } else {
        confidenceReason =
            "判断材料が少なく、様子見が無難です。";
    }

    return {
        available: confidenceCandidates.length > 0,
        bullishScore,
        bearishScore,
        scoreDifference,
        marketLevel,
        confidenceScore,
        reasons: {
            bullish: bullishReasons,
            bearish: bearishReasons,
            selected: selectedDiagnosisReasons
        },
        bullishReasons,
        bearishReasons,
        diagnosisReason,
        marketAdvice,
        marketIcon,
        confidence,
        confidenceReason,
        sameStrikeCandidate
    };
}

function renderDifferenceRankings(
    callDifferenceData,
    putDifferenceData
) {
    const callIncrease = [...callDifferenceData]
        .filter(item => item.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 3);

    const callDecrease = [...callDifferenceData]
        .filter(item => item.diff < 0)
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 3);

    const putIncrease = [...putDifferenceData]
        .filter(item => item.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 3);

    const putDecrease = [...putDifferenceData]
        .filter(item => item.diff < 0)
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 3);

    function renderList(elementId, items) {
        const element =
            document.getElementById(elementId);

        if (!element) return;

        if (items.length === 0) {
            element.textContent =
                "該当する変化はありません";
            return;
        }

        element.innerHTML = items
            .map((item, index) => {
                const sign =
                    item.diff > 0 ? "+" : "";

                return `
                    <div class="difference-row">
                        <span>
                            ${index + 1}位　
                            ${item.strike.toLocaleString()}円
                        </span>

                        <strong class="${
                            item.diff > 0
                                ? "difference-up"
                                : "difference-down"
                        }">
                            ${sign}${item.diff.toLocaleString()}枚
                        </strong>
                    </div>
                `;
            })
            .join("");
    }

    renderList(
        "callIncreaseResult",
        callIncrease
    );

    renderList(
        "callDecreaseResult",
        callDecrease
    );

    renderList(
        "putIncreaseResult",
        putIncrease
    );

    renderList(
        "putDecreaseResult",
        putDecrease
    );

    // 現在値から±1,000円以内を対象にする
const focusRange = 1000;
const numericCurrentPrice = Number(currentPrice) || 0;

const nearbyCallIncrease = callDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff > 0
    )
    .sort((a, b) => b.diff - a.diff)[0] || null;

const nearbyCallDecrease = callDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff < 0
    )
    .sort((a, b) => a.diff - b.diff)[0] || null;

const nearbyPutIncrease = putDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff > 0
    )
    .sort((a, b) => b.diff - a.diff)[0] || null;

const nearbyPutDecrease = putDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff < 0
    )
    .sort((a, b) => a.diff - b.diff)[0] || null;


// 注目変化をカードへ表示する
function renderNearbyItem(elementId, item) {
    const element =
        document.getElementById(elementId);

    if (!element) return;

    const card =
        element.closest(".difference-summary-item");

    // 前回付けた距離クラスをいったん外す
    if (card) {
        card.classList.remove(
            "nearby-close",
            "nearby-middle",
            "nearby-far"
        );
    }

    if (!item) {
        element.textContent =
            "±1,000円以内に該当する変化はありません";
        return;
    }

    const differenceFromPrice =
        item.strike - numericCurrentPrice;

    const absoluteDistance =
        Math.abs(differenceFromPrice);

        let attentionLevel = 2;

        if (absoluteDistance <= 250) {
            attentionLevel = 5;
        } else if (absoluteDistance <= 500) {
            attentionLevel = 4;
        } else if (absoluteDistance <= 750) {
            attentionLevel = 3;
        }
        
        const attentionStars =
            "★".repeat(attentionLevel) +
            "☆".repeat(5 - attentionLevel);
        
        const distanceArrow =
            differenceFromPrice > 0
                ? "⬆"
                : differenceFromPrice < 0
                    ? "⬇"
                    : "●";

    // 現在値との距離でカードを色分け
    if (card) {
        if (absoluteDistance <= 250) {
            card.classList.add("nearby-close");
        } else if (absoluteDistance <= 500) {
            card.classList.add("nearby-middle");
        } else {
            card.classList.add("nearby-far");
        }
    }

    const diffSign =
        item.diff > 0 ? "+" : "";

    const distanceSign =
        differenceFromPrice > 0 ? "+" : "";

        element.innerHTML = `
        <div class="nearby-card-header">
            <span class="nearby-attention">
                ${attentionStars}
            </span>
        </div>
    
        <span class="nearby-strike">
            ${item.strike.toLocaleString()}円
        </span>
    
        <strong class="${
            item.diff > 0
                ? "difference-up"
                : "difference-down"
        }">
            ${diffSign}${item.diff.toLocaleString()}枚
        </strong>
    
        <small class="nearby-distance">
            現在値より
            <span class="nearby-arrow">
                ${distanceArrow}
            </span>
            ${absoluteDistance.toLocaleString()}円
        </small>
    `;
}

renderNearbyItem(
    "maxCallIncrease",
    nearbyCallIncrease
);

renderNearbyItem(
    "maxCallDecrease",
    nearbyCallDecrease
);

renderNearbyItem(
    "maxPutIncrease",
    nearbyPutIncrease
);

renderNearbyItem(
    "maxPutDecrease",
    nearbyPutDecrease
);

// 現在値に近い順でカードを並び替える
const nearbyCards = [
    {
        elementId: "maxCallIncrease",
        item: nearbyCallIncrease
    },
    {
        elementId: "maxCallDecrease",
        item: nearbyCallDecrease
    },
    {
        elementId: "maxPutIncrease",
        item: nearbyPutIncrease
    },
    {
        elementId: "maxPutDecrease",
        item: nearbyPutDecrease
    }
];

nearbyCards.sort((a, b) => {
    const distanceA = a.item
        ? Math.abs(
            a.item.strike - numericCurrentPrice
        )
        : Infinity;

    const distanceB = b.item
        ? Math.abs(
            b.item.strike - numericCurrentPrice
        )
        : Infinity;

    return distanceA - distanceB;
});

const summaryGrid =
    document.querySelector(
        ".difference-summary-grid"
    );

if (summaryGrid) {
    nearbyCards.forEach(cardData => {
        const contentElement =
            document.getElementById(
                cardData.elementId
            );

        const card =
            contentElement?.closest(
                ".difference-summary-item"
            );

        if (card) {
            summaryGrid.appendChild(card);
        }
    });
}

console.log(
    "現在値付近CALL増加:",
    nearbyCallIncrease
);

console.log(
    "現在値付近CALL減少:",
    nearbyCallDecrease
);

console.log(
    "現在値付近PUT増加:",
    nearbyPutIncrease
);

console.log(
    "現在値付近PUT減少:",
    nearbyPutDecrease
);

const optionMarketJudgment =
    calculateOptionMarketJudgment({
        nearbyCallIncrease,
        nearbyCallDecrease,
        nearbyPutIncrease,
        nearbyPutDecrease,
        currentPrice: numericCurrentPrice
    });

optionMapJudgmentState.option = {
    available: optionMarketJudgment.available === true,
    judgment: optionMarketJudgment.available === true
        ? optionMarketJudgment
        : null,
    metadata: {
        comparisonSourceDate:
            comparisonSnapshot?.sourceDate || null,
        currentSourceDate:
            getCurrentQriOpenInterestSourceDate(),
        currentOpenInterestSourceDate:
            getCurrentQriOpenInterestSourceDate(),
        currentOpenInterestSourceDateKind:
            qriOpenInterestDataState.sourceDateKind,
        openInterestOrigin:
            qriOpenInterestDataState.origin,
        usingFallback:
            qriOpenInterestDataState.usingFallback === true,
        qriPageSourceDate:
            lastJpxFetchedAt instanceof Date &&
            !Number.isNaN(lastJpxFetchedAt.getTime())
                ? lastJpxFetchedAt.toISOString()
                : null,
        currentPrice: numericCurrentPrice
    }
};

renderOptionMapOverallJudgment();
safeRenderOptionMapOverallJudgmentV2();

const {
    bullishScore,
    bearishScore,
    scoreDifference,
    marketLevel,
    confidenceScore,
    bullishReasons,
    bearishReasons,
    diagnosisReason,
    marketAdvice,
    marketIcon,
    confidence,
    confidenceReason,
    sameStrikeCandidate
} = optionMarketJudgment;

console.log("強気スコア:", bullishScore);
console.log("弱気スコア:", bearishScore);
const aiComment = createAIComment(
    bullishReasons,
    bearishReasons,
    marketLevel,
    latestFutureOpenInterestResult
);

const summary = [];

let badgeClass = "neutral";

if (marketLevel === "強気") {
    badgeClass = "strong";
}
else if (marketLevel === "弱気") {
    badgeClass = "weak";
}

summary.unshift(
    `<span class="market-badge ${badgeClass}">
        ${marketIcon} 市場診断：${marketLevel}
     </span>`
);
summary.splice(
    1,
    0,
    `　理由：${diagnosisReason}`
);

summary.splice(
    2,
    0,
    `<span class="ai-comment">AIコメント：${aiComment}</span>`
);


const diagnosisHtml = `
<div class="market-diagnosis ${marketLevel}">
    <div class="title">${marketIcon} 市場診断</div>
    <div class="level">${marketLevel}</div>
</div>
`;

       // 星を計算したあとで表示に追加

         summary.splice( 
             2,
             0,
             `<span class="confidence-badge">⭐ 信頼度：${confidence}</span>`
);     
         summary.splice(
             3,
             0,
             `　理由：${confidenceReason}`
);
        summary.splice(
             4,
             0,
             `<span class="point-badge">💡 注目ポイント</span>`
);

         summary.splice(
             5,
             0,
);

         summary.splice(
             6,
             0,
             `${marketAdvice}`
);    




if (sameStrikeCandidate != null) {
    summary.push(
        `• CALL・PUTともに ${sameStrikeCandidate.toLocaleString()}円で建玉増加が確認されています。`
    );
    summary.push(
        `• ${sameStrikeCandidate.toLocaleString()}円付近が重要価格帯として意識されている可能性があります。`
    );
}

if (
    sameStrikeCandidate == null &&
    nearbyCallIncrease?.strike != null
) {
    summary.push(
        `• 現在値付近では ${nearbyCallIncrease.strike.toLocaleString()}円CALLの建玉増加が目立ちます。`
    );
}
if (nearbyPutDecrease?.strike != null) {
    summary.push(
        `• ${nearbyPutDecrease.strike.toLocaleString()}円PUTでは建玉減少が確認されています。`
    );
}

const nearbyCandidates = [
    nearbyCallIncrease,
    nearbyCallDecrease,
    nearbyPutIncrease,
    nearbyPutDecrease
].filter(item => item?.strike != null);

if (nearbyCandidates.length > 0) {
    const nearestItem = nearbyCandidates
        .slice()
        .sort(
            (a, b) =>
                Math.abs(a.strike - numericCurrentPrice) -
                Math.abs(b.strike - numericCurrentPrice)
        )[0];

        summary.push(
            `• 現在値に最も近い注目価格帯は ${nearestItem.strike.toLocaleString()}円です。`
        );
}

const marketSummaryElement =
    document.getElementById("marketSummary");

if (marketSummaryElement) {
    marketSummaryElement.innerHTML =
        summary.length > 0
            ? summary.join("<br>")
            : "現在値付近に該当する変化はありません。";
}
}


// 初期表示
renderSavedSnapshots();
