(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const adapter = commonJs
        ? require("./weeklyFuturesTwelveGroupFormalPairAdapter.js")
        : root.OptionMapWeeklyFuturesTwelveGroupFormalPairAdapter;
    const api = factory(adapter);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapWeeklyFuturesTwelveGroupDualRunRuntime = api;
        const runtime = api.createRuntime();
        root.publishWeeklyFuturesTwelveGroupDualRun = runtime.publish;
        root.invalidateWeeklyFuturesTwelveGroupDualRun = runtime.invalidate;
        root.getWeeklyFuturesTwelveGroupDualRun = runtime.getState;
        root.getWeeklyFuturesTwelveGroupDualRunDiagnostics =
            runtime.getDiagnostics;
    }
})(typeof window !== "undefined" ? window : globalThis,
function (adapter) {
    "use strict";

    const RUNTIME_VERSION = 1;
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
        if (Array.isArray(value)) {
            return `[${value.map(canonical).join(",")}]`;
        }
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
    const text = value => typeof value === "string" && value.trim()
        ? value.trim() : null;

    function identity(revision) {
        return {
            sourceDate: revision?.sourceDate || null,
            versionKey: revision?.versionKey || null,
            signature: revision?.signature || null,
            activeVersionKey: revision?.activeVersionKey || null
        };
    }

    function pairIdentity(pair) {
        return {
            previous: identity(pair?.previous),
            current: identity(pair?.current),
            activeVersionMatched:
                pair?.formalContext?.activeVersionMatched === true
        };
    }

    async function createPairFingerprint(pair) {
        return `sha256:${await hash(pairIdentity(pair))}`;
    }

    function exact(left, right) {
        return canonical(left) === canonical(right);
    }

    function classifyAgreement(major5, groups12) {
        if (!major5?.available || !groups12?.available ||
            !finite(major5.normalizedDirection) ||
            !finite(groups12.normalizedDirection)) {
            return "unavailable";
        }
        const major = major5.normalizedDirection;
        const twelve = groups12.normalizedDirection;
        if (major === 0 || twelve === 0) return "zero_involved";
        if (Math.sign(major) !== Math.sign(twelve)) return "opposite_direction";
        return major === twelve ? "same_direction" : "different_strength";
    }

    function diagnosticsBase() {
        return {
            formalPairAvailable: false,
            major5Available: false,
            twelveGroupAvailable: false,
            samePairVerified: false,
            requestMatched: false,
            generationMatched: false,
            sourceFingerprintMatched: false,
            configVersion: adapter?.CONFIG_VERSION || null,
            scoringVersion: adapter?.SCORING_VERSION || null,
            availableGroupCount: null,
            missingGroups: [],
            agreement: "unavailable",
            shadowOnly: true,
            formalApplied: false,
            overallV2Applied: false,
            tradeDecisionEligible: false,
            storageAccessed: false,
            databaseAccessed: false,
            fetchTriggered: false,
            formalRecalculationTriggered: false,
            domMutated: false
        };
    }

    function validateInput(input) {
        const weeklyState = input?.weeklyFormalIdentity;
        const weekly = weeklyState?.fact;
        const major = input?.major5;
        if (weeklyState?.status !== "available" || !weekly) {
            return "weekly_formal_identity_unavailable";
        }
        if (major?.available !== true || major?.formalApplied !== true ||
            !finite(major.normalizedDirection) ||
            !finite(major.qualityFactor)) {
            return "major5_unavailable";
        }
        if (input.formalPair?.formalContext?.activeVersionMatched !== true ||
            weekly.activeVersionMatched !== true) {
            return "active_revision_mismatch";
        }
        const expectedPair = pairIdentity(input.formalPair);
        if (!exact(expectedPair, major.pairIdentity)) return "major5_pair_mismatch";
        const weeklyPair = {
            previous: {
                sourceDate: weekly.componentMetadata?.previous?.sourceDate,
                versionKey: weekly.previousVersionKey,
                signature: weekly.componentMetadata?.previous?.signature,
                activeVersionKey: weekly.previousVersionKey
            },
            current: {
                sourceDate: weekly.componentMetadata?.current?.sourceDate ||
                    weekly.sourceDate,
                versionKey: weekly.currentVersionKey,
                signature: weekly.currentSignature,
                activeVersionKey: weekly.currentVersionKey
            },
            activeVersionMatched: weekly.activeVersionMatched === true
        };
        if (!exact(expectedPair, weeklyPair)) return "weekly_pair_mismatch";
        const context = input.formalPair.formalContext;
        if (!text(context.requestId) || context.requestId !== weekly.requestId ||
            context.requestId !== major.requestId) return "request_mismatch";
        if (!Number.isSafeInteger(weeklyState.publicationGeneration) ||
            weeklyState.publicationGeneration <= 0 ||
            context.generation !== weeklyState.publicationGeneration) {
            return "generation_mismatch";
        }
        if (!text(weekly.sourceFingerprint) ||
            context.generationFingerprint !== weekly.sourceFingerprint ||
            major.sourceFingerprint !== weekly.sourceFingerprint) {
            return "source_fingerprint_mismatch";
        }
        return null;
    }

    function createRuntime({
        now = () => new Date().toISOString(),
        adaptFormalPair = adapter.adaptFormalPair
    } = {}) {
        let publicationGeneration = 0;
        let attempt = 0;
        let latestWeeklyGeneration = 0;
        let state = freeze({
            runtimeVersion: RUNTIME_VERSION,
            status: "empty",
            reason: "not_published",
            publicationGeneration: 0,
            publishedAt: null,
            pairIdentity: null,
            pairFingerprint: null,
            major5: null,
            groups12: null,
            comparison: null,
            diagnostics: diagnosticsBase()
        });

        const current = guard => {
            try {
                return typeof guard === "function" && guard() === true;
            } catch (_error) {
                return false;
            }
        };

        function unavailable(reason, input = null) {
            publicationGeneration += 1;
            const diagnostics = diagnosticsBase();
            diagnostics.formalPairAvailable = Boolean(input?.formalPair);
            diagnostics.major5Available = input?.major5?.available === true;
            state = freeze({
                runtimeVersion: RUNTIME_VERSION,
                status: "unavailable",
                reason,
                publicationGeneration,
                publishedAt: now(),
                pairIdentity: input?.formalPair
                    ? pairIdentity(input.formalPair) : null,
                pairFingerprint: null,
                major5: null,
                groups12: null,
                comparison: null,
                diagnostics
            });
            return freeze({ published: true, status: "unavailable", reason,
                generation: publicationGeneration });
        }

        async function publish(input = {}, { isCurrentPublication } = {}) {
            const ownAttempt = ++attempt;
            if (!current(isCurrentPublication)) {
                return freeze({ published: false, reason: "stale_publication" });
            }
            const inputReason = validateInput(input);
            if (inputReason) return unavailable(inputReason, input);
            const weeklyGeneration =
                input.weeklyFormalIdentity.publicationGeneration;
            if (weeklyGeneration < latestWeeklyGeneration) {
                return unavailable("stale_generation", input);
            }
            const pairFingerprint = await createPairFingerprint(input.formalPair);
            const adapted = await adaptFormalPair(input.formalPair);
            if (ownAttempt !== attempt || !current(isCurrentPublication)) {
                return freeze({ published: false, reason: "stale_publication" });
            }
            if (adapted.diagnostics?.inputBindingVerified !== true) {
                return unavailable(adapted.reason || "formal_pair_unavailable", input);
            }
            if (!exact(pairIdentity(input.formalPair), adapted.pairIdentity)) {
                return unavailable("adapter_pair_mismatch", input);
            }
            const major5 = {
                formal: true,
                formalApplied: true,
                available: true,
                direction: input.major5.direction,
                normalizedDirection: input.major5.normalizedDirection,
                qualityFactor: input.major5.qualityFactor,
                eligibleBrokerCount: input.major5.eligibleBrokerCount,
                requiredBrokerCount: input.major5.requiredBrokerCount
            };
            const source = adapted.result;
            const groups12 = {
                shadowOnly: true,
                referenceOnly: true,
                formalApplied: false,
                overallV2Eligible: false,
                available: source.available,
                status: source.status,
                reason: source.reason,
                direction: source.direction,
                normalizedDirection: source.normalizedDirection,
                qualityState: source.qualityState,
                availableGroupCount: source.availableGroupCount,
                requiredGroupCount: source.requiredGroupCount,
                missingGroups: clone(source.missingGroups),
                dominantGroup: source.dominantGroup,
                dominanceRatio: source.dominanceRatio
            };
            const agreement = classifyAgreement(major5, groups12);
            const comparisonAvailable = groups12.available === true;
            const comparison = {
                available: comparisonAvailable,
                normalizedDirectionDelta: comparisonAvailable
                    ? groups12.normalizedDirection - major5.normalizedDirection
                    : null,
                agreement,
                tradeDecisionEligible: false,
                overallV2Applied: false
            };
            const diagnostics = {
                ...diagnosticsBase(),
                formalPairAvailable: true,
                major5Available: true,
                twelveGroupAvailable: groups12.available,
                samePairVerified: true,
                requestMatched: true,
                generationMatched: true,
                sourceFingerprintMatched: true,
                configVersion: adapted.configIdentity.configVersion,
                scoringVersion: adapted.configIdentity.scoringVersion,
                availableGroupCount: groups12.availableGroupCount,
                missingGroups: clone(groups12.missingGroups),
                agreement
            };
            latestWeeklyGeneration = weeklyGeneration;
            publicationGeneration += 1;
            state = freeze({
                runtimeVersion: RUNTIME_VERSION,
                status: comparisonAvailable ? "available" : "unavailable",
                reason: comparisonAvailable ? null :
                    groups12.reason || "twelve_group_unavailable",
                publicationGeneration,
                publishedAt: now(),
                requestId: input.major5.requestId,
                weeklyPublicationGeneration: weeklyGeneration,
                sourceFingerprint: input.major5.sourceFingerprint,
                pairIdentity: pairIdentity(input.formalPair),
                pairFingerprint,
                configIdentity: adapted.configIdentity,
                major5,
                groups12,
                comparison,
                diagnostics
            });
            return freeze({ published: true, status: state.status,
                generation: publicationGeneration });
        }

        function invalidate(reason = "source_invalidated") {
            attempt += 1;
            return unavailable(reason);
        }

        const getState = () => freeze(clone(state));
        const getDiagnostics = () => freeze(clone(state.diagnostics));
        return Object.freeze({ publish, invalidate, getState, getDiagnostics });
    }

    return freeze({
        RUNTIME_VERSION,
        pairIdentity,
        createPairFingerprint,
        classifyAgreement,
        createRuntime
    });
});
