(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsMajorSqAcquisition = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
    const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
    const QUARTER_MONTHS = Object.freeze([3, 6, 9, 12]);
    const REQUIRED_DEPENDENCIES = Object.freeze(["fetchReferencePage", "buildCanonical",
        "validateCanonical", "buildCache", "validateCache", "persistReference",
        "getCurrentFormalContext", "getCurrentLifecycleState", "now", "createRequestId"]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function validDate(value) {
        if (!DATE_PATTERN.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    function nextMajorSqContract(activeContract) {
        if (!CONTRACT_PATTERN.test(activeContract || "")) return null;
        let year = Number(activeContract.slice(0, 4));
        const month = Number(activeContract.slice(5));
        let targetMonth = QUARTER_MONTHS.find(value => value > month);
        if (!targetMonth) { year += 1; targetMonth = 3; }
        return `${year}-${String(targetMonth).padStart(2, "0")}`;
    }
    function emptyState() {
        return { status: "idle", reason: null, generation: 0,
            parentMarketRefreshRequestId: null, formalPublicationGeneration: null,
            requestId: null, activeContract: null, activeTradingDate: null,
            activeVersionKey: null, targetContract: null, targetUrl: null,
            referenceTradingDate: null, versionKey: null, startedAt: null,
            completedAt: null, fetched: false, canonicalValid: false,
            persistenceStatus: null, persisted: false, unchanged: false, errorCode: null };
    }
    function validFormalContext(context) {
        return context && context.formalCompletionVerified === true &&
            text(context.parentMarketRefreshRequestId) &&
            Number.isSafeInteger(context.formalPublicationGeneration) &&
            context.formalPublicationGeneration >= 0 && context.sourceClass === "formal_live" &&
            context.identityVerified === true && context.acquisitionVerified === true &&
            context.openInterestStatus === "available" &&
            CONTRACT_PATTERN.test(context.activeContract || "") && validDate(context.formalTradingDate) &&
            text(context.activeCanonicalVersionKey) && text(context.activeSourceUrl) &&
            Array.isArray(context.availableContracts);
    }
    function sameFormalContext(captured, current) {
        return validFormalContext(current) &&
            current.parentMarketRefreshRequestId === captured.parentMarketRefreshRequestId &&
            current.formalPublicationGeneration === captured.formalPublicationGeneration &&
            current.activeContract === captured.activeContract &&
            current.formalTradingDate === captured.formalTradingDate &&
            current.activeCanonicalVersionKey === captured.activeCanonicalVersionKey &&
            current.activeSourceUrl === captured.activeSourceUrl;
    }
    function monthFromLabel(label) {
        const match = String(label || "").match(/(1[0-2]|[1-9])月/);
        return match ? Number(match[1]) : null;
    }
    function selectManifestEntry(context, targetContract) {
        const entries = context.availableContracts;
        if (entries.length === 0) return { reason: "manifest_invalid" };
        const urls = new Set(); const contracts = new Set();
        for (const entry of entries) {
            const url = text(entry?.url); const label = text(entry?.label);
            const resolved = CONTRACT_PATTERN.test(entry?.contract || "");
            const unresolved = entry?.contract == null && entry?.active === false &&
                (entry?.resolution == null || entry.resolution === "unresolved") &&
                (entry?.selectionKey == null || entry.selectionKey === `url:${url}`);
            if (!url || !label || typeof entry?.active !== "boolean" || urls.has(url) ||
                !resolved && !unresolved || resolved && contracts.has(entry.contract)) {
                return { reason: "manifest_invalid" };
            }
            urls.add(url); if (resolved) contracts.add(entry.contract);
        }
        const active = entries.filter(entry => entry?.active === true);
        if (active.length !== 1 || active[0].contract !== context.activeContract ||
            active[0].url !== context.activeSourceUrl) return { reason: "manifest_active_mismatch" };
        const resolved = entries.filter(entry => entry?.active === false &&
            entry.contract === targetContract && text(entry.url));
        if (resolved.length === 1) return { entry: resolved[0], unresolved: false };
        if (resolved.length > 1) return { reason: "manifest_target_ambiguous" };
        const targetMonth = Number(targetContract.slice(5));
        const unresolved = entries.filter(entry => entry?.active === false &&
            entry.contract == null && text(entry.url) && monthFromLabel(entry.label) === targetMonth);
        if (unresolved.length === 1) return { entry: unresolved[0], unresolved: true };
        return { reason: unresolved.length > 1 ? "manifest_target_ambiguous" : "manifest_target_missing" };
    }
    function canonicalMatchesTarget(canonical, entry, targetContract, validateCanonical) {
        if (!canonical || validateCanonical !== true || canonical.contract !== targetContract ||
            canonical.sourceUrl !== entry.url || canonical.gengetsu !== targetContract.replace("-", "") ||
            !Array.isArray(canonical.records) || canonical.records.length === 0 ||
            canonical.records.some(record => record?.contract !== targetContract)) return false;
        const selected = canonical.availableContracts?.filter(item => item?.active === true) || [];
        return selected.length === 1 && selected[0].url === entry.url &&
            selected[0].contract === targetContract && selected[0].label === entry.label &&
            canonical.contractLabel === entry.label;
    }

    function createQriMajorSqAcquisitionOrchestrator(dependencies = {}) {
        for (const name of REQUIRED_DEPENDENCIES) {
            if (typeof dependencies[name] !== "function") throw new TypeError(`missing_dependency:${name}`);
        }
        let generation = 0; let disposed = false; let state = freeze(emptyState());
        const successMemos = new Map();
        const publish = patch => (state = freeze({ ...state, ...clone(patch) }), getState());
        const getState = () => freeze(clone(state));
        const lifecycleCurrent = ownGeneration => {
            let lifecycle;
            try { lifecycle = dependencies.getCurrentLifecycleState(); } catch (_error) { return false; }
            return !disposed && ownGeneration === generation && lifecycle?.disposed !== true &&
                (lifecycle?.generation == null || lifecycle.generation === ownGeneration);
        };
        const requestCurrent = (ownGeneration, captured) => {
            if (!lifecycleCurrent(ownGeneration)) return false;
            try { return sameFormalContext(captured, dependencies.getCurrentFormalContext()); }
            catch (_error) { return false; }
        };
        const stale = (ownGeneration, reason = "lifecycle_changed") => disposed
            ? publish({ status: "disposed", reason: "disposed", completedAt: dependencies.now() })
            : ownGeneration !== generation ? freeze({ ...emptyState(), status: "stale", reason,
                generation: ownGeneration, completedAt: dependencies.now() })
                : publish({ status: "stale", reason, completedAt: dependencies.now() });
        const fail = (ownGeneration, reason, error = null) => !lifecycleCurrent(ownGeneration)
            ? stale(ownGeneration) : publish({ status: "failed", reason,
                completedAt: dependencies.now(),
                errorCode: text(error?.code) || text(error?.message) || text(error) || reason });
        const skip = (ownGeneration, reason, extra = {}) => publish({ status: "skipped", reason,
            generation: ownGeneration, completedAt: dependencies.now(), ...extra });

        async function run(inputContext) {
            if (disposed) return publish({ status: "disposed", reason: "disposed",
                completedAt: dependencies.now() });
            const ownGeneration = ++generation; const captured = clone(inputContext);
            state = freeze({ ...emptyState(), status: "scheduled", generation: ownGeneration,
                startedAt: dependencies.now(), parentMarketRefreshRequestId:
                    text(captured?.parentMarketRefreshRequestId),
                formalPublicationGeneration: captured?.formalPublicationGeneration ?? null,
                activeContract: text(captured?.activeContract),
                activeTradingDate: text(captured?.formalTradingDate),
                activeVersionKey: text(captured?.activeCanonicalVersionKey) });
            if (!validFormalContext(captured)) return skip(ownGeneration,
                captured?.openInterestStatus !== "available" ? "open_interest_unavailable"
                    : "formal_context_incomplete");
            if (!requestCurrent(ownGeneration, captured)) return stale(ownGeneration, "stale_parent");
            const targetContract = nextMajorSqContract(captured.activeContract);
            if (!targetContract) return skip(ownGeneration, "target_contract_invalid");
            publish({ targetContract });
            const selection = selectManifestEntry(captured, targetContract);
            if (!selection.entry) return skip(ownGeneration, selection.reason, { targetContract });
            const targetUrl = text(selection.entry.url);
            const requestId = text(dependencies.createRequestId({ generation: ownGeneration,
                parentMarketRefreshRequestId: captured.parentMarketRefreshRequestId,
                targetContract, targetUrl }));
            if (!requestId || !targetUrl || targetUrl === captured.activeSourceUrl) {
                return skip(ownGeneration, "invalid_target", { targetContract, targetUrl });
            }
            const successKey = [captured.activeContract, captured.formalTradingDate,
                targetContract, targetUrl].join("|");
            const successMemo = successMemos.get(successKey) || null;
            if (successMemo) {
                const memoCurrent = successMemo.role === "major_sq" &&
                    successMemo.activeContract === captured.activeContract &&
                    successMemo.targetContract === targetContract &&
                    successMemo.referenceTradingDate === captured.formalTradingDate &&
                    successMemo.targetUrl === targetUrl &&
                    requestCurrent(ownGeneration, captured);
                if (memoCurrent && typeof dependencies.restoreAcceptedIvHistory === "function") {
                    try {
                        await dependencies.restoreAcceptedIvHistory(freeze(clone(successMemo)), {
                            isCurrentRequest: () => requestCurrent(ownGeneration, captured)
                        });
                    } catch (_error) { /* Exact history restore is fail-closed and read-only. */ }
                }
                if (!requestCurrent(ownGeneration, captured)) {
                    return stale(ownGeneration, "stale_parent");
                }
                return skip(ownGeneration, "already_succeeded_for_trading_date", {
                    requestId, targetContract, targetUrl,
                    referenceTradingDate: memoCurrent ? successMemo.referenceTradingDate : null,
                    versionKey: memoCurrent ? successMemo.versionKey : null
                });
            }
            publish({ status: "fetching", requestId, targetUrl });
            let raw;
            try { raw = await dependencies.fetchReferencePage(targetUrl); }
            catch (error) { return fail(ownGeneration, "fetch_failed", error); }
            if (!requestCurrent(ownGeneration, captured)) return stale(ownGeneration);
            publish({ status: "validating", fetched: true });
            let canonical;
            try { canonical = await dependencies.buildCanonical(raw, { sourceUrl: targetUrl }); }
            catch (error) { return fail(ownGeneration, "canonical_build_failed", error); }
            let canonicalValid = false;
            try { canonicalValid = await dependencies.validateCanonical(canonical) === true; }
            catch (error) { return fail(ownGeneration, "canonical_validation_failed", error); }
            const referenceTradingDate = text(canonical?.tradingDate);
            publish({ canonicalValid, referenceTradingDate });
            if (!canonicalValid) return fail(ownGeneration, "canonical_invalid");
            if (!canonicalMatchesTarget(canonical, selection.entry, targetContract, canonicalValid)) {
                return fail(ownGeneration, canonical?.sourceUrl !== targetUrl
                    ? "source_url_mismatch" : "contract_mismatch");
            }
            if (!validDate(referenceTradingDate)) return fail(ownGeneration, "reference_trading_date_invalid");
            if (canonical.openInterestStatus !== "available") {
                return fail(ownGeneration, "open_interest_unavailable");
            }
            if (!canonical.records.some(record => record?.published === true)) {
                return fail(ownGeneration, "published_record_missing");
            }
            let cache;
            try { cache = await dependencies.buildCache(canonical); }
            catch (error) { return fail(ownGeneration, "cache_build_failed", error); }
            let cacheValid = false;
            try { cacheValid = await dependencies.validateCache(cache) === true; }
            catch (error) { return fail(ownGeneration, "cache_validation_failed", error); }
            if (!cacheValid || cache?.contract !== targetContract || cache?.sourceUrl !== targetUrl ||
                !text(cache?.signature) || !text(cache?.versionKey)) return fail(ownGeneration, "cache_invalid");
            if (!requestCurrent(ownGeneration, captured)) return stale(ownGeneration);
            publish({ status: "persisting", versionKey: cache.versionKey });
            let persistence;
            try {
                persistence = await dependencies.persistReference(cache, {
                    mode: "reference_history", acquisitionOrigin: "live",
                    requestedContract: targetContract, sourceUrl: targetUrl, requestId,
                    isCurrentRequest: () => requestCurrent(ownGeneration, captured)
                });
            } catch (error) { return fail(ownGeneration, "persistence_failed", error); }
            if (!requestCurrent(ownGeneration, captured)) return stale(ownGeneration);
            if (persistence?.status === "saved" || persistence?.status === "unchanged") {
                if (typeof dependencies.persistAcceptedIvHistory === "function") {
                    try { await dependencies.persistAcceptedIvHistory({ responseHtml: raw,
                        referenceCanonical: canonical, referenceCache: cache,
                        referenceStatus: persistence.status, targetContract,
                        sourceUrl: targetUrl, requestId,
                        parentMarketRefreshRequestId: captured.parentMarketRefreshRequestId,
                        formalPublicationGeneration: captured.formalPublicationGeneration,
                        acquisitionGeneration: ownGeneration, fetchedAt: cache.fetchedAt,
                        confirmedAt: dependencies.now()
                    }, { isCurrentRequest: () => requestCurrent(ownGeneration, captured) }); }
                    catch (_error) { /* IV history is fail-open for the live acquisition. */ }
                }
                if (typeof dependencies.publishAcceptedReference === "function") {
                    try {
                        await dependencies.publishAcceptedReference({ responseHtml: raw,
                            referenceCanonical: canonical, referenceCache: cache,
                            referenceStatus: persistence.status, targetContract,
                            referenceVersionKey: cache.versionKey,
                            sourceUrl: targetUrl, requestId,
                            parentMarketRefreshRequestId: captured.parentMarketRefreshRequestId,
                            formalPublicationGeneration: captured.formalPublicationGeneration,
                            acquisitionGeneration: ownGeneration,
                            fetchedAt: cache.fetchedAt, completedAt: dependencies.now()
                        }, { isCurrentRequest: () => requestCurrent(ownGeneration, captured) });
                    } catch (_error) { /* IV session publication is fail-closed and non-authoritative. */ }
                }
                if (!requestCurrent(ownGeneration, captured)) return stale(ownGeneration);
                successMemos.set(successKey, freeze({ role: "major_sq",
                    activeContract: captured.activeContract,
                    activeVersionKey: captured.activeCanonicalVersionKey, targetContract,
                    referenceTradingDate, targetUrl, versionKey: cache.versionKey }));
                return publish({ status: persistence.status, reason: persistence.reason || null,
                    completedAt: dependencies.now(), persistenceStatus: persistence.status,
                    persisted: persistence.status === "saved", unchanged: persistence.status === "unchanged" });
            }
            return fail(ownGeneration, persistence?.reason || "persistence_rejected",
                persistence?.errorCode || null);
        }
        function getFormalHistoryLocator() {
            if (!["saved", "unchanged"].includes(state.status) ||
                !CONTRACT_PATTERN.test(state.targetContract || "") || !validDate(state.referenceTradingDate) ||
                !text(state.targetUrl) || !text(state.versionKey) || !text(state.requestId) ||
                !text(state.parentMarketRefreshRequestId)) return null;
            return freeze(clone({ status: state.status, targetContract: state.targetContract,
                referenceTradingDate: state.referenceTradingDate, targetUrl: state.targetUrl,
                versionKey: state.versionKey, requestId: state.requestId,
                parentMarketRefreshRequestId: state.parentMarketRefreshRequestId,
                formalPublicationGeneration: state.formalPublicationGeneration,
                acquisitionGeneration: state.generation, activeContract: state.activeContract,
                activeTradingDate: state.activeTradingDate, activeVersionKey: state.activeVersionKey,
                startedAt: state.startedAt, completedAt: state.completedAt }));
        }
        function invalidate(reason = "invalidated") {
            generation += 1;
            if (!disposed) publish({ status: "stale", reason, generation, completedAt: dependencies.now() });
            return getState();
        }
        function dispose() {
            generation += 1; disposed = true;
            publish({ status: "disposed", reason: "disposed", generation,
                completedAt: dependencies.now() });
            return getState();
        }
        return Object.freeze({ run, invalidate, dispose, getState, getFormalHistoryLocator });
    }
    return Object.freeze({ nextMajorSqContract, createQriMajorSqAcquisitionOrchestrator });
});
