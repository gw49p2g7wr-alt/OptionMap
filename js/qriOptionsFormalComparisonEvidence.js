(function (root, factory) {
    const availabilityApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./formalOptionAvailabilityEvidence.js") : root?.OptionMapFormalOptionAvailabilityEvidence;
    const api = factory(availabilityApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsFormalComparisonEvidence = api;
})(typeof window !== "undefined" ? window : globalThis, function (availabilityApi) {
    "use strict";

    const ENVELOPE_VERSION = 1;
    const SOURCE_CLASS = "formal_qri_history";
    const COMPARISON_SOURCE = "formal_qri_options_history";
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
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
    const revisionIdentity = value => text(value?.revisionIdentity) || text(value?.versionKey);
    const validRevision = value => object(value) && date(value.tradingDate) &&
        timestamp(value.pageUpdatedAt) && text(value.versionKey) && text(value.signature) &&
        revisionIdentity(value) && value.replacedAt === null;
    const validGeneration = value => object(value) && value.source === "qri" &&
        Number.isSafeInteger(value.sequence) && value.sequence >= 0 && value.current === true &&
        text(value.fingerprint);
    function unavailable(reason, diagnostics = {}) { return freeze({ envelopeVersion: ENVELOPE_VERSION,
        available: false, status: "unavailable", reason, sourceClass: SOURCE_CLASS, contract: null,
        tradingDate: null, previous: null, current: null, currentQriIdentity: null,
        comparison: null, requestIdentity: null, generation: null, sourceFingerprint: null,
        evidenceFingerprint: null, diagnostics: clone(diagnostics) }); }
    function counts(result) { const call = result?.comparison?.byType?.call?.summary;
        const put = result?.comparison?.byType?.put?.summary;
        return { callIncrease: call?.increaseCount, callDecrease: call?.decreaseCount,
            putIncrease: put?.increaseCount, putDecrease: put?.decreaseCount }; }
    const validCounts = value => object(value) && Object.values(value).length === 4 &&
        Object.values(value).every(item => Number.isSafeInteger(item) && item >= 0);
    function revisionView(revision, entryIdentity, activeVersionKey) {
        return { entryIdentity, revisionIdentity: revisionIdentity(revision),
            versionKey: revision.versionKey, canonicalSignature: revision.signature,
            contract: revision.contract, tradingDate: revision.tradingDate,
            sourceDate: revision.pageUpdatedAt, pageUpdatedAt: revision.pageUpdatedAt,
            replacedAt: revision.replacedAt ?? null,
            activeAtComparison: activeVersionKey === revision.versionKey };
    }

    async function createEnvelope(input = {}) {
        const source = clone(input); const result = source.historyComparisonResult;
        const previousRevision = source.previousRevision; const currentRevision = source.currentRevision;
        const qri = source.currentQriFormalIdentity; const runtime = source.runtimeContext;
        if (runtime?.comparisonExecuted !== true) return unavailable("comparison_not_executed");
        if (!object(result) || result.source !== COMPARISON_SOURCE || result.available !== true ||
            result.status !== "comparable" || !object(result.comparison))
            return unavailable("history_comparison_unavailable");
        if (!validRevision(previousRevision)) return unavailable("previous_identity_missing");
        if (!validRevision(currentRevision)) return unavailable("current_identity_missing");
        if (!text(previousRevision.contract) || !text(currentRevision.contract) ||
            previousRevision.contract !== currentRevision.contract || result.contract !== currentRevision.contract)
            return unavailable("contract_mismatch");
        if (!object(qri) || qri.sourceClass !== "formal_live" || qri.origin !== "live" ||
            qri.identityVerified !== true || qri.acquisitionVerified !== true)
            return unavailable("current_identity_missing");
        if (!text(qri.contract) || qri.contract !== currentRevision.contract)
            return unavailable("contract_mismatch");
        if (qri.tradingDate !== currentRevision.tradingDate ||
            result.currentSourceDate !== currentRevision.tradingDate ||
            result.previousSourceDate !== previousRevision.tradingDate)
            return unavailable("trading_date_mismatch");
        if (result.previousVersionKey !== previousRevision.versionKey ||
            result.currentVersionKey !== currentRevision.versionKey ||
            qri.canonicalVersionKey !== currentRevision.versionKey) return unavailable("version_mismatch");
        if (qri.canonicalSignature !== currentRevision.signature) return unavailable("signature_mismatch");
        if (revisionIdentity(previousRevision) === revisionIdentity(currentRevision))
            return unavailable("same_acquisition_rejected");
        if (revisionIdentity(currentRevision) !== currentRevision.versionKey ||
            revisionIdentity(previousRevision) !== previousRevision.versionKey)
            return unavailable("revision_identity_mismatch");
        const previousEntry = text(runtime?.previousEntryIdentity);
        const currentEntry = text(runtime?.currentEntryIdentity);
        if (previousEntry !== `${previousRevision.contract}|${previousRevision.tradingDate}` ||
            currentEntry !== `${currentRevision.contract}|${currentRevision.tradingDate}`)
            return unavailable("revision_identity_mismatch");
        if (runtime?.currentActiveVersionKey !== currentRevision.versionKey)
            return unavailable("current_revision_not_active");
        if (runtime?.previousActiveVersionKey !== previousRevision.versionKey)
            return unavailable("previous_identity_missing");
        if (previousRevision.versionKey === currentRevision.versionKey ||
            previousRevision.signature === currentRevision.signature ||
            revisionIdentity(previousRevision) === revisionIdentity(currentRevision))
            return unavailable("same_acquisition_rejected");
        if (Date.parse(previousRevision.pageUpdatedAt) >= Date.parse(currentRevision.pageUpdatedAt))
            return unavailable("source_date_order_invalid");
        if (!text(runtime?.requestId) || runtime.requestId !== qri.requestId)
            return unavailable("request_mismatch");
        if (!validGeneration(runtime?.generation) || !validGeneration(qri.generation) ||
            runtime.generation.sequence !== qri.generation.sequence ||
            runtime.generation.fingerprint !== qri.generation.fingerprint ||
            text(runtime.sourceFingerprint) !== qri.generation.fingerprint)
            return unavailable("generation_stale");
        if (runtime.mixedAcquisition !== false) return unavailable("mixed_acquisition");
        const comparisonCounts = counts(result);
        if (!validCounts(comparisonCounts)) return unavailable("comparison_counts_invalid");
        const previous = revisionView(previousRevision, previousEntry, runtime.previousActiveVersionKey);
        const current = revisionView(currentRevision, currentEntry, runtime.currentActiveVersionKey);
        const requestIdentity = { requestId: runtime.requestId,
            comparisonRequestId: runtime.requestId, mixedAcquisition: false };
        const comparison = { executed: true, source: COMPARISON_SOURCE,
            sourceDateOrderVerified: true, contractMatched: true, sameAcquisitionRejected: true,
            counts: comparisonCounts };
        const generation = clone(runtime.generation);
        const fingerprintInput = { envelopeVersion: ENVELOPE_VERSION, sourceClass: SOURCE_CLASS,
            contract: current.contract, tradingDate: current.tradingDate, previous, current,
            comparison, requestIdentity, generation, sourceFingerprint: runtime.sourceFingerprint };
        const envelope = { envelopeVersion: ENVELOPE_VERSION, available: true, status: "available",
            reason: null, sourceClass: SOURCE_CLASS, contract: current.contract,
            tradingDate: current.tradingDate, previous, current, currentQriIdentity: clone(qri),
            comparison, requestIdentity, generation, sourceFingerprint: runtime.sourceFingerprint,
            evidenceFingerprint: await hash(fingerprintInput), diagnostics: {
                existingComparisonReused: true, comparisonLogicExecutedHere: false,
                currentQriBound: true, activeRevisionsVerified: true,
                currentPriceRequired: false, storageAccessed: false, fetchTriggered: false,
                domMutated: false, runtimeWired: false } };
        return freeze(envelope);
    }

    function toAvailabilityEvidenceInput(envelope) {
        if (envelope?.available !== true || envelope.sourceClass !== SOURCE_CLASS) return null;
        const c = envelope.comparison.counts;
        const allZero = [c.callIncrease, c.callDecrease, c.putIncrease, c.putDecrease]
            .every(value => value === 0);
        const qri = clone(envelope.currentQriIdentity);
        qri.saved = false;
        return freeze({ classification: allZero ? "normal_no_change" : "judgment_unavailable",
            reason: allZero ? "no_candidates" : "change_candidates_present",
            currentQriIdentity: qri, comparisonIdentity: {
                comparisonExecuted: true, source: COMPARISON_SOURCE,
                previous: { revisionIdentity: envelope.previous.revisionIdentity,
                    versionKey: envelope.previous.versionKey,
                    signature: envelope.previous.canonicalSignature,
                    contract: envelope.previous.contract, sourceDate: envelope.previous.tradingDate,
                    activeRevisionVerified: envelope.previous.activeAtComparison },
                current: { revisionIdentity: envelope.current.revisionIdentity,
                    versionKey: envelope.current.versionKey,
                    signature: envelope.current.canonicalSignature,
                    contract: envelope.current.contract, sourceDate: envelope.current.tradingDate,
                    activeRevisionVerified: envelope.current.activeAtComparison } },
            counts: { ...clone(c), nearbyCandidates: allZero ? 0 : null },
            requestIdentity: { currentRequestId: envelope.requestIdentity.requestId,
                comparisonRequestId: envelope.requestIdentity.comparisonRequestId,
                mixedAcquisition: envelope.requestIdentity.mixedAcquisition },
            generation: clone(envelope.generation) });
    }

    return Object.freeze({ ENVELOPE_VERSION, SOURCE_CLASS, COMPARISON_SOURCE,
        canonical, createEnvelope, toAvailabilityEvidenceInput,
        availabilityEvidenceVersion: availabilityApi?.EVIDENCE_VERSION || null });
});
