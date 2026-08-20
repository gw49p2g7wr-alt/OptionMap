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
    if (root) root.OptionMapWeeklyFuturesParticipantCodeShadow = api;
})(typeof window !== "undefined" ? window : globalThis,
function (weekly, historyApi, brokerConfig) {
    "use strict";

    const REASON_TYPES = Object.freeze({
        NAME_MATCH_CODE_MISMATCH: "A_name_match_code_mismatch",
        CODE_MATCH_NAME_MISMATCH: "B_code_match_name_mismatch",
        PARTICIPANT_CODE_MISSING: "C_participant_code_missing",
        BROKER_NAME_MISSING: "D_broker_name_missing",
        COMPANY_RESULT_MISMATCH: "E_company_result_mismatch",
        GROUP_RESULT_MISMATCH: "F_group_result_mismatch",
        HISTORY_INVALID: "G_history_schema_version_problem",
        OTHER: "H_other"
    });
    const PRODUCT = "日経225先物";
    const RECORD_FIELDS = Object.freeze([
        "sourceDate", "product", "expiry", "side", "broker",
        "participantCode", "published", "value"
    ]);
    const COMPANY_FIELDS = Object.freeze([
        "previous", "current", "delta", "status",
        "comparisonAvailable", "reason"
    ]);
    const GROUP_FIELDS = Object.freeze([
        "available", "unavailableReason", "eligibleBrokerCount", "requiredBrokerCount",
        "buyScore", "sellScore", "scoreDiff", "direction"
    ]);

    function exact(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function recordView(sourceDate, record) {
        return {
            sourceDate,
            product: record.product,
            expiry: record.expiry,
            side: record.side,
            broker: record.broker,
            participantCode: record.participantCode,
            published: record.published,
            value: record.value
        };
    }

    function recordKey(record) {
        return RECORD_FIELDS.map(field => JSON.stringify(record[field])).join("|");
    }

    function selectRecords(data, participant, matching, sourceDate) {
        const records = Array.isArray(data?.records) ? data.records : [];
        return records.filter(record => matching === "brokerName"
            ? record.broker === participant.brokerName
            : record.participantCode === participant.participantCode
        ).map(record => recordView(sourceDate, record));
    }

    function selectionMismatches(version, participant) {
        const data = version.futureOpenInterest;
        const byName = selectRecords(
            data, participant, "brokerName", version.sourceDate
        );
        const byCode = selectRecords(
            data, participant, "participantCode", version.sourceDate
        );
        const nameKeys = new Set(byName.map(recordKey));
        const codeKeys = new Set(byCode.map(recordKey));
        const mismatches = [];

        for (const record of byName) {
            if (codeKeys.has(recordKey(record))) continue;
            mismatches.push({
                type: record.participantCode
                    ? REASON_TYPES.NAME_MATCH_CODE_MISMATCH
                    : REASON_TYPES.PARTICIPANT_CODE_MISSING,
                participantKey: participant.key,
                matching: "brokerName_only",
                record
            });
        }
        for (const record of byCode) {
            if (nameKeys.has(recordKey(record))) continue;
            mismatches.push({
                type: record.broker
                    ? REASON_TYPES.CODE_MATCH_NAME_MISMATCH
                    : REASON_TYPES.BROKER_NAME_MISSING,
                participantKey: participant.key,
                matching: "participantCode_only",
                record
            });
        }
        return { byName, byCode, mismatches };
    }

    function getCodeObservation(data, participant) {
        const product = data?.products?.[PRODUCT];
        const expiryKeys = Array.isArray(product?.expiryKeys)
            ? product.expiryKeys : [];
        const records = Array.isArray(data?.records)
            ? data.records.filter(record =>
                record.product === PRODUCT &&
                record.participantCode === participant.participantCode
            ) : [];
        const byExpiry = Object.fromEntries(expiryKeys.map(expiry => [expiry, {
            expiry,
            published: false,
            side: null,
            value: null
        }]));
        for (const record of records) {
            const current = byExpiry[record.expiry];
            if (!current || current.published) {
                return {
                    complete: false,
                    reason: "ambiguous_observation",
                    byExpiry
                };
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
            reason: expiryKeys.length === 0
                ? "no_expiries"
                : Object.values(byExpiry).some(item => !item.published)
                    ? "unpublished_expiry"
                    : null,
            byExpiry
        };
    }

    function totalsFromObservation(observation) {
        const totals = { sell: 0, buy: 0, net: 0 };
        for (const item of Object.values(observation.byExpiry || {})) {
            if (!item.published) return null;
            totals[item.side] += item.value;
        }
        totals.net = totals.buy - totals.sell;
        return totals;
    }

    function calculateParticipantCodeShadow(previousData, currentData) {
        const brokerDiffs = {};
        let buyScore = 0;
        let sellScore = 0;
        let eligibleBrokerCount = 0;

        for (const participant of brokerConfig.PARTICIPANTS) {
            const previousObservation = getCodeObservation(
                previousData, participant
            );
            const currentObservation = getCodeObservation(
                currentData, participant
            );
            const sameExpiries = exact(
                Object.keys(previousObservation.byExpiry || {}).sort(),
                Object.keys(currentObservation.byExpiry || {}).sort()
            );
            const previous = previousObservation.complete
                ? totalsFromObservation(previousObservation) : null;
            const current = currentObservation.complete
                ? totalsFromObservation(currentObservation) : null;

            if (!previous || !current || !sameExpiries) {
                brokerDiffs[participant.key] = {
                    brokerName: participant.brokerName,
                    previous,
                    current,
                    delta: null,
                    status: "unconfirmed",
                    comparisonAvailable: false,
                    reason: !sameExpiries
                        ? "expiry_set_changed"
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
            brokerDiffs[participant.key] = {
                brokerName: participant.brokerName,
                previous,
                current,
                delta,
                status,
                comparisonAvailable: true,
                reason: null
            };
        }

        const requiredBrokerCount = brokerConfig.PARTICIPANTS.length;
        const available = requiredBrokerCount > 0 &&
            eligibleBrokerCount === requiredBrokerCount;
        const scoreDiff = available ? buyScore - sellScore : null;
        let direction = null;
        if (available) {
            direction = "方向感薄い";
            if (scoreDiff >= 0.10) direction = "強い買い優勢";
            else if (scoreDiff >= 0.02) direction = "買い優勢";
            else if (scoreDiff <= -0.10) direction = "強い売り優勢";
            else if (scoreDiff <= -0.02) direction = "売り優勢";
        }
        return {
            available,
            reason: available ? null : "insufficient_published_observations",
            eligibleBrokerCount,
            requiredBrokerCount,
            brokerDiffs,
            buyScore: available ? buyScore : null,
            sellScore: available ? sellScore : null,
            scoreDiff,
            direction
        };
    }

    function groupView(result) {
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

    function compareRevisionPair(previous, current) {
        const mismatches = [];
        const selections = {};
        for (const participant of brokerConfig.PARTICIPANTS) {
            const previousSelection = selectionMismatches(
                previous, participant
            );
            const currentSelection = selectionMismatches(current, participant);
            selections[participant.key] = {
                previous: {
                    brokerNameCount: previousSelection.byName.length,
                    participantCodeCount: previousSelection.byCode.length
                },
                current: {
                    brokerNameCount: currentSelection.byName.length,
                    participantCodeCount: currentSelection.byCode.length
                }
            };
            mismatches.push(
                ...previousSelection.mismatches,
                ...currentSelection.mismatches
            );
        }

        const formal = weekly.calculateWeeklyBrokerJudgment(
            previous.futureOpenInterest,
            current.futureOpenInterest
        );
        const shadow = calculateParticipantCodeShadow(
            previous.futureOpenInterest,
            current.futureOpenInterest
        );

        for (const participant of brokerConfig.PARTICIPANTS) {
            const formalCompany = formal.brokerDiffs[participant.key];
            const shadowCompany = shadow.brokerDiffs[participant.key];
            const fields = COMPANY_FIELDS.filter(field =>
                !exact(formalCompany?.[field], shadowCompany?.[field])
            );
            if (fields.length > 0) {
                mismatches.push({
                    type: REASON_TYPES.COMPANY_RESULT_MISMATCH,
                    participantKey: participant.key,
                    fields,
                    formal: Object.fromEntries(fields.map(field => [
                        field, formalCompany?.[field]
                    ])),
                    shadow: Object.fromEntries(fields.map(field => [
                        field, shadowCompany?.[field]
                    ]))
                });
            }
        }
        const formalGroup = groupView(formal);
        const shadowGroup = groupView(shadow);
        const groupFields = GROUP_FIELDS.filter(field =>
            !exact(formalGroup[field], shadowGroup[field])
        );
        if (groupFields.length > 0) {
            mismatches.push({
                type: REASON_TYPES.GROUP_RESULT_MISMATCH,
                fields: groupFields,
                formal: Object.fromEntries(groupFields.map(field => [
                        field, formalGroup[field]
                ])),
                shadow: Object.fromEntries(groupFields.map(field => [
                        field, shadowGroup[field]
                ]))
            });
        }

        return {
            previousSourceDate: previous.sourceDate,
            currentSourceDate: current.sourceDate,
            matched: mismatches.length === 0,
            selections,
            formal,
            shadow,
            group: {
                formal: formalGroup,
                shadow: shadowGroup
            },
            mismatches
        };
    }

    async function validateHistoryShadow(history) {
        if (!(await historyApi.validateHistory(history))) {
            return {
                status: "invalid_history",
                checkedRevisions: 0,
                checkedPairs: 0,
                matchedPairs: 0,
                mismatchedPairs: 0,
                mismatchCounts: {
                    [REASON_TYPES.HISTORY_INVALID]: 1
                },
                pairReports: [],
                mismatches: [{ type: REASON_TYPES.HISTORY_INVALID }]
            };
        }

        const versions = await historyApi.getActiveVersions(history);
        const pairReports = [];
        for (let index = 1; index < versions.length; index += 1) {
            pairReports.push(compareRevisionPair(
                versions[index - 1], versions[index]
            ));
        }
        const mismatches = pairReports.flatMap(report =>
            report.mismatches.map(mismatch => ({
                previousSourceDate: report.previousSourceDate,
                currentSourceDate: report.currentSourceDate,
                ...mismatch
            }))
        );
        const mismatchCounts = {};
        for (const mismatch of mismatches) {
            mismatchCounts[mismatch.type] =
                (mismatchCounts[mismatch.type] || 0) + 1;
        }
        const matchedPairs = pairReports.filter(report => report.matched).length;
        const mismatchedPairs = pairReports.length - matchedPairs;
        return {
            status: mismatchedPairs > 0
                ? "mismatched"
                : versions.length < 2 ? "insufficient_history" : "matched",
            checkedRevisions: versions.length,
            checkedPairs: pairReports.length,
            matchedPairs,
            mismatchedPairs,
            mismatchCounts,
            pairReports,
            mismatches
        };
    }

    return Object.freeze({
        REASON_TYPES,
        RECORD_FIELDS,
        COMPANY_FIELDS,
        GROUP_FIELDS,
        selectRecords,
        calculateParticipantCodeShadow,
        compareRevisionPair,
        validateHistoryShadow
    });
});
