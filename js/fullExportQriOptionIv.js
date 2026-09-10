(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        commonJs ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv,
        commonJs ? require("./qriOptionIvHistory.js") : root?.OptionMapQriOptionIvHistory
    );
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportQriOptionIv = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ivApi, historyApi) {
    "use strict";

    const ROLES = Object.freeze(["active", "next", "major_sq"]);
    const SUCCESSFUL_PERSISTENCE = new Set(["saved", "unchanged", "confirmation_added"]);
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    const output = value => freeze(clone(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const unavailableFreshness = () => ({ status: "unavailable", reason: "role_unavailable" });
    const emptyRole = (role, reason = "formal_iv_revision_unavailable", status = "unavailable") => ({
        role, status, reason, contract: null, tradingDate: null, payloadId: null,
        sourceUrl: null, pageUpdatedAt: null, lastTradingDate: null, signature: null,
        versionKey: null, origin: null, sourceClass: null, formalStatus: null,
        fetchedAt: null, confirmedAt: null, snapshotDate: null,
        matchingRoleConfirmation: null, freshness: unavailableFreshness()
    });
    const identity = value => JSON.stringify(value ?? null);

    function capture(configuration) {
        return clone({
            restore: configuration.getRestoreState?.() || null,
            runtime: configuration.getRuntimeState?.() || null,
            reference: configuration.getReferenceSessionState?.() || null,
            persistence: configuration.getPersistenceState?.() || null,
            formal: configuration.getFormalIdentityState?.() || null
        });
    }

    function roleGeneration(snapshot, role) {
        const restored = snapshot?.restore?.roles?.[role];
        const common = { context: restored?.context || null, restoreGeneration: restored?.generation ?? null,
            restoreRevisionIdentity: restored?.source ? {
                versionKey: restored.source.versionKey, signature: restored.source.signature,
                contract: restored.source.contract, tradingDate: restored.source.tradingDate,
                confirmation: restored.source.matchingRoleConfirmation
            } : null,
            persistence: snapshot?.persistence?.roles?.[role] || null };
        if (role === "active") return { ...common,
            runtimeVersion: snapshot?.runtime?.runtimeVersion ?? null,
            runtimeIdentity: snapshot?.runtime?.active ? {
                versionKey: snapshot.runtime.active.versionKey,
                requestContext: snapshot.runtime.active.requestContext
            } : null,
            formalPublicationGeneration: snapshot?.formal?.publicationGeneration ?? null,
            formalGeneration: snapshot?.formal?.fact?.generation ?? null };
        return { ...common, sessionGeneration: snapshot?.reference?.sessionGeneration ?? null,
            parentMarketRefreshRequestId: snapshot?.reference?.parentMarketRefreshRequestId ?? null,
            runtimeIdentity: snapshot?.reference?.sources?.[role] ? {
                versionKey: snapshot.reference.sources[role].versionKey,
                referenceIdentity: snapshot.reference.sources[role].referenceIdentity
            } : null };
    }

    function confirmationMatches(role, confirmation, snapshot, live) {
        if (!object(confirmation) || confirmation.acquisitionRole !== role) return false;
        if (role === "active") {
            const fact = snapshot?.formal?.fact;
            return confirmation.requestId === live?.requestContext?.requestId &&
                confirmation.parentMarketRefreshRequestId === live?.requestContext?.requestId &&
                confirmation.acquisitionGeneration === fact?.generation?.sequence &&
                confirmation.formalPublicationGeneration === snapshot?.formal?.publicationGeneration &&
                confirmation.parentOptionsVersionKey === fact?.canonicalVersionKey;
        }
        const reference = live?.referenceIdentity;
        return confirmation.requestId === reference?.requestId &&
            confirmation.parentMarketRefreshRequestId === reference?.parentMarketRefreshRequestId &&
            confirmation.acquisitionGeneration === reference?.acquisitionGeneration &&
            confirmation.formalPublicationGeneration === reference?.formalPublicationGeneration &&
            confirmation.parentOptionsVersionKey === reference?.referenceVersionKey;
    }

    async function verifiedHistory(role, snapshot) {
        const state = snapshot?.restore?.roles?.[role];
        const source = state?.source;
        const context = state?.context;
        if (state?.status !== "available" || source?.available !== true ||
            source.sourceClass !== "formal_history" || source.origin !== "history" ||
            source.formalStatus !== "verified" || !object(context)) return null;
        if (source.role !== role || source.contract !== context.contract ||
            source.tradingDate !== context.tradingDate || source.canonical?.contract !== context.contract ||
            source.canonical?.tradingDate !== context.tradingDate ||
            context.sourceUrl && source.sourceUrl !== context.sourceUrl) return { invalid: true };
        if (!ivApi?.validateCanonical?.(source.canonical) || source.canonical.sourceUrl !== source.sourceUrl ||
            source.canonical.pageUpdatedAt !== source.pageUpdatedAt ||
            source.canonical.lastTradingDate !== source.lastTradingDate) return { invalid: true };
        const [signature, versionKey] = await Promise.all([
            ivApi.createSignature(source.canonical), ivApi.createVersionKey(source.canonical)
        ]);
        if (signature !== source.signature || versionKey !== source.versionKey) return { invalid: true };
        const confirmation = source.matchingRoleConfirmation;
        if (historyApi?.validateConfirmation?.(confirmation)?.valid !== true ||
            confirmation.acquisitionRole !== role || confirmation.confirmedAt !== source.confirmedAt) {
            return { invalid: true, reason: "role_confirmation_missing" };
        }
        return { source, confirmation };
    }

    async function liveFor(role, snapshot, history) {
        const live = role === "active" ? snapshot?.runtime?.active :
            snapshot?.reference?.sources?.[role];
        const persistence = snapshot?.persistence?.roles?.[role];
        if (live?.available !== true || !ivApi?.validateCanonical?.(live.canonical) ||
            !SUCCESSFUL_PERSISTENCE.has(persistence?.status)) return null;
        const [signature, versionKey] = await Promise.all([
            ivApi.createSignature(live.canonical), ivApi.createVersionKey(live.canonical)
        ]);
        if (signature !== live.signature || versionKey !== live.versionKey ||
            history.source.signature !== signature || history.source.versionKey !== versionKey ||
            identity(history.source.canonical) !== identity(live.canonical) ||
            persistence.versionKey !== versionKey || persistence.signature !== signature ||
            persistence.contract !== live.canonical.contract ||
            persistence.tradingDate !== live.canonical.tradingDate ||
            !confirmationMatches(role, history.confirmation, snapshot, live)) return null;
        return live;
    }

    function inventory(records) {
        const result = { call: { available: 0, missing: 0, invalid: 0 },
            put: { available: 0, missing: 0, invalid: 0 }, minStrike: null, maxStrike: null,
            valueUnit: ivApi?.VALUE_UNIT || "percent_points" };
        for (const record of records) {
            result[record.optionType][record.iv.status] += 1;
            result.minStrike = result.minStrike === null ? record.strike :
                Math.min(result.minStrike, record.strike);
            result.maxStrike = result.maxStrike === null ? record.strike :
                Math.max(result.maxStrike, record.strike);
        }
        return result;
    }

    function projectPayload(source, sourceClass, origin, formalStatus) {
        const canonical = source.canonical;
        const records = clone(canonical.records).sort((left, right) =>
            (left.optionType === right.optionType ? 0 : left.optionType === "call" ? -1 : 1) ||
            left.strike - right.strike);
        return { payloadId: source.versionKey, parserVersion: canonical.parserVersion,
            schemaVersion: canonical.schemaVersion, source: canonical.source,
            contract: canonical.contract, tradingDate: canonical.tradingDate,
            sourceUrl: canonical.sourceUrl, pageUpdatedAt: canonical.pageUpdatedAt,
            lastTradingDate: canonical.lastTradingDate, fetchedAt: source.fetchedAt,
            confirmedAt: source.confirmedAt, snapshotDate: source.snapshotDate,
            signature: source.signature, versionKey: source.versionKey, formalStatus,
            sourceClass, origin, valueUnit: canonical.valueUnit,
            inventory: inventory(records), records };
    }

    async function resolveRole(role, snapshot, configuration) {
        const historical = await verifiedHistory(role, snapshot);
        if (historical?.invalid) return emptyRole(role,
            historical.reason || "formal_iv_revision_invalid", "invalid");
        if (!historical) return emptyRole(role);
        const live = await liveFor(role, snapshot, historical);
        const source = live || historical.source;
        const sourceClass = live ? "verified_live" : "formal_history";
        const origin = live ? "live" : "history";
        const freshness = live ? clone(configuration.evaluateLiveFreshness?.(role, source) ||
            { status: "unavailable", reason: "freshness_status_unavailable" }) :
            { status: "saved", reason: "formal_history" };
        return { role, status: "available", reason: null, contract: source.canonical.contract,
            tradingDate: source.canonical.tradingDate, payloadId: source.versionKey,
            sourceUrl: source.canonical.sourceUrl, pageUpdatedAt: source.canonical.pageUpdatedAt,
            lastTradingDate: source.canonical.lastTradingDate, signature: source.signature,
            versionKey: source.versionKey, origin, sourceClass, formalStatus: "verified",
            fetchedAt: source.fetchedAt, confirmedAt: historical.source.confirmedAt,
            snapshotDate: historical.source.snapshotDate,
            matchingRoleConfirmation: clone(historical.confirmation), freshness,
            payload: projectPayload({ ...historical.source, canonical: source.canonical,
                signature: source.signature, versionKey: source.versionKey,
                fetchedAt: source.fetchedAt }, sourceClass, origin,
            historical.source.revisionFormalStatus || "verified") };
    }

    function outerFreshness(roles) {
        const available = roles.filter(role => role.status === "available");
        if (available.length === 0) return unavailableFreshness();
        const statuses = new Set(available.map(role => role.freshness?.status));
        return statuses.size === 1 ? clone(available[0].freshness) :
            { status: "mixed", reason: "multiple_role_freshness" };
    }

    async function collectQriOptionIv(configuration = {}) {
        const start = capture(configuration);
        const roles = [];
        for (const role of ROLES) roles.push(await resolveRole(role, start, configuration));
        const end = capture(configuration);
        for (let index = 0; index < ROLES.length; index += 1) {
            if (identity(roleGeneration(start, ROLES[index])) !==
                identity(roleGeneration(end, ROLES[index]))) {
                roles[index] = emptyRole(ROLES[index], "iv_source_changed_during_export");
            }
        }
        const payloads = []; const seen = new Set();
        for (const role of roles) if (role.status === "available" && !seen.has(role.payloadId)) {
            seen.add(role.payloadId); payloads.push(role.payload);
        }
        const bindings = roles.map(role => { const binding = clone(role); delete binding.payload;
            return binding; });
        const availableCount = roles.filter(role => role.status === "available").length;
        const invalidCount = roles.filter(role => role.status === "invalid").length;
        const status = availableCount === 3 ? "available" : availableCount > 0 ? "partial" :
            invalidCount > 0 ? "invalid" : "unavailable";
        const reason = status === "available" ? null : status === "partial"
            ? "formal_iv_roles_partial" : status === "invalid"
                ? "formal_iv_validation_failed" : "formal_iv_revision_unavailable";
        const roleSummary = Object.fromEntries(bindings.map(role => [role.role, {
            status: role.status, reason: role.reason, contract: role.contract,
            tradingDate: role.tradingDate, payloadId: role.payloadId,
            sourceClass: role.sourceClass, formalStatus: role.formalStatus,
            freshness: clone(role.freshness)
        }]));
        return output({ status, reason,
            authority: { source: "qri-nikkei225-option-iv", sourceClass: "formal_multi_role",
                origin: availableCount === 0 ? null : new Set(roles.filter(role =>
                    role.status === "available").map(role => role.origin)).size > 1 ? "mixed" :
                    roles.find(role => role.status === "available")?.origin || null,
                formalStatus: availableCount > 0 ? "verified" : null,
                versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: outerFreshness(roles),
            summary: { availableRoleCount: availableCount, roleCount: ROLES.length,
                valueUnit: ivApi?.VALUE_UNIT || "percent_points",
                moneynessReference: { sourceSection: "marketSnapshot" }, roles: roleSummary },
            details: { roles: bindings, payloads } });
    }

    return Object.freeze({ ROLES, collectQriOptionIv });
});
