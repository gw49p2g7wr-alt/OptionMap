(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const overall = commonJs
        ? require("./overallJudgmentV2.js")
        : root?.OptionMapOverallJudgmentV2;
    const envelope = commonJs
        ? require("./overallV2FormalEnvelopeRuntime.js")
        : root?.OptionMapOverallV2FormalEnvelopeRuntime;
    const weekly = commonJs
        ? require("./weeklyFutures.js")
        : root?.OptionMapWeeklyFutures;
    const brokers = commonJs
        ? require("./weeklyBrokerConfig.js")
        : root?.OptionMapWeeklyBrokerConfig;
    const api = factory(overall, envelope, weekly, brokers);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapOverallTraceIdentityContract = api;
})(typeof window !== "undefined" ? window : globalThis,
function (overallApi, envelopeApi, weeklyApi, brokerApi) {
    "use strict";

    const CONTRACT_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const SERIES_ID = "overall-v2-trace";
    const LOGIC_ALGORITHM_NAME = "overall_v2";
    const SESSION_KINDS = Object.freeze(["day", "night", "closed"]);
    const READINESS_STATES = Object.freeze([
        "available", "unavailable", "invalid", "stale"
    ]);
    const REFERENCE_STATES = Object.freeze([
        "current_formal", "saved_reference", "fallback", "unavailable", "excluded"
    ]);

    const OPTION_SCORING_POLICY_VERSION = "option-market-judgment-current-v1";
    const ROUNDING_POLICY_VERSION = "overall-v2-js-round-after-clamp-v1";
    const CLAMP_POLICY_VERSION = "overall-v2-range-clamp-v1";
    const FALLBACK_POLICY_VERSION = "overall-v2-quality-origin-v1";
    const READINESS_POLICY_VERSION = "overall-v2-component-availability-v1";

    const object = value => value !== null && typeof value === "object" &&
        !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim()
        ? value.trim() : null;
    const finite = Number.isFinite;
    const date = value => typeof value === "string" &&
        /^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value) &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" &&
        Number.isFinite(Date.parse(value));
    const contract = value => typeof value === "string" &&
        /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
    const digest = value => typeof value === "string" &&
        /^(?:sha256:)?[0-9a-f]{64}$/.test(value);
    const versionKey = value => text(value) &&
        /\|sha256:[0-9a-f]{64}$/.test(value);
    const exact = (value, keys) => object(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
    function sameShape(value, template) {
        if (Array.isArray(template)) return Array.isArray(value) &&
            value.length === template.length && value.every((item, index) =>
                sameShape(item, template[index]));
        if (object(template)) return object(value) &&
            exact(value, Object.keys(template)) && Object.keys(template)
                .every(key => sameShape(value[key], template[key]));
        return typeof value === typeof template;
    }
    const clone = value => value == null ? value :
        typeof structuredClone === "function" ? structuredClone(value) :
            JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }

    function canonicalize(value) {
        if (value === null) return "null";
        if (typeof value === "string" || typeof value === "boolean") {
            return JSON.stringify(value);
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new TypeError("non_finite_number");
            return JSON.stringify(Object.is(value, -0) ? 0 : value);
        }
        if (Array.isArray(value)) {
            return `[${value.map(canonicalize).join(",")}]`;
        }
        if (object(value)) {
            return `{${Object.keys(value).sort().map(key =>
                `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        }
        throw new TypeError("unsupported_canonical_value");
    }

    async function sha256(value) {
        const serialized = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256")
                .update(serialized).digest("hex");
        }
        const result = await crypto.subtle.digest(
            "SHA-256", new TextEncoder().encode(serialized)
        );
        return [...new Uint8Array(result)]
            .map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function success(identity, hash) {
        return freeze({ accepted: true, reason: null, identity: freeze(identity), hash });
    }
    function failure(reason) {
        return freeze({ accepted: false, reason, identity: null, hash: null });
    }

    /*
     * These policy versions are introduced by T1 and freeze the exact current
     * behavior described in materialRules.  The rules, rather than the labels
     * alone, are part of the canonical hash.
     */
    const CURRENT_LOGIC_IDENTITY = freeze({
        contractVersion: CONTRACT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        algorithmName: LOGIC_ALGORITHM_NAME,
        algorithmVersion: envelopeApi?.OVERALL_V2_LOGIC_VERSION ||
            "overall-v2-weights-55-45-v1",
        plannedComponents: clone(overallApi?.CONFIG?.plannedComponents ||
            ["option", "weekly"]),
        configuredWeights: clone(overallApi?.CONFIG?.weights ||
            { option: 55, weekly: 45 }),
        normalizationBases: {
            option: overallApi?.CONFIG?.optionNormalizationBase ?? 8,
            weekly: overallApi?.CONFIG?.weeklyNormalizationBase ?? 0.10
        },
        confidenceWeights: clone(overallApi?.CONFIG?.confidenceWeights || {
            coverage: 0.35, quality: 0.30, evidence: 0.20, agreement: 0.15
        }),
        singleComponentAgreement:
            overallApi?.CONFIG?.singleComponentAgreement ?? 0.5,
        roundingPolicy: {
            version: ROUNDING_POLICY_VERSION,
            direction: "Math.round_after_clamp",
            confidence: "Math.round_after_clamp"
        },
        clampPolicy: {
            version: CLAMP_POLICY_VERSION,
            normalizedDirection: { minimum: -1, maximum: 1 },
            direction: { minimum: -100, maximum: 100 },
            confidence: { minimum: 0, maximum: 100 },
            qualityFactor: { minimum: 0, maximum: 1 },
            evidenceFactor: { minimum: 0, maximum: 1 }
        },
        optionScoringPolicyVersion: OPTION_SCORING_POLICY_VERSION,
        weeklyScoringVersion: weeklyApi?.SCORING_VERSION ?? 2,
        weeklyBrokerSetVersion: weeklyApi?.BROKER_SET_VERSION ?? 1,
        fallbackPolicyVersion: FALLBACK_POLICY_VERSION,
        readinessPolicyVersion: READINESS_POLICY_VERSION,
        materialRules: {
            overall: {
                weightedContribution: "normalizedDirection*baseWeight*qualityFactor",
                direction: "sum(weightedContribution)/sum(effectiveWeight)*100",
                coverage: "availableComponentCount/plannedComponentCount*100",
                quality: "baseWeightWeightedMeanOfAvailableComponents",
                evidence: "effectiveWeightWeightedMeanOfAvailableComponents",
                agreement: "one-minus-absolute-normalized-difference-over-two",
                directionLabels: { strongBuyMinimum: 60, buyMinimum: 20,
                    sellMaximum: -20, strongSellMaximum: -60 }
            },
            option: {
                currentPriceCoercion: "Number(value)||0",
                openInterestThresholds: { largeIncreaseExclusive: 1000,
                    smallIncreaseExclusive: 500, largeDecreaseExclusive: -1000,
                    anyDecreaseExclusive: 0 },
                openInterestPoints: { large: 2, small: 1 },
                distancePoints: [
                    { maximumInclusive: 100, points: 2 },
                    { maximumInclusive: 300, points: 1 }
                ],
                scoreDifferenceLabels: { strongBuyMinimum: 5, buyMinimum: 2,
                    sellMaximum: -2, strongSellMaximum: -5 },
                confidence: { base: 1, nonNeutralIncrement: 1,
                    sameStrikeIncrement: 1, strongestDifferenceMinimum: 1000,
                    strongestDifferenceIncrement: 1, nearestDistanceMaximum: 500,
                    nearestDistanceIncrement: 1, maximum: 5 },
                availability: "at_least_one_candidate_strike"
            },
            weekly: {
                schemaVersion: weeklyApi?.SCHEMA_VERSION ?? 2,
                parserVersion: weeklyApi?.PARSER_VERSION ?? 2,
                brokerSetVersion: weeklyApi?.BROKER_SET_VERSION ?? 1,
                scoringVersion: weeklyApi?.SCORING_VERSION ?? 2,
                requiredProduct: "日経225先物",
                requiredBrokerKeys: Object.keys(brokerApi?.BROKER_MAP || {
                    JPM: true, GS: true, NOMURA: true, BNP: true, ABN: true
                }),
                expiryPolicy: "exact_same_expiry_set_per_broker",
                scorePolicy: "absolute_directional_delta_over_previous_buy_plus_sell",
                directionThresholds: { strongBuyMinimum: 0.10, buyMinimum: 0.02,
                    sellMaximum: -0.02, strongSellMaximum: -0.10 }
            },
            quality: {
                option: { live: 1.00, fallback: 0.70 },
                weekly: { liveCurrent: 1.00, cacheCurrent: 0.95,
                    waitingUpdate: 0.50, remoteFailed: 0.70, pending: 0.70 }
            },
            readiness: {
                componentAvailable: "input_available_and_valid_and_effective_weight_positive",
                invalidPrecedence: "any_invalid_component_makes_overall_invalid_input",
                complete: "all_planned_components_available",
                partial: "at_least_one_but_not_all_components_available",
                unavailable: "no_available_components_or_zero_effective_weight"
            }
        }
    });

    const LOGIC_KEYS = ["contractVersion", "schemaVersion", "algorithmName",
        "algorithmVersion", "plannedComponents", "configuredWeights",
        "normalizationBases", "confidenceWeights", "singleComponentAgreement",
        "roundingPolicy", "clampPolicy", "optionScoringPolicyVersion",
        "weeklyScoringVersion", "weeklyBrokerSetVersion", "fallbackPolicyVersion",
        "readinessPolicyVersion", "materialRules"];

    function validLogicIdentity(value) {
        if (!exact(value, LOGIC_KEYS) || !sameShape(value, CURRENT_LOGIC_IDENTITY) ||
            value.contractVersion !== CONTRACT_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION || value.algorithmName !== LOGIC_ALGORITHM_NAME ||
            !text(value.algorithmVersion) || !text(value.optionScoringPolicyVersion) ||
            !text(value.fallbackPolicyVersion) || !text(value.readinessPolicyVersion) ||
            !Array.isArray(value.plannedComponents) ||
            JSON.stringify(value.plannedComponents) !== JSON.stringify(["option", "weekly"]) ||
            !object(value.configuredWeights) || !object(value.normalizationBases) ||
            !object(value.confidenceWeights) || !object(value.roundingPolicy) ||
            !object(value.clampPolicy) || !object(value.materialRules) ||
            !Number.isSafeInteger(value.weeklyScoringVersion) ||
            !Number.isSafeInteger(value.weeklyBrokerSetVersion)) return false;
        const numbers = [value.configuredWeights.option, value.configuredWeights.weekly,
            value.normalizationBases.option, value.normalizationBases.weekly,
            value.confidenceWeights.coverage, value.confidenceWeights.quality,
            value.confidenceWeights.evidence, value.confidenceWeights.agreement,
            value.singleComponentAgreement];
        return numbers.every(finite) && value.configuredWeights.option > 0 &&
            value.configuredWeights.weekly > 0 && value.normalizationBases.option > 0 &&
            value.normalizationBases.weekly > 0 && value.singleComponentAgreement >= 0 &&
            value.singleComponentAgreement <= 1;
    }

    async function createLogicIdentity(value = CURRENT_LOGIC_IDENTITY) {
        const identity = clone(value);
        if (!validLogicIdentity(identity)) return failure("logic_identity_invalid");
        try { return success(identity, await sha256(identity)); }
        catch (_) { return failure("logic_identity_invalid"); }
    }

    const QRI_KEYS = ["contract", "tradingDate", "pageUpdatedAt", "revisionIdentity",
        "versionKey", "canonicalSignature"];
    const PREVIOUS_QRI_KEYS = ["contract", "sourceDate", "revisionIdentity",
        "versionKey", "canonicalSignature"];
    const QUOTE_KEYS = ["source", "contract", "quotedAt", "value", "versionKey",
        "quoteSignature"];
    const OPTION_KEYS = ["contractVersion", "schemaVersion", "sourceFamily",
        "readinessState", "reason", "referenceState", "currentQri",
        "previousComparisonQri", "comparisonFingerprint", "futuresQuote"];

    function currentQri(value) {
        if (!exact(value, QRI_KEYS) || !contract(value.contract) ||
            !date(value.tradingDate) || !timestamp(value.pageUpdatedAt) ||
            !versionKey(value.revisionIdentity) || !versionKey(value.versionKey) ||
            value.revisionIdentity !== value.versionKey || !digest(value.canonicalSignature)) return null;
        return clone(value);
    }
    function previousQri(value) {
        if (!exact(value, PREVIOUS_QRI_KEYS) || !contract(value.contract) ||
            !timestamp(value.sourceDate) || !versionKey(value.revisionIdentity) ||
            !versionKey(value.versionKey) || value.revisionIdentity !== value.versionKey ||
            !digest(value.canonicalSignature)) return null;
        return clone(value);
    }
    function quote(value) {
        if (!exact(value, QUOTE_KEYS) || value.source !== "qri-nikkei225-futures" ||
            !contract(value.contract) || !timestamp(value.quotedAt) ||
            !finite(value.value) || value.value <= 0 || !versionKey(value.versionKey) ||
            !digest(value.quoteSignature)) return null;
        return clone(value);
    }

    function normalizeOptionInput(value) {
        if (!object(value) || value.contractVersion !== CONTRACT_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION ||
            !READINESS_STATES.includes(value.readinessState) ||
            !REFERENCE_STATES.includes(value.referenceState)) return null;
        const available = value.readinessState === "available";
        if ((available && value.reason != null) || (!available && !text(value.reason))) return null;
        if (!available) return { contractVersion: CONTRACT_VERSION,
            schemaVersion: SCHEMA_VERSION, sourceFamily: "qri_option_open_interest",
            readinessState: value.readinessState, reason: text(value.reason),
            referenceState: value.referenceState, currentQri: null,
            previousComparisonQri: null, comparisonFingerprint: null, futuresQuote: null };
        const current = currentQri(value.currentQri);
        const previous = previousQri(value.previousComparisonQri);
        const futures = quote(value.futuresQuote);
        if (!current || !previous || !futures || !digest(value.comparisonFingerprint) ||
            current.contract !== previous.contract ||
            Date.parse(previous.sourceDate) >= Date.parse(current.pageUpdatedAt)) return null;
        return { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION,
            sourceFamily: "qri_option_open_interest", readinessState: "available",
            reason: null, referenceState: value.referenceState, currentQri: current,
            previousComparisonQri: previous,
            comparisonFingerprint: value.comparisonFingerprint, futuresQuote: futures };
    }

    async function createOptionInputIdentity(value = {}) {
        const identity = normalizeOptionInput({ contractVersion: value.contractVersion ?? CONTRACT_VERSION,
            schemaVersion: value.schemaVersion ?? SCHEMA_VERSION, ...value });
        if (!identity) return failure("option_identity_invalid");
        try { return success(identity, await sha256(identity)); }
        catch (_) { return failure("option_identity_invalid"); }
    }

    const WEEKLY_REVISION_KEYS = ["sourceDate", "versionKey", "signature"];
    const WEEKLY_KEYS = ["contractVersion", "schemaVersion", "sourceFamily",
        "readinessState", "reason", "previous", "current", "activeVersionKey",
        "sourceSchemaVersion", "parserVersion", "brokerSetVersion", "scoringVersion",
        "contractExpiries"];
    function weeklyRevision(value) {
        if (!exact(value, WEEKLY_REVISION_KEYS) || !date(value.sourceDate) ||
            !versionKey(value.versionKey) || !digest(value.signature)) return null;
        return clone(value);
    }
    function expiryList(value) {
        if (!Array.isArray(value) || !value.every(contract)) return null;
        const normalized = [...new Set(value)].sort();
        return normalized.length === value.length &&
            JSON.stringify(normalized) === JSON.stringify(value) ? normalized : null;
    }
    function normalizeWeeklyInput(value) {
        if (!object(value) || value.contractVersion !== CONTRACT_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION ||
            !READINESS_STATES.includes(value.readinessState)) return null;
        const available = value.readinessState === "available";
        if ((available && value.reason != null) || (!available && !text(value.reason))) return null;
        if (!available) return { contractVersion: CONTRACT_VERSION,
            schemaVersion: SCHEMA_VERSION, sourceFamily: "jpx_weekly_index_futures",
            readinessState: value.readinessState, reason: text(value.reason), previous: null,
            current: null, activeVersionKey: null, sourceSchemaVersion: null,
            parserVersion: null, brokerSetVersion: null, scoringVersion: null,
            contractExpiries: [] };
        const previous = weeklyRevision(value.previous);
        const current = weeklyRevision(value.current);
        const expiries = expiryList(value.contractExpiries);
        if (!previous || !current || !expiries || previous.sourceDate >= current.sourceDate ||
            previous.versionKey === current.versionKey || value.activeVersionKey !== current.versionKey ||
            ![value.sourceSchemaVersion, value.parserVersion, value.brokerSetVersion,
                value.scoringVersion].every(item => Number.isSafeInteger(item) && item > 0)) return null;
        return { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION,
            sourceFamily: "jpx_weekly_index_futures", readinessState: "available",
            reason: null, previous, current, activeVersionKey: value.activeVersionKey,
            sourceSchemaVersion: value.sourceSchemaVersion, parserVersion: value.parserVersion,
            brokerSetVersion: value.brokerSetVersion, scoringVersion: value.scoringVersion,
            contractExpiries: expiries };
    }

    async function createWeeklyInputIdentity(value = {}) {
        const identity = normalizeWeeklyInput({ contractVersion: value.contractVersion ?? CONTRACT_VERSION,
            schemaVersion: value.schemaVersion ?? SCHEMA_VERSION, ...value });
        if (!identity) return failure("weekly_identity_invalid");
        try { return success(identity, await sha256(identity)); }
        catch (_) { return failure("weekly_identity_invalid"); }
    }

    const INPUT_KEYS = ["contractVersion", "schemaVersion", "option", "weekly"];
    function validOptionIdentity(value) {
        return exact(value, OPTION_KEYS) &&
            canonicalize(normalizeOptionInput(value)) === canonicalize(value);
    }
    function validWeeklyIdentity(value) {
        return exact(value, WEEKLY_KEYS) &&
            canonicalize(normalizeWeeklyInput(value)) === canonicalize(value);
    }
    async function createInputSetIdentity(value = {}) {
        const optionResult = value.option?.accepted !== undefined ? value.option :
            await createOptionInputIdentity(value.option);
        const weeklyResult = value.weekly?.accepted !== undefined ? value.weekly :
            await createWeeklyInputIdentity(value.weekly);
        if (optionResult?.accepted !== true || weeklyResult?.accepted !== true ||
            !validOptionIdentity(optionResult.identity) ||
            !validWeeklyIdentity(weeklyResult.identity)) return failure("input_set_identity_invalid");
        const identity = { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION,
            option: clone(optionResult.identity), weekly: clone(weeklyResult.identity) };
        try { return success(identity, await sha256(identity)); }
        catch (_) { return failure("input_set_identity_invalid"); }
    }

    const SLOT_KEYS = ["contractVersion", "schemaVersion", "calendarDay", "sessionIdentity"];
    const SESSION_KEYS = ["kind", "key"];
    function createObservationSlot(value = {}) {
        const identity = { contractVersion: value.contractVersion ?? CONTRACT_VERSION,
            schemaVersion: value.schemaVersion ?? SCHEMA_VERSION,
            calendarDay: value.calendarDay,
            sessionIdentity: object(value.sessionIdentity) ? {
                kind: value.sessionIdentity.kind, key: value.sessionIdentity.key
            } : null };
        if (identity.contractVersion !== CONTRACT_VERSION || identity.schemaVersion !== SCHEMA_VERSION ||
            !date(identity.calendarDay) || !exact(identity.sessionIdentity, SESSION_KEYS) ||
            !SESSION_KINDS.includes(identity.sessionIdentity.kind) ||
            !date(identity.sessionIdentity.key)) return failure("observation_slot_invalid");
        return success(identity, null);
    }

    const RECORD_KEYS = ["contractVersion", "schemaVersion", "observationSlot",
        "logicIdentity", "logicIdentityHash", "inputSetIdentity", "inputSetIdentityHash",
        "observationId"];
    async function createObservationIdentity(value = {}) {
        const logicSource = value.logic?.accepted === true
            ? value.logic.identity : value.logic;
        const inputSource = value.inputs?.accepted === true
            ? value.inputs.identity : value.inputs;
        const slotSource = value.observationSlot?.accepted === true
            ? value.observationSlot.identity : value.observationSlot;
        const logicResult = await createLogicIdentity(logicSource || CURRENT_LOGIC_IDENTITY);
        const inputResult = await createInputSetIdentity(inputSource);
        const slotResult = createObservationSlot(slotSource);
        if (logicResult?.accepted !== true || inputResult?.accepted !== true ||
            slotResult?.accepted !== true) return failure("observation_identity_invalid");
        const seed = { observationSlot: slotResult.identity,
            inputSetIdentityHash: inputResult.hash, logicIdentityHash: logicResult.hash };
        try {
            const observationId = `${SERIES_ID}|sha256:${await sha256(seed)}`;
            const identity = { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION,
                observationSlot: clone(slotResult.identity), logicIdentity: clone(logicResult.identity),
                logicIdentityHash: logicResult.hash, inputSetIdentity: clone(inputResult.identity),
                inputSetIdentityHash: inputResult.hash, observationId };
            return success(identity, observationId.slice(observationId.lastIndexOf(":") + 1));
        } catch (_) { return failure("observation_identity_invalid"); }
    }

    async function validRecord(value) {
        if (!exact(value, RECORD_KEYS) || value.contractVersion !== CONTRACT_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION || !digest(value.logicIdentityHash) ||
            !digest(value.inputSetIdentityHash) ||
            !new RegExp(`^${SERIES_ID}\\|sha256:[0-9a-f]{64}$`).test(value.observationId || "")) return false;
        const rebuilt = await createObservationIdentity({ logic: value.logicIdentity,
            inputs: value.inputSetIdentity, observationSlot: value.observationSlot });
        return rebuilt.accepted === true && rebuilt.identity.observationId === value.observationId &&
            rebuilt.identity.logicIdentityHash === value.logicIdentityHash &&
            rebuilt.identity.inputSetIdentityHash === value.inputSetIdentityHash;
    }

    function readinessView(inputSet) {
        return { option: { readinessState: inputSet.option.readinessState,
            reason: inputSet.option.reason, referenceState: inputSet.option.referenceState },
        weekly: { readinessState: inputSet.weekly.readinessState,
            reason: inputSet.weekly.reason } };
    }
    function marketView(inputSet) {
        const value = clone(inputSet);
        value.option.readinessState = null; value.option.reason = null;
        value.option.referenceState = null; value.weekly.readinessState = null;
        value.weekly.reason = null;
        return value;
    }
    function stableComponentMarketChanged(previous, current) {
        for (const name of ["option", "weekly"]) {
            const left = previous[name]; const right = current[name];
            if (left.readinessState !== right.readinessState ||
                (name === "option" && left.referenceState !== right.referenceState)) continue;
            const container = { contractVersion: previous.contractVersion,
                schemaVersion: previous.schemaVersion, option: clone(previous.option),
                weekly: clone(previous.weekly) };
            const comparison = clone(container);
            comparison[name] = clone(right);
            if (canonicalize(marketView(container)) !== canonicalize(marketView(comparison))) {
                return true;
            }
        }
        return false;
    }
    async function classifyIdentityChange(previous, current) {
        if (!(await validRecord(previous)) || !(await validRecord(current))) {
            return "not_comparable";
        }
        const logicChanged = previous.logicIdentityHash !== current.logicIdentityHash;
        const inputChanged = previous.inputSetIdentityHash !== current.inputSetIdentityHash;
        if (!logicChanged && !inputChanged) return "same";
        const readinessChanged = canonicalize(readinessView(previous.inputSetIdentity)) !==
            canonicalize(readinessView(current.inputSetIdentity));
        if (logicChanged && inputChanged) return "mixed";
        if (logicChanged) return "logic_change";
        if (readinessChanged) return stableComponentMarketChanged(previous.inputSetIdentity,
            current.inputSetIdentity) ? "mixed" : "readiness_change";
        return "market_data_change";
    }

    function sameGeneration(left, right, source) {
        if (!object(left) || !object(right) || left.source !== source || right.source !== source ||
            !Number.isSafeInteger(left.sequence) || !Number.isSafeInteger(right.sequence) ||
            !text(left.fingerprint) || !text(right.fingerprint)) return false;
        return left.sequence === right.sequence && left.fingerprint === right.fingerprint &&
            left.current === true && right.current === true;
    }

    async function adaptCurrentEnvelope(input = {}) {
        const value = input.envelope;
        if (!object(value) || value.envelopeVersion !== envelopeApi?.ENVELOPE_VERSION ||
            value.formalApplied !== true || value.identityVerified !== true ||
            !digest(value.inputFingerprint)) return failure("envelope_invalid");
        const optionComponent = value.result?.components?.option;
        const weeklyComponent = value.result?.components?.weekly;
        let option;
        if (optionComponent?.available === true) {
            const evidence = input.optionComparisonEnvelope;
            const fact = input.futuresQuoteFact;
            if (evidence?.envelopeVersion !== 1 || evidence.available !== true ||
                fact?.factVersion !== 1 || fact.available !== true ||
                fact.identityVerified !== true || fact.acquisitionVerified !== true ||
                value.optionSourceIdentity?.canonicalVersionKey !== evidence.current?.versionKey ||
                value.optionSourceIdentity?.canonicalSignature !== evidence.current?.canonicalSignature ||
                !sameGeneration(value.optionSourceIdentity?.generation, evidence.generation, "qri"))
                return failure("option_adapter_binding_invalid");
            option = await createOptionInputIdentity({ readinessState: "available", reason: null,
                referenceState: optionComponent.metadata?.usingFallback === true ? "fallback" : "current_formal",
                currentQri: { contract: evidence.current.contract,
                    tradingDate: evidence.current.tradingDate,
                    pageUpdatedAt: evidence.current.pageUpdatedAt,
                    revisionIdentity: evidence.current.revisionIdentity,
                    versionKey: evidence.current.versionKey,
                    canonicalSignature: evidence.current.canonicalSignature },
                previousComparisonQri: { contract: evidence.previous.contract,
                    sourceDate: evidence.previous.sourceDate,
                    revisionIdentity: evidence.previous.revisionIdentity,
                    versionKey: evidence.previous.versionKey,
                    canonicalSignature: evidence.previous.canonicalSignature },
                comparisonFingerprint: evidence.evidenceFingerprint,
                futuresQuote: { source: fact.source || "qri-nikkei225-futures",
                    contract: fact.quoteIdentity?.contract, quotedAt: fact.quoteIdentity?.quotedAtNormalized,
                    value: fact.quoteIdentity?.value, versionKey: fact.quoteIdentity?.versionKey,
                    quoteSignature: fact.quoteIdentity?.quoteSignature } });
        } else option = await createOptionInputIdentity({ readinessState: "unavailable",
            reason: optionComponent?.notes?.[0] || "component_unavailable",
            referenceState: "unavailable" });
        if (!option.accepted) return option;

        let weekly;
        if (weeklyComponent?.available === true) {
            const fact = input.weeklyFact;
            const metadata = weeklyComponent.metadata;
            if (!object(fact) || value.weeklySourceIdentity?.currentVersionKey !== fact.currentVersionKey ||
                value.weeklySourceIdentity?.previousVersionKey !== fact.previousVersionKey ||
                value.weeklySourceIdentity?.currentSignature !== fact.currentSignature ||
                !sameGeneration(value.weeklySourceIdentity?.generation, fact.generation, "weekly") ||
                metadata?.previous?.versionKey !== fact.previousVersionKey ||
                metadata?.current?.versionKey !== fact.currentVersionKey)
                return failure("weekly_adapter_binding_invalid");
            weekly = await createWeeklyInputIdentity({ readinessState: "available", reason: null,
                previous: { sourceDate: metadata.previous.sourceDate,
                    versionKey: metadata.previous.versionKey, signature: metadata.previous.signature },
                current: { sourceDate: metadata.current.sourceDate,
                    versionKey: metadata.current.versionKey, signature: metadata.current.signature },
                activeVersionKey: metadata.activeVersionKey,
                sourceSchemaVersion: weeklyApi?.SCHEMA_VERSION,
                parserVersion: weeklyApi?.PARSER_VERSION,
                brokerSetVersion: weeklyApi?.BROKER_SET_VERSION,
                scoringVersion: weeklyApi?.SCORING_VERSION,
                contractExpiries: input.weeklyContractExpiries || [] });
        } else weekly = await createWeeklyInputIdentity({ readinessState: "unavailable",
            reason: weeklyComponent?.notes?.[0] || "component_unavailable" });
        if (!weekly.accepted) return weekly;
        return createObservationIdentity({ logic: CURRENT_LOGIC_IDENTITY,
            inputs: { option, weekly }, observationSlot: input.observationSlot });
    }

    return freeze({ CONTRACT_VERSION, SCHEMA_VERSION, SIGNATURE_ALGORITHM, SERIES_ID,
        SESSION_KINDS, READINESS_STATES, REFERENCE_STATES,
        OPTION_SCORING_POLICY_VERSION, ROUNDING_POLICY_VERSION, CLAMP_POLICY_VERSION,
        FALLBACK_POLICY_VERSION, READINESS_POLICY_VERSION, CURRENT_LOGIC_IDENTITY,
        canonicalize, sha256, createLogicIdentity, createOptionInputIdentity,
        createWeeklyInputIdentity, createInputSetIdentity, createObservationSlot,
        createObservationIdentity, classifyIdentityChange, adaptCurrentEnvelope });
});
