(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketObservation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const OBSERVATION_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const LOGIC_VERSION = "overall-v2-weights-55-45";
    const QUALITY_STATUSES = Object.freeze(["complete", "partial", "unavailable"]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

    function canonicalize(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }

    async function sha256(value) {
        const text = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(text).digest("hex");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function jstSession(observedAt) {
        const shifted = new Date(Date.parse(observedAt) + 9 * 60 * 60 * 1000);
        return { timeZone: "Asia/Tokyo", calendarDay: shifted.toISOString().slice(0, 10),
            localTime: shifted.toISOString().slice(11, 19), boundary: "jst_calendar_day" };
    }

    function componentSnapshot(component) {
        if (!object(component)) return { available: false, invalid: false, normalizedDirection: null,
            directionScore: null, qualityFactor: null, evidenceFactor: null, effectiveWeight: 0,
            weightedContribution: 0, notes: [], metadata: null };
        return { available: component.available === true, invalid: component.invalid === true,
            normalizedDirection: finite(component.normalizedDirection) ? component.normalizedDirection : null,
            directionScore: finite(component.directionScore) ? component.directionScore : null,
            qualityFactor: finite(component.qualityFactor) ? component.qualityFactor : null,
            evidenceFactor: finite(component.evidenceFactor) ? component.evidenceFactor : null,
            effectiveWeight: finite(component.effectiveWeight) ? component.effectiveWeight : 0,
            weightedContribution: finite(component.weightedContribution) ? component.weightedContribution : 0,
            notes: Array.isArray(component.notes) ? component.notes.filter(item => typeof item === "string") : [],
            metadata: object(component.metadata) ? clone(component.metadata) : null };
    }

    function semanticContent(record) {
        const value = clone(record);
        delete value.observationId; delete value.observedAt; delete value.generatedAt;
        delete value.semanticSignature;
        if (value.session) delete value.session.localTime;
        return value;
    }

    async function createObservation({ summary, rendererState, qri, observedAt }) {
        if (!object(summary) || !object(summary.payload)) throw new Error("summary_unavailable");
        const at = observedAt || new Date().toISOString();
        if (!timestamp(at)) throw new Error("observed_at_invalid");
        const source = summary.sourceVersions?.find(item => item.source === "qri-options") || null;
        const canonical = qri?.canonicalV2 || null;
        const rawPrice = rendererState?.currentPrice || {};
        const price = summary.payload.currentPrice;
        const overall = summary.payload.overallV2;
        const rawOverall = rendererState?.overallV2 || {};
        const record = { observationVersion: OBSERVATION_VERSION, observationId: "",
            semanticSignature: "", signatureAlgorithm: SIGNATURE_ALGORITHM, observedAt: at,
            generatedAt: summary.generatedAt, marketDate: summary.marketDate, session: jstSession(at),
            producer: { appVersion: summary.producer?.appVersion || null,
                platform: summary.producer?.platform || null, scoringLogicVersion: LOGIC_VERSION },
            overallV2: clone(overall),
            currentPrice: { ...clone(price), quotedAtRaw: typeof rawPrice.quotedAt === "string"
                ? rawPrice.quotedAt : null, quotedAtNormalized: timestamp(rawPrice.quotedAt)
                    ? rawPrice.quotedAt : null },
            components: { option: componentSnapshot(rawOverall.components?.option),
                weekly: componentSnapshot(rawOverall.components?.weekly) },
            qriReference: { available: qri?.available === true, versionKey: source?.versionKey || null,
                signature: source?.signature || null, tradingDate: source?.tradingDate || canonical?.tradingDate || null,
                contract: source?.contract || canonical?.contract || null,
                openInterestStatus: canonical?.openInterestStatus || null,
                pageUpdatedAt: canonical?.pageUpdatedAt || null, fetchedAt: qri?.fetchedAt || null,
                confirmedAt: qri?.confirmedAt || null,
                formalRevisionAvailable: qri?.formalRevisionAvailable === true,
                usingFallback: rendererState?.qriOpenInterest?.usingFallback === true },
            sourceVersions: clone(summary.sourceVersions || []), dataQuality: clone(summary.dataQuality),
            freshness: clone(summary.freshness), nearestLevels: clone(summary.payload.nearestLevels),
            morningContext: { activeBaselineId: summary.payload.morningBaseline?.baselineId || null,
                comparisonAvailable: summary.payload.changeSinceMorning?.available === true } };
        record.semanticSignature = await sha256(semanticContent(record));
        const idTime = new Date(at).toISOString().replace(/[^0-9]/g, "").slice(0, 17);
        record.observationId = `obs1-${idTime}-${record.semanticSignature.slice(0, 16)}`;
        const validation = validateObservation(record);
        if (!validation.valid) throw new Error(`observation_invalid:${validation.errors.join(",")}`);
        return record;
    }

    function validateComponent(value) {
        return object(value) && typeof value.available === "boolean" && typeof value.invalid === "boolean" &&
            [value.normalizedDirection, value.directionScore, value.qualityFactor, value.evidenceFactor]
                .every(item => item === null || finite(item)) && finite(value.effectiveWeight) &&
            finite(value.weightedContribution) && Array.isArray(value.notes) &&
            value.notes.every(item => typeof item === "string") && (value.metadata === null || object(value.metadata));
    }

    function validateObservation(record) {
        const errors = [];
        if (!object(record) || record.observationVersion !== OBSERVATION_VERSION) errors.push("version_invalid");
        if (!/^obs1-[0-9]{17}-[0-9a-f]{16}$/.test(record?.observationId || "")) errors.push("id_invalid");
        if (!/^[0-9a-f]{64}$/.test(record?.semanticSignature || "") ||
            record?.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_invalid");
        if (!timestamp(record?.observedAt) || !timestamp(record?.generatedAt)) errors.push("timestamp_invalid");
        if (!date(record?.marketDate) || !date(record?.session?.calendarDay) ||
            record?.session?.timeZone !== "Asia/Tokyo" || record?.session?.boundary !== "jst_calendar_day")
            errors.push("session_invalid");
        const overall = record?.overallV2;
        if (!object(overall) || typeof overall.available !== "boolean" ||
            [overall.direction, overall.confidence, overall.coverage, overall.agreement]
                .some(item => item !== null && !finite(item))) errors.push("overall_invalid");
        const price = record?.currentPrice;
        if (!object(price) || typeof price.available !== "boolean" ||
            (price.available ? !finite(price.value) || price.value <= 0 : price.value !== null) ||
            (price.quotedAtNormalized !== null && !timestamp(price.quotedAtNormalized)) ||
            (price.fetchedAt !== null && !timestamp(price.fetchedAt))) errors.push("price_invalid");
        if (!validateComponent(record?.components?.option) || !validateComponent(record?.components?.weekly))
            errors.push("components_invalid");
        if (!object(record?.qriReference) || typeof record.qriReference.formalRevisionAvailable !== "boolean" ||
            (record.qriReference.confirmedAt !== null && !timestamp(record.qriReference.confirmedAt)) ||
            !QUALITY_STATUSES.includes(record?.dataQuality?.status) ||
            !Array.isArray(record?.dataQuality?.warnings) || !object(record?.freshness) ||
            !object(record?.nearestLevels)) errors.push("context_invalid");
        return { valid: errors.length === 0, errors };
    }

    async function verifyObservation(record) {
        const validation = validateObservation(record);
        if (!validation.valid) return validation;
        const expected = await sha256(semanticContent(record));
        return expected === record.semanticSignature ? validation : { valid: false,
            errors: ["semantic_signature_mismatch"] };
    }

    async function persistBestEffort(input, store, onError = () => undefined) {
        try {
            const observation = await createObservation(input);
            return await store.append(observation);
        } catch (error) {
            onError(error);
            return { saved: false, outcome: "storage_unavailable", error: error?.message || String(error) };
        }
    }

    return Object.freeze({ OBSERVATION_VERSION, SIGNATURE_ALGORITHM, LOGIC_VERSION,
        canonicalize, semanticContent, createObservation, validateObservation, verifyObservation,
        persistBestEffort });
});
