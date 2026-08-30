"use strict";

const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;

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

function notices(hasPartialCoverage = false) {
    return { historicalAggregation: true, isCurrent: false, hasPartialCoverage };
}

function result(status, reason, details = {}) {
    return deepFreeze({
        status,
        reason,
        available: status === "available" || status === "partial",
        tradingDate: null,
        contracts: [],
        strikes: [],
        points: [],
        provenance: null,
        aggregationIdentity: null,
        notices: notices(false),
        ...clone(details)
    });
}

function validSide(side) {
    return side && typeof side === "object" && typeof side.published === "boolean" &&
        (side.published
            ? Number.isSafeInteger(side.value) && side.value >= 0
            : side.value === null);
}

function normalizeSnapshot(snapshot) {
    const identity = snapshot?.identity;
    if (!snapshot || typeof snapshot !== "object" || !identity ||
        typeof identity !== "object" || !CONTRACT_PATTERN.test(identity.contract || "") ||
        !validDate(identity.tradingDate) ||
        identity.entryKey !== `${identity.contract}|${identity.tradingDate}` ||
        typeof identity.activeVersionKey !== "string" ||
        identity.activeVersionKey.length === 0 || !Array.isArray(snapshot.facts)) return null;

    const facts = new Map();
    for (const fact of snapshot.facts) {
        if (!fact || typeof fact !== "object" || !Number.isFinite(fact.strike) ||
            fact.strike <= 0 || !validSide(fact.call) || !validSide(fact.put) ||
            facts.has(fact.strike)) return null;
        facts.set(fact.strike, {
            strike: fact.strike,
            call: { published: fact.call.published, value: fact.call.value },
            put: { published: fact.put.published, value: fact.put.value }
        });
    }
    return {
        identity: {
            contract: identity.contract,
            tradingDate: identity.tradingDate,
            entryKey: identity.entryKey,
            activeVersionKey: identity.activeVersionKey
        },
        source: typeof snapshot.source === "string" && snapshot.source.length > 0
            ? snapshot.source : null,
        facts
    };
}

function aggregateSide(snapshots, strike, side) {
    const contributions = snapshots.map(snapshot => {
        const fact = snapshot.facts.get(strike);
        if (!fact) return { contract: snapshot.identity.contract, presence: "absent",
            published: null, value: null };
        const value = fact[side];
        if (!value.published) return { contract: snapshot.identity.contract,
            presence: "unpublished", published: false, value: null };
        return { contract: snapshot.identity.contract, presence: "published",
            published: true, value: value.value };
    });
    const published = contributions.filter(item => item.presence === "published");
    const contributed = published.length;
    const expected = snapshots.length;
    return {
        total: contributed === 0 ? null : published.reduce((sum, item) => sum + item.value, 0),
        contributingContracts: contributed,
        expectedContracts: expected,
        coverage: { contributed, expected, ratio: contributed / expected },
        complete: contributed === expected,
        contributions
    };
}

function buildQriHistoricalAggregation({ snapshots } = {}) {
    if (!Array.isArray(snapshots) || snapshots.length < 2) {
        return result("unavailable", "not_enough_contracts");
    }
    const normalized = snapshots.map(normalizeSnapshot);
    if (normalized.some(snapshot => snapshot === null)) {
        return result("invalid", "snapshot_invalid");
    }
    normalized.sort((a, b) => a.identity.contract.localeCompare(b.identity.contract));
    const contracts = normalized.map(snapshot => snapshot.identity.contract);
    if (new Set(contracts).size !== contracts.length) {
        return result("invalid", "duplicate_contract");
    }
    const tradingDates = new Set(normalized.map(snapshot => snapshot.identity.tradingDate));
    if (tradingDates.size !== 1) {
        return result("invalid", "trading_date_mismatch", { contracts });
    }
    const tradingDate = normalized[0].identity.tradingDate;
    const strikes = [...new Set(normalized.flatMap(snapshot => [...snapshot.facts.keys()]))]
        .sort((a, b) => a - b);
    const points = strikes.map(strike => ({ strike,
        call: aggregateSide(normalized, strike, "call"),
        put: aggregateSide(normalized, strike, "put") }));
    const hasRecords = points.some(point => point.call.contributingContracts > 0 ||
        point.put.contributingContracts > 0);
    const hasPartialCoverage = points.some(point => !point.call.complete || !point.put.complete);
    const provenanceSnapshots = normalized.map(snapshot => ({
        ...snapshot.identity,
        ...(snapshot.source === null ? {} : { source: snapshot.source })
    }));
    const provenance = { tradingDate, contracts, snapshots: provenanceSnapshots };
    const aggregationIdentity = JSON.stringify({
        kind: "qri-historical-aggregation-v1",
        tradingDate,
        snapshots: provenanceSnapshots.map(({ contract, entryKey, activeVersionKey }) =>
            ({ contract, entryKey, activeVersionKey }))
    });
    if (!hasRecords) return result("unavailable", "no_records", {
        tradingDate, contracts, strikes, points, provenance, aggregationIdentity,
        notices: notices(hasPartialCoverage)
    });
    const status = hasPartialCoverage ? "partial" : "available";
    return result(status, hasPartialCoverage ? "partial_coverage" : null, {
        tradingDate, contracts, strikes, points, provenance, aggregationIdentity,
        notices: notices(hasPartialCoverage)
    });
}

module.exports = Object.freeze({ buildQriHistoricalAggregation });
