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
            isRefreshInProgress: () => root.isMarketRefreshInProgress?.() === true,
            notifyCaptureSuccess: result =>
                root.OptionMapMorningBaselineV4RestoreRuntime?.reloadAfterCapture?.(result)
        });
        root.getMorningBaselineV4CaptureRuntimeState =
            root.OptionMapMorningBaselineV4CaptureRuntime.getState;
        root.getMorningBaselineV4AutomaticCaptureOutcome =
            root.OptionMapMorningBaselineV4CaptureRuntime.getAutomaticOutcome;
    }
})(typeof window !== "undefined" ? window : globalThis,
function (storageApi, policyApi, storeApi) {
    "use strict";
    const RUNTIME_VERSION = 1;
    const AUTOMATIC_OUTCOME_KEY = "optionMapMorningBaselineV4AutomaticOutcomeV1";
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
        const notifyCaptureSuccess = configuration.notifyCaptureSuccess;
        let sequence = 0; let lastState = null; let inProgress = false;
        const attemptedRefreshes = new Set();
        function finish(state, overrides = {}) { lastState = freeze(clone({ ...state, ...overrides,
            diagnostics: { ...state.diagnostics, ...(overrides.diagnostics || {}) } }));
            return freeze(clone(lastState)); }
        function initial(requestedAt) { return { runtimeVersion: RUNTIME_VERSION, status: "rejected",
            reason: null, attemptSequence: ++sequence, requestedAt, collectorIdentity: null,
            policyResultIdentity: null, action: "reject", saved: false,
            storageBeforeFingerprint: null, storageAfterFingerprint: null, activeBaselineId: null,
            contentSignature: null, versionKey: null, capturedAt: null,
            diagnostics: diagnostics() }; }
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
        async function capture(context = {}) {
            const requestedAt = context.requestedAt || now(); const state = initial(requestedAt);
            if (inProgress) return finish(state, { reason: "capture_in_progress" });
            const manual = context.mode === "manual" && context.userInitiated === true;
            const automatic = context.mode === "automatic_first_success" &&
                context.userInitiated !== true;
            if (!manual && !automatic)
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
                    captureContext: { mode: context.mode, userInitiated: manual,
                        requestedAt: policyRequestedAt },
                    existingStorageState: before.restored });
                state.diagnostics.policyEligible = policyResult?.eligible === true;
                state.diagnostics.policyAction = policyResult?.action || null;
                state.policyResultIdentity = { status: policyResult?.status || null,
                    action: policyResult?.action || null, scopeId: policyResult?.scopeIdentity?.scopeId || null,
                    contract: policyResult?.scopeIdentity?.contract || null,
                    formalTradingDate: policyResult?.scopeIdentity?.formalTradingDate || null,
                    baselineId: policyResult?.baselineCandidate?.baselineId || null };
                state.action = policyResult?.action || "reject";
                if (policyResult?.status === "no_change" && policyResult?.action === "duplicate")
                    return finish(state, { status: "duplicate", reason: "duplicate", action: "duplicate",
                        diagnostics: { duplicateNoWrite: true } });
                if (policyResult?.status === "no_change" && policyResult?.action === "already_saved")
                    return finish(state, { status: "already_saved", reason: "already_saved",
                        action: "already_saved" });
                if (!policyResult?.eligible || policyResult.status !== "ready_to_save" ||
                    !["create", "replace"].includes(policyResult.action) || !policyResult.savePlan)
                    return finish(state, { reason: automatic ?
                        (policyResult?.reason || "validation_failed") : "policy_rejected" });
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
                const saved = finish(state, { status: "saved", reason: null, action: policyResult.action,
                    saved: true, storageAfterFingerprint: readBack.fingerprint,
                    activeBaselineId: active.baselineId, contentSignature: active.contentSignature,
                    versionKey: active.versionKey,
                    capturedAt: policyResult.baselineCandidate?.capturedAt || null });
                try { await notifyCaptureSuccess?.(saved); }
                catch (_error) { /* restore notification must not change a completed save */ }
                return saved;
            } catch (_error) { return finish(state, { reason: "storage_write_failed" }); }
            finally { inProgress = false; }
        }
        function windowState(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return { eligible: false, status: "invalid" };
            const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit",
                hourCycle: "h23"
            }).formatToParts(date).map(part => [part.type, part.value]));
            const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
            return seconds < 5 * 3600 ? { eligible: false, status: "outside_window_before" } :
                seconds >= 9 * 3600 ? { eligible: false, status: "outside_window_after" } :
                    { eligible: true, status: "inside_window" };
        }
        function automaticOutcome(result, overrides = {}) {
            const technicalReason = overrides.reason || result?.reason || null;
            const persistenceReasons = ["storage_write_failed", "storage_readback_failed",
                "existing_storage_invalid", "storage_changed_during_capture"];
            const staleReasons = ["source_changed_during_capture", "refresh_in_progress"];
            const invalidScopeReasons = ["session_unverified", "scope_identity_mismatch",
                "storage_identity_mismatch"];
            const classifiedStatus = overrides.status || (result?.saved === true ? "saved" :
                result?.status === "already_saved" ? "already_saved" :
                    result?.status === "duplicate" ? "duplicate" :
                        persistenceReasons.includes(technicalReason) ? "persistence_failed" :
                            staleReasons.includes(technicalReason) ? "stale" :
                                invalidScopeReasons.includes(technicalReason) ? "invalid_scope" :
                                    "waiting_for_eligibility");
            return freeze({ outcomeVersion: 1,
                status: classifiedStatus, reason: technicalReason,
                mode: "automatic_first_success", attemptedAt: result?.requestedAt ||
                    overrides.attemptedAt || now(), savedAt: result?.saved === true ? now() : null,
                contract: result?.policyResultIdentity?.contract || null,
                formalTradingDate: result?.policyResultIdentity?.formalTradingDate || null,
                scopeId: result?.policyResultIdentity?.scopeId || null,
                capturedAt: result?.saved === true ? result.capturedAt : null,
                versionKey: result?.versionKey || null, baselineId: result?.activeBaselineId || null,
                saved: result?.saved === true, duplicate: result?.status === "duplicate",
                revision: result?.action === "replace", retryEligible: result?.saved !== true &&
                    !["already_saved", "duplicate"].includes(result?.status),
                windowStatus: overrides.windowStatus || "inside_window",
                errorCode: overrides.errorCode || (classifiedStatus === "waiting_for_eligibility" ||
                    ["saved", "already_saved", "duplicate"].includes(classifiedStatus) ? null :
                    technicalReason) });
        }
        function persistOutcome(value) {
            try { storage?.setItem?.(AUTOMATIC_OUTCOME_KEY, JSON.stringify(value)); return true; }
            catch (_error) { return false; }
        }
        function readOutcome() {
            try {
                const raw = storage?.getItem?.(AUTOMATIC_OUTCOME_KEY);
                if (!raw) return null;
                const value = JSON.parse(raw);
                return value?.outcomeVersion === 1 && value?.mode === "automatic_first_success"
                    ? freeze(clone(value)) : null;
            } catch (_error) { return null; }
        }
        async function captureAutomatic(context = {}) {
            const attemptedAt = context.requestedAt || now();
            const requestId = typeof context.requestId === "string" ? context.requestId : null;
            const automaticWindow = windowState(attemptedAt);
            if (!automaticWindow.eligible) {
                const value = automaticOutcome(null, { attemptedAt,
                    windowStatus: automaticWindow.status, status: automaticWindow.status,
                    reason: automaticWindow.status });
                persistOutcome(value); return value;
            }
            if (!requestId || attemptedRefreshes.has(requestId)) {
                const value = automaticOutcome(null, { attemptedAt, windowStatus: "inside_window",
                    errorCode: requestId ? "same_refresh_attempted" : "request_id_missing" });
                persistOutcome(value); return value;
            }
            attemptedRefreshes.add(requestId);
            const result = await capture({ mode: "automatic_first_success", userInitiated: false,
                requestedAt: attemptedAt });
            const value = automaticOutcome(result, { windowStatus: "inside_window" });
            if (!persistOutcome(value)) return freeze({ ...clone(value), reason: value.saved ?
                "diagnostics_failed" : value.reason, errorCode: "diagnostics_failed" });
            return value;
        }
        const captureManual = context => capture(context);
        const getState = () => freeze(clone(lastState));
        const getAutomaticOutcome = () => readOutcome();
        return Object.freeze({ captureManual, captureAutomatic, getState, getAutomaticOutcome,
            evaluateAutomaticWindow: windowState });
    }
    return Object.freeze({ RUNTIME_VERSION, AUTOMATIC_OUTCOME_KEY, createRuntime });
});
