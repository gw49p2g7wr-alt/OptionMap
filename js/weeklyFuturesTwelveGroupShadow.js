(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const historyApi = commonJs
        ? require("./weeklyFuturesHistory.js")
        : root.OptionMapWeeklyFuturesHistory;
    const brokerConfig = commonJs
        ? require("./weeklyBrokerConfig.js")
        : root.OptionMapWeeklyBrokerConfig;
    const api = factory(historyApi, brokerConfig);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesTwelveGroupShadow = api;
})(typeof window !== "undefined" ? window : globalThis,
function (historyApi, brokerConfig) {
    "use strict";

    const PRODUCT = "日経225先物";
    const REQUIRED_GROUP_COUNT = 12;
    const MINIMUM_AVAILABLE_GROUP_COUNT = 10;
    const NORMALIZATION = Object.freeze({
        method: "raw_score_diff_times_5_over_12",
        numeratorBase: 5,
        denominator: 12
    });
    const NORMALIZATION_BASE = 0.10;

    const participant = (key, participantCode, brokerName, displayName) =>
        Object.freeze({ key, participantCode, brokerName, displayName });
    const CORE_PARTICIPANTS = brokerConfig.PARTICIPANTS;
    const ADDITIONAL_PARTICIPANTS = Object.freeze({
        SG: participant("SG", "11788", "ソシエテＧ証券", "ソシエテG"),
        MORGAN_MUFG: participant(
            "MORGAN_MUFG", "12800", "モルガンＭＵＦＧ証券", "モルガンMUFG"
        ),
        SBI: participant("SBI", "11256", "ＳＢＩ証券", "SBI"),
        RAKUTEN: participant("RAKUTEN", "12057", "楽天証券", "楽天"),
        MITSUBISHI_UFJ: participant(
            "MITSUBISHI_UFJ", "11520", "三菱ＵＦＪ証券", "三菱UFJ"
        ),
        DAIWA: participant("DAIWA", "12000", "大和証券", "大和"),
        CITI: participant("CITI", "11792", "シティグループ証券", "シティ"),
        BARCLAYS: participant(
            "BARCLAYS", "12410", "バークレイズ証券", "バークレイズ"
        )
    });
    const singleGroup = (id, member, core = false) => Object.freeze({
        id, core, composite: false, members: Object.freeze([member])
    });
    const GROUP_DEFINITIONS = Object.freeze([
        ...CORE_PARTICIPANTS.map(item => singleGroup(item.key, item, true)),
        singleGroup("SG", ADDITIONAL_PARTICIPANTS.SG),
        singleGroup("MORGAN_MUFG", ADDITIONAL_PARTICIPANTS.MORGAN_MUFG),
        Object.freeze({
            id: "SBI_RAKUTEN",
            core: false,
            composite: true,
            members: Object.freeze([
                ADDITIONAL_PARTICIPANTS.SBI,
                ADDITIONAL_PARTICIPANTS.RAKUTEN
            ])
        }),
        singleGroup("MITSUBISHI_UFJ", ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ),
        singleGroup("DAIWA", ADDITIONAL_PARTICIPANTS.DAIWA),
        singleGroup("CITI", ADDITIONAL_PARTICIPANTS.CITI),
        singleGroup("BARCLAYS", ADDITIONAL_PARTICIPANTS.BARCLAYS)
    ]);
    const CORE_GROUP_IDS = Object.freeze(
        CORE_PARTICIPANTS.map(item => item.key)
    );

    function exact(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function getStrictObservation(data, member) {
        const expiryKeys = Array.isArray(data?.products?.[PRODUCT]?.expiryKeys)
            ? data.products[PRODUCT].expiryKeys : [];
        const records = Array.isArray(data?.records)
            ? data.records.filter(record => record.product === PRODUCT) : [];
        const codeRecords = records.filter(record =>
            record.participantCode === member.participantCode
        );
        const nameRecords = records.filter(record =>
            record.broker === member.brokerName
        );
        if (codeRecords.some(record => record.broker !== member.brokerName) ||
            nameRecords.some(record =>
                record.participantCode !== member.participantCode
            )) {
            return { complete: false, invalid: true,
                reason: "code_name_mismatch", byExpiry: {} };
        }
        const byExpiry = Object.fromEntries(expiryKeys.map(expiry => [expiry, {
            expiry, published: false, side: null, value: null
        }]));
        for (const record of codeRecords) {
            if (!byExpiry[record.expiry] || byExpiry[record.expiry].published) {
                return { complete: false, invalid: true,
                    reason: "duplicate_or_unknown_expiry", byExpiry };
            }
            byExpiry[record.expiry] = {
                expiry: record.expiry,
                published: true,
                side: record.side,
                value: record.value
            };
        }
        const complete = expiryKeys.length > 0 &&
            Object.values(byExpiry).every(item => item.published);
        return {
            complete,
            invalid: false,
            reason: expiryKeys.length === 0 ? "no_expiries"
                : complete ? null : "unpublished_expiry",
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

    function memberComparison(previousData, currentData, member) {
        const previousObservation = getStrictObservation(previousData, member);
        const currentObservation = getStrictObservation(currentData, member);
        const sameExpiries = exact(
            Object.keys(previousObservation.byExpiry || {}).sort(),
            Object.keys(currentObservation.byExpiry || {}).sort()
        );
        const previous = previousObservation.complete
            ? totals(previousObservation) : null;
        const current = currentObservation.complete
            ? totals(currentObservation) : null;
        const invalid = previousObservation.invalid || currentObservation.invalid;
        const available = Boolean(previous && current && sameExpiries && !invalid);
        return {
            key: member.key,
            participantCode: member.participantCode,
            brokerName: member.brokerName,
            available,
            previous,
            current,
            reason: available ? null : invalid
                ? previousObservation.reason || currentObservation.reason
                : !sameExpiries ? "expiry_set_changed"
                    : previousObservation.reason || currentObservation.reason ||
                        "unpublished"
        };
    }

    function scoreComparison(previous, current) {
        const delta = {
            sell: current.sell - previous.sell,
            buy: current.buy - previous.buy,
            net: current.net - previous.net
        };
        let status = "unconfirmed";
        if (delta.buy > 0 && delta.sell <= 0) status = "estimatedBuy";
        else if (delta.sell > 0 && delta.buy <= 0) status = "estimatedSell";
        else if (delta.buy < 0 && delta.sell === 0) status = "reducedBuy";
        else if (delta.sell < 0 && delta.buy === 0) status = "reducedSell";
        const previousTotal = Math.abs(previous.buy) + Math.abs(previous.sell);
        let contribution = 0;
        if (previousTotal > 0 && status === "estimatedBuy") {
            contribution = Math.abs(delta.buy) / previousTotal;
        } else if (previousTotal > 0 && status === "estimatedSell") {
            contribution = -Math.abs(delta.sell) / previousTotal;
        }
        return { previous, current, delta, status, contribution };
    }

    function sourceMetadata(previous, current) {
        return {
            previousSourceDate: previous?.sourceDate || null,
            currentSourceDate: current?.sourceDate || null,
            previousVersionKey: previous?.versionKey || null,
            currentVersionKey: current?.versionKey || null
        };
    }

    function unavailableGroup(group, members, reason, previous, current) {
        return {
            id: group.id,
            core: group.core,
            composite: group.composite,
            availability: false,
            members,
            status: "unconfirmed",
            contribution: null,
            reason,
            sourceMetadata: sourceMetadata(previous, current)
        };
    }

    function calculateGroup(previous, current, group) {
        const previousData = previous?.futureOpenInterest || previous?.data || previous;
        const currentData = current?.futureOpenInterest || current?.data || current;
        const members = group.members.map(member =>
            memberComparison(previousData, currentData, member)
        );
        if (members.some(member => !member.available)) {
            return unavailableGroup(
                group,
                members,
                group.composite ? "composite_group_unavailable"
                    : members.find(member => !member.available)?.reason ||
                        "group_unavailable",
                previous,
                current
            );
        }
        const previousTotals = members.reduce((sum, member) => ({
            sell: sum.sell + member.previous.sell,
            buy: sum.buy + member.previous.buy,
            net: sum.net + member.previous.net
        }), { sell: 0, buy: 0, net: 0 });
        const currentTotals = members.reduce((sum, member) => ({
            sell: sum.sell + member.current.sell,
            buy: sum.buy + member.current.buy,
            net: sum.net + member.current.net
        }), { sell: 0, buy: 0, net: 0 });
        return {
            id: group.id,
            core: group.core,
            composite: group.composite,
            availability: true,
            members,
            ...scoreComparison(previousTotals, currentTotals),
            reason: null,
            sourceMetadata: sourceMetadata(previous, current)
        };
    }

    function directionFor(score) {
        if (score >= 0.10) return "強い買い優勢";
        if (score >= 0.02) return "買い優勢";
        if (score <= -0.10) return "強い売り優勢";
        if (score <= -0.02) return "売り優勢";
        return "方向感薄い";
    }

    function qualityState(availableGroupCount) {
        if (availableGroupCount === 12) return "full";
        if (availableGroupCount === 11) return "partial_one_missing";
        if (availableGroupCount === 10) return "partial_two_missing";
        return "unavailable";
    }

    function calculatePair(previous, current) {
        const groupResults = GROUP_DEFINITIONS.map(group =>
            calculateGroup(previous, current, group)
        );
        const groups = Object.fromEntries(groupResults.map(group => [
            group.id, group
        ]));
        const missingGroups = groupResults.filter(group => !group.availability)
            .map(group => group.id);
        const availableGroups = groupResults.filter(group => group.availability);
        const availableGroupCount = availableGroups.length;
        const coreGroupsAvailable = CORE_GROUP_IDS.every(id =>
            groups[id].availability
        );
        const enoughGroups = availableGroupCount >= MINIMUM_AVAILABLE_GROUP_COUNT;
        const available = coreGroupsAvailable && enoughGroups;
        const compositeUnavailable = !groups.SBI_RAKUTEN.availability;
        const unavailableReasons = [];
        if (!coreGroupsAvailable) unavailableReasons.push("core_group_missing");
        if (!enoughGroups) unavailableReasons.push("insufficient_group_count");
        if (!available && compositeUnavailable) {
            unavailableReasons.push("composite_group_unavailable");
        }
        const rawScore = availableGroups.reduce(
            (sum, group) => sum + group.contribution, 0
        );
        const scaledScore = rawScore * NORMALIZATION.numeratorBase /
            NORMALIZATION.denominator;
        const absoluteTotal = availableGroups.reduce(
            (sum, group) => sum + Math.abs(group.contribution), 0
        );
        const dominant = availableGroups.length > 0
            ? [...availableGroups].sort((left, right) =>
                Math.abs(right.contribution) - Math.abs(left.contribution)
            )[0] : null;
        const exposedScore = available ? scaledScore : null;
        const normalizedDirection = available
            ? clamp(exposedScore / NORMALIZATION_BASE, -1, 1) : null;
        return {
            status: available ? "available" : "unavailable",
            available,
            qualityState: available ? qualityState(availableGroupCount)
                : "unavailable",
            reason: available ? null : unavailableReasons[0],
            unavailableReasons,
            requiredGroupCount: REQUIRED_GROUP_COUNT,
            availableGroupCount,
            missingGroupCount: missingGroups.length,
            missingGroups,
            coreGroupsAvailable,
            rawScoreDiff: available ? rawScore : null,
            scaledScoreDiff: exposedScore,
            normalization: NORMALIZATION,
            direction: available ? directionFor(exposedScore) : null,
            normalizedDirection,
            directionScore: available ? normalizedDirection * 100 : null,
            dominantGroup: available && absoluteTotal > 0 ? dominant.id : null,
            dominanceRatio: available && absoluteTotal > 0
                ? Math.abs(dominant.contribution) / absoluteTotal : null,
            sourceMetadata: sourceMetadata(previous, current),
            groups
        };
    }

    async function analyzeHistory(history) {
        if (!(await historyApi.validateHistory(history))) {
            return { status: "invalid_history", checkedRevisions: 0,
                checkedPairs: 0, pairReports: [] };
        }
        const versions = await historyApi.getActiveVersions(history);
        const pairReports = [];
        for (let index = 1; index < versions.length; index += 1) {
            pairReports.push(calculatePair(versions[index - 1], versions[index]));
        }
        return {
            status: versions.length < 2 ? "insufficient_history" : "complete",
            checkedRevisions: versions.length,
            checkedPairs: pairReports.length,
            pairReports
        };
    }

    return Object.freeze({
        PRODUCT,
        REQUIRED_GROUP_COUNT,
        MINIMUM_AVAILABLE_GROUP_COUNT,
        NORMALIZATION,
        NORMALIZATION_BASE,
        CORE_PARTICIPANTS,
        ADDITIONAL_PARTICIPANTS,
        GROUP_DEFINITIONS,
        CORE_GROUP_IDS,
        getStrictObservation,
        memberComparison,
        scoreComparison,
        calculateGroup,
        calculatePair,
        analyzeHistory
    });
});
