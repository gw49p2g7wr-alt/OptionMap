(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const envelopeApi = commonJs ? require("./qriOptionsFormalComparisonEvidence.js")
        : root?.OptionMapQriOptionsFormalComparisonEvidence;
    const availabilityApi = commonJs ? require("./formalOptionAvailabilityEvidence.js")
        : root?.OptionMapFormalOptionAvailabilityEvidence;
    const api = factory(envelopeApi, availabilityApi);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapFormalOptionAvailabilityEvidenceRuntime = api;
        const runtime = api.createRuntime();
        root.beginFormalOptionAvailabilityEvidencePublication = runtime.beginRequest;
        root.publishFormalOptionAvailabilityEvidence = runtime.publish;
        root.invalidateFormalOptionAvailabilityEvidence = runtime.invalidate;
        root.getFormalOptionAvailabilityEvidence = runtime.getState;
        root.getFormalOptionAvailabilityEvidenceDiagnostics = runtime.getDiagnostics;
    }
})(typeof window !== "undefined" ? window : globalThis,
function (envelopeApi, availabilityApi) {
    "use strict";

    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const guardCurrent = guard => { try { return typeof guard === "function" && guard() === true; }
        catch (_) { return false; } };
    const baseDiagnostics = () => ({ comparisonAvailable: false, comparisonExecuted: false,
        historyComparisonReason: null,
        sourceClass: null, previousRevisionIdentity: null, currentRevisionIdentity: null,
        qriBindingVerified: false, requestMatched: false, generationMatched: false,
        countsAvailable: false, allCountsZero: false, envelopeAvailable: false,
        evidenceAvailable: false, classification: null, safeForPartialApplicability: false,
        legacyUsed: false, storageAccessed: false, databaseAccessed: false,
        fetchTriggered: false, formalRecalculationTriggered: false,
        optionJudgmentChanged: false, overallChanged: false, domMutated: false });

    function createRuntime({ now = () => new Date().toISOString(),
        createEnvelope = envelopeApi?.createEnvelope,
        toAvailabilityEvidenceInput = envelopeApi?.toAvailabilityEvidenceInput,
        createEvidence = availabilityApi?.createEvidence } = {}) {
        let publicationGeneration = 0; let attempt = 0;
        let state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "empty",
            reason: "not_published", publicationGeneration, publishedAt: null,
            requestId: null, comparisonEnvelope: null, availabilityEvidence: null,
            diagnostics: baseDiagnostics() });
        function setUnavailable(reason, requestId, diagnostics = {}) {
            publicationGeneration += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION,
                status: reason === "acquisition_pending" ? "pending" : "unavailable", reason,
                publicationGeneration, publishedAt: now(), requestId: requestId || null,
                comparisonEnvelope: null, availabilityEvidence: null,
                diagnostics: { ...baseDiagnostics(), ...clone(diagnostics) } });
        }
        function beginRequest({ requestId, isCurrentRequest } = {}) {
            if (!text(requestId) || !guardCurrent(isCurrentRequest))
                return freeze({ published: false, reason: "stale_request" });
            attempt += 1; setUnavailable("acquisition_pending", requestId);
            return freeze({ published: true, status: state.status,
                generation: publicationGeneration });
        }
        function invalidate({ requestId = null, reason = "comparison_reset",
            isCurrentRequest } = {}) {
            if (isCurrentRequest && !guardCurrent(isCurrentRequest))
                return freeze({ published: false, reason: "stale_request" });
            attempt += 1; setUnavailable(reason, text(requestId));
            return freeze({ published: true, status: state.status,
                generation: publicationGeneration });
        }
        async function publish(input = {}, { isCurrentRequest } = {}) {
            const source = clone(input); const requestId = text(source.runtimeContext?.requestId);
            const ownAttempt = ++attempt;
            if (!requestId || !guardCurrent(isCurrentRequest))
                return freeze({ published: false, reason: "stale_request" });
            const before = source.currentQriFormalIdentity?.generation;
            const envelope = await createEnvelope(source);
            if (ownAttempt !== attempt || !guardCurrent(isCurrentRequest))
                return freeze({ published: false, reason: "stale_publication" });
            if (envelope?.available !== true) {
                setUnavailable(envelope?.reason || "envelope_unavailable", requestId, {
                    comparisonAvailable: source.historyComparisonResult?.available === true,
                    comparisonExecuted: source.runtimeContext?.comparisonExecuted === true,
                    historyComparisonReason: source.historyComparisonResult?.reason || null,
                    sourceClass: source.historyComparisonResult?.source || null,
                    previousRevisionIdentity: source.previousRevision?.versionKey || null,
                    currentRevisionIdentity: source.currentRevision?.versionKey || null,
                    legacyUsed: source.historyComparisonResult?.source === "legacy_optionMapJpxSnapshots"
                });
                return freeze({ published: true, status: state.status,
                    reason: state.reason, generation: publicationGeneration });
            }
            const evidenceInput = toAvailabilityEvidenceInput(envelope);
            const evidence = await createEvidence(evidenceInput);
            if (ownAttempt !== attempt || !guardCurrent(isCurrentRequest) ||
                before?.sequence !== source.runtimeContext?.generation?.sequence ||
                before?.fingerprint !== source.runtimeContext?.generation?.fingerprint ||
                envelope.evidenceFingerprint == null)
                return freeze({ published: false, reason: "stale_publication" });
            const counts = envelope.comparison.counts;
            const allCountsZero = Object.values(counts).every(value => value === 0);
            publicationGeneration += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "available", reason: null,
                publicationGeneration, publishedAt: now(), requestId,
                comparisonEnvelope: clone(envelope), availabilityEvidence: clone(evidence),
                diagnostics: { ...baseDiagnostics(), comparisonAvailable: true,
                    comparisonExecuted: true, sourceClass: envelope.sourceClass,
                    previousRevisionIdentity: envelope.previous.revisionIdentity,
                    currentRevisionIdentity: envelope.current.revisionIdentity,
                    qriBindingVerified: true, requestMatched: true, generationMatched: true,
                    countsAvailable: true, allCountsZero, envelopeAvailable: true,
                    evidenceAvailable: true, classification: evidence.classification,
                    safeForPartialApplicability: evidence.safeForPartialApplicability,
                    legacyUsed: false } });
            return freeze({ published: true, status: state.status,
                generation: publicationGeneration,
                envelopeFingerprint: envelope.evidenceFingerprint });
        }
        const getState = () => freeze(clone(state));
        const getDiagnostics = () => freeze(clone(state.diagnostics));
        return Object.freeze({ beginRequest, publish, invalidate, getState, getDiagnostics });
    }

    return Object.freeze({ RUNTIME_VERSION, createRuntime });
});
