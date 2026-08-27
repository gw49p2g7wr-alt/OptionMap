(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const shadow = commonJs
        ? require("./weeklyFuturesTwelveGroupShadow.js")
        : root.OptionMapWeeklyFuturesTwelveGroupShadow;
    const weekly = commonJs
        ? require("./weeklyFutures.js")
        : root.OptionMapWeeklyFutures;
    const api = factory(shadow, weekly);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesTwelveGroupFormalPairAdapter = api;
})(typeof window !== "undefined" ? window : globalThis,
function (shadow, weekly) {
    "use strict";

    const ADAPTER_VERSION = 1;
    const CONFIG_VERSION = "weekly-scoring-groups-v1";
    const SCORING_VERSION = "twelve-group-shadow-scoring-v1";
    const MISSING_POLICY = Object.freeze({
        coreGroupsRequired: true,
        fullGroupCount: 12,
        minimumAvailableGroupCount: 10,
        missingZeroFilled: false,
        fixedNormalizationDenominator: 12
    });

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        for (const child of Object.values(value)) deepFreeze(child);
        return Object.freeze(value);
    }

    function canonicalize(value) {
        if (Array.isArray(value)) {
            return `[${value.map(canonicalize).join(",")}]`;
        }
        if (value && typeof value === "object") {
            return `{${Object.keys(value).sort().map(key =>
                `${JSON.stringify(key)}:${canonicalize(value[key])}`
            ).join(",")}}`;
        }
        return JSON.stringify(value);
    }

    async function sha256(value) {
        if (typeof require === "function") {
            return require("node:crypto").createHash("sha256")
                .update(value).digest("hex");
        }
        const bytes = new TextEncoder().encode(value);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)]
            .map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function configDescriptor(groupDefinitions = shadow?.GROUP_DEFINITIONS) {
        return {
            configVersion: CONFIG_VERSION,
            scoringVersion: SCORING_VERSION,
            product: shadow?.PRODUCT,
            requiredGroupCount: shadow?.REQUIRED_GROUP_COUNT,
            minimumAvailableGroupCount: shadow?.MINIMUM_AVAILABLE_GROUP_COUNT,
            normalization: shadow?.NORMALIZATION,
            normalizationBase: shadow?.NORMALIZATION_BASE,
            missingPolicy: MISSING_POLICY,
            groups: (groupDefinitions || []).map(group => ({
                id: group.id,
                core: group.core,
                composite: group.composite,
                members: group.members.map(member => ({
                    key: member.key,
                    participantCode: member.participantCode,
                    brokerName: member.brokerName
                }))
            }))
        };
    }

    async function createConfigFingerprint(
        descriptor = configDescriptor()
    ) {
        return `sha256:${await sha256(canonicalize(descriptor))}`;
    }

    function canonicalData(revision) {
        return revision?.canonicalData || revision?.futureOpenInterest ||
            revision?.data || null;
    }

    function revisionIdentity(revision) {
        return {
            sourceDate: revision?.sourceDate || null,
            versionKey: revision?.versionKey || null,
            signature: revision?.signature || null,
            activeVersionKey: revision?.activeVersionKey || null
        };
    }

    function validateRevision(revision, label) {
        if (!revision?.sourceDate || !revision?.versionKey) {
            return `${label}_identity_missing`;
        }
        if (!revision.signature) return `${label}_signature_missing`;
        if (!canonicalData(revision)) return `${label}_canonical_data_missing`;
        if (
            !revision.activeVersionKey ||
            revision.activeVersionKey !== revision.versionKey
        ) return `${label}_active_version_mismatch`;
        return null;
    }

    async function validateInput(input) {
        const previousError = validateRevision(input?.previous, "previous");
        if (previousError) return previousError;
        const currentError = validateRevision(input?.current, "current");
        if (currentError) return currentError;
        if (input?.formalContext?.sourceClass !== "formal_history") {
            return "formal_history_required";
        }
        if (input.formalContext.activeVersionMatched !== true) {
            return "active_pair_mismatch";
        }
        if (input.previous.sourceDate >= input.current.sourceDate) {
            return "source_date_order_invalid";
        }
        if (input.previous.versionKey === input.current.versionKey) {
            return "distinct_versions_required";
        }
        for (const [label, revision] of [
            ["previous", input.previous], ["current", input.current]
        ]) {
            const signature = await weekly.createSignature(
                canonicalData(revision)
            );
            if (!signature || signature !== revision.signature) {
                return `${label}_signature_mismatch`;
            }
            if (revision.versionKey !==
                `weekly-futures-v2|${revision.sourceDate}|sha256:${signature}`) {
                return `${label}_version_key_mismatch`;
            }
        }
        return null;
    }

    function contextIdentity(formalContext) {
        return {
            sourceClass: formalContext?.sourceClass || null,
            requestId: formalContext?.requestId ?? null,
            generation: formalContext?.generation ?? null,
            generationFingerprint:
                formalContext?.generationFingerprint ??
                formalContext?.fingerprint ?? null
        };
    }

    async function adaptFormalPair(input) {
        const descriptor = configDescriptor();
        const fingerprint = await createConfigFingerprint(descriptor);
        const configIdentity = {
            configVersion: CONFIG_VERSION,
            scoringVersion: SCORING_VERSION,
            fingerprint
        };
        const reason = await validateInput(input);
        const pairIdentity = {
            previous: revisionIdentity(input?.previous),
            current: revisionIdentity(input?.current),
            activeVersionMatched:
                input?.formalContext?.activeVersionMatched === true
        };
        const formalContext = contextIdentity(input?.formalContext);

        if (reason) {
            return deepFreeze({
                adapterVersion: ADAPTER_VERSION,
                available: false,
                status: "unavailable",
                reason,
                shadowOnly: true,
                referenceOnly: true,
                formalApplied: false,
                overallV2Eligible: false,
                pairIdentity,
                configIdentity,
                formalContext,
                result: null,
                diagnostics: {
                    inputBindingVerified: false,
                    calculationExecuted: false,
                    historySelected: false
                }
            });
        }

        const result = shadow.calculatePair({
            ...input.previous,
            futureOpenInterest: canonicalData(input.previous)
        }, {
            ...input.current,
            futureOpenInterest: canonicalData(input.current)
        });
        return deepFreeze({
            adapterVersion: ADAPTER_VERSION,
            available: result.available,
            status: result.status,
            reason: result.reason,
            shadowOnly: true,
            referenceOnly: true,
            formalApplied: false,
            overallV2Eligible: false,
            pairIdentity,
            configIdentity,
            formalContext,
            result,
            diagnostics: {
                inputBindingVerified: true,
                calculationExecuted: true,
                historySelected: false,
                major5PairComparable: true,
                qualityFactorDefined: false
            }
        });
    }

    return deepFreeze({
        ADAPTER_VERSION,
        CONFIG_VERSION,
        SCORING_VERSION,
        MISSING_POLICY,
        deepFreeze,
        canonicalize,
        configDescriptor,
        createConfigFingerprint,
        revisionIdentity,
        adaptFormalPair
    });
});
