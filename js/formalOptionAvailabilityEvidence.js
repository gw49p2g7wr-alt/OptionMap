(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapFormalOptionAvailabilityEvidence = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const EVIDENCE_VERSION = 1;
    const TAXONOMY = Object.freeze(["normal_no_change", "source_unavailable",
        "comparison_unavailable", "fallback_or_reference", "judgment_unavailable",
        "identity_missing", "invalid_input", "stale_or_mixed", "unknown"]);
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function hash(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    function generation(value, source) { return object(value) && value.source === source &&
        Number.isSafeInteger(value.sequence) && value.sequence >= 0 && text(value.fingerprint) &&
        value.current === true; }
    function revision(value) { return object(value) && text(value.revisionIdentity) &&
        text(value.versionKey) && text(value.signature) && text(value.contract) &&
        date(value.sourceDate) && value.activeRevisionVerified === true; }
    function qri(value) { return object(value) && value.sourceClass === "formal_live" &&
        value.origin === "live" && value.identityVerified === true &&
        value.acquisitionVerified === true && value.usingFallback === false &&
        value.referenceOnly === false && value.saved === false && text(value.canonicalVersionKey) &&
        text(value.canonicalSignature) && text(value.contract) && date(value.tradingDate) &&
        text(value.requestId) && generation(value.generation, "qri"); }
    const zeroCounts = value => object(value) && ["callIncrease", "callDecrease", "putIncrease",
        "putDecrease", "nearbyCandidates"].every(key => value[key] === 0);

    function assess(input) {
        const current = input.currentQriIdentity;
        const comparison = input.comparisonIdentity;
        const previous = comparison?.previous;
        const comparedCurrent = comparison?.current;
        const request = input.requestIdentity;
        const diagnostics = {
            requestedClassification: TAXONOMY.includes(input.classification) ? input.classification : "unknown",
            qriFormalVerified: qri(current), comparisonExecuted: comparison?.comparisonExecuted === true,
            comparisonSourceFormal: comparison?.source === "formal_qri_options_history",
            previousIdentityVerified: revision(previous), currentIdentityVerified: revision(comparedCurrent),
            activeRevisionsVerified: previous?.activeRevisionVerified === true &&
                comparedCurrent?.activeRevisionVerified === true,
            contractMatched: revision(previous) && revision(comparedCurrent) && qri(current) &&
                previous.contract === current.contract && comparedCurrent.contract === current.contract,
            currentVersionMatched: revision(comparedCurrent) && qri(current) &&
                comparedCurrent.versionKey === current.canonicalVersionKey,
            currentSignatureMatched: revision(comparedCurrent) && qri(current) &&
                comparedCurrent.signature === current.canonicalSignature,
            currentRevisionMatched: revision(comparedCurrent) && qri(current) &&
                comparedCurrent.revisionIdentity === current.canonicalVersionKey,
            distinctAcquisitions: revision(previous) && revision(comparedCurrent) &&
                previous.versionKey !== comparedCurrent.versionKey &&
                previous.signature !== comparedCurrent.signature &&
                previous.revisionIdentity !== comparedCurrent.revisionIdentity,
            sourceDateOrderVerified: revision(previous) && revision(comparedCurrent) &&
                previous.sourceDate < comparedCurrent.sourceDate &&
                comparedCurrent.sourceDate === current?.tradingDate,
            requestMatched: object(request) && text(request.currentRequestId) &&
                request.currentRequestId === current?.requestId &&
                request.comparisonRequestId === current?.requestId,
            generationCurrent: generation(input.generation, "qri") && qri(current) &&
                input.generation.sequence === current.generation.sequence &&
                input.generation.fingerprint === current.generation.fingerprint,
            mixedAcquisitionAbsent: request?.mixedAcquisition === false,
            countsAreZero: zeroCounts(input.counts), unavailableReasonVerified:
                input.reason === "no_candidates", currentPriceRequired: false,
            legacyComparisonRejected: comparison?.source !== "legacy_optionMapJpxSnapshots"
        };
        const requested = diagnostics.requestedClassification;
        if (requested !== "normal_no_change") return { classification: requested,
            reason: text(input.reason) || requested, diagnostics };
        if (!diagnostics.qriFormalVerified) {
            const fallback = current?.usingFallback === true || current?.referenceOnly === true ||
                current?.saved === true || current?.origin === "saved";
            return { classification: fallback ? "fallback_or_reference" : object(current)
                ? "identity_missing" : "source_unavailable", reason: fallback
                ? "fallback_or_reference" : "qri_identity_invalid", diagnostics };
        }
        if (!diagnostics.comparisonExecuted) return { classification: "comparison_unavailable",
            reason: "comparison_not_executed", diagnostics };
        if (!diagnostics.comparisonSourceFormal || !diagnostics.legacyComparisonRejected)
            return { classification: comparison?.source === "legacy_optionMapJpxSnapshots"
                ? "comparison_unavailable" : "identity_missing", reason: comparison?.source ===
                "legacy_optionMapJpxSnapshots" ? "legacy_comparison_rejected" :
                    "formal_comparison_source_missing", diagnostics };
        if (!diagnostics.previousIdentityVerified || !diagnostics.currentIdentityVerified ||
            !diagnostics.activeRevisionsVerified || !diagnostics.contractMatched ||
            !diagnostics.currentVersionMatched || !diagnostics.currentSignatureMatched ||
            !diagnostics.currentRevisionMatched || !diagnostics.distinctAcquisitions ||
            !diagnostics.sourceDateOrderVerified) return { classification: "identity_missing",
                reason: "comparison_identity_invalid", diagnostics };
        if (!diagnostics.requestMatched || !diagnostics.generationCurrent ||
            !diagnostics.mixedAcquisitionAbsent) return { classification: "stale_or_mixed",
                reason: "request_or_generation_mismatch", diagnostics };
        if (!object(input.counts) || Object.values(input.counts).some(value =>
            !Number.isSafeInteger(value) || value < 0)) return { classification: "invalid_input",
                reason: "counts_invalid", diagnostics };
        if (!diagnostics.countsAreZero) return { classification: "judgment_unavailable",
            reason: "change_candidates_present", diagnostics };
        if (!diagnostics.unavailableReasonVerified) return { classification: "judgment_unavailable",
            reason: "unavailable_reason_unverified", diagnostics };
        return { classification: "normal_no_change", reason: "no_candidates", diagnostics };
    }

    async function createEvidence(input = {}) {
        const source = clone(input); const assessment = assess(source);
        const safe = assessment.classification === "normal_no_change" &&
            Object.entries(assessment.diagnostics).filter(([key]) => !["requestedClassification",
                "currentPriceRequired"].includes(key)).every(([, value]) => value === true);
        const fingerprintInput = { evidenceVersion: EVIDENCE_VERSION,
            classification: assessment.classification, reason: assessment.reason,
            currentQriIdentity: source.currentQriIdentity || null,
            comparisonIdentity: source.comparisonIdentity || null, counts: source.counts || null,
            requestIdentity: source.requestIdentity || null, generation: source.generation || null };
        const evidence = { evidenceVersion: EVIDENCE_VERSION, available: false,
            classification: assessment.classification, safeForPartialApplicability: safe,
            reason: assessment.reason, currentQriIdentity: clone(source.currentQriIdentity || null),
            comparisonIdentity: clone(source.comparisonIdentity || null),
            counts: clone(source.counts || null), requestIdentity: clone(source.requestIdentity || null),
            generation: clone(source.generation || null),
            evidenceFingerprint: await hash(fingerprintInput), diagnostics: assessment.diagnostics };
        return freeze(evidence);
    }

    return Object.freeze({ EVIDENCE_VERSION, TAXONOMY, canonical, createEvidence });
});
