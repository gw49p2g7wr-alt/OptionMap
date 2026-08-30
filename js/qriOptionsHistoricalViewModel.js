"use strict";

const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
const VERSION_KEY_PATTERN = /^qri-options-v2\|20\d{2}-(0[1-9]|1[0-2])\|.+\|sha256:[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}

function validDate(value) {
    if (!DATE_PATTERN.test(value || "")) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function result(status, reason, details = {}) {
    return deepFreeze({
        status,
        reason,
        available: status === "available",
        contracts: [],
        dates: [],
        selection: null,
        snapshot: null,
        chartData: null,
        metadata: null,
        notices: { isHistorical: true, isCurrent: false, savedSnapshot: true },
        ...clone(details)
    });
}

function validHistoryHeader(history) {
    return history && typeof history === "object" && Array.isArray(history.entries) &&
        history.historyVersion === 1 && history.parserVersion === 2 &&
        history.schemaVersion === 2 && history.source === "qri-nikkei225-options" &&
        history.signatureAlgorithm === "sha256";
}

function contractList(history) {
    const contracts = new Set();
    for (const entry of history.entries) {
        if (!entry || !CONTRACT_PATTERN.test(entry.contract || "")) return null;
        contracts.add(entry.contract);
    }
    return [...contracts].sort((a, b) => b.localeCompare(a));
}

function dateList(history, contract) {
    const dates = new Set();
    for (const entry of history.entries.filter(item => item?.contract === contract)) {
        if (!validDate(entry.sourceDateKey)) return null;
        dates.add(entry.sourceDateKey);
    }
    return [...dates].sort((a, b) => b.localeCompare(a));
}

function validTimestamp(value) {
    return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function normalizeRecords(records, contract) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const byStrike = new Map();
    for (const record of records) {
        if (!record || record.contract !== contract || !["call", "put"].includes(record.optionType) ||
            !Number.isFinite(record.strike) || record.strike <= 0 ||
            typeof record.published !== "boolean" ||
            (record.published
                ? !Number.isSafeInteger(record.value) || record.value < 0
                : record.value !== null)) return null;
        const pair = byStrike.get(record.strike) || {};
        if (pair[record.optionType]) return null;
        pair[record.optionType] = {
            published: record.published,
            value: record.published ? record.value : null
        };
        byStrike.set(record.strike, pair);
    }
    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    if (strikes.some(strike => !byStrike.get(strike).call || !byStrike.get(strike).put)) return null;
    const points = strikes.map(strike => ({ strike, ...byStrike.get(strike) }));
    return {
        series: { call: "call", put: "put" },
        strikes,
        callOpenInterest: points.map(point => point.call.value),
        putOpenInterest: points.map(point => point.put.value),
        publishedByStrike: points.map(point => ({
            strike: point.strike,
            call: point.call.published,
            put: point.put.published
        })),
        points
    };
}

function validSelectedRevision(revision, entry) {
    const canonical = revision?.canonical;
    return revision && typeof revision === "object" &&
        revision.contract === entry.contract && revision.tradingDate === entry.sourceDateKey &&
        VERSION_KEY_PATTERN.test(revision.versionKey || "") &&
        SIGNATURE_PATTERN.test(revision.signature || "") &&
        revision.signatureAlgorithm === "sha256" &&
        validTimestamp(revision.fetchedAt) && validTimestamp(revision.confirmedAt) &&
        revision.replacedAt === null && canonical && typeof canonical === "object" &&
        canonical.contract === entry.contract && canonical.tradingDate === entry.sourceDateKey &&
        canonical.parserVersion === 2 && canonical.schemaVersion === 2 &&
        canonical.source === "qri-nikkei225-options" &&
        canonical.pageUpdatedAt === revision.pageUpdatedAt &&
        canonical.sourceUrl === revision.sourceUrl &&
        canonical.openInterestStatus === revision.openInterestStatus;
}

function buildQriHistoricalViewModel({
    history,
    selectedContract = null,
    selectedTradingDate = null
} = {}) {
    if (history == null) return result("empty", "no_history");
    if (!validHistoryHeader(history)) return result("invalid", "snapshot_invalid");
    if (history.entries.length === 0) return result("empty", "no_history");

    const contracts = contractList(history);
    if (!contracts) return result("invalid", "snapshot_invalid");
    if (contracts.length === 0) return result("empty", "no_contracts");

    const contractExplicit = selectedContract !== null && selectedContract !== undefined;
    const contract = contractExplicit ? selectedContract : contracts[0];
    if (!CONTRACT_PATTERN.test(contract || "") || !contracts.includes(contract)) {
        return result("unavailable", "selection_not_found", { contracts });
    }

    const dates = dateList(history, contract);
    if (!dates) return result("invalid", "snapshot_invalid", { contracts });
    if (dates.length === 0) return result("unavailable", "no_dates", { contracts });

    const dateExplicit = selectedTradingDate !== null && selectedTradingDate !== undefined;
    const tradingDate = dateExplicit ? selectedTradingDate : dates[0];
    if (!validDate(tradingDate) || !dates.includes(tradingDate)) {
        return result("unavailable", "selection_not_found", { contracts, dates });
    }

    const entries = history.entries.filter(entry => entry.contract === contract &&
        entry.sourceDateKey === tradingDate);
    if (entries.length !== 1) {
        return result("invalid", "snapshot_invalid", { contracts, dates });
    }
    const entry = entries[0];
    if (entry.entryKey !== `${contract}|${tradingDate}` ||
        typeof entry.activeVersionKey !== "string" || entry.activeVersionKey.length === 0 ||
        !Array.isArray(entry.revisions)) {
        return result("invalid", "active_revision_missing", { contracts, dates });
    }
    const active = entry.revisions.filter(revision =>
        revision?.versionKey === entry.activeVersionKey);
    if (active.length === 0) {
        return result("invalid", "active_revision_missing", { contracts, dates });
    }
    if (active.length !== 1) {
        return result("invalid", "active_revision_ambiguous", { contracts, dates });
    }
    const revision = active[0];
    if (!validSelectedRevision(revision, entry)) {
        return result("invalid", "snapshot_invalid", { contracts, dates });
    }
    if (revision.openInterestStatus !== "available") {
        return result("unavailable", "oi_unavailable", { contracts, dates });
    }
    const chartData = normalizeRecords(revision.canonical.records, contract);
    if (!chartData) {
        return result("unavailable", "records_unavailable", { contracts, dates });
    }

    const identity = {
        contract,
        tradingDate,
        entryKey: entry.entryKey,
        activeVersionKey: entry.activeVersionKey
    };
    const signatureShort = revision.signature.length > 12
        ? `${revision.signature.slice(0, 12)}…` : revision.signature;
    const metadata = {
        contract,
        tradingDate,
        pageUpdatedAt: revision.pageUpdatedAt,
        fetchedAt: revision.fetchedAt,
        confirmedAt: revision.confirmedAt,
        openInterestAsOf: revision.openInterestAsOf,
        lastTradingDate: revision.lastTradingDate,
        openInterestStatus: revision.openInterestStatus,
        source: revision.canonical.source,
        sourceUrl: revision.sourceUrl,
        activeVersionKey: entry.activeVersionKey,
        signature: revision.signature,
        signatureShort,
        parserVersion: history.parserVersion,
        schemaVersion: history.schemaVersion,
        historyVersion: history.historyVersion
    };
    return result("available", null, {
        contracts,
        dates,
        selection: identity,
        snapshot: { identity, facts: chartData.points },
        chartData,
        metadata
    });
}

module.exports = Object.freeze({ buildQriHistoricalViewModel });
