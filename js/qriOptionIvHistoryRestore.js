(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        commonJs ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv,
        commonJs ? require("./qriOptionIvHistory.js") : root?.OptionMapQriOptionIvHistory,
        commonJs ? require("./storage/qriOptionIvHistoryStore.js") :
            root?.OptionMapQriOptionIvHistoryStore
    );
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvHistoryRestore = api;
})(typeof window !== "undefined" ? window : globalThis,
function (ivApi, historyApi, storeApi) {
    "use strict";

    const ROLES = Object.freeze(["active", "next", "major_sq"]);
    const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
    const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    const output = value => freeze(clone(value));
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function validDate(value) {
        if (!DATE_PATTERN.test(value || "")) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }
    const emptyRole = (generation = 0, status = "deferred", reason = "context_incomplete") =>
        freeze({ generation, status, reason, context: null, source: null, completedAt: null });
    function normalizeContext(role, context) {
        if (!ROLES.includes(role) || !context ||
            context.role != null && context.role !== role ||
            !CONTRACT_PATTERN.test(context.contract || "") || !validDate(context.tradingDate)) {
            return null;
        }
        const sourceUrl = context.sourceUrl == null ? null : ivApi?.normalizeSourceUrl?.(context.sourceUrl);
        if (context.sourceUrl != null && !sourceUrl) return null;
        return { role, contract: context.contract, tradingDate: context.tradingDate, sourceUrl };
    }

    function createRuntime(configuration = {}) {
        const store = configuration.store || storeApi?.createStore?.();
        const now = configuration.now || (() => new Date().toISOString());
        let generations = Object.fromEntries(ROLES.map(role => [role, 0]));
        let roles = Object.fromEntries(ROLES.map(role => [role, emptyRole()]));
        const getState = () => output({ restoreVersion: 1, roles });
        const publish = (role, value) => {
            roles = freeze({ ...roles, [role]: output(value) });
            return output(value);
        };
        const current = (role, generation, context) => generations[role] === generation &&
            JSON.stringify(roles[role]?.context) === JSON.stringify(context);

        function defer(role, reason = "context_incomplete") {
            if (!ROLES.includes(role)) return output({ status: "unavailable", reason: "role_invalid" });
            const generation = ++generations[role];
            return publish(role, { ...emptyRole(generation, "deferred", reason),
                completedAt: now() });
        }
        function invalidateAll(reason = "context_changed") {
            for (const role of ROLES) defer(role, reason);
            return getState();
        }

        async function restore(role, rawContext) {
            if (!ROLES.includes(role)) return output({ status: "unavailable", reason: "role_invalid" });
            const context = normalizeContext(role, rawContext);
            if (!context) return defer(role, "context_incomplete");
            const generation = ++generations[role];
            publish(role, { generation, status: "loading", reason: null,
                context, source: null, completedAt: null });
            let loaded;
            try { loaded = await store.getEntry(context.contract, context.tradingDate); }
            catch (error) { loaded = { status: "unavailable",
                reason: error?.message || "history_read_failed", entry: null }; }
            if (!current(role, generation, context)) {
                return output({ status: "stale_ignored", reason: "context_changed",
                    generation, context, source: null, completedAt: now() });
            }
            if (loaded?.status !== "available" || !loaded.entry) {
                return publish(role, { generation, status: "unavailable",
                    reason: loaded?.reason || "exact_entry_not_found", context,
                    source: null, completedAt: now() });
            }
            const entry = loaded.entry;
            const revision = entry.revisions?.find(item => item.versionKey === entry.activeVersionKey);
            if (entry.contract !== context.contract || entry.tradingDate !== context.tradingDate ||
                entry.entryKey !== historyApi.entryKeyFor(context.contract, context.tradingDate) ||
                !revision) {
                return publish(role, { generation, status: "unavailable",
                    reason: "entry_identity_invalid", context, source: null, completedAt: now() });
            }
            const validation = await historyApi.validateRevision(revision, entry);
            if (!current(role, generation, context)) return output({ status: "stale_ignored",
                reason: "context_changed", generation, context, source: null, completedAt: now() });
            if (!validation.valid || !ivApi?.validateCanonical?.(revision.canonical)) {
                return publish(role, { generation, status: "unavailable",
                    reason: "revision_invalid", context, source: null, completedAt: now() });
            }
            const roleConfirmations = revision.confirmations.filter(item =>
                item.acquisitionRole === role);
            if (roleConfirmations.length === 0) return publish(role, { generation,
                status: "unavailable", reason: "role_confirmation_missing", context,
                source: null, completedAt: now() });
            if (revision.contract !== context.contract ||
                revision.canonical.contract !== context.contract ||
                revision.tradingDate !== context.tradingDate ||
                revision.canonical.tradingDate !== context.tradingDate) {
                return publish(role, { generation, status: "unavailable",
                    reason: "revision_context_mismatch", context, source: null, completedAt: now() });
            }
            if (context.sourceUrl && (revision.sourceUrl !== context.sourceUrl ||
                revision.canonical.sourceUrl !== context.sourceUrl)) {
                return publish(role, { generation, status: "unavailable",
                    reason: "source_url_mismatch", context, source: null, completedAt: now() });
            }
            const [signature, versionKey] = await Promise.all([
                ivApi.createSignature(revision.canonical),
                ivApi.createVersionKey(revision.canonical)
            ]);
            if (!current(role, generation, context)) return output({ status: "stale_ignored",
                reason: "context_changed", generation, context, source: null, completedAt: now() });
            if (signature !== revision.signature || versionKey !== revision.versionKey) {
                return publish(role, { generation, status: "unavailable",
                    reason: "revision_identity_mismatch", context, source: null, completedAt: now() });
            }
            const matchingRoleConfirmation = clone([...roleConfirmations]
                .sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt) ||
                    left.requestId.localeCompare(right.requestId)).at(-1));
            const confirmedAt = matchingRoleConfirmation.confirmedAt;
            const source = freeze({ available: true, origin: "history",
                sourceClass: "formal_history", formalStatus: "verified", role,
                revisionFormalStatus: revision.formalStatus,
                contract: revision.contract, tradingDate: revision.tradingDate,
                versionKey: revision.versionKey, signature: revision.signature,
                sourceUrl: revision.sourceUrl, pageUpdatedAt: revision.pageUpdatedAt,
                lastTradingDate: revision.lastTradingDate,
                canonical: clone(revision.canonical), fetchedAt: revision.fetchedAt,
                confirmedAt, snapshotDate: revision.snapshotDate,
                matchingRoleConfirmation,
                freshness: { status: "saved", reason: "formal_history", origin: "history",
                    displayEligible: true, calculationEligible: "undetermined" } });
            return publish(role, { generation, status: "available", reason: null,
                context, source, completedAt: now() });
        }
        return Object.freeze({ restore, defer, invalidateAll, getState });
    }

    return Object.freeze({ ROLES, normalizeContext, createRuntime });
});
