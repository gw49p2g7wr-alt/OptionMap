(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        commonJs ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv,
        commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions,
        commonJs ? require("./qriOptionIvHistory.js") : root?.OptionMapQriOptionIvHistory,
        commonJs ? require("./storage/qriOptionIvHistoryStore.js") :
            root?.OptionMapQriOptionIvHistoryStore
    );
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvHistoryPersistence = api;
})(typeof window !== "undefined" ? window : globalThis,
function (ivApi, optionsApi, historyApi, storeApi) {
    "use strict";

    const ROLES = Object.freeze(["active", "next", "major_sq"]);
    const ACCEPTED_PARENT_STATUSES = Object.freeze(["saved", "unchanged"]);
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    const output = value => freeze(clone(value));
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const validGeneration = value => Number.isSafeInteger(value) && value >= 0;
    const current = guard => {
        try { return typeof guard === "function" && guard() === true; }
        catch (_error) { return false; }
    };

    function createPersistence(configuration = {}) {
        const store = configuration.store || storeApi?.createStore?.();
        const now = configuration.now || (() => new Date().toISOString());
        let state = freeze({ roles: Object.fromEntries(ROLES.map(role => [role, null])) });
        const getState = () => output(state);
        const publish = (role, result) => {
            state = freeze({ roles: { ...state.roles, [role]: output(result) } });
            return output(result);
        };
        const resultFor = (input, status, reason, completedAt, extra = {}) => ({
            role: ROLES.includes(input?.acquisitionRole) ? input.acquisitionRole : null,
            status, reason, contract: text(input?.ivCanonical?.contract),
            tradingDate: text(input?.ivCanonical?.tradingDate), versionKey: extra.versionKey || null,
            completedAt, ...extra
        });

        async function persist(input = {}, { isCurrentRequest } = {}) {
            const role = input.acquisitionRole;
            const completedAt = now();
            const reject = reason => output(resultFor(input, "unavailable", reason, completedAt));
            if (!ROLES.includes(role)) return reject("acquisition_role_invalid");
            const finish = value => publish(role, value);
            if (!ACCEPTED_PARENT_STATUSES.includes(input.parentPersistenceStatus)) {
                return finish(resultFor(input, "unavailable", "parent_persistence_not_accepted",
                    completedAt));
            }
            if (!text(input.parentMarketRefreshRequestId) || !text(input.requestId)) {
                return finish(resultFor(input, "unavailable", "request_identity_invalid", completedAt));
            }
            if (!validGeneration(input.acquisitionGeneration) ||
                !validGeneration(input.formalPublicationGeneration)) {
                return finish(resultFor(input, "unavailable", "generation_identity_invalid", completedAt));
            }
            if (!current(isCurrentRequest)) {
                return finish(resultFor(input, "unavailable", "stale_request", completedAt));
            }
            const iv = input.ivCanonical; const parent = input.parentOptionsCanonical;
            if (!ivApi?.validateCanonical?.(iv)) {
                return finish(resultFor(input, "unavailable", "iv_canonical_invalid", completedAt));
            }
            if (!optionsApi?.validateCanonical?.(parent, { allowUnresolvedContracts: true })) {
                return finish(resultFor(input, "unavailable", "parent_canonical_invalid", completedAt));
            }
            const expected = [input.expectedContract, input.expectedTradingDate,
                input.expectedPageUpdatedAt, input.expectedSourceUrl];
            if (expected.some(value => !text(value))) {
                return finish(resultFor(input, "unavailable", "expected_identity_invalid", completedAt));
            }
            if (iv.contract !== parent.contract || iv.contract !== input.expectedContract) {
                return finish(resultFor(input, "unavailable", "contract_mismatch", completedAt));
            }
            if (iv.tradingDate !== parent.tradingDate ||
                iv.tradingDate !== input.expectedTradingDate) {
                return finish(resultFor(input, "unavailable", "trading_date_mismatch", completedAt));
            }
            if (iv.pageUpdatedAt !== parent.pageUpdatedAt ||
                iv.pageUpdatedAt !== input.expectedPageUpdatedAt) {
                return finish(resultFor(input, "unavailable", "page_updated_at_mismatch", completedAt));
            }
            if (iv.sourceUrl !== parent.sourceUrl || iv.sourceUrl !== input.expectedSourceUrl) {
                return finish(resultFor(input, "unavailable", "source_url_mismatch", completedAt));
            }
            if (iv.lastTradingDate !== parent.lastTradingDate) {
                return finish(resultFor(input, "unavailable", "last_trading_date_mismatch", completedAt));
            }
            let ivSignature; let ivVersionKey; let parentCache;
            try {
                [ivSignature, ivVersionKey, parentCache] = await Promise.all([
                    ivApi.createSignature(iv), ivApi.createVersionKey(iv),
                    optionsApi.createCacheV2(parent, input.fetchedAt)
                ]);
            } catch (_error) {
                return finish(resultFor(input, "unavailable", "identity_generation_failed", completedAt));
            }
            if (ivSignature !== input.ivSignature || ivVersionKey !== input.ivVersionKey) {
                return finish(resultFor(input, "unavailable", "iv_identity_mismatch", completedAt));
            }
            if (!parentCache || parentCache.signature !== input.parentOptionsSignature ||
                parentCache.versionKey !== input.parentOptionsVersionKey) {
                return finish(resultFor(input, "unavailable", "parent_identity_mismatch", completedAt,
                    { versionKey: ivVersionKey }));
            }
            if (!current(isCurrentRequest)) {
                return finish(resultFor(input, "unavailable", "stale_request", completedAt,
                    { versionKey: ivVersionKey }));
            }
            const candidateResult = await historyApi.createHistoryCandidate(iv, {
                acquisitionRole: role,
                parentMarketRefreshRequestId: input.parentMarketRefreshRequestId,
                requestId: input.requestId, acquisitionGeneration: input.acquisitionGeneration,
                formalPublicationGeneration: input.formalPublicationGeneration,
                parentOptionsVersionKey: input.parentOptionsVersionKey,
                fetchedAt: input.fetchedAt, confirmedAt: input.confirmedAt,
                formalStatus: input.parentPersistenceStatus, origin: "formal_live"
            });
            if (!candidateResult.ok) return finish(resultFor(input, "unavailable",
                candidateResult.reason, completedAt, { versionKey: ivVersionKey }));
            if (!current(isCurrentRequest)) return finish(resultFor(input, "unavailable",
                "stale_request", completedAt, { versionKey: ivVersionKey }));
            let stored;
            try { stored = await store.persistCandidate(candidateResult.candidate); }
            catch (error) { stored = { saved: false, outcome: "storage_exception",
                error: error?.message || String(error) }; }
            const status = stored?.saved
                ? stored.outcome === "confirmation_added" ? "confirmation_added" : "saved"
                : stored?.outcome === "same_version" ? "unchanged" : "failed";
            const value = resultFor(input, status,
                status === "failed" ? stored?.outcome || "storage_failed" : null,
                now(), { versionKey: ivVersionKey, signature: ivSignature,
                    storageOutcome: stored?.outcome || null });
            if (!current(isCurrentRequest)) return output({ ...value, status: "stale_ignored",
                reason: "stale_after_write" });
            return finish(value);
        }
        return Object.freeze({ persist, getState });
    }
    return Object.freeze({ ROLES, ACCEPTED_PARENT_STATUSES, createPersistence });
});
