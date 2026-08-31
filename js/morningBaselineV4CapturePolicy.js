(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const baselineApi = commonJs ? require("./morningBaselineV4.js") : root?.OptionMapMorningBaselineV4;
    const storageApi = commonJs ? require("./morningBaselineV4Storage.js") :
        root?.OptionMapMorningBaselineV4StorageFoundation;
    const api = factory(baselineApi, storageApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4CapturePolicy = api;
})(typeof window !== "undefined" ? window : globalThis, function (baselineApi, storageApi) {
    "use strict";

    const POLICY_VERSION = 1;
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    async function sha256(value) {
        const serialized = typeof value === "string" ? value : baselineApi.canonicalize(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function initialDiagnostics() {
        return { collectorReady: false, sessionVerified: false, manualCapture: false,
            userInitiated: false, builderInputValidated: false, builderInvoked: false,
            baselineBuilt: false, baselineValidated: false, existingStorageStatus: "unchecked",
            sameScopeFound: false, duplicateDetected: false, replaceRequired: false,
            staleCapture: false, storageFingerprintAvailable: false, storageAccessed: false,
            databaseAccessed: false, fetchTriggered: false, formalRecalculationTriggered: false,
            domMutated: false };
    }

    function result({ eligible = false, status = "rejected", reason = null, reasons = [],
        action = "reject", scopeIdentity = null, collectorIdentity = null,
        existingBaselineIdentity = null, builderInput = null, baselineCandidate = null,
        savePlan = null, diagnostics }) {
        return deepFreeze({ policyVersion: POLICY_VERSION, eligible, status, reason,
            reasons: [...reasons], action, scopeIdentity: clone(scopeIdentity),
            collectorIdentity: clone(collectorIdentity),
            existingBaselineIdentity: clone(existingBaselineIdentity),
            builderInput: clone(builderInput), baselineCandidate: clone(baselineCandidate),
            savePlan: clone(savePlan), diagnostics: clone(diagnostics) });
    }

    function rejected(reason, state) {
        return result({ reason, reasons: [reason], scopeIdentity: state.scopeIdentity,
            collectorIdentity: state.collectorIdentity,
            existingBaselineIdentity: state.existingBaselineIdentity,
            builderInput: state.builderInput, baselineCandidate: state.baselineCandidate,
            diagnostics: state.diagnostics });
    }

    function generationBoundaryValid(value) {
        return object(value) && object(value.start) && object(value.end) &&
            baselineApi.canonicalize(value.start) === baselineApi.canonicalize(value.end);
    }

    function collectorIntegrity(collector) {
        const diagnostics = collector?.diagnostics;
        return collector?.ready === true && collector.status === "ready" &&
            collector.reason === null && Array.isArray(collector.reasons) && collector.reasons.length === 0 &&
            text(collector.formalSnapshotInputFingerprint) && generationBoundaryValid(collector.sourceGenerations) &&
            collector.factContract?.ready === true && collector.factContract?.status === "ready" &&
            object(collector.sessionScope) && object(collector.builderInput) &&
            diagnostics?.fingerprintMatched === true && diagnostics?.refreshInProgress === false &&
            diagnostics?.mixedAcquisitionDetected === false && diagnostics?.builderInvoked === false &&
            collector.baselineCandidate === null;
    }

    function validBuilderInput(value) {
        return object(value) && timestamp(value.capturedAt) && object(value.marketContext) &&
            object(value.overallV2Context) && object(value.currentPriceContext) &&
            object(value.qriContext) && object(value.weeklyContext) &&
            Object.hasOwn(value, "nearestLevelsContext") && object(value.dataQualityContext) &&
            (value.nearestLevelsContext === null || object(value.nearestLevelsContext));
    }

    function fallbackPresent(input) {
        return input?.qriContext?.usingFallback === true || input?.weeklyContext?.usingFallback === true ||
            input?.nearestLevelsContext?.usingFallback === true ||
            Object.values(input?.dataQualityContext?.fallbackFlags || {}).some(value => value !== false);
    }

    function storageContainerOf(value) {
        if (value === null || value === undefined || value?.status === "missing")
            return { status: "missing", container: null };
        if (value?.success === true && value?.status === "ready" && object(value.container))
            return { status: "ready", container: value.container };
        if (object(value) && value.storageVersion === storageApi.STORAGE_VERSION)
            return { status: "ready", container: value };
        return { status: "invalid", container: null };
    }

    async function evaluateMorningBaselineV4CapturePolicy(input = {}, dependencies = {}) {
        const collector = input.collectorResult;
        const context = input.captureContext;
        const diagnostics = initialDiagnostics();
        const state = { diagnostics, scopeIdentity: null, collectorIdentity: null,
            existingBaselineIdentity: null, builderInput: null, baselineCandidate: null };
        diagnostics.collectorReady = collector?.ready === true && collector?.status === "ready";
        if (!diagnostics.collectorReady) return result({ reason: "collector_not_ready",
            reasons: ["collector_not_ready", ...(Array.isArray(collector?.reasons) ?
                collector.reasons.filter(item => text(item) && item !== "collector_not_ready") : [])],
            diagnostics });
        if (!collectorIntegrity(collector)) return rejected("collector_identity_invalid", state);

        const scope = collector.sessionScope;
        diagnostics.sessionVerified = scope.available === true && scope.status === "verified" &&
            scope.mappingVerified === true && scope.sessionClass === "same_date_verified" &&
            Boolean(text(scope.scopeId) && text(scope.formalTradingDate) && text(scope.contract));
        state.scopeIdentity = { scopeId: scope.scopeId, formalTradingDate: scope.formalTradingDate,
            contract: scope.contract, mappingVerified: scope.mappingVerified === true,
            sessionClass: scope.sessionClass };
        state.collectorIdentity = { collectedAt: collector.collectedAt,
            formalSnapshotInputFingerprint: collector.formalSnapshotInputFingerprint,
            sourceGenerations: clone(collector.sourceGenerations) };
        if (!diagnostics.sessionVerified)
            return rejected("session_unverified", state);

        diagnostics.manualCapture = context?.mode === "manual";
        diagnostics.userInitiated = context?.userInitiated === true;
        const automaticCapture = context?.mode === "automatic_first_success";
        if (!diagnostics.manualCapture && !automaticCapture)
            return rejected("capture_not_manual", state);
        if (diagnostics.manualCapture && !diagnostics.userInitiated)
            return rejected("capture_not_user_initiated", state);
        if (automaticCapture && diagnostics.userInitiated)
            return rejected("capture_mode_invalid", state);
        if (!timestamp(context?.requestedAt) || !timestamp(collector.collectedAt) ||
            Date.parse(context.requestedAt) < Date.parse(collector.collectedAt))
            return rejected("collector_identity_invalid", state);

        const builderInput = clone(collector.builderInput);
        builderInput.capturedAt = context.requestedAt;
        state.builderInput = builderInput;
        if (!validBuilderInput(builderInput)) return rejected("builder_input_invalid", state);
        diagnostics.builderInputValidated = true;
        if (fallbackPresent(builderInput)) return rejected("fallback_present", state);
        if (builderInput.marketContext.sessionIdentity !== scope.scopeId ||
            builderInput.marketContext.formalTradingDate !== scope.formalTradingDate ||
            builderInput.currentPriceContext.contract !== scope.contract ||
            builderInput.qriContext?.identity?.contract !== scope.contract)
            return rejected("scope_identity_mismatch", state);

        const existing = storageContainerOf(input.existingStorageState);
        diagnostics.existingStorageStatus = existing.status;
        if (existing.status === "invalid" || existing.status === "ready" &&
            !await storageApi.validateMorningBaselineV4Storage(existing.container))
            return rejected("existing_storage_invalid", state);
        const existingSeries = existing.container?.series.find(item => item.scopeId === scope.scopeId) || null;
        diagnostics.sameScopeFound = Boolean(existingSeries);
        if (existingSeries && (existingSeries.formalTradingDate !== scope.formalTradingDate ||
            existingSeries.contract !== scope.contract)) return rejected("storage_identity_mismatch", state);
        const existingActive = existingSeries?.revisions.find(item =>
            item.baselineId === existingSeries.activeBaselineId) || null;
        if (existingSeries && !existingActive) return rejected("storage_identity_mismatch", state);
        state.existingBaselineIdentity = existingActive ? { baselineId: existingActive.baselineId,
            contentSignature: existingActive.contentSignature, versionKey: existingActive.versionKey,
            capturedAt: existingActive.capturedAt } : null;
        if (automaticCapture && existingActive) return result({ status: "no_change",
            reason: "already_saved", reasons: ["already_saved"], action: "already_saved",
            scopeIdentity: state.scopeIdentity, collectorIdentity: state.collectorIdentity,
            existingBaselineIdentity: state.existingBaselineIdentity, builderInput,
            diagnostics });

        const builder = dependencies.buildBaseline || baselineApi.buildMorningBaselineV4;
        let built;
        diagnostics.builderInvoked = true;
        try { built = await builder(builderInput); }
        catch (_error) { return rejected("baseline_build_failed", state); }
        if (built?.success !== true || !object(built.baseline))
            return rejected("baseline_build_failed", state);
        diagnostics.baselineBuilt = true;
        let valid = false;
        try { valid = await baselineApi.validateMorningBaselineV4(built.baseline) === true; }
        catch (_error) { valid = false; }
        if (!valid) return rejected("baseline_build_failed", state);
        diagnostics.baselineValidated = true;
        state.baselineCandidate = built.baseline;

        const storage = existing;
        diagnostics.existingStorageStatus = storage.status;
        let containerFingerprint = null;
        if (storage.container) {
            const serialized = await storageApi.serializeMorningBaselineV4Storage(storage.container);
            if (!serialized.success) return rejected("existing_storage_invalid", state);
            containerFingerprint = await sha256(serialized.serialized);
            diagnostics.storageFingerprintAvailable = true;
        }

        const series = existingSeries;
        diagnostics.sameScopeFound = Boolean(series);
        if (series && (series.formalTradingDate !== scope.formalTradingDate ||
            series.contract !== scope.contract)) return rejected("storage_identity_mismatch", state);
        const active = existingActive;
        if (active && Date.parse(built.baseline.capturedAt) < Date.parse(active.capturedAt)) {
            diagnostics.staleCapture = true; return rejected("stale_capture", state);
        }
        const duplicate = active && active.contentSignature === built.baseline.contentSignature &&
            active.versionKey === built.baseline.versionKey;
        if (duplicate) {
            diagnostics.duplicateDetected = true;
            return result({ status: "no_change", action: "duplicate", scopeIdentity: state.scopeIdentity,
                collectorIdentity: state.collectorIdentity,
                existingBaselineIdentity: state.existingBaselineIdentity,
                builderInput, baselineCandidate: built.baseline, diagnostics });
        }
        if (active && Date.parse(built.baseline.capturedAt) === Date.parse(active.capturedAt))
            return rejected("ambiguous_same_timestamp", state);

        const action = active ? "replace" : "create";
        diagnostics.replaceRequired = action === "replace";
        const planned = await storageApi.buildMorningBaselineV4Storage({ baseline: built.baseline,
            existingContainer: storage.container });
        if (!planned.success || !planned.changed) return rejected("storage_identity_mismatch", state);
        const expectedActiveBaselineId = active?.baselineId || null;
        const expectedActiveVersionKey = active?.versionKey || null;
        const savePlan = { required: true, action, storageKey: storageApi.STORAGE_KEY,
            scopeId: scope.scopeId, baselineId: built.baseline.baselineId,
            contentSignature: built.baseline.contentSignature, versionKey: built.baseline.versionKey,
            expectedContainerFingerprint: containerFingerprint, expectedActiveBaselineId,
            expectedActiveVersionKey, proposedContainer: planned.container };
        return result({ eligible: true, status: "ready_to_save", action,
            scopeIdentity: state.scopeIdentity, collectorIdentity: state.collectorIdentity,
            existingBaselineIdentity: state.existingBaselineIdentity, builderInput,
            baselineCandidate: built.baseline, savePlan, diagnostics });
    }

    return Object.freeze({ POLICY_VERSION, evaluateMorningBaselineV4CapturePolicy });
});
