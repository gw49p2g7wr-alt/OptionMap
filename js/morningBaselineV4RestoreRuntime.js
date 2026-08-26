(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const storageApi = commonJs ? require("./morningBaselineV4Storage.js") :
        root?.OptionMapMorningBaselineV4StorageFoundation;
    const sessionApi = commonJs ? require("./morningV4FormalSessionScope.js") :
        root?.OptionMapMorningV4FormalSessionScope;
    const api = factory(storageApi, sessionApi);
    if (commonJs) module.exports = api;
    if (root) {
        const runtime = api.createRuntime({ storage: root.localStorage,
            getCurrentPrice: () => root.getCurrentPriceLiveIdentityFact?.(),
            getQri: () => root.getQriFormalIdentityFact?.(),
            getWeekly: () => root.getWeeklyFormalIdentityFact?.(),
            getOverall: () => root.getOverallV2FormalEnvelope?.() });
        root.OptionMapMorningBaselineV4RestoreRuntime = runtime;
        root.getMorningBaselineV4RestoreRuntimeState = runtime.getState;
        root.evaluateMorningBaselineV4Applicability = runtime.evaluateApplicability;
        void runtime.restoreAndEvaluate();
    }
})(typeof window !== "undefined" ? window : globalThis,
function (storageApi, sessionApi) {
    "use strict";
    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function hash(value) { const serialized = typeof value === "string" ? value : canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    function initialDiagnostics() { return { storageRead: false, restoreValid: false,
        storageFingerprint: null, currentFactsReady: false, currentScopeVerified: false,
        scopeMatched: false, contractMatched: false, tradingDateMatched: false,
        logicVersionMatched: false, currentPriceEligible: false, qriEligible: false,
        weeklyEligible: false, overallEligible: false, selectedActiveRevision: false,
        storageAccessed: false, databaseAccessed: false, fetchTriggered: false,
        formalRecalculationTriggered: false, comparisonTriggered: false, domMutated: false }; }
    function createRuntime(configuration = {}) {
        const storage = configuration.storage; const now = configuration.now || (() => new Date().toISOString());
        const getters = { currentPrice: configuration.getCurrentPrice || (() => null),
            qri: configuration.getQri || (() => null), weekly: configuration.getWeekly || (() => null),
            overall: configuration.getOverall || (() => null) };
        let restoredContainer = null; let storageFingerprint = null; let state = freeze({
            runtimeVersion: RUNTIME_VERSION, restoreStatus: "not_started", integrityStatus: "pending",
            applicabilityStatus: "pending", reason: "restore_not_started", storageFingerprint: null,
            selectedScopeId: null, selectedBaselineId: null, baseline: null, currentScope: null,
            evaluatedAt: null, diagnostics: initialDiagnostics() });
        const finish = overrides => { state = freeze({ ...clone(state), ...clone(overrides),
            diagnostics: { ...clone(state.diagnostics), ...clone(overrides.diagnostics || {}) } });
            return freeze(clone(state)); };
        const pendingReason = value => ["not_published", "acquisition_pending"].includes(value?.reason) ||
            ["empty", "pending"].includes(value?.status);
        function facts() { return { currentPrice: clone(getters.currentPrice?.() || null),
            qri: clone(getters.qri?.() || null), weekly: clone(getters.weekly?.() || null),
            overall: clone(getters.overall?.() || null) }; }
        function priceFact(source) { const fact = clone(source?.fact || null);
            if (fact && Number.isSafeInteger(source?.publicationGeneration)) fact.generation = {
                source: "currentPrice", sequence: source.publicationGeneration,
                fingerprint: fact.versionKey, current: source.status === "available" }; return fact; }
        async function currentScopeOf(sources) {
            if (typeof configuration.getCurrentScope === "function")
                return clone(await configuration.getCurrentScope(sources));
            const identity = { currentPriceGeneration: sources.currentPrice?.publicationGeneration ?? null,
                qriGeneration: sources.qri?.publicationGeneration ?? null,
                weeklyGeneration: sources.weekly?.publicationGeneration ?? null,
                overallGeneration: sources.overall?.publicationGeneration ?? null,
                requestIds: [sources.currentPrice?.requestId, sources.qri?.requestId,
                    sources.weekly?.requestId, sources.overall?.requestId].map(value => value || null) };
            const fingerprint = await hash(identity); const qri = sources.qri?.fact;
            return sessionApi?.evaluateFormalSessionScope?.({ capturedAt: now(),
                currentPriceLiveIdentity: priceFact(sources.currentPrice), qriFormalIdentity: qri,
                weeklyFormalIdentity: sources.weekly?.fact, overallV2Envelope: sources.overall?.envelope,
                marketRefreshContext: { requestId: qri?.requestId || null,
                    startGenerationFingerprint: fingerprint, endGenerationFingerprint: fingerprint,
                    sourceGenerationChanged: false } }) || null;
        }
        async function restore() {
            const diagnostics = initialDiagnostics(); diagnostics.storageRead = true;
            diagnostics.storageAccessed = true; let raw;
            try { raw = storage?.getItem?.(storageApi.STORAGE_KEY); }
            catch (_error) { restoredContainer = null; storageFingerprint = null;
                return finish({ restoreStatus: "invalid", integrityStatus: "integrity_invalid",
                    applicabilityStatus: "integrity_invalid", reason: "storage_read_failed",
                    storageFingerprint: null, selectedScopeId: null, selectedBaselineId: null,
                    baseline: null, currentScope: null, evaluatedAt: now(), diagnostics }); }
            const restored = await storageApi.restoreMorningBaselineV4Storage(raw);
            if (restored.status === "missing") { restoredContainer = null; storageFingerprint = null;
                return finish({ restoreStatus: "missing", integrityStatus: "missing",
                    applicabilityStatus: "no_baseline", reason: "no_baseline", storageFingerprint: null,
                    selectedScopeId: null, selectedBaselineId: null, baseline: null,
                    currentScope: null, evaluatedAt: now(), diagnostics }); }
            if (!restored.success) { restoredContainer = null; storageFingerprint = null;
                return finish({ restoreStatus: "invalid", integrityStatus: "integrity_invalid",
                    applicabilityStatus: "integrity_invalid", reason: restored.reason || "integrity_invalid",
                    storageFingerprint: null, selectedScopeId: null, selectedBaselineId: null,
                    baseline: null, currentScope: null, evaluatedAt: now(), diagnostics }); }
            const serialized = await storageApi.serializeMorningBaselineV4Storage(restored.container);
            if (!serialized.success) { restoredContainer = null; storageFingerprint = null;
                return finish({ restoreStatus: "invalid", integrityStatus: "integrity_invalid",
                    applicabilityStatus: "integrity_invalid", reason: "integrity_invalid",
                    storageFingerprint: null, selectedScopeId: null, selectedBaselineId: null,
                    baseline: null, currentScope: null, evaluatedAt: now(), diagnostics }); }
            restoredContainer = clone(restored.container); storageFingerprint = await hash(serialized.serialized);
            diagnostics.restoreValid = true; diagnostics.storageFingerprint = storageFingerprint;
            return finish({ restoreStatus: "valid", integrityStatus: "valid",
                applicabilityStatus: "pending", reason: "current_facts_pending",
                storageFingerprint, selectedScopeId: null, selectedBaselineId: null,
                baseline: null, currentScope: null, evaluatedAt: now(), diagnostics });
        }
        async function evaluateApplicability() {
            if (state.integrityStatus !== "valid" || !restoredContainer) return freeze(clone(state));
            const sources = facts(); const diagnostics = { ...initialDiagnostics(), storageRead: true,
                restoreValid: true, storageFingerprint, storageAccessed: true };
            const pending = Object.values(sources).some(pendingReason);
            if (pending) return finish({ applicabilityStatus: "pending", reason: "current_facts_pending",
                selectedScopeId: null, selectedBaselineId: null, baseline: null, currentScope: null,
                evaluatedAt: now(), diagnostics });
            const price = sources.currentPrice?.fact; const qri = sources.qri?.fact;
            const weekly = sources.weekly?.fact; const overall = sources.overall?.envelope;
            diagnostics.currentPriceEligible = sources.currentPrice?.status === "available" &&
                price?.available === true && price.sourceKind === "live" && price.origin === "live" &&
                price.mode === "automatic" && price.identityVerified === true &&
                price.acquisitionVerified === true && price.currentRequestVerified === true &&
                price.qriTradingDateMapping?.mappingVerified === true &&
                price.qriTradingDateMapping?.mappingSource === "same_date_explicit";
            diagnostics.qriEligible = sources.qri?.status === "available" && qri?.sourceClass === "formal_live" &&
                qri.origin === "live" && qri.usingFallback === false && qri.referenceOnly === false &&
                qri.superseded !== true && qri.identityVerified === true && qri.acquisitionVerified === true;
            diagnostics.weeklyEligible = sources.weekly?.status === "available" &&
                weekly?.sourceClass === "formal_history" && weekly.activeVersionMatched === true &&
                text(weekly.currentVersionKey) && text(weekly.currentSignature) && text(weekly.sourceFingerprint);
            diagnostics.overallEligible = sources.overall?.status === "available" && overall?.formalApplied === true &&
                overall.referenceOnly === false && overall.identityVerified === true &&
                ["complete", "partial"].includes(overall.status) && text(overall.logicVersion) &&
                text(overall.inputFingerprint);
            diagnostics.currentFactsReady = true;
            let ineligible = null;
            if (!diagnostics.currentPriceEligible) ineligible = sources.currentPrice?.diagnostics
                ?.formalCurrentPriceMode === "manual" ? "current_price_manual" : "current_price_ineligible";
            else if (!diagnostics.qriEligible) ineligible = qri?.usingFallback === true ? "qri_fallback" :
                qri?.origin === "saved" || qri?.referenceOnly === true ? "qri_saved_or_reference" : "qri_ineligible";
            else if (!diagnostics.weeklyEligible) ineligible = "weekly_ineligible";
            else if (!diagnostics.overallEligible) ineligible = "overall_ineligible";
            if (ineligible) return finish({ applicabilityStatus: "not_applicable", reason: ineligible,
                selectedScopeId: null, selectedBaselineId: null, baseline: null, currentScope: null,
                evaluatedAt: now(), diagnostics });
            const currentScope = await currentScopeOf(sources);
            diagnostics.currentScopeVerified = currentScope?.status === "verified" &&
                currentScope?.mappingVerified === true && currentScope?.sessionClass === "same_date_verified";
            if (!diagnostics.currentScopeVerified) return finish({ applicabilityStatus: "not_applicable",
                reason: currentScope?.reason || "session_unverified", selectedScopeId: null,
                selectedBaselineId: null, baseline: null, currentScope: clone(currentScope),
                evaluatedAt: now(), diagnostics });
            const series = restoredContainer.series.find(item => item.scopeId === currentScope.scopeId) || null;
            if (!series) { const sameDate = restoredContainer.series.find(item =>
                    item.formalTradingDate === currentScope.formalTradingDate);
                const sameContract = restoredContainer.series.find(item => item.contract === currentScope.contract);
                return finish({ applicabilityStatus: "not_applicable", reason: sameDate &&
                    sameDate.contract !== currentScope.contract ? "contract_mismatch" : sameContract &&
                        sameContract.formalTradingDate !== currentScope.formalTradingDate ?
                            "trading_date_mismatch" : "scope_not_found", selectedScopeId: null,
                    selectedBaselineId: null, baseline: null, currentScope: clone(currentScope),
                    evaluatedAt: now(), diagnostics }); }
            diagnostics.scopeMatched = true; diagnostics.contractMatched = series.contract === currentScope.contract;
            diagnostics.tradingDateMatched = series.formalTradingDate === currentScope.formalTradingDate;
            if (!diagnostics.contractMatched || !diagnostics.tradingDateMatched)
                return finish({ applicabilityStatus: "not_applicable", reason:
                    !diagnostics.contractMatched ? "contract_mismatch" : "trading_date_mismatch",
                    selectedScopeId: series.scopeId, selectedBaselineId: null, baseline: null,
                    currentScope: clone(currentScope), evaluatedAt: now(), diagnostics });
            const active = series.revisions.find(item => item.baselineId === series.activeBaselineId) || null;
            if (!active || active.replacedAt !== null) return finish({ applicabilityStatus: "integrity_invalid",
                reason: "active_revision_invalid", selectedScopeId: series.scopeId, selectedBaselineId: null,
                baseline: null, currentScope: clone(currentScope), evaluatedAt: now(), diagnostics });
            diagnostics.selectedActiveRevision = true;
            diagnostics.logicVersionMatched = active.snapshot?.overallV2?.logicVersion === overall.logicVersion;
            if (!diagnostics.logicVersionMatched) return finish({ applicabilityStatus: "not_applicable",
                reason: "logic_version_mismatch", selectedScopeId: series.scopeId,
                selectedBaselineId: active.baselineId, baseline: null, currentScope: clone(currentScope),
                evaluatedAt: now(), diagnostics });
            return finish({ applicabilityStatus: "applicable", reason: null,
                selectedScopeId: series.scopeId, selectedBaselineId: active.baselineId,
                baseline: clone(active.snapshot), currentScope: clone(currentScope),
                evaluatedAt: now(), diagnostics });
        }
        async function restoreAndEvaluate() { await restore(); return evaluateApplicability(); }
        async function reloadAfterCapture(result) { if (result?.status !== "saved" || result?.saved !== true)
            return freeze(clone(state)); return restoreAndEvaluate(); }
        const getState = () => freeze(clone(state));
        return Object.freeze({ restore, evaluateApplicability, restoreAndEvaluate,
            reloadAfterCapture, getState });
    }
    return Object.freeze({ RUNTIME_VERSION, createRuntime });
});
