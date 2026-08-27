(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const baselineApi = commonJs ? require("./morningBaselineV4.js") :
        root?.OptionMapMorningBaselineV4;
    const comparisonApi = commonJs ? require("./morningComparisonV4.js") :
        root?.OptionMapMorningComparisonV4;
    const collectorApi = commonJs ? require("./morningBaselineV4RuntimeCollector.js") :
        root?.OptionMapMorningBaselineV4RuntimeCollector;
    const api = factory(baselineApi, comparisonApi, collectorApi);
    if (commonJs) module.exports = api;
    if (root) {
        const sourceStates = () => ({
            currentPrice: root.getCurrentPriceLiveIdentityFact?.() || null,
            qri: root.getQriFormalIdentityFact?.() || null,
            weekly: root.getWeeklyFormalIdentityFact?.() || null,
            overall: root.getOverallV2FormalEnvelope?.() || null
        });
        const runtime = api.createRuntime({
            getRestoreState: () => root.getMorningBaselineV4RestoreRuntimeState?.() || null,
            collect: options => root.collectMorningBaselineV4ReadOnly?.(options),
            getSourceStates: sourceStates,
            isRefreshInProgress: () => root.isMarketRefreshInProgress?.() === true
        });
        root.OptionMapMorningComparisonV4Runtime = runtime;
        root.publishMorningComparisonV4Runtime = runtime.publish;
        root.invalidateMorningComparisonV4Runtime = runtime.invalidate;
        root.getMorningComparisonV4RuntimeState = runtime.getState;
    }
})(typeof window !== "undefined" ? window : globalThis,
function (baselineApi, comparisonApi, collectorApi) {
    "use strict";

    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    function canonical(value) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }
    const same = (left, right) => canonical(left) === canonical(right);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

    function diagnosticsBase() {
        return { restoreAvailable: false, restoreApplicable: false,
            selectedActiveRevision: false, baselineValidated: false, collectorReady: false,
            currentSnapshotBuilt: false, currentSnapshotValidated: false,
            comparisonInvoked: false, comparisonAvailable: false, sameScopeVerified: false,
            requestMatched: false, generationsMatched: false, fingerprintMatched: false,
            baselineIdentityMatched: false, raceGuardPassed: false,
            storageAccessed: false, storageWritten: false, databaseAccessed: false,
            fetchTriggered: false, formalRecalculationTriggered: false, domMutated: false };
    }

    function snapshotIdentity(snapshot, scopeId = null) {
        if (!snapshot) return null;
        return { baselineId: snapshot.baselineId || null,
            contentSignature: snapshot.contentSignature || null,
            versionKey: snapshot.versionKey || null, capturedAt: snapshot.capturedAt || null,
            scopeId, formalTradingDate: snapshot.marketContext?.formalTradingDate || null,
            contract: snapshot.qri?.contract || null,
            logicVersion: snapshot.overallV2?.logicVersion || null };
    }

    function requestIdOf(identity) {
        const ids = identity?.requestIds;
        if (!Array.isArray(ids) || ids.length !== 4 || ids.some(id => !text(id))) return null;
        return ids.every(id => id === ids[0]) ? ids[0] : null;
    }

    function restoreReason(restore) {
        if (!restore) return "restore_missing";
        if (restore.restoreStatus !== "valid" || restore.integrityStatus !== "valid")
            return "restore_invalid";
        if (restore.applicabilityStatus !== "applicable") return "restore_not_applicable";
        if (restore.diagnostics?.selectedActiveRevision !== true) return "active_revision_invalid";
        if (!restore.baseline || restore.selectedBaselineId !== restore.baseline.baselineId)
            return "baseline_identity_mismatch";
        if (!text(restore.selectedScopeId) || restore.selectedScopeId !== restore.currentScope?.scopeId)
            return "scope_mismatch";
        return null;
    }

    function createRuntime(configuration = {}) {
        const now = configuration.now || (() => new Date().toISOString());
        const getRestoreState = configuration.getRestoreState || (() => null);
        const collect = configuration.collect || (() => null);
        const getSourceStates = configuration.getSourceStates || (() => ({}));
        const isRefreshInProgress = configuration.isRefreshInProgress || (() => false);
        const buildSnapshot = configuration.buildSnapshot || baselineApi?.buildMorningBaselineV4;
        const validateSnapshot = configuration.validateSnapshot || baselineApi?.validateMorningBaselineV4;
        const compare = configuration.compare || comparisonApi?.buildMorningComparisonV4;
        const sourceIdentity = configuration.sourceIdentity || collectorApi?.sourceIdentity;
        let attempt = 0;
        let publicationGeneration = 0;
        let state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "empty",
            reason: "not_published", available: false, publicationGeneration: 0,
            publishedAt: null, requestId: null, scopeId: null, formalTradingDate: null,
            contract: null, selectedBaselineId: null, baselineIdentity: null,
            currentIdentity: null, sourceGenerations: null,
            formalSnapshotInputFingerprint: null, comparison: null,
            diagnostics: diagnosticsBase() });

        function unavailable(reason, context = {}, diagnostics = diagnosticsBase()) {
            publicationGeneration += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "unavailable", reason,
                available: false, publicationGeneration, publishedAt: now(),
                requestId: context.requestId || null, scopeId: context.scopeId || null,
                formalTradingDate: context.formalTradingDate || null,
                contract: context.contract || null,
                selectedBaselineId: context.selectedBaselineId || null,
                baselineIdentity: clone(context.baselineIdentity || null),
                currentIdentity: clone(context.currentIdentity || null),
                sourceGenerations: clone(context.sourceGenerations || null),
                formalSnapshotInputFingerprint:
                    context.formalSnapshotInputFingerprint || null,
                comparison: null, diagnostics: freeze(clone(diagnostics)) });
            return freeze({ published: true, status: state.status, reason,
                generation: publicationGeneration });
        }

        function invalidate(reason = "source_invalidated") {
            attempt += 1;
            return unavailable(reason);
        }

        async function publish() {
            const ownAttempt = ++attempt;
            const diagnostics = diagnosticsBase();
            if (isRefreshInProgress()) return unavailable("refresh_in_progress", {}, diagnostics);
            const startRestore = clone(getRestoreState());
            diagnostics.restoreAvailable = Boolean(startRestore);
            diagnostics.restoreApplicable = startRestore?.applicabilityStatus === "applicable";
            diagnostics.selectedActiveRevision =
                startRestore?.diagnostics?.selectedActiveRevision === true;
            const invalidRestore = restoreReason(startRestore);
            if (invalidRestore) return unavailable(invalidRestore, {}, diagnostics);

            const baseline = clone(startRestore.baseline);
            const baselineIdentity = snapshotIdentity(baseline, startRestore.selectedScopeId);
            const context = { scopeId: startRestore.selectedScopeId,
                formalTradingDate: startRestore.currentScope.formalTradingDate,
                contract: startRestore.currentScope.contract,
                selectedBaselineId: startRestore.selectedBaselineId, baselineIdentity,
                requestId: null, sourceGenerations: null,
                formalSnapshotInputFingerprint: null, currentIdentity: null };
            diagnostics.baselineIdentityMatched = baselineIdentity.baselineId ===
                startRestore.selectedBaselineId && baselineIdentity.scopeId ===
                startRestore.selectedScopeId;
            if (!diagnostics.baselineIdentityMatched)
                return unavailable("baseline_identity_mismatch", context, diagnostics);
            diagnostics.baselineValidated = await validateSnapshot?.(baseline) === true;
            if (!diagnostics.baselineValidated)
                return unavailable("baseline_invalid", context, diagnostics);

            const collected = clone(await collect?.());
            diagnostics.collectorReady = collected?.ready === true;
            if (!diagnostics.collectorReady)
                return unavailable(collected?.reason || "collector_not_ready", context, diagnostics);
            context.sourceGenerations = clone(collected.sourceGenerations);
            context.formalSnapshotInputFingerprint = collected.formalSnapshotInputFingerprint;
            context.requestId = requestIdOf(collected.sourceGenerations?.end);
            diagnostics.requestMatched = Boolean(context.requestId);
            diagnostics.generationsMatched = same(collected.sourceGenerations?.start,
                collected.sourceGenerations?.end);
            diagnostics.fingerprintMatched = collected.diagnostics?.fingerprintMatched === true;
            if (!diagnostics.requestMatched) return unavailable("request_mismatch", context, diagnostics);
            if (!diagnostics.generationsMatched) return unavailable("generation_mismatch", context, diagnostics);
            if (!diagnostics.fingerprintMatched || !text(context.formalSnapshotInputFingerprint))
                return unavailable("fingerprint_mismatch", context, diagnostics);
            if (collected.diagnostics?.mixedAcquisitionDetected === true)
                return unavailable("mixed_acquisition", context, diagnostics);

            const scope = collected.sessionScope;
            diagnostics.sameScopeVerified = scope?.scopeId === context.scopeId &&
                scope.formalTradingDate === context.formalTradingDate &&
                scope.contract === context.contract;
            if (!diagnostics.sameScopeVerified)
                return unavailable(scope?.formalTradingDate !== context.formalTradingDate
                    ? "trading_date_mismatch" : scope?.contract !== context.contract
                        ? "contract_mismatch" : "scope_mismatch", context, diagnostics);

            const built = await buildSnapshot?.(collected.builderInput);
            diagnostics.currentSnapshotBuilt = built?.success === true && Boolean(built.baseline);
            if (!diagnostics.currentSnapshotBuilt)
                return unavailable(built?.reason || "current_snapshot_build_failed", context, diagnostics);
            const currentSnapshot = clone(built.baseline);
            context.currentIdentity = snapshotIdentity(currentSnapshot, scope.scopeId);
            diagnostics.currentSnapshotValidated = await validateSnapshot?.(currentSnapshot) === true;
            if (!diagnostics.currentSnapshotValidated)
                return unavailable("current_invalid", context, diagnostics);

            diagnostics.comparisonInvoked = true;
            const comparison = await compare?.({ baseline, currentSnapshot });
            diagnostics.comparisonAvailable = comparison?.available === true &&
                comparison?.status === "comparable";
            if (!diagnostics.comparisonAvailable)
                return unavailable(comparison?.reason || "comparison_unavailable", context, diagnostics);

            if (ownAttempt !== attempt) return freeze({ published: false,
                reason: "stale_publication" });
            const endRestore = clone(getRestoreState());
            const endSourceIdentity = sourceIdentity?.(clone(getSourceStates())) || null;
            const restoreStable = restoreReason(endRestore) === null &&
                endRestore.selectedScopeId === context.scopeId &&
                endRestore.selectedBaselineId === context.selectedBaselineId &&
                endRestore.baseline?.contentSignature === baselineIdentity.contentSignature &&
                endRestore.baseline?.versionKey === baselineIdentity.versionKey;
            diagnostics.baselineIdentityMatched = diagnostics.baselineIdentityMatched && restoreStable;
            diagnostics.requestMatched = diagnostics.requestMatched &&
                requestIdOf(endSourceIdentity) === context.requestId;
            diagnostics.generationsMatched = diagnostics.generationsMatched &&
                same(endSourceIdentity, collected.sourceGenerations.end);
            diagnostics.fingerprintMatched = diagnostics.fingerprintMatched &&
                diagnostics.generationsMatched;
            diagnostics.raceGuardPassed = restoreStable && diagnostics.requestMatched &&
                diagnostics.generationsMatched && diagnostics.fingerprintMatched &&
                !isRefreshInProgress();
            if (!diagnostics.raceGuardPassed) return unavailable(!restoreStable
                ? "active_revision_changed" : !diagnostics.requestMatched ? "request_mismatch"
                    : !diagnostics.generationsMatched ? "generation_mismatch"
                        : isRefreshInProgress() ? "refresh_in_progress" : "fingerprint_mismatch",
            context, diagnostics);
            if (ownAttempt !== attempt) return freeze({ published: false,
                reason: "stale_publication" });

            publicationGeneration += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "available", reason: null,
                available: true, publicationGeneration, publishedAt: now(),
                requestId: context.requestId, scopeId: context.scopeId,
                formalTradingDate: context.formalTradingDate, contract: context.contract,
                selectedBaselineId: context.selectedBaselineId,
                baselineIdentity: clone(baselineIdentity),
                currentIdentity: clone(context.currentIdentity),
                sourceGenerations: clone(context.sourceGenerations),
                formalSnapshotInputFingerprint: context.formalSnapshotInputFingerprint,
                comparison: clone(comparison), diagnostics: freeze(clone(diagnostics)) });
            return freeze({ published: true, status: state.status,
                generation: publicationGeneration });
        }

        const getState = () => freeze(clone(state));
        return Object.freeze({ publish, invalidate, getState });
    }

    return freeze({ RUNTIME_VERSION, snapshotIdentity, createRuntime });
});
