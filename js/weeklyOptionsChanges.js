(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weeklyOptions = commonJs
        ? require("./weeklyOptions.js")
        : root?.OptionMapWeeklyOptions;
    const weeklyOptionsSignals = commonJs
        ? require("./weeklyOptionsSignals.js")
        : root?.OptionMapWeeklyOptionsSignals;
    const api = factory(weeklyOptions, weeklyOptionsSignals);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsChanges = api;
})(typeof window !== "undefined" ? window : globalThis,
function (weeklyOptions, weeklyOptionsSignals) {
    "use strict";

    const CHANGE_VERSION = 1;
    const OPTION_TYPES = Object.freeze(["put", "call"]);
    const SIDES = Object.freeze(["sell", "buy"]);

    function round(value, digits = 6) {
        if (!Number.isFinite(value)) return null;
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    function emptyResult(status, reason, details = {}) {
        return {
            changeVersion: CHANGE_VERSION,
            available: false,
            sameExpiry: null,
            status,
            reason,
            comparisonCoverage: null,
            strikeWindow: null,
            strikeChanges: [],
            relativeBucketChanges: [],
            participantChanges: [],
            newlyPublished: [],
            disappeared: [],
            breadthChanges: null,
            concentrationChanges: null,
            distributionShift: null,
            supportChanges: { available: false, reason: "comparison_unavailable" },
            resistanceChanges: { available: false, reason: "comparison_unavailable" },
            labels: [],
            warnings: [],
            ...details
        };
    }

    function observation(records) {
        if (records.length === 0) return { published: false, value: null };
        return {
            published: true,
            value: records.reduce((sum, record) => sum + record.value, 0),
            recordCount: records.length,
            participantCount: new Set(records.map(record =>
                record.participantCode
            )).size
        };
    }

    function matchingRecords(data, { optionType, side, strike }) {
        return data.records.filter(record =>
            record.optionType === optionType &&
            record.side === side &&
            (strike === undefined || record.strike === strike)
        );
    }

    function median(values) {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        if (sorted.length === 0) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function strikeStep(strikes) {
        return median(strikes.slice(1).map((strike, index) =>
            strike - strikes[index]
        ).filter(value => value > 0));
    }

    function strikeWindow(data) {
        const put = [...data.strikes.put].sort((a, b) => a - b);
        const call = [...data.strikes.call].sort((a, b) => a - b);
        const sameAcrossTypes = JSON.stringify(put) === JSON.stringify(call);
        const strikes = sameAcrossTypes
            ? put : [...new Set([...put, ...call])].sort((a, b) => a - b);
        return {
            strikes,
            put,
            call,
            sameAcrossTypes,
            center: median(strikes),
            step: strikeStep(strikes)
        };
    }

    function translatedWindow(previousWindow, currentWindow) {
        if (
            !previousWindow.sameAcrossTypes || !currentWindow.sameAcrossTypes ||
            previousWindow.strikes.length !== currentWindow.strikes.length ||
            previousWindow.strikes.length === 0 ||
            previousWindow.step !== currentWindow.step
        ) return { comparable: false, translation: null };
        const translations = previousWindow.strikes.map((strike, index) =>
            currentWindow.strikes[index] - strike
        );
        return {
            comparable: new Set(translations).size === 1,
            translation: new Set(translations).size === 1 ? translations[0] : null
        };
    }

    function hhi(records, key) {
        if (records.length === 0) return null;
        const totals = new Map();
        let total = 0;
        for (const record of records) {
            const group = key(record);
            totals.set(group, (totals.get(group) || 0) + record.value);
            total += record.value;
        }
        return total > 0 ? round([...totals.values()].reduce((sum, value) =>
            sum + (value / total) ** 2, 0
        )) : null;
    }

    function sliceSummary(data, optionType, side, window) {
        const records = matchingRecords(data, { optionType, side });
        const published = records.length > 0;
        const observedTotal = records.reduce((sum, record) => sum + record.value, 0);
        const centroid = observedTotal > 0
            ? records.reduce((sum, record) =>
                sum + record.strike * record.value, 0
            ) / observedTotal
            : null;
        const byStrike = data.strikes[optionType].map(strike => ({
            strike,
            value: matchingRecords(data, { optionType, side, strike })
                .reduce((sum, record) => sum + record.value, 0)
        }));
        const mode = byStrike.reduce((selected, entry) =>
            !selected || entry.value > selected.value ? entry : selected, null
        );
        return {
            published,
            total: published ? observedTotal : null,
            breadth: published
                ? new Set(records.map(record => record.participantCode)).size : null,
            participantHhi: hhi(records, record => record.participantCode),
            strikeHhi: hhi(records, record => record.strike),
            centroid: round(centroid),
            relativeCentroid: round(centroid - window.center),
            modeStrike: mode?.value > 0 ? mode.strike : null,
            modeBucket: mode?.value > 0 && Number.isFinite(window.step)
                ? round((mode.strike - window.center) / window.step) : null
        };
    }

    function buildStrikeChanges(previous, current) {
        const changes = [];
        for (const optionType of OPTION_TYPES) {
            const strikes = [...new Set([
                ...previous.strikes[optionType], ...current.strikes[optionType]
            ])].sort((a, b) => a - b);
            for (const strike of strikes) {
                for (const side of SIDES) {
                    const before = observation(matchingRecords(previous, {
                        optionType, side, strike
                    }));
                    const after = observation(matchingRecords(current, {
                        optionType, side, strike
                    }));
                    changes.push({
                        optionType,
                        expiry: previous.optionExpiries[optionType],
                        strike,
                        side,
                        comparisonBasis: "exact_strike",
                        previous: before,
                        current: after,
                        delta: before.published && after.published
                            ? after.value - before.value : null,
                        status: before.published && after.published
                            ? "continued"
                            : before.published
                                ? "previous_only"
                                : after.published ? "current_only" : "unobserved"
                    });
                }
            }
        }
        return changes;
    }

    function buildRelativeBucketChanges(previous, current, windows, translated) {
        if (!translated.comparable) return [];
        const changes = [];
        for (const optionType of OPTION_TYPES) {
            const previousStrikes = windows.previous[optionType];
            const currentStrikes = windows.current[optionType];
            const centerIndex = (previousStrikes.length - 1) / 2;
            for (let index = 0; index < previousStrikes.length; index += 1) {
                for (const side of SIDES) {
                    const previousStrike = previousStrikes[index];
                    const currentStrike = currentStrikes[index];
                    const before = observation(matchingRecords(previous, {
                        optionType, side, strike: previousStrike
                    }));
                    const after = observation(matchingRecords(current, {
                        optionType, side, strike: currentStrike
                    }));
                    changes.push({
                        optionType,
                        side,
                        bucket: index - centerIndex,
                        previousStrike,
                        currentStrike,
                        comparisonBasis: "translated_bucket",
                        previous: before,
                        current: after,
                        delta: before.published && after.published
                            ? after.value - before.value : null,
                        warning: previousStrike === currentStrike
                            ? null : "different_strikes"
                    });
                }
            }
        }
        return changes;
    }

    function participantObservation(records) {
        if (records.length === 0) {
            return { published: false, value: null, ranks: [], strikes: [] };
        }
        return {
            published: true,
            value: records.reduce((sum, record) => sum + record.value, 0),
            ranks: [...new Set(records.map(record => record.rank))]
                .sort((a, b) => a - b),
            strikes: [...new Set(records.map(record => record.strike))]
                .sort((a, b) => a - b),
            broker: records[0].broker
        };
    }

    function buildRankChanges(previous, current, optionType, side,
        participantCode, windows, translated) {
        const changes = [];
        const previousRecords = matchingRecords(previous, { optionType, side })
            .filter(record => record.participantCode === participantCode);
        const currentRecords = matchingRecords(current, { optionType, side })
            .filter(record => record.participantCode === participantCode);
        const currentByStrike = new Map(currentRecords.map(record =>
            [record.strike, record]
        ));
        for (const before of previousRecords) {
            const after = currentByStrike.get(before.strike);
            if (!after) continue;
            changes.push({
                comparisonBasis: "exact_strike",
                previousStrike: before.strike,
                currentStrike: after.strike,
                previousRank: before.rank,
                currentRank: after.rank,
                rankDelta: after.rank - before.rank,
                previousValue: before.value,
                currentValue: after.value,
                valueDelta: after.value - before.value
            });
        }
        if (translated.comparable && translated.translation !== 0) {
            const previousStrikes = windows.previous[optionType];
            const currentStrikes = windows.current[optionType];
            for (let index = 0; index < previousStrikes.length; index += 1) {
                const before = previousRecords.find(record =>
                    record.strike === previousStrikes[index]
                );
                const after = currentRecords.find(record =>
                    record.strike === currentStrikes[index]
                );
                if (!before || !after) continue;
                changes.push({
                    comparisonBasis: "translated_bucket",
                    bucket: index - (previousStrikes.length - 1) / 2,
                    previousStrike: before.strike,
                    currentStrike: after.strike,
                    previousRank: before.rank,
                    currentRank: after.rank,
                    rankDelta: after.rank - before.rank,
                    previousValue: before.value,
                    currentValue: after.value,
                    valueDelta: after.value - before.value,
                    warning: "different_strikes"
                });
            }
        }
        return changes;
    }

    function buildParticipantChanges(previous, current, windows, translated) {
        const changes = [];
        for (const optionType of OPTION_TYPES) {
            for (const side of SIDES) {
                const previousRecords = matchingRecords(previous, { optionType, side });
                const currentRecords = matchingRecords(current, { optionType, side });
                const codes = [...new Set([
                    ...previousRecords.map(record => record.participantCode),
                    ...currentRecords.map(record => record.participantCode)
                ])].sort();
                for (const participantCode of codes) {
                    const beforeRecords = previousRecords.filter(record =>
                        record.participantCode === participantCode
                    );
                    const afterRecords = currentRecords.filter(record =>
                        record.participantCode === participantCode
                    );
                    const before = participantObservation(beforeRecords);
                    const after = participantObservation(afterRecords);
                    changes.push({
                        optionType,
                        side,
                        participantCode,
                        brokerLabels: {
                            previous: before.broker || null,
                            current: after.broker || null
                        },
                        comparisonBasis: "published_window_aggregate",
                        previous: before,
                        current: after,
                        delta: before.published && after.published
                            ? after.value - before.value : null,
                        status: before.published && after.published
                            ? "continued"
                            : before.published ? "disappeared" : "newly_published",
                        rankChanges: buildRankChanges(
                            previous, current, optionType, side,
                            participantCode, windows, translated
                        )
                    });
                }
            }
        }
        return changes;
    }

    function nestedChanges(previous, current, previousWindow, currentWindow) {
        const breadth = {};
        const participantHhi = {};
        const strikeHhi = {};
        const distribution = {};
        for (const optionType of OPTION_TYPES) {
            breadth[optionType] = {};
            participantHhi[optionType] = {};
            strikeHhi[optionType] = {};
            distribution[optionType] = {};
            for (const side of SIDES) {
                const before = sliceSummary(previous, optionType, side, previousWindow);
                const after = sliceSummary(current, optionType, side, currentWindow);
                breadth[optionType][side] = {
                    previous: before.breadth,
                    current: after.breadth,
                    delta: before.published && after.published
                        ? after.breadth - before.breadth : null
                };
                participantHhi[optionType][side] = {
                    previous: before.participantHhi,
                    current: after.participantHhi,
                    delta: before.published && after.published
                        ? round(after.participantHhi - before.participantHhi) : null
                };
                strikeHhi[optionType][side] = {
                    previous: before.strikeHhi,
                    current: after.strikeHhi,
                    delta: before.published && after.published
                        ? round(after.strikeHhi - before.strikeHhi) : null
                };
                distribution[optionType][side] = {
                    previous: {
                        centroid: before.centroid,
                        relativeCentroid: before.relativeCentroid,
                        modeStrike: before.modeStrike,
                        modeBucket: before.modeBucket
                    },
                    current: {
                        centroid: after.centroid,
                        relativeCentroid: after.relativeCentroid,
                        modeStrike: after.modeStrike,
                        modeBucket: after.modeBucket
                    },
                    absoluteCentroidShift: before.published && after.published
                        ? round(after.centroid - before.centroid) : null,
                    windowRelativeCentroidShift:
                        before.published && after.published
                            ? round(after.relativeCentroid - before.relativeCentroid)
                            : null,
                    modeStrikeShift: after.modeStrike !== null && before.modeStrike !== null
                        ? after.modeStrike - before.modeStrike : null,
                    modeBucketShift: after.modeBucket !== null && before.modeBucket !== null
                        ? after.modeBucket - before.modeBucket : null
                };
            }
        }
        return {
            breadth,
            concentration: { participantHhi, strikeHhi },
            distribution
        };
    }

    function supportOrResistance(previous, current, options, kind) {
        const previousPrice = Number(options.previousReferencePrice);
        const currentPrice = Number(options.currentReferencePrice);
        if (
            !Number.isFinite(previousPrice) || previousPrice <= 0 ||
            !Number.isFinite(currentPrice) || currentPrice <= 0
        ) return { available: false, reason: "reference_prices_unavailable" };
        const beforeSignal = weeklyOptionsSignals?.deriveWeeklyOptionsSignals?.(
            previous, { currentPrice: previousPrice }
        );
        const afterSignal = weeklyOptionsSignals?.deriveWeeklyOptionsSignals?.(
            current, { currentPrice: currentPrice }
        );
        if (!beforeSignal?.available || !afterSignal?.available) {
            return {
                available: false,
                reason: "weekly_signal_unavailable",
                previousReason: beforeSignal?.reason || null,
                currentReason: afterSignal?.reason || null
            };
        }
        const key = kind === "support" ? "lowerSupport" : "upperResistance";
        const before = beforeSignal[key];
        const after = afterSignal[key];
        const previousTop = before.strikes[0] || null;
        const currentTop = after.strikes[0] || null;
        if (!previousTop || !currentTop) {
            return { available: false, reason: "candidate_unavailable" };
        }
        const previousRelative = (previousTop.strike - previousPrice) /
            beforeSignal.strikeStep;
        const currentRelative = (currentTop.strike - currentPrice) /
            afterSignal.strikeStep;
        return {
            available: true,
            referencePriceBasis: options.referencePriceBasis || "explicit",
            previousReferencePrice: previousPrice,
            currentReferencePrice: currentPrice,
            previous: {
                strike: previousTop.strike,
                relativeSteps: round(previousRelative),
                weightedValue: before.weightedValue
            },
            current: {
                strike: currentTop.strike,
                relativeSteps: round(currentRelative),
                weightedValue: after.weightedValue
            },
            absoluteStrikeShift: currentTop.strike - previousTop.strike,
            relativeStepShift: round(currentRelative - previousRelative),
            weightedValueChange: round(after.weightedValue - before.weightedValue),
            warning: "structural_candidate_not_direction_forecast"
        };
    }

    function buildLabels({ translated, nested, support, resistance }) {
        const labels = [];
        if (translated.translation !== 0 && translated.translation !== null) {
            labels.push({
                code: translated.translation > 0
                    ? "strike_window_moved_up" : "strike_window_moved_down",
                facts: { translation: translated.translation }
            });
        }
        for (const optionType of OPTION_TYPES) {
            const shift = nested.distribution[optionType].sell
                .windowRelativeCentroidShift;
            if (shift !== 0 && shift !== null) {
                labels.push({
                    code: `${optionType}_distribution_shifted_` +
                        (shift > 0 ? "higher" : "lower") + "_relative_to_window",
                    facts: { shift }
                });
            }
            for (const side of SIDES) {
                const breadth = nested.breadth[optionType][side].delta;
                if (Number.isFinite(breadth) && breadth !== 0) labels.push({
                    code: "published_participant_breadth_" +
                        (breadth > 0 ? "increased" : "decreased"),
                    facts: { optionType, side, delta: breadth }
                });
                const hhiChange = nested.concentration.participantHhi[optionType][side]
                    .delta;
                if (Number.isFinite(hhiChange) && hhiChange !== 0) labels.push({
                    code: "participant_concentration_" +
                        (hhiChange > 0 ? "increased" : "decreased"),
                    facts: { optionType, side, delta: hhiChange }
                });
            }
        }
        for (const [kind, change] of [["support", support], ["resistance", resistance]]) {
            if (!change.available || change.absoluteStrikeShift === 0) continue;
            labels.push({
                code: `${kind}_candidate_moved_` +
                    (change.absoluteStrikeShift > 0 ? "up" : "down"),
                facts: {
                    absoluteStrikeShift: change.absoluteStrikeShift,
                    relativeStepShift: change.relativeStepShift
                }
            });
            if (change.relativeStepShift === 0) labels.push({
                code: `${kind}_candidate_relative_position_unchanged`,
                facts: { relativeSteps: change.current.relativeSteps }
            });
        }
        return labels;
    }

    function compareWeeklyOptions(previous, current, options = {}) {
        if (
            !weeklyOptions?.validateWeeklyOptionsData?.(previous) ||
            !weeklyOptions?.validateWeeklyOptionsData?.(current)
        ) return emptyResult("unavailable", "invalid_canonical");
        const basic = {
            product: previous.product,
            previousSourceDate: previous.sourceDate,
            currentSourceDate: current.sourceDate
        };
        if (previous.product !== current.product) {
            return emptyResult("unavailable", "product_mismatch", basic);
        }
        if (previous.sourceDate >= current.sourceDate) {
            return emptyResult("unavailable", "source_date_order_invalid", basic);
        }
        const previousInternalExpiry = previous.optionExpiries.put ===
            previous.optionExpiries.call;
        const currentInternalExpiry = current.optionExpiries.put ===
            current.optionExpiries.call;
        if (!previousInternalExpiry || !currentInternalExpiry) {
            return emptyResult("unavailable", "internal_expiry_mismatch", basic);
        }
        const sameExpiry = previous.optionExpiries.put === current.optionExpiries.put;
        if (!sameExpiry) {
            return emptyResult("roll_transition", "expiry_changed", {
                ...basic,
                sameExpiry: false,
                previousExpiry: previous.optionExpiries.put,
                currentExpiry: current.optionExpiries.put,
                warnings: ["roll_transition", "different_expiries_not_compared"]
            });
        }

        const previousWindow = strikeWindow(previous);
        const currentWindow = strikeWindow(current);
        const translated = translatedWindow(previousWindow, currentWindow);
        const windows = {
            previous: previousWindow,
            current: currentWindow
        };
        const common = {};
        for (const optionType of OPTION_TYPES) {
            common[optionType] = previous.strikes[optionType].filter(strike =>
                current.strikes[optionType].includes(strike)
            );
        }
        const commonCount = common.put.length + common.call.length;
        const possibleCount = previous.strikes.put.length + previous.strikes.call.length;
        const strikeChanges = buildStrikeChanges(previous, current);
        const relativeBucketChanges = buildRelativeBucketChanges(
            previous, current, windows, translated
        );
        const participantChanges = buildParticipantChanges(
            previous, current, windows, translated
        );
        const nested = nestedChanges(
            previous, current, previousWindow, currentWindow
        );
        const supportChanges = supportOrResistance(
            previous, current, options, "support"
        );
        const resistanceChanges = supportOrResistance(
            previous, current, options, "resistance"
        );
        const warnings = [
            "published_rankings_only",
            "absence_is_not_zero",
            "weekly_not_realtime",
            "hedging_spreads_and_market_making_not_identified",
            "no_direction_forecast"
        ];
        if (commonCount === 0) warnings.push("no_common_strikes");
        if (translated.translation !== 0) warnings.push("strike_window_changed");
        if (relativeBucketChanges.some(change => change.warning)) {
            warnings.push("translated_bucket_is_not_exact_strike");
        }
        if (!supportChanges.available || !resistanceChanges.available) {
            warnings.push("support_resistance_reference_unavailable");
        }
        const result = {
            changeVersion: CHANGE_VERSION,
            available: true,
            sameExpiry: true,
            status: commonCount === 0 ||
                !supportChanges.available || !resistanceChanges.available
                ? "partial" : "comparable",
            reason: null,
            ...basic,
            expiry: previous.optionExpiries.put,
            comparisonCoverage: {
                exactCommonStrikes: common,
                exactCommonStrikeCount: commonCount,
                exactCommonStrikeRatio: round(commonCount / possibleCount),
                previousStrikeCount: possibleCount,
                currentStrikeCount:
                    current.strikes.put.length + current.strikes.call.length,
                translatedWindowComparable: translated.comparable
            },
            strikeWindow: {
                previous: previousWindow,
                current: currentWindow,
                translation: translated.translation
            },
            strikeChanges,
            relativeBucketChanges,
            participantChanges,
            newlyPublished: participantChanges.filter(change =>
                change.status === "newly_published"
            ),
            disappeared: participantChanges.filter(change =>
                change.status === "disappeared"
            ),
            breadthChanges: nested.breadth,
            concentrationChanges: nested.concentration,
            distributionShift: nested.distribution,
            supportChanges,
            resistanceChanges,
            labels: [],
            warnings
        };
        result.labels = buildLabels({
            translated,
            nested,
            support: supportChanges,
            resistance: resistanceChanges
        });
        return result;
    }

    return Object.freeze({
        CHANGE_VERSION,
        compareWeeklyOptions
    });
});
