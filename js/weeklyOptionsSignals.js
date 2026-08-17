(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weeklyOptions = commonJs
        ? require("./weeklyOptions.js")
        : root?.OptionMapWeeklyOptions;
    const api = factory(weeklyOptions);

    if (commonJs) {
        module.exports = api;
    }
    if (root) root.OptionMapWeeklyOptionsSignals = api;
})(typeof window !== "undefined" ? window : globalThis, function (weeklyOptions) {
    "use strict";

    const SIGNAL_VERSION = 1;
    const MIN_DIRECTION = 0.20;
    const MIN_STRIKES_WITH_RECORDS = 3;

    function clamp(value, minimum = 0, maximum = 1) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function round(value, digits = 6) {
        if (!Number.isFinite(value)) return null;
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    function median(values) {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        if (sorted.length === 0) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function getStrikeStep(canonical) {
        const strikes = [...new Set([
            ...(canonical.strikes?.put || []),
            ...(canonical.strikes?.call || [])
        ])].sort((a, b) => a - b);
        return median(strikes.slice(1).map((strike, index) =>
            strike - strikes[index]
        ).filter(value => value > 0));
    }

    function summarizeRecords(records) {
        if (records.length === 0) {
            return {
                published: false,
                value: null,
                participantCount: 0,
                top1Share: null,
                concentration: null,
                ranks: [],
                participants: []
            };
        }
        const total = records.reduce((sum, record) => sum + record.value, 0);
        const participantTotals = new Map();
        for (const record of records) {
            participantTotals.set(
                record.participantCode,
                (participantTotals.get(record.participantCode) || 0) + record.value
            );
        }
        const shares = [...participantTotals.values()].map(value => value / total);
        return {
            published: true,
            value: total,
            participantCount: participantTotals.size,
            top1Share: round(Math.max(...shares)),
            concentration: round(shares.reduce((sum, share) => sum + share ** 2, 0)),
            ranks: [...new Set(records.map(record => record.rank))].sort((a, b) => a - b),
            participants: records.map(record => ({
                participantCode: record.participantCode,
                broker: record.broker,
                rank: record.rank,
                value: record.value,
                share: round(record.value / total)
            })).sort((left, right) => right.value - left.value || left.rank - right.rank)
        };
    }

    function createStrikeMetrics(canonical, currentPrice, strikeStep) {
        const keys = [];
        for (const optionType of ["put", "call"]) {
            for (const strike of canonical.strikes[optionType]) {
                keys.push({ optionType, expiry: canonical.optionExpiries[optionType], strike });
            }
        }
        return keys.map(key => {
            const matching = canonical.records.filter(record =>
                record.optionType === key.optionType &&
                record.expiry === key.expiry &&
                record.strike === key.strike
            );
            const sell = summarizeRecords(matching.filter(record => record.side === "sell"));
            const buy = summarizeRecords(matching.filter(record => record.side === "buy"));
            const observedTotal = (sell.value || 0) + (buy.value || 0);
            const sideBalance = sell.published || buy.published
                ? round(((buy.value || 0) - (sell.value || 0)) / observedTotal)
                : null;
            const distanceSteps = (key.strike - currentPrice) / strikeStep;
            return {
                ...key,
                distanceSteps: round(distanceSteps),
                distanceWeight: round(clamp(1 - Math.abs(distanceSteps) / 2)),
                sell,
                buy,
                sideBalance
            };
        });
    }

    function categoryFrom(metrics, { optionType, side, position }) {
        const selected = metrics.filter(metric =>
            metric.optionType === optionType &&
            (position === "above" ? metric.distanceSteps >= 0 : metric.distanceSteps <= 0)
        ).map(metric => ({
            strike: metric.strike,
            distanceSteps: metric.distanceSteps,
            distanceWeight: metric.distanceWeight,
            observation: metric[side]
        })).filter(item => item.observation.published);
        const weightedValue = selected.reduce((sum, item) =>
            sum + item.observation.value * item.distanceWeight, 0
        );
        const participantCodes = new Set();
        const relevantEntries = [];
        for (const metric of metrics) {
            if (
                metric.optionType !== optionType ||
                (position === "above" ? metric.distanceSteps < 0 : metric.distanceSteps > 0)
            ) continue;
            relevantEntries.push(...metric._records
                .filter(record => record.side === side)
                .map(record => ({ record, weight: metric.distanceWeight }))
            );
        }
        relevantEntries.forEach(({ record }) =>
            participantCodes.add(record.participantCode)
        );
        const weightedTotal = relevantEntries.reduce((sum, { record, weight }) =>
            sum + record.value * weight, 0
        );
        const byParticipant = new Map();
        relevantEntries.forEach(({ record, weight }) => {
            const participant = byParticipant.get(record.participantCode) || {
                participantCode: record.participantCode,
                brokers: new Set(),
                value: 0,
                weightedValue: 0,
                ranks: []
            };
            participant.brokers.add(record.broker);
            participant.value += record.value;
            participant.weightedValue += record.value * weight;
            participant.ranks.push(record.rank);
            byParticipant.set(record.participantCode, participant);
        });
        const shares = weightedTotal > 0
            ? [...byParticipant.values()]
                .map(participant => participant.weightedValue / weightedTotal)
                .filter(share => share > 0)
            : [];
        return {
            published: selected.length > 0,
            weightedValue: round(weightedValue),
            participantCount: participantCodes.size,
            top1Share: shares.length ? round(Math.max(...shares)) : null,
            concentration: shares.length
                ? round(shares.reduce((sum, share) => sum + share ** 2, 0))
                : null,
            participants: [...byParticipant.values()].map(participant => ({
                participantCode: participant.participantCode,
                brokers: [...participant.brokers].sort(),
                value: participant.value,
                weightedValue: round(participant.weightedValue),
                share: weightedTotal > 0
                    ? round(participant.weightedValue / weightedTotal) : null,
                ranks: [...new Set(participant.ranks)].sort((a, b) => a - b)
            })).sort((left, right) =>
                right.weightedValue - left.weightedValue ||
                left.participantCode.localeCompare(right.participantCode)
            ),
            strikes: selected.map(item => ({
                strike: item.strike,
                value: item.observation.value,
                weightedValue: round(item.observation.value * item.distanceWeight),
                participantCount: item.observation.participantCount,
                ranks: [...item.observation.ranks]
            })).sort((left, right) => right.weightedValue - left.weightedValue)
        };
    }

    function attachRecords(metrics, canonical) {
        return metrics.map(metric => ({
            ...metric,
            _records: canonical.records.filter(record =>
                record.optionType === metric.optionType &&
                record.expiry === metric.expiry &&
                record.strike === metric.strike
            )
        }));
    }

    function publicMetrics(metrics) {
        return metrics.map(({ _records, ...metric }) => metric);
    }

    function unavailable(reason, details = {}) {
        return {
            signalVersion: SIGNAL_VERSION,
            available: false,
            reason,
            label: "insufficient",
            normalizedDirection: null,
            qualityFactor: 0,
            evidenceFactor: 0,
            ...details
        };
    }

    function deriveWeeklyOptionsSignals(canonical, options = {}) {
        if (!weeklyOptions?.validateWeeklyOptionsData?.(canonical)) {
            return unavailable("invalid_canonical");
        }
        const currentPrice = Number(options.currentPrice);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            return unavailable("current_price_unavailable", {
                sourceDate: canonical.sourceDate
            });
        }
        if (canonical.optionExpiries.put !== canonical.optionExpiries.call) {
            return unavailable("expiry_mismatch", {
                sourceDate: canonical.sourceDate,
                expiries: { ...canonical.optionExpiries }
            });
        }
        const strikeStep = getStrikeStep(canonical);
        if (!Number.isFinite(strikeStep) || strikeStep <= 0) {
            return unavailable("strike_step_unavailable", {
                sourceDate: canonical.sourceDate
            });
        }
        const allStrikes = [...new Set([
            ...canonical.strikes.put, ...canonical.strikes.call
        ])].sort((a, b) => a - b);
        const priceInUsableRange = currentPrice >= allStrikes[0] - strikeStep &&
            currentPrice <= allStrikes[allStrikes.length - 1] + strikeStep;
        if (!priceInUsableRange) {
            return unavailable("current_price_outside_strike_range", {
                sourceDate: canonical.sourceDate,
                expiry: canonical.optionExpiries.put,
                currentPrice,
                strikeStep,
                strikeRange: [allStrikes[0], allStrikes[allStrikes.length - 1]]
            });
        }

        const baseMetrics = createStrikeMetrics(canonical, currentPrice, strikeStep);
        const metrics = attachRecords(baseMetrics, canonical);
        const lowerSupport = categoryFrom(metrics, {
            optionType: "put", side: "sell", position: "below"
        });
        const upperResistance = categoryFrom(metrics, {
            optionType: "call", side: "sell", position: "above"
        });
        const upsideAppetite = categoryFrom(metrics, {
            optionType: "call", side: "buy", position: "above"
        });
        const downsideProtection = categoryFrom(metrics, {
            optionType: "put", side: "buy", position: "below"
        });
        const categories = [lowerSupport, upperResistance,
            upsideAppetite, downsideProtection];
        const strikesWithRecords = new Set(canonical.records.map(record =>
            `${record.optionType}|${record.strike}`
        )).size;
        if (
            strikesWithRecords < MIN_STRIKES_WITH_RECORDS ||
            categories.some(category =>
                !category.published || category.weightedValue <= 0
            )
        ) {
            return unavailable("insufficient_published_observations", {
                sourceDate: canonical.sourceDate,
                expiry: canonical.optionExpiries.put,
                currentPrice,
                strikeStep,
                strikeMetrics: publicMetrics(metrics),
                lowerSupport,
                upperResistance,
                upsideAppetite,
                downsideProtection
            });
        }

        const bullish = lowerSupport.weightedValue + upsideAppetite.weightedValue;
        const bearish = upperResistance.weightedValue + downsideProtection.weightedValue;
        const totalDirectionalEvidence = bullish + bearish;
        const normalizedDirection = totalDirectionalEvidence > 0
            ? (bullish - bearish) / totalDirectionalEvidence
            : 0;
        const observedCategoryRatio = categories.filter(category =>
            category.published
        ).length / categories.length;
        const potentialStrikeSides = metrics.filter(metric =>
            (metric.optionType === "put" && metric.distanceSteps <= 0) ||
            (metric.optionType === "call" && metric.distanceSteps >= 0)
        ).length * 2;
        const observedStrikeSides = categories.reduce((sum, category) =>
            sum + category.strikes.length, 0
        );
        const coverage = potentialStrikeSides > 0
            ? observedStrikeSides / potentialStrikeSides : 0;
        const participantCodes = new Set(canonical.records.map(record =>
            record.participantCode
        ));
        const breadth = clamp(participantCodes.size / 8);
        const concentrations = categories.map(category => category.concentration)
            .filter(Number.isFinite);
        const concentration = concentrations.length
            ? concentrations.reduce((sum, value) => sum + value, 0) /
                concentrations.length
            : 1;
        const concentrationQuality = clamp(1 - concentration);
        const evidenceFactor = clamp(
            observedCategoryRatio * 0.25 +
            coverage * 0.35 +
            breadth * 0.20 +
            concentrationQuality * 0.20
        );
        const metadata = options.sourceMetadata || {};
        const originFactor = metadata.origin === "cache" ? 0.9 : 1;
        const remoteFactor = metadata.remoteCheckStatus === "newer_available"
            ? 0.4 : metadata.remoteCheckStatus === "failed" ? 0.65 : 1;
        const qualityFactor = clamp(0.65 * originFactor * remoteFactor);
        const label = normalizedDirection >= MIN_DIRECTION
            ? "bullish"
            : normalizedDirection <= -MIN_DIRECTION ? "bearish" : "neutral";

        return {
            signalVersion: SIGNAL_VERSION,
            available: true,
            reason: null,
            label,
            normalizedDirection: round(normalizedDirection),
            qualityFactor: round(qualityFactor),
            evidenceFactor: round(evidenceFactor),
            sourceDate: canonical.sourceDate,
            expiry: canonical.optionExpiries.put,
            currentPrice,
            strikeStep,
            strikeRange: [allStrikes[0], allStrikes[allStrikes.length - 1]],
            lowerSupport,
            upperResistance,
            upsideAppetite,
            downsideProtection,
            breadth: {
                participantCount: participantCodes.size,
                factor: round(breadth)
            },
            concentration: {
                meanHhi: round(concentration),
                qualityFactor: round(concentrationQuality)
            },
            coverage: {
                observedCategoryRatio: round(observedCategoryRatio),
                observedStrikeSides,
                potentialStrikeSides,
                factor: round(coverage),
                strikesWithRecords
            },
            directionalEvidence: {
                bullish: round(bullish),
                bearish: round(bearish)
            },
            strikeMetrics: publicMetrics(metrics),
            warnings: [
                "published_rankings_only",
                "weekly_not_realtime",
                "contract_counts_not_delta_adjusted"
            ]
        };
    }

    return Object.freeze({
        SIGNAL_VERSION,
        MIN_DIRECTION,
        MIN_STRIKES_WITH_RECORDS,
        deriveWeeklyOptionsSignals
    });
});
