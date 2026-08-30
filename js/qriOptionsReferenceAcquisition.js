(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsReferenceAcquisition = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
    const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
    const STATUSES = Object.freeze(["idle", "scheduled", "fetching", "validating",
        "persisting", "saved", "unchanged", "skipped", "failed", "stale", "disposed"]);
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
    const timestamp = value => text(value) && Number.isFinite(Date.parse(value));
    function validDate(value) {
        if (!DATE_PATTERN.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    function emptyState() {
        return { status: "idle", reason: null, generation: 0,
            parentMarketRefreshRequestId: null, requestId: null, activeContract: null,
            activeTradingDate: null, activeVersionKey: null, targetUrl: null,
            targetContract: null, startedAt: null, completedAt: null, skippedReason: null,
            fetched: false, canonicalValid: false, referenceTradingDate: null,
            tradingDateAlignment: "unknown", persistenceStatus: null, persisted: false,
            unchanged: false, versionKey: null, errorCode: null };
    }
    function validFormalContext(context) {
        return context && context.formalCompletionVerified === true &&
            text(context.parentMarketRefreshRequestId) &&
            Number.isSafeInteger(context.formalPublicationGeneration) &&
            context.formalPublicationGeneration >= 0 &&
            context.sourceClass === "formal_live" && context.identityVerified === true &&
            context.acquisitionVerified === true && context.openInterestStatus === "available" &&
            CONTRACT_PATTERN.test(context.activeContract || "") &&
            validDate(context.formalTradingDate) && text(context.activeCanonicalVersionKey) &&
            Array.isArray(context.availableContracts);
    }
    function selectTarget(context) {
        const entries = context.availableContracts;
        const activeIndex = entries.findIndex(entry => entry?.active === true &&
            entry.contract === context.activeContract);
        if (activeIndex < 0 || entries.filter(entry => entry?.active === true).length !== 1) return null;
        for (let index = activeIndex + 1; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry?.active === false && text(entry.url)) return { url: entry.url, index };
        }
        return null;
    }
    function alignment(active, reference) {
        if (!validDate(active) || !validDate(reference)) return "unknown";
        if (active === reference) return "aligned";
        return reference < active ? "reference_older" : "reference_newer";
    }
    function sameFormalContext(captured, current) {
        return validFormalContext(current) &&
            current.parentMarketRefreshRequestId === captured.parentMarketRefreshRequestId &&
            current.formalPublicationGeneration === captured.formalPublicationGeneration &&
            current.activeContract === captured.activeContract &&
            current.formalTradingDate === captured.formalTradingDate &&
            current.activeCanonicalVersionKey === captured.activeCanonicalVersionKey;
    }

    function createQriReferenceAcquisitionOrchestrator(dependencies = {}) {
        for (const name of REQUIRED_DEPENDENCIES) {
            if (typeof dependencies[name] !== "function") {
                throw new TypeError(`missing_dependency:${name}`);
            }
        }
        let generation = 0;
        let disposed = false;
        let state = emptyState();
        const successes = new Set();
        const publish = patch => {
            state = freeze({ ...state, ...clone(patch) });
            return getState();
        };
        const getState = () => freeze(clone(state));
        const lifecycleCurrent = ownGeneration => {
            let lifecycle;
            try { lifecycle = dependencies.getCurrentLifecycleState(); }
            catch (_error) { return false; }
            return !disposed && ownGeneration === generation && lifecycle?.disposed !== true &&
                (lifecycle?.generation == null || lifecycle.generation === ownGeneration);
        };
        const requestCurrent = (ownGeneration, captured) => {
            if (!lifecycleCurrent(ownGeneration)) return false;
            try { return sameFormalContext(captured, dependencies.getCurrentFormalContext()); }
            catch (_error) { return false; }
        };
        const finishStale = (ownGeneration, reason = "lifecycle_changed") => {
            if (disposed) return publish({ status: "disposed", reason: "disposed",
                skippedReason: "disposed", completedAt: dependencies.now() });
            if (ownGeneration !== generation) return freeze({ ...emptyState(), status: "stale",
                reason, skippedReason: reason, generation: ownGeneration,
                completedAt: dependencies.now() });
            return publish({ status: "stale", reason, skippedReason: reason,
                completedAt: dependencies.now() });
        };
        const finishFailure = (ownGeneration, reason, error = null) => {
            if (!lifecycleCurrent(ownGeneration)) return finishStale(ownGeneration);
            return publish({ status: "failed", reason, completedAt: dependencies.now(),
                errorCode: text(error?.code) || text(error?.message) || text(error) || reason });
        };
        const finishSkip = (ownGeneration, reason, extra = {}) => publish({ status: "skipped",
            reason, skippedReason: reason, generation: ownGeneration,
            completedAt: dependencies.now(), ...extra });

        async function run(inputContext) {
            if (disposed) return publish({ status: "disposed", reason: "disposed",
                skippedReason: "disposed", completedAt: dependencies.now() });
            const ownGeneration = ++generation;
            const captured = clone(inputContext);
            const startedAt = dependencies.now();
            state = freeze({ ...emptyState(), status: "scheduled", generation: ownGeneration,
                startedAt, parentMarketRefreshRequestId:
                    text(captured?.parentMarketRefreshRequestId),
                activeContract: text(captured?.activeContract),
                activeTradingDate: text(captured?.formalTradingDate),
                activeVersionKey: text(captured?.activeCanonicalVersionKey) });
            if (!validFormalContext(captured)) {
                return finishSkip(ownGeneration, captured?.openInterestStatus !== "available"
                    ? "open_interest_unavailable" : "formal_context_incomplete");
            }
            if (!requestCurrent(ownGeneration, captured)) {
                return finishStale(ownGeneration, "stale_parent");
            }
            const target = selectTarget(captured);
            if (!target) return finishSkip(ownGeneration, "no_target");
            const requestId = text(dependencies.createRequestId({ generation: ownGeneration,
                parentMarketRefreshRequestId: captured.parentMarketRefreshRequestId,
                targetUrl: target.url }));
            if (!requestId || target.url === captured.activeSourceUrl) {
                return finishSkip(ownGeneration, "invalid_target", { targetUrl: target.url });
            }
            const successKey = [captured.activeContract, captured.formalTradingDate,
                target.url].join("|");
            if (successes.has(successKey)) return finishSkip(ownGeneration,
                "already_succeeded_for_trading_date", { requestId, targetUrl: target.url });
            publish({ status: "fetching", requestId, targetUrl: target.url });
            let raw;
            try { raw = await dependencies.fetchReferencePage(target.url); }
            catch (error) { return finishFailure(ownGeneration, "fetch_failed", error); }
            if (!requestCurrent(ownGeneration, captured)) return finishStale(ownGeneration);
            publish({ status: "validating", fetched: true });
            let canonical;
            try { canonical = await dependencies.buildCanonical(raw, { sourceUrl: target.url }); }
            catch (error) { return finishFailure(ownGeneration, "canonical_build_failed", error); }
            let canonicalValid = false;
            try { canonicalValid = await dependencies.validateCanonical(canonical) === true; }
            catch (error) { return finishFailure(ownGeneration, "canonical_validation_failed", error); }
            const targetContract = text(canonical?.contract);
            const referenceTradingDate = text(canonical?.tradingDate);
            const facts = { canonicalValid, targetContract,
                referenceTradingDate, tradingDateAlignment:
                    alignment(captured.formalTradingDate, referenceTradingDate) };
            publish(facts);
            if (!canonicalValid) return finishFailure(ownGeneration, "canonical_invalid");
            if (canonical.sourceUrl !== target.url || !CONTRACT_PATTERN.test(targetContract || "") ||
                targetContract === captured.activeContract || targetContract <= captured.activeContract ||
                !Array.isArray(canonical.records) || canonical.records.length === 0 ||
                canonical.records.some(record => record?.contract !== targetContract)) {
                return finishFailure(ownGeneration, "contract_mismatch");
            }
            if (canonical.openInterestStatus !== "available" ||
                !canonical.records.some(record => record?.published === true)) {
                return finishFailure(ownGeneration, "open_interest_unavailable");
            }
            if (!validDate(referenceTradingDate)) {
                return finishFailure(ownGeneration, "reference_trading_date_invalid");
            }
            let cache;
            try { cache = await dependencies.buildCache(canonical); }
            catch (error) { return finishFailure(ownGeneration, "cache_build_failed", error); }
            let cacheValid = false;
            try { cacheValid = await dependencies.validateCache(cache) === true; }
            catch (error) { return finishFailure(ownGeneration, "cache_validation_failed", error); }
            if (!cacheValid || cache?.contract !== targetContract || cache?.sourceUrl !== target.url ||
                !text(cache?.versionKey)) return finishFailure(ownGeneration, "cache_invalid");
            if (!requestCurrent(ownGeneration, captured)) return finishStale(ownGeneration);
            publish({ status: "persisting", versionKey: cache.versionKey });
            let persistence;
            try {
                persistence = await dependencies.persistReference(cache, {
                    mode: "reference_history", acquisitionOrigin: "live",
                    requestedContract: targetContract, sourceUrl: target.url, requestId,
                    isCurrentRequest: () => requestCurrent(ownGeneration, captured)
                });
            } catch (error) { return finishFailure(ownGeneration, "persistence_failed", error); }
            if (!requestCurrent(ownGeneration, captured)) return finishStale(ownGeneration);
            if (persistence?.status === "saved") {
                successes.add(successKey);
                return publish({ status: "saved", reason: null, completedAt: dependencies.now(),
                    persistenceStatus: "saved", persisted: true, unchanged: false });
            }
            if (persistence?.status === "unchanged") {
                successes.add(successKey);
                return publish({ status: "unchanged", reason: persistence.reason || null,
                    completedAt: dependencies.now(), persistenceStatus: "unchanged",
                    persisted: false, unchanged: true });
            }
            return finishFailure(ownGeneration, persistence?.reason || "persistence_rejected",
                persistence?.errorCode || null);
        }

        function invalidate(reason = "invalidated") {
            generation += 1;
            if (!disposed) publish({ status: "stale", reason, generation,
                skippedReason: reason, completedAt: dependencies.now() });
            return getState();
        }
        function dispose() {
            generation += 1; disposed = true;
            publish({ status: "disposed", reason: "disposed", generation,
                skippedReason: "disposed", completedAt: dependencies.now() });
            return getState();
        }
        return Object.freeze({ run, invalidate, dispose, getState });
    }

    return Object.freeze({ STATUSES, createQriReferenceAcquisitionOrchestrator });
});
