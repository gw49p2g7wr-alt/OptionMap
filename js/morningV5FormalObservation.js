(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const authorityApi = commonJs ? require("./morningV5FormalAuthority.js") :
        root?.OptionMapMorningV5FormalAuthority;
    const api = factory(authorityApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5FormalObservation = api;
})(typeof window !== "undefined" ? window : globalThis, function (authorityApi) {
    "use strict";

    const SERIES_ID = "formal-morning-v5";
    const SCHEMA_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const FIELDS = Object.freeze(["seriesId", "authorityVersion", "schemaVersion", "observationId",
        "observationSlotId", "observedAt", "calendarDay", "tradingDate", "sourceIdentities",
        "inputDigests", "contractContext", "freshness", "calculationVersion", "result",
        "baselineSelection", "comparison", "contentSignature", "signature", "versionKey"]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => !!text(value) && Number.isFinite(Date.parse(value));
    const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
        fields.every(field => Object.hasOwn(value, field));
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function sha256(value) { const serialized = typeof value === "string" ? value : canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function content(value) { const copy = clone(value); delete copy.contentSignature;
        delete copy.signature; delete copy.versionKey; return copy; }
    function event(value) { return { ...content(value), contentSignature: value.contentSignature,
        versionKey: value.versionKey }; }
    function semanticInputsOf(input) { return { qri: { contract: input.qri.contract,
        tradingDate: input.qri.tradingDate, versionKey: input.qri.canonicalVersionKey,
        signature: input.qri.signature, confirmedAt: input.qri.confirmedAt },
    weekly: { sourceDate: input.weekly.sourceDate,
        previousVersionKey: input.weekly.previousVersionKey,
        previousSignature: input.weekly.previousSignature,
        currentVersionKey: input.weekly.currentVersionKey,
        currentSignature: input.weekly.currentSignature }, overall: {
        logicVersion: input.overall.logicVersion, inputFingerprint: input.overall.inputFingerprint,
        direction: input.overall.direction, confidence: input.overall.confidence }, futures: {
        source: input.futures.source, instrument: input.futures.instrument,
        contract: input.futures.contract, value: input.futures.value,
        quotedAtNormalized: input.futures.quotedAtNormalized,
        quoteSignature: input.futures.quoteSignature }, calendarDigest: input.calendar.digest }; }
    async function semanticDigestOf(input) { return `sha256:${await sha256(semanticInputsOf(input))}`; }
    function resultFor(authority) { return { status: "available",
        supplyDirection: authority.sourceIdentities.overall.direction,
        supplyConfidence: authority.sourceIdentities.overall.confidence,
        futuresPrice: authority.sourceIdentities.futures.value };
    }

    function comparisonFor(baseline, current) {
        if (!baseline) return { aggregateClass: "first_observation", supply: { comparable: false,
            reason: "first_observation", delta: null }, price: { comparable: false,
            reason: "first_observation", delta: null, deltaRate: null },
        divergence: { comparable: false, reason: "first_observation", relation: null } };
        const qriSame = baseline.contractContext.qriContract === current.contractContext.qriContract;
        const futuresSame = baseline.contractContext.futuresContract === current.contractContext.futuresContract;
        const supplyDelta = qriSame ? current.result.supplyDirection - baseline.result.supplyDirection : null;
        const priceDelta = futuresSame ? current.result.futuresPrice - baseline.result.futuresPrice : null;
        const priceRate = futuresSame ? priceDelta / baseline.result.futuresPrice : null;
        const supply = { comparable: qriSame, reason: qriSame ? null : "qri_contract_roll",
            delta: supplyDelta };
        const price = { comparable: futuresSame, reason: futuresSame ? null : "futures_contract_roll",
            delta: priceDelta, deltaRate: priceRate };
        const full = qriSame && futuresSame, partial = qriSame !== futuresSame;
        let relation = null;
        if (full) { const supplySign = Math.sign(supplyDelta), priceSign = Math.sign(priceDelta);
            relation = supplySign === 0 || priceSign === 0 ? "neutral" :
                supplySign === priceSign ? "aligned" : "divergent"; }
        return { aggregateClass: full ? "full" : partial ? "partial" : "none", supply, price,
            divergence: { comparable: full, reason: full ? null : "lane_not_comparable", relation } };
    }

    async function validateFormalObservation(value) {
        if (!exact(value, FIELDS) || value.seriesId !== SERIES_ID || value.schemaVersion !== SCHEMA_VERSION ||
            value.authorityVersion !== authorityApi.AUTHORITY_VERSION || !text(value.observationId) ||
            !text(value.observationSlotId) || !timestamp(value.observedAt) ||
            value.result?.status !== "available" || value.freshness?.status !== "fresh" ||
            value.freshness?.reason !== "current_session" ||
            value.calculationVersion !== authorityApi.CALCULATION_VERSION ||
            !["same_contract", "independent_cross_contract"].includes(value.contractContext?.relation) ||
            value.freshness?.policyVersion !== authorityApi.FRESHNESS_POLICY_VERSION ||
            value.inputDigests?.comparisonPolicyVersion !== authorityApi.COMPARISON_POLICY_VERSION ||
            !["full", "partial", "none", "first_observation"].includes(
                value.comparison?.aggregateClass)) return false;
        const relation = value.contractContext.relation;
        const reconstructed = { observedAt: value.observedAt, calendarDay: value.calendarDay,
            tradingDate: value.tradingDate, qri: clone(value.sourceIdentities?.qri),
            weekly: clone(value.sourceIdentities?.weekly), overall: clone(value.sourceIdentities?.overall),
            futures: clone(value.sourceIdentities?.futures),
            shadowMappingClass: relation === "same_contract" ? "same_contract_reference" :
                "explicit_cross_contract_reference",
            freshnessPolicyVersion: value.freshness.policyVersion,
            calendar: clone(value.sourceIdentities?.calendar), calculation: {
                calculationVersion: value.calculationVersion,
                comparisonPolicyVersion: value.inputDigests.comparisonPolicyVersion } };
        const accepted = await authorityApi.acceptMorningV5FormalAuthority(reconstructed);
        if (!accepted.eligible || canonical(accepted.authority.sourceIdentities) !==
            canonical(value.sourceIdentities) || canonical(accepted.authority.contractContext) !==
            canonical(value.contractContext) || canonical(accepted.authority.freshness) !==
            canonical(value.freshness)) return false;
        const semanticInputDigest = await semanticDigestOf(reconstructed);
        const observationSlotId = `${SERIES_ID}|${value.calendarDay}|${value.tradingDate}`;
        const observationId = `${SERIES_ID}|sha256:${await sha256({ observationSlotId,
            semanticInputDigest, calculationVersion: value.calculationVersion })}`;
        if (value.observationSlotId !== observationSlotId || value.observationId !== observationId ||
            value.inputDigests.semanticInputDigest !== semanticInputDigest ||
            value.inputDigests.calendarDigest !== value.sourceIdentities.calendar.digest ||
            value.result.supplyDirection !== value.sourceIdentities.overall.direction ||
            value.result.supplyConfidence !== value.sourceIdentities.overall.confidence ||
            value.result.futuresPrice !== value.sourceIdentities.futures.value ||
            value.baselineSelection?.ruleVersion !== "previous-accepted-v5-v1" ||
            (value.comparison.aggregateClass === "first_observation") !==
                (value.baselineSelection.baselineObservationId === null)) return false;
        const expectedContent = await sha256(content(value));
        return value.contentSignature === expectedContent &&
            value.versionKey === `formal-morning-v5|sha256:${expectedContent}` &&
            value.signature === await sha256(event(value));
    }

    async function selectBaseline(observations, observedAt) {
        if (!Array.isArray(observations)) return { valid: false, baseline: null };
        const accepted = [];
        for (const value of observations) {
            if (!await validateFormalObservation(value)) return { valid: false, baseline: null };
            if (value.seriesId === SERIES_ID && Date.parse(value.observedAt) < Date.parse(observedAt))
                accepted.push(value);
        }
        accepted.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
            a.observationId.localeCompare(b.observationId));
        return { valid: true, baseline: accepted.at(-1) || null };
    }

    async function buildMorningV5FormalObservation(input = {}, previousObservations = []) {
        const accepted = await authorityApi.acceptMorningV5FormalAuthority(input);
        if (!accepted.eligible) return freeze({ success: false, reason: accepted.reason,
            writeCandidate: false, observation: null, authority: accepted });
        const selected = await selectBaseline(previousObservations, input.observedAt);
        if (!selected.valid) return freeze({ success: false, reason: "baseline_set_invalid",
            writeCandidate: false, observation: null, authority: accepted });
        const authority = accepted.authority;
        const semanticInputDigest = await semanticDigestOf(input);
        const observationSlotId = `${SERIES_ID}|${input.calendarDay}|${input.tradingDate}`;
        const observationId = `${SERIES_ID}|sha256:${await sha256({ observationSlotId,
            semanticInputDigest, calculationVersion: input.calculation.calculationVersion })}`;
        const draft = { seriesId: SERIES_ID, authorityVersion: authority.authorityVersion,
            schemaVersion: SCHEMA_VERSION, observationId, observationSlotId,
            observedAt: input.observedAt, calendarDay: input.calendarDay,
            tradingDate: input.tradingDate, sourceIdentities: clone(authority.sourceIdentities),
            inputDigests: { semanticInputDigest, calendarDigest: input.calendar.digest,
                comparisonPolicyVersion: input.calculation.comparisonPolicyVersion },
            contractContext: clone(authority.contractContext), freshness: clone(authority.freshness),
            calculationVersion: input.calculation.calculationVersion, result: resultFor(authority),
            baselineSelection: { ruleVersion: "previous-accepted-v5-v1",
                baselineObservationId: selected.baseline?.observationId || null },
            comparison: null, contentSignature: "", signature: "", versionKey: "" };
        draft.comparison = comparisonFor(selected.baseline, draft);
        draft.contentSignature = await sha256(content(draft));
        draft.versionKey = `formal-morning-v5|sha256:${draft.contentSignature}`;
        draft.signature = await sha256(event(draft));
        if (!await validateFormalObservation(draft)) return freeze({ success: false,
            reason: "observation_validation_failed", writeCandidate: false, observation: null,
            authority: accepted });
        return freeze({ success: true, reason: null, writeCandidate: true,
            observation: freeze(draft), authority: accepted });
    }

    return freeze({ SERIES_ID, SCHEMA_VERSION, SIGNATURE_ALGORITHM, FIELDS, canonicalize: canonical,
        comparisonFor, selectBaseline, validateFormalObservation, buildMorningV5FormalObservation });
});
