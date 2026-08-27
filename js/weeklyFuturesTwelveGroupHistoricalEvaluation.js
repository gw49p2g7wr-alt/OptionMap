(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const historyApi = commonJs
        ? require("./weeklyFuturesHistory.js")
        : root.OptionMapWeeklyFuturesHistory;
    const weekly = commonJs
        ? require("./weeklyFutures.js")
        : root.OptionMapWeeklyFutures;
    const adapter = commonJs
        ? require("./weeklyFuturesTwelveGroupFormalPairAdapter.js")
        : root.OptionMapWeeklyFuturesTwelveGroupFormalPairAdapter;
    const dualRun = commonJs
        ? require("./weeklyFuturesTwelveGroupDualRunRuntime.js")
        : root.OptionMapWeeklyFuturesTwelveGroupDualRunRuntime;
    const api = factory(historyApi, weekly, adapter, dualRun);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesTwelveGroupHistoricalEvaluation = api;
})(typeof window !== "undefined" ? window : globalThis,
function (historyApi, weekly, adapter, dualRun) {
    "use strict";

    const EVALUATION_VERSION = 1;
    const MAJOR5_NORMALIZATION_BASE = 0.10;
    const clone = value => value == null ? value
        : typeof structuredClone === "function" ? structuredClone(value)
            : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    function canonical(value) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") {
            return `{${Object.keys(value).sort().map(key =>
                `${JSON.stringify(key)}:${canonical(value[key])}`
            ).join(",")}}`;
        }
        return JSON.stringify(value);
    }
    async function hash(value) {
        const serialized = canonical(value);
        if (typeof require === "function") {
            return require("node:crypto").createHash("sha256")
                .update(serialized).digest("hex");
        }
        const digest = await crypto.subtle.digest(
            "SHA-256", new TextEncoder().encode(serialized)
        );
        return [...new Uint8Array(digest)]
            .map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    const finite = Number.isFinite;
    const clamp = value => Math.min(1, Math.max(-1, value));

    function revisionIdentity(version) {
        return {
            sourceDate: version.sourceDate,
            versionKey: version.versionKey,
            signature: version.signature,
            activeVersionKey: version.versionKey
        };
    }

    function formalPair(previous, current) {
        return {
            previous: {
                ...revisionIdentity(previous),
                canonicalData: previous.futureOpenInterest
            },
            current: {
                ...revisionIdentity(current),
                canonicalData: current.futureOpenInterest
            },
            formalContext: {
                sourceClass: "formal_history",
                activeVersionMatched: true,
                requestId: null,
                generation: null,
                generationFingerprint: null
            }
        };
    }

    function major5Result(previous, current) {
        const judgment = weekly.calculateWeeklyBrokerJudgment(previous, current);
        const normalizedDirection = judgment.available
            ? clamp(judgment.scoreDiff / MAJOR5_NORMALIZATION_BASE) : null;
        return {
            available: judgment.available,
            reason: judgment.reason,
            direction: judgment.direction,
            normalizedDirection,
            scoreDiff: judgment.scoreDiff,
            eligibleBrokerCount: judgment.eligibleBrokerCount,
            requiredBrokerCount: judgment.requiredBrokerCount,
            missingBrokers: Object.entries(judgment.brokerDiffs)
                .filter(([, value]) => value.comparisonAvailable !== true)
                .map(([key]) => key),
            brokers: Object.fromEntries(Object.entries(judgment.brokerDiffs)
                .map(([key, value]) => [key, {
                    brokerName: value.brokerName,
                    available: value.comparisonAvailable,
                    classification: value.status,
                    previous: clone(value.previous),
                    current: clone(value.current),
                    delta: clone(value.delta),
                    contribution: null,
                    contributionReason: "formal_result_not_exposed"
                }]))
        };
    }

    function samePairVerified(pair, adapted) {
        const expected = {
            previous: revisionIdentity(pair.previous),
            current: revisionIdentity(pair.current),
            activeVersionMatched: true
        };
        return canonical(expected) === canonical(adapted?.pairIdentity);
    }

    function emptyGroupSummary(groupDefinitions) {
        return Object.fromEntries(groupDefinitions.map(group => [group.id, {
            availablePairCount: 0,
            missingPairCount: 0,
            estimatedBuyCount: 0,
            estimatedSellCount: 0,
            reducedBuyCount: 0,
            reducedSellCount: 0,
            unconfirmedCount: 0,
            positiveContributionCount: 0,
            negativeContributionCount: 0,
            zeroContributionCount: 0,
            dominantGroupCount: 0
        }]));
    }

    function summarizePairs(pairs, groupDefinitions) {
        const agreementCounts = {
            same_direction: 0,
            different_strength: 0,
            opposite_direction: 0,
            zero_involved: 0,
            unavailable: 0
        };
        const missingByGroup = Object.fromEntries(
            groupDefinitions.map(group => [group.id, 0])
        );
        const groupSummaries = emptyGroupSummary(groupDefinitions);
        const dominantGroupCounts = {};
        const comparable = [];
        const dominance = [];
        for (const pair of pairs) {
            agreementCounts[pair.agreement] += 1;
            if (finite(pair.delta.normalizedDirection)) comparable.push(pair);
            for (const groupId of pair.groups12.missingGroups) {
                missingByGroup[groupId] += 1;
            }
            for (const [groupId, group] of Object.entries(
                pair.groups12.groups || {}
            )) {
                const summary = groupSummaries[groupId];
                if (group.availability) summary.availablePairCount += 1;
                else summary.missingPairCount += 1;
                const statusKey = `${group.status}Count`;
                if (statusKey in summary) summary[statusKey] += 1;
                if (finite(group.contribution)) {
                    if (group.contribution > 0) {
                        summary.positiveContributionCount += 1;
                    } else if (group.contribution < 0) {
                        summary.negativeContributionCount += 1;
                    } else {
                        summary.zeroContributionCount += 1;
                    }
                }
            }
            if (pair.groups12.dominantGroup) {
                const id = pair.groups12.dominantGroup;
                dominantGroupCounts[id] = (dominantGroupCounts[id] || 0) + 1;
                groupSummaries[id].dominantGroupCount += 1;
            }
            if (finite(pair.groups12.dominanceRatio)) {
                dominance.push(pair.groups12.dominanceRatio);
            }
        }
        const absoluteDeltas = comparable.map(pair => ({
            previousDate: pair.previousDate,
            currentDate: pair.currentDate,
            value: Math.abs(pair.delta.normalizedDirection)
        }));
        const maximum = absoluteDeltas.length
            ? [...absoluteDeltas].sort((left, right) => right.value - left.value)[0]
            : null;
        const reversals = pairs.filter(pair =>
            pair.agreement === "opposite_direction"
        );
        const differentStrength = pairs.filter(pair =>
            pair.agreement === "different_strength"
        ).sort((left, right) =>
            Math.abs(right.delta.normalizedDirection) -
            Math.abs(left.delta.normalizedDirection)
        );
        return {
            agreementCounts,
            averageAbsoluteDelta: absoluteDeltas.length
                ? absoluteDeltas.reduce((sum, item) => sum + item.value, 0) /
                    absoluteDeltas.length : null,
            maximumAbsoluteDelta: maximum,
            reversalPairs: reversals.map(pair => ({
                previousDate: pair.previousDate,
                currentDate: pair.currentDate,
                major5: clone(pair.major5),
                groups12: clone(pair.groups12),
                delta: pair.delta.normalizedDirection
            })),
            differentStrengthPairs: differentStrength.map(pair => ({
                previousDate: pair.previousDate,
                currentDate: pair.currentDate,
                major5Direction: pair.major5.direction,
                major5NormalizedDirection: pair.major5.normalizedDirection,
                groups12Direction: pair.groups12.direction,
                groups12NormalizedDirection: pair.groups12.normalizedDirection,
                delta: pair.delta.normalizedDirection,
                dominantGroup: pair.groups12.dominantGroup,
                missingGroups: clone(pair.groups12.missingGroups)
            })),
            missingByGroup,
            groupSummaries,
            dominantGroupCounts,
            dominanceRatio: dominance.length ? {
                average: dominance.reduce((sum, value) => sum + value, 0) /
                    dominance.length,
                maximum: Math.max(...dominance),
                minimum: Math.min(...dominance)
            } : { average: null, maximum: null, minimum: null }
        };
    }

    async function evaluateHistory(history) {
        const inputSnapshot = clone(history);
        if (!(await historyApi.validateHistory(history))) {
            return freeze({
                evaluationVersion: EVALUATION_VERSION,
                status: "invalid_history",
                reason: "formal_history_validation_failed",
                configIdentity: null,
                historyIdentity: null,
                pairCount: 0,
                comparablePairCount: 0,
                unavailablePairCount: 0,
                pairs: [],
                summary: null,
                diagnostics: {
                    historyValid: false,
                    activeRevisionsOnly: true,
                    adjacentPairsOnly: true,
                    inputMutated: canonical(inputSnapshot) !== canonical(history),
                    storageAccessed: false,
                    databaseAccessed: false,
                    fetchTriggered: false,
                    domMutated: false,
                    overallV2Calculated: false
                }
            });
        }
        const versions = await historyApi.getActiveVersions(history);
        const identities = versions.map(revisionIdentity);
        const historyIdentity = {
            source: history.source,
            entryCount: history.entries.length,
            revisionCount: history.entries.reduce((sum, entry) =>
                sum + entry.revisions.length, 0),
            activeVersionCount: versions.length,
            earliestSourceDate: versions[0]?.sourceDate || null,
            latestSourceDate: versions.at(-1)?.sourceDate || null,
            fingerprint: `sha256:${await hash(identities)}`
        };
        const pairs = [];
        let configIdentity = null;
        for (let index = 1; index < versions.length; index += 1) {
            const previous = versions[index - 1];
            const current = versions[index];
            const pair = formalPair(previous, current);
            const adapted = await adapter.adaptFormalPair(pair);
            const major5 = major5Result(previous, current);
            const verified = adapted.diagnostics?.inputBindingVerified === true &&
                samePairVerified({ previous, current }, adapted);
            const source = adapted.result;
            configIdentity ||= adapted.configIdentity;
            const groups12 = source ? {
                available: source.available,
                status: source.status,
                reason: source.reason,
                direction: source.direction,
                normalizedDirection: source.normalizedDirection,
                rawScoreDiff: source.rawScoreDiff,
                scaledScoreDiff: source.scaledScoreDiff,
                qualityState: source.qualityState,
                availableGroupCount: source.availableGroupCount,
                requiredGroupCount: source.requiredGroupCount,
                missingGroups: clone(source.missingGroups),
                dominantGroup: source.dominantGroup,
                dominanceRatio: source.dominanceRatio,
                groups: clone(source.groups)
            } : {
                available: false, status: "unavailable", reason: adapted.reason,
                direction: null, normalizedDirection: null, rawScoreDiff: null,
                scaledScoreDiff: null, qualityState: "unavailable",
                availableGroupCount: 0, requiredGroupCount: 12,
                missingGroups: [], dominantGroup: null, dominanceRatio: null,
                groups: {}
            };
            const comparable = verified && major5.available && groups12.available;
            const agreement = verified
                ? dualRun.classifyAgreement(major5, groups12) : "unavailable";
            pairs.push({
                previousDate: previous.sourceDate,
                currentDate: current.sourceDate,
                pairIdentity: {
                    previous: revisionIdentity(previous),
                    current: revisionIdentity(current)
                },
                samePairVerified: verified,
                major5,
                groups12,
                delta: {
                    normalizedDirection: comparable
                        ? groups12.normalizedDirection -
                            major5.normalizedDirection : null
                },
                agreement
            });
        }
        const summary = summarizePairs(pairs, adapter.configDescriptor().groups);
        const comparablePairCount = pairs.filter(pair =>
            finite(pair.delta.normalizedDirection)
        ).length;
        return freeze({
            evaluationVersion: EVALUATION_VERSION,
            status: "complete",
            reason: null,
            configIdentity: configIdentity || {
                configVersion: adapter.CONFIG_VERSION,
                scoringVersion: adapter.SCORING_VERSION,
                fingerprint: await adapter.createConfigFingerprint()
            },
            historyIdentity,
            pairCount: pairs.length,
            comparablePairCount,
            unavailablePairCount: pairs.length - comparablePairCount,
            pairs,
            summary,
            diagnostics: {
                historyValid: true,
                activeRevisionsOnly: true,
                adjacentPairsOnly: true,
                samePairVerifiedCount: pairs.filter(pair =>
                    pair.samePairVerified).length,
                major5ContributionExposed: false,
                qualityFactorInvented: false,
                inputMutated: canonical(inputSnapshot) !== canonical(history),
                storageAccessed: false,
                databaseAccessed: false,
                fetchTriggered: false,
                domMutated: false,
                overallV2Calculated: false
            }
        });
    }

    return freeze({
        EVALUATION_VERSION,
        MAJOR5_NORMALIZATION_BASE,
        revisionIdentity,
        formalPair,
        major5Result,
        samePairVerified,
        summarizePairs,
        evaluateHistory
    });
});
