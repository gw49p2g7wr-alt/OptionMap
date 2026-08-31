(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const historyApi = commonJs
        ? require("./weeklyOptionsHistory.js")
        : root?.OptionMapWeeklyOptionsHistory;
    const api = factory(historyApi);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsParticipantHistoricalViewModel = api;
})(typeof window !== "undefined" ? window : globalThis, function (historyApi) {
    "use strict";

    const OPTION_TYPES = Object.freeze(["call", "put"]);
    const PERIODS = Object.freeze(["last20", "threeMonths", "all"]);

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function notices() {
        return {
            historical: true,
            current: false,
            publishedRankedRecordsOnly: true,
            participantTotalOpenInterest: false,
            absenceIsZero: false,
            directionalInterpretationAllowed: false
        };
    }

    function emptyResult(status, reason, details = {}) {
        return deepFreeze({
            status,
            reason,
            selectedParticipantCode: null,
            selectedOptionType: null,
            period: null,
            participants: [],
            points: [],
            rollBoundaries: [],
            summary: {
                totalObservations: 0,
                publishedObservations: 0,
                missingObservations: 0,
                buyPublishedObservations: 0,
                sellPublishedObservations: 0,
                observedExpiryCount: 0
            },
            notices: notices(),
            ...details
        });
    }

    function activeRevision(entry) {
        const matches = (entry?.revisions || []).filter(revision =>
            revision?.versionKey === entry?.activeVersionKey
        );
        return matches.length === 1 ? matches[0] : null;
    }

    function activeCanonicals(history) {
        return [...history.entries]
            .sort((left, right) => left.sourceDate.localeCompare(right.sourceDate))
            .map(entry => ({ entry, revision: activeRevision(entry) }));
    }

    function participantList(activeEntries) {
        const participants = new Map();
        for (const { entry, revision } of activeEntries) {
            for (const record of revision.canonical.records) {
                const item = participants.get(record.participantCode) || {
                    participantCode: record.participantCode,
                    observedNames: new Set(),
                    firstSeenDate: entry.sourceDate,
                    lastSeenDate: entry.sourceDate,
                    latestObservedName: record.broker,
                    observationCount: 0
                };
                item.observedNames.add(record.broker);
                item.firstSeenDate = item.firstSeenDate < entry.sourceDate
                    ? item.firstSeenDate : entry.sourceDate;
                if (entry.sourceDate >= item.lastSeenDate) {
                    item.lastSeenDate = entry.sourceDate;
                    item.latestObservedName = record.broker;
                }
                item.observationCount += 1;
                participants.set(record.participantCode, item);
            }
        }
        return [...participants.values()].map(item => {
            const observedNames = [...item.observedNames].sort((a, b) =>
                a.localeCompare(b, "ja")
            );
            return {
                participantCode: item.participantCode,
                displayName: item.latestObservedName || item.participantCode,
                observedNames,
                nameVariation: observedNames.length > 1,
                firstSeenDate: item.firstSeenDate,
                lastSeenDate: item.lastSeenDate,
                observationCount: item.observationCount
            };
        }).sort((left, right) =>
            left.displayName.localeCompare(right.displayName, "ja") ||
            left.participantCode.localeCompare(right.participantCode)
        );
    }

    function subtractCalendarMonths(isoDate, months) {
        const [year, month, day] = isoDate.split("-").map(Number);
        const targetMonthIndex = year * 12 + month - 1 - months;
        const targetYear = Math.floor(targetMonthIndex / 12);
        const targetMonth = targetMonthIndex % 12;
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0))
            .getUTCDate();
        return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
            .toISOString().slice(0, 10);
    }

    function filterPeriod(entries, period) {
        if (period === "all") return entries;
        if (period === "last20") return entries.slice(-20);
        const latest = entries.at(-1)?.entry.sourceDate;
        if (!latest) return [];
        const cutoff = subtractCalendarMonths(latest, 3);
        return entries.filter(({ entry }) => entry.sourceDate >= cutoff);
    }

    function sideObservation(records, side) {
        const matching = records.filter(record => record.side === side);
        const strikes = [...new Set(matching.map(record => record.strike))]
            .sort((left, right) => left - right);
        return {
            published: matching.length > 0,
            total: matching.length > 0
                ? matching.reduce((sum, record) => sum + record.value, 0)
                : null,
            contributingRecords: matching.length,
            contributingStrikes: strikes.length
        };
    }

    function createPoint(active, participantCode, optionType) {
        const { entry, revision } = active;
        const canonical = revision.canonical;
        const expiry = canonical.optionExpiries[optionType];
        const records = canonical.records.filter(record =>
            record.participantCode === participantCode &&
            record.optionType === optionType &&
            record.expiry === expiry &&
            record.published === true
        );
        const contributingStrikes = [...new Set(records.map(record => record.strike))]
            .sort((left, right) => left - right);
        const publishedWindow = [...canonical.strikes[optionType]]
            .sort((left, right) => left - right);
        return {
            sourceDate: entry.sourceDate,
            expiry,
            buy: sideObservation(records, "buy"),
            sell: sideObservation(records, "sell"),
            coverage: {
                publishedStrikeCount: contributingStrikes.length,
                contributingRecordCount: records.length,
                buyPublished: records.some(record => record.side === "buy"),
                sellPublished: records.some(record => record.side === "sell"),
                participantPublishedRecords: records.length,
                scope: "jpx_published_ranked_records"
            },
            strikeWindow: {
                min: publishedWindow.at(0) ?? null,
                max: publishedWindow.at(-1) ?? null,
                count: publishedWindow.length
            },
            provenance: {
                sourceDate: entry.sourceDate,
                entryKey: entry.sourceDate,
                activeVersionKey: entry.activeVersionKey,
                source: historyApi.HISTORY_SOURCE,
                sourceTitle: canonical.sourceTitle,
                sourceUrl: revision.sourceUrl,
                expiry,
                optionType,
                participantCode
            }
        };
    }

    function rollBoundaries(points) {
        const result = [];
        for (let index = 1; index < points.length; index += 1) {
            if (points[index - 1].expiry !== points[index].expiry) {
                result.push({
                    index,
                    sourceDate: points[index].sourceDate,
                    fromExpiry: points[index - 1].expiry,
                    toExpiry: points[index].expiry
                });
            }
        }
        return result;
    }

    function summarize(points) {
        const published = points.filter(point =>
            point.buy.published || point.sell.published
        );
        return {
            totalObservations: points.length,
            publishedObservations: published.length,
            missingObservations: points.length - published.length,
            buyPublishedObservations: points.filter(point => point.buy.published).length,
            sellPublishedObservations: points.filter(point => point.sell.published).length,
            observedExpiryCount: new Set(points.map(point => point.expiry)).size
        };
    }

    async function validatedEntries(history) {
        const validation = await historyApi?.validateWeeklyOptionsHistory?.(history);
        return validation?.valid
            ? { ok: true, entries: activeCanonicals(history), validation }
            : { ok: false, entries: [], validation: validation || null };
    }

    async function listWeeklyOptionsParticipants(history) {
        const validated = await validatedEntries(history);
        if (!validated.ok) {
            return emptyResult("invalid", "history_corrupted", {
                diagnostics: validated.validation
            });
        }
        if (validated.entries.length === 0) {
            return emptyResult("empty", "no_history");
        }
        const participants = participantList(validated.entries);
        return participants.length > 0
            ? deepFreeze({ status: "available", reason: null, participants })
            : emptyResult("empty", "no_participants");
    }

    async function buildWeeklyOptionsParticipantHistoricalViewModel({
        history,
        selectedParticipantCode,
        selectedOptionType,
        period = "last20"
    } = {}) {
        if (!OPTION_TYPES.includes(selectedOptionType)) {
            return emptyResult("invalid", "invalid_option_type", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType: selectedOptionType || null,
                period: PERIODS.includes(period) ? period : null
            });
        }
        if (!PERIODS.includes(period)) {
            return emptyResult("invalid", "invalid_period", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType,
                period: null
            });
        }
        const validated = await validatedEntries(history);
        if (!validated.ok) {
            return emptyResult("invalid", "history_corrupted", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType,
                period,
                diagnostics: validated.validation
            });
        }
        if (validated.entries.length === 0) {
            return emptyResult("empty", "no_history", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType,
                period
            });
        }
        const participants = participantList(validated.entries);
        if (participants.length === 0) {
            return emptyResult("empty", "no_participants", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType,
                period
            });
        }
        if (!participants.some(item =>
            item.participantCode === selectedParticipantCode
        )) {
            return emptyResult("empty", "participant_not_found", {
                selectedParticipantCode: selectedParticipantCode || null,
                selectedOptionType,
                period,
                participants
            });
        }
        const selectedEntries = filterPeriod(validated.entries, period);
        const points = selectedEntries.map(entry => createPoint(
            entry, selectedParticipantCode, selectedOptionType
        ));
        const summary = summarize(points);
        const hasAny = summary.publishedObservations > 0;
        const complete = hasAny && points.every(point =>
            point.buy.published && point.sell.published
        );
        return deepFreeze({
            status: !hasAny ? "empty" : complete ? "available" : "partial",
            reason: !hasAny ? "no_records"
                : complete ? null : "partial_publication",
            selectedParticipantCode,
            selectedOptionType,
            period,
            participants,
            points,
            rollBoundaries: rollBoundaries(points),
            summary,
            notices: notices()
        });
    }

    return deepFreeze({
        OPTION_TYPES,
        PERIODS,
        listWeeklyOptionsParticipants,
        buildWeeklyOptionsParticipantHistoricalViewModel
    });
});
