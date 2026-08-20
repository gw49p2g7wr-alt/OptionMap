(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weekly = commonJs
        ? require("./weeklyFutures.js")
        : root.OptionMapWeeklyFutures;
    const historyApi = commonJs
        ? require("./weeklyFuturesHistory.js")
        : root.OptionMapWeeklyFuturesHistory;
    const brokerConfig = commonJs
        ? require("./weeklyBrokerConfig.js")
        : root.OptionMapWeeklyBrokerConfig;
    const api = factory(weekly, historyApi, brokerConfig);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesExpansionShadow = api;
})(typeof window !== "undefined" ? window : globalThis,
function (weekly, historyApi, brokerConfig) {
    "use strict";

    const PRODUCT = "日経225先物";
    const NORMALIZATION_BASE = 0.10;
    const CANDIDATES = Object.freeze({
        UBS: Object.freeze({
            key: "UBS",
            participantCode: "11746",
            brokerName: "ＵＢＳ証券",
            displayName: "UBS"
        }),
        SG: Object.freeze({
            key: "SG",
            participantCode: "11788",
            brokerName: "ソシエテＧ証券",
            displayName: "ソシエテG"
        })
    });
    const GROUPS = Object.freeze([
        Object.freeze({
            id: "A",
            label: "現行5社",
            participants: brokerConfig.PARTICIPANTS
        }),
        Object.freeze({
            id: "B",
            label: "5社 + UBS",
            participants: Object.freeze([
                ...brokerConfig.PARTICIPANTS, CANDIDATES.UBS
            ])
        }),
        Object.freeze({
            id: "C",
            label: "5社 + UBS + ソシエテG",
            participants: Object.freeze([
                ...brokerConfig.PARTICIPANTS,
                CANDIDATES.UBS,
                CANDIDATES.SG
            ])
        })
    ]);
    const GROUP_FIELDS = Object.freeze([
        "available", "unavailableReason", "eligibleBrokerCount",
        "requiredBrokerCount", "buyScore", "sellScore", "scoreDiff",
        "direction"
    ]);

    function exact(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function validateGroups(groups) {
        if (!Array.isArray(groups) || groups.length === 0) return false;
        return groups.every(group =>
            group && typeof group.id === "string" &&
            typeof group.label === "string" &&
            Array.isArray(group.participants) &&
            group.participants.length > 0 &&
            new Set(group.participants.map(item => item.key)).size ===
                group.participants.length &&
            new Set(group.participants.map(item => item.participantCode)).size ===
                group.participants.length &&
            group.participants.every(item =>
                item && typeof item.key === "string" &&
                /^\d+$/.test(item.participantCode) &&
                typeof item.brokerName === "string" && item.brokerName.length > 0
            )
        );
    }

    function getStrictCodeObservation(data, participant) {
        const expiryKeys = Array.isArray(data?.products?.[PRODUCT]?.expiryKeys)
            ? data.products[PRODUCT].expiryKeys : [];
        const productRecords = Array.isArray(data?.records)
            ? data.records.filter(record => record.product === PRODUCT) : [];
        const codeRecords = productRecords.filter(record =>
            record.participantCode === participant.participantCode
        );
        const nameRecords = productRecords.filter(record =>
            record.broker === participant.brokerName
        );
        if (codeRecords.some(record => record.broker !== participant.brokerName) ||
            nameRecords.some(record =>
                record.participantCode !== participant.participantCode
            )) {
            return { complete: false, invalid: true,
                reason: "code_name_mismatch", byExpiry: {} };
        }

        const byExpiry = Object.fromEntries(expiryKeys.map(expiry => [expiry, {
            expiry, published: false, side: null, value: null
        }]));
        for (const record of codeRecords) {
            const current = byExpiry[record.expiry];
            if (!current || current.published) {
                return { complete: false, invalid: true,
                    reason: "duplicate_or_unknown_expiry", byExpiry };
            }
            byExpiry[record.expiry] = {
                expiry: record.expiry,
                participantCode: record.participantCode,
                broker: record.broker,
                published: true,
                side: record.side,
                value: record.value
            };
        }
        return {
            complete: expiryKeys.length > 0 &&
                Object.values(byExpiry).every(item => item.published),
            invalid: false,
            reason: expiryKeys.length === 0
                ? "no_expiries"
                : Object.values(byExpiry).some(item => !item.published)
                    ? "unpublished_expiry" : null,
            byExpiry
        };
    }

    function totals(observation) {
        const result = { sell: 0, buy: 0, net: 0 };
        for (const item of Object.values(observation.byExpiry || {})) {
            if (!item.published) return null;
            result[item.side] += item.value;
        }
        result.net = result.buy - result.sell;
        return result;
    }

    function calculateGroup(previousData, currentData, group) {
        const companyResults = {};
        let buyScore = 0;
        let sellScore = 0;
        let eligibleBrokerCount = 0;
        let invalidIdentity = false;

        for (const participant of group.participants) {
            const previousObservation = getStrictCodeObservation(
                previousData, participant
            );
            const currentObservation = getStrictCodeObservation(
                currentData, participant
            );
            const sameExpiries = exact(
                Object.keys(previousObservation.byExpiry || {}).sort(),
                Object.keys(currentObservation.byExpiry || {}).sort()
            );
            const previous = previousObservation.complete
                ? totals(previousObservation) : null;
            const current = currentObservation.complete
                ? totals(currentObservation) : null;
            const identityInvalid = previousObservation.invalid ||
                currentObservation.invalid;
            invalidIdentity ||= identityInvalid;

            if (!previous || !current || !sameExpiries || identityInvalid) {
                companyResults[participant.key] = {
                    participantCode: participant.participantCode,
                    brokerName: participant.brokerName,
                    previous,
                    current,
                    delta: null,
                    status: "unconfirmed",
                    comparisonAvailable: false,
                    reason: identityInvalid
                        ? previousObservation.reason || currentObservation.reason
                        : !sameExpiries ? "expiry_set_changed"
                            : previousObservation.reason ||
                                currentObservation.reason || "unpublished"
                };
                continue;
            }

            eligibleBrokerCount += 1;
            const delta = {
                sell: current.sell - previous.sell,
                buy: current.buy - previous.buy,
                net: current.net - previous.net
            };
            let status = "unconfirmed";
            if (delta.buy > 0 && delta.sell <= 0) status = "estimatedBuy";
            else if (delta.sell > 0 && delta.buy <= 0) {
                status = "estimatedSell";
            } else if (delta.buy < 0 && delta.sell === 0) {
                status = "reducedBuy";
            } else if (delta.sell < 0 && delta.buy === 0) {
                status = "reducedSell";
            }
            const previousTotal = Math.abs(previous.buy) +
                Math.abs(previous.sell);
            if (previousTotal > 0 && status === "estimatedBuy") {
                buyScore += Math.abs(delta.buy) / previousTotal;
            }
            if (previousTotal > 0 && status === "estimatedSell") {
                sellScore += Math.abs(delta.sell) / previousTotal;
            }
            companyResults[participant.key] = {
                participantCode: participant.participantCode,
                brokerName: participant.brokerName,
                previous,
                current,
                delta,
                status,
                comparisonAvailable: true,
                reason: null
            };
        }

        const requiredBrokerCount = group.participants.length;
        const available = !invalidIdentity && requiredBrokerCount > 0 &&
            eligibleBrokerCount === requiredBrokerCount;
        const unavailableReason = available ? null : invalidIdentity
            ? "invalid_participant_identity"
            : "insufficient_published_observations";
        const scoreDiff = available ? buyScore - sellScore : null;
        let direction = null;
        if (available) {
            direction = "方向感薄い";
            if (scoreDiff >= 0.10) direction = "強い買い優勢";
            else if (scoreDiff >= 0.02) direction = "買い優勢";
            else if (scoreDiff <= -0.10) direction = "強い売り優勢";
            else if (scoreDiff <= -0.02) direction = "売り優勢";
        }
        const normalizedDirection = available
            ? clamp(scoreDiff / NORMALIZATION_BASE, -1, 1) : null;
        return {
            requiredBrokerCount,
            eligibleBrokerCount,
            available,
            unavailableReason,
            buyScore: available ? buyScore : null,
            sellScore: available ? sellScore : null,
            scoreDiff,
            direction,
            normalizedDirection,
            directionScore: available ? normalizedDirection * 100 : null,
            companyResults
        };
    }

    function formalGroupView(result) {
        return {
            available: result.available,
            unavailableReason: result.reason,
            eligibleBrokerCount: result.eligibleBrokerCount,
            requiredBrokerCount: result.requiredBrokerCount,
            buyScore: result.buyScore,
            sellScore: result.sellScore,
            scoreDiff: result.scoreDiff,
            direction: result.direction
        };
    }

    function groupView(result) {
        return Object.fromEntries(GROUP_FIELDS.map(field => [field, result[field]]));
    }

    function comparePair(previous, current, groups = GROUPS) {
        if (!validateGroups(groups)) throw new TypeError("invalid_groups");
        const results = Object.fromEntries(groups.map(group => [
            group.id,
            calculateGroup(
                previous.futureOpenInterest,
                current.futureOpenInterest,
                group
            )
        ]));
        const formalA = weekly.calculateWeeklyBrokerJudgment(
            previous.futureOpenInterest,
            current.futureOpenInterest
        );
        const groupAFormalMatch = exact(
            groupView(results.A), formalGroupView(formalA)
        );
        for (const group of groups.filter(item => item.id !== "A")) {
            const result = results[group.id];
            result.scoreDiffDeltaFromA = result.available && results.A.available
                ? result.scoreDiff - results.A.scoreDiff : null;
            result.directionChangedFromA = result.available && results.A.available
                ? result.direction !== results.A.direction : null;
            result.availabilityChangedFromA =
                result.available !== results.A.available;
        }
        return {
            previousSourceDate: previous.sourceDate,
            currentSourceDate: current.sourceDate,
            groupAFormalMatch,
            groups: results
        };
    }

    function summarizeGroup(pairReports, groupId) {
        const results = pairReports.map(report => report.groups[groupId]);
        const available = results.filter(result => result.available);
        const scoreDiffs = available.map(result => result.scoreDiff);
        const deltas = available.map(result => result.scoreDiffDeltaFromA)
            .filter(Number.isFinite);
        const average = values => values.length > 0
            ? values.reduce((sum, value) => sum + value, 0) / values.length
            : null;
        return {
            checkedPairs: results.length,
            availablePairs: available.length,
            unavailablePairs: results.length - available.length,
            bullishPairs: available.filter(result => result.scoreDiff >= 0.02).length,
            bearishPairs: available.filter(result => result.scoreDiff <= -0.02).length,
            neutralPairs: available.filter(result =>
                result.scoreDiff > -0.02 && result.scoreDiff < 0.02
            ).length,
            saturatedPositivePairs: available.filter(result =>
                result.directionScore === 100
            ).length,
            saturatedNegativePairs: available.filter(result =>
                result.directionScore === -100
            ).length,
            saturatedTotalPairs: available.filter(result =>
                Math.abs(result.directionScore) === 100
            ).length,
            directionChangedFromACount: groupId === "A" ? null :
                results.filter(result => result.directionChangedFromA).length,
            availabilityChangedFromACount: groupId === "A" ? null :
                results.filter(result => result.availabilityChangedFromA).length,
            averageAbsScoreDiff: average(scoreDiffs.map(Math.abs)),
            averageAbsScoreDeltaFromA: groupId === "A" ? null :
                average(deltas.map(Math.abs)),
            maxAbsScoreDeltaFromA: groupId === "A" ? null :
                deltas.length > 0 ? Math.max(...deltas.map(Math.abs)) : null,
            scoreDiffs
        };
    }

    async function analyzeHistory(history, groups = GROUPS) {
        if (!validateGroups(groups)) {
            return { status: "invalid_groups", checkedRevisions: 0,
                checkedPairs: 0, summaries: {}, pairReports: [] };
        }
        if (!(await historyApi.validateHistory(history))) {
            return { status: "invalid_history", checkedRevisions: 0,
                checkedPairs: 0, summaries: {}, pairReports: [] };
        }
        const versions = await historyApi.getActiveVersions(history);
        const pairReports = [];
        for (let index = 1; index < versions.length; index += 1) {
            pairReports.push(comparePair(versions[index - 1], versions[index], groups));
        }
        const summaries = Object.fromEntries(groups.map(group => [
            group.id, summarizeGroup(pairReports, group.id)
        ]));
        const formalMismatches = pairReports.filter(report =>
            !report.groupAFormalMatch
        ).map(report => ({
            previousSourceDate: report.previousSourceDate,
            currentSourceDate: report.currentSourceDate
        }));
        return {
            status: formalMismatches.length > 0 ? "formal_mismatch"
                : versions.length < 2 ? "insufficient_history" : "complete",
            checkedRevisions: versions.length,
            checkedPairs: pairReports.length,
            normalizationBase: NORMALIZATION_BASE,
            groupDefinitions: groups.map(group => ({
                id: group.id,
                label: group.label,
                participants: group.participants.map(participant => ({
                    key: participant.key,
                    participantCode: participant.participantCode,
                    brokerName: participant.brokerName,
                    displayName: participant.displayName
                }))
            })),
            summaries,
            formalMismatches,
            pairReports
        };
    }

    return Object.freeze({
        PRODUCT,
        NORMALIZATION_BASE,
        CANDIDATES,
        GROUPS,
        validateGroups,
        getStrictCodeObservation,
        calculateGroup,
        comparePair,
        summarizeGroup,
        analyzeHistory
    });
});
