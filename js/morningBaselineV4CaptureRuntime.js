(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const storageApi = commonJs ? require("./morningBaselineV4Storage.js") :
        root?.OptionMapMorningBaselineV4StorageFoundation;
    const policyApi = commonJs ? require("./morningBaselineV4CapturePolicy.js") :
        root?.OptionMapMorningBaselineV4CapturePolicy;
    const storeApi = commonJs ? require("./storage/morningBaselineV4Store.js") :
        root?.OptionMapMorningBaselineV4Store;
    const api = factory(storageApi, policyApi, storeApi);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapMorningBaselineV4CaptureRuntime = api.createRuntime({
            storage: root.localStorage,
            collect: options => root.collectMorningBaselineV4ReadOnly?.(options),
            isRefreshInProgress: () => root.isMarketRefreshInProgress?.() === true
        });
        root.getMorningBaselineV4CaptureRuntimeState =
            root.OptionMapMorningBaselineV4CaptureRuntime.getState;
    }
})(typeof window !== "undefined" ? window : globalThis,
function (storageApi, policyApi, storeApi) {
    "use strict";
    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const canonical = value => { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); };
    async function sha256(value) { const serialized = typeof value === "string" ? value : canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    const same = (left, right) => canonical(left) === canonical(right);
    function diagnostics() { return { collectorReady: false, policyEligible: false,
        policyAction: null, sourceStableBeforeWrite: false, storageStableBeforeWrite: false,
        setItemCount: 0, readBackValidated: false, savedBaselineActive: false,
        duplicateNoWrite: false, legacyStorageTouched: false, unrelatedStorageTouched: false,
        databaseAccessed: false, fetchTriggered: false, formalRecalculationTriggered: false,
        domMutatedByRuntime: false, autoComparisonTriggered: false }; }
    function createRuntime(configuration = {}) {
        const storage = configuration.storage;
        const collect = configuration.collect;
        const refresh = configuration.isRefreshInProgress || (() => false);
        const now = configuration.now || (() => new Date().toISOString());
        const policy = configuration.evaluatePolicy || policyApi?.evaluateMorningBaselineV4CapturePolicy;
        const store = configuration.store || storeApi?.createStore?.(storage);
        let sequence = 0; let lastState = null; let inProgress = false;
        function finish(state, overrides = {}) { lastState = freeze(clone({ ...state, ...overrides,
            diagnostics: { ...state.diagnostics, ...(overrides.diagnostics || {}) } }));
            return freeze(clone(lastState)); }
        function initial(requestedAt) { return { runtimeVersion: RUNTIME_VERSION, status: "rejected",
            reason: null, attemptSequence: ++sequence, requestedAt, collectorIdentity: null,
            policyResultIdentity: null, action: "reject", saved: false,
            storageBeforeFingerprint: null, storageAfterFingerprint: null, activeBaselineId: null,
            contentSignature: null, versionKey: null, diagnostics: diagnostics() }; }
        function readRaw() { return storage.getItem(storageApi.STORAGE_KEY); }
        async function inspectRaw(raw) {
            if (raw === null || raw === undefined || raw === "")
                return { status: "missing", restored: await storageApi.restoreMorningBaselineV4Storage(null),
                    container: null, fingerprint: null, active: null };
            const restored = await storageApi.restoreMorningBaselineV4Storage(raw);
            if (!restored.success) return { status: "invalid", restored, container: null,
                fingerprint: null, active: null };
            const serialized = await storageApi.serializeMorningBaselineV4Storage(restored.container);
            if (!serialized.success) return { status: "invalid", restored, container: null,
                fingerprint: null, active: null };
            return { status: "valid", restored, container: restored.container,
                fingerprint: await sha256(serialized.serialized), active: null };
        }
        function activeIdentity(container, scopeId) {
            const series = container?.series?.find(item => item.scopeId === scopeId);
            const active = series?.revisions?.find(item => item.baselineId === series.activeBaselineId);
            return active ? { baselineId: active.baselineId, versionKey: active.versionKey,
                contentSignature: active.contentSignature } : null;
        }
        function sourceIdentity(collector) { return { generations: collector?.sourceGenerations?.end || null,
            formalSnapshotInputFingerprint: collector?.formalSnapshotInputFingerprint || null }; }
        async function captureManual(context = {}) {
            const requestedAt = context.requestedAt || now(); const state = initial(requestedAt);
            if (inProgress) return finish(state, { reason: "capture_in_progress" });
            if (context.mode !== "manual" || context.userInitiated !== true)
                return finish(state, { reason: "policy_rejected" });
            inProgress = true;
            try {
                if (refresh()) return finish(state, { reason: "refresh_in_progress" });
                const collector = await collect();
                state.diagnostics.collectorReady = collector?.ready === true && collector?.status === "ready";
                state.collectorIdentity = { collectedAt: collector?.collectedAt || null,
                    formalSnapshotInputFingerprint: collector?.formalSnapshotInputFingerprint || null,
                    sourceGenerations: clone(collector?.sourceGenerations || null) };
                if (!state.diagnostics.collectorReady) return finish(state, {
                    reason: "collector_not_ready" });
                const policyRequestedAt = now();
                let beforeRaw; try { beforeRaw = readRaw(); }
                catch (_error) { return finish(state, { reason: "existing_storage_invalid" }); }
                const before = await inspectRaw(beforeRaw);
                if (before.status === "invalid") return finish(state, { reason: "existing_storage_invalid" });
                state.storageBeforeFingerprint = before.fingerprint;
                const policyResult = await policy({ collectorResult: collector,
                    captureContext: { mode: "manual", userInitiated: true,
                        requestedAt: policyRequestedAt },
                    existingStorageState: before.restored });
                state.diagnostics.policyEligible = policyResult?.eligible === true;
                state.diagnostics.policyAction = policyResult?.action || null;
                state.policyResultIdentity = { status: policyResult?.status || null,
                    action: policyResult?.action || null, scopeId: policyResult?.scopeIdentity?.scopeId || null,
                    baselineId: policyResult?.baselineCandidate?.baselineId || null };
                state.action = policyResult?.action || "reject";
                if (policyResult?.status === "no_change" && policyResult?.action === "duplicate")
                    return finish(state, { status: "duplicate", reason: "duplicate", action: "duplicate",
                        diagnostics: { duplicateNoWrite: true } });
                if (!policyResult?.eligible || policyResult.status !== "ready_to_save" ||
                    !["create", "replace"].includes(policyResult.action) || !policyResult.savePlan)
                    return finish(state, { reason: "policy_rejected" });
                if (refresh()) return finish(state, { reason: "refresh_in_progress" });
                const verification = await collect();
                if (refresh()) return finish(state, { reason: "refresh_in_progress" });
                const sourceStable = verification?.ready === true &&
                    same(sourceIdentity(collector), sourceIdentity(verification));
                state.diagnostics.sourceStableBeforeWrite = sourceStable;
                if (!sourceStable) return finish(state, { reason: "source_changed_during_capture" });
                let currentRaw; try { currentRaw = readRaw(); }
                catch (_error) { return finish(state, { reason: "storage_changed_during_capture" }); }
                const current = await inspectRaw(currentRaw); const plan = policyResult.savePlan;
                if (current.status === "invalid") return finish(state, { reason: "storage_changed_during_capture" });
                const currentActive = activeIdentity(current.container, plan.scopeId);
                const storageStable = current.fingerprint === plan.expectedContainerFingerprint &&
                    (currentActive?.baselineId || null) === plan.expectedActiveBaselineId &&
                    (currentActive?.versionKey || null) === plan.expectedActiveVersionKey;
                state.diagnostics.storageStableBeforeWrite = storageStable;
                if (!storageStable) return finish(state, { reason: "storage_changed_during_capture" });
                if (refresh()) return finish(state, { reason: "refresh_in_progress" });
                const stored = await store.saveContainer(plan.proposedContainer);
                state.diagnostics.setItemCount = stored?.writeCount || 0;
                if (!stored?.saved) return finish(state, { reason: "storage_write_failed" });
                let readBackRaw; try { readBackRaw = readRaw(); }
                catch (_error) { return finish(state, { reason: "storage_readback_failed" }); }
                const readBack = await inspectRaw(readBackRaw);
                const active = activeIdentity(readBack.container, plan.scopeId);
                const readBackValid = readBack.status === "valid" && active?.baselineId === plan.baselineId &&
                    active?.contentSignature === plan.contentSignature && active?.versionKey === plan.versionKey;
                state.diagnostics.readBackValidated = readBack.status === "valid";
                state.diagnostics.savedBaselineActive = readBackValid;
                if (!readBackValid) return finish(state, { reason: "storage_readback_failed",
                    storageAfterFingerprint: readBack.fingerprint });
                return finish(state, { status: "saved", reason: null, action: policyResult.action,
                    saved: true, storageAfterFingerprint: readBack.fingerprint,
                    activeBaselineId: active.baselineId, contentSignature: active.contentSignature,
                    versionKey: active.versionKey });
            } catch (_error) { return finish(state, { reason: "storage_write_failed" }); }
            finally { inProgress = false; }
        }
        const getState = () => freeze(clone(lastState));
        return Object.freeze({ captureManual, getState });
    }
    return Object.freeze({ RUNTIME_VERSION, createRuntime });
});
