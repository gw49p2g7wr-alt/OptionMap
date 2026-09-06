(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        commonJs ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv,
        commonJs ? require("./qriOptionIvRuntime.js") : root?.OptionMapQriOptionIvRuntime
    );
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvReferenceSession = api;
})(typeof window !== "undefined" ? window : globalThis,
function (ivApi, ivRuntimeApi) {
    "use strict";

    const RUNTIME_VERSION = 1;
    const ROLES = Object.freeze(["next", "major_sq"]);
    const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
    const ACCEPTED_STATUSES = new Set(["saved", "unchanged"]);

    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    function validDate(value) {
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    function emptySource(reason = "reference_acquisition_pending") {
        return freeze({ available: false, reason, contract: null, canonical: null,
            signature: null, versionKey: null, fetchedAt: null, referenceIdentity: null });
    }

    function createRuntime({ now = () => new Date().toISOString() } = {}) {
        let sessionGeneration = 0;
        let parentMarketRefreshRequestId = null;
        let state = freeze({ runtimeVersion: RUNTIME_VERSION, sessionGeneration,
            parentMarketRefreshRequestId, sources: {
                next: emptySource(), major_sq: emptySource()
            } });
        const getState = () => freeze(clone(state));
        const publishState = sources => {
            state = freeze({ runtimeVersion: RUNTIME_VERSION, sessionGeneration,
                parentMarketRefreshRequestId, sources: clone(sources) });
            return getState();
        };

        function beginSession(requestId) {
            sessionGeneration += 1;
            parentMarketRefreshRequestId = text(requestId);
            return publishState({ next: emptySource(), major_sq: emptySource() });
        }

        function reject(role, reason, input, ownGeneration) {
            if (!ROLES.includes(role) || ownGeneration !== sessionGeneration) return getState();
            const source = freeze({ ...emptySource(reason),
                contract: text(input?.targetContract), fetchedAt: text(input?.fetchedAt),
                referenceIdentity: input ? freeze({ role,
                    parentMarketRefreshRequestId: text(input.parentMarketRefreshRequestId),
                    requestId: text(input.requestId),
                    acquisitionGeneration: input.acquisitionGeneration ?? null,
                    formalPublicationGeneration: input.formalPublicationGeneration ?? null,
                    referenceStatus: text(input.referenceStatus),
                    referenceVersionKey: text(input.referenceVersionKey),
                    sourceUrl: text(input.sourceUrl),
                    tradingDate: text(input.referenceCanonical?.tradingDate),
                    pageUpdatedAt: text(input.referenceCanonical?.pageUpdatedAt),
                    completedAt: text(input.completedAt)
                }) : null });
            return publishState({ ...state.sources, [role]: source });
        }

        async function publishAccepted(role, input = {}, guard = {}) {
            const ownGeneration = sessionGeneration;
            const current = () => ownGeneration === sessionGeneration &&
                parentMarketRefreshRequestId &&
                text(input.parentMarketRefreshRequestId) === parentMarketRefreshRequestId &&
                (typeof guard.isCurrent !== "function" || guard.isCurrent() === true);
            if (!ROLES.includes(role)) return { published: false, reason: "role_invalid", state: getState() };
            if (!current()) return { published: false, reason: "stale_request", state: getState() };
            const reference = input.referenceCanonical;
            const referenceCache = input.referenceCache;
            const targetContract = text(input.targetContract);
            const sourceUrl = text(input.sourceUrl);
            if (!ACCEPTED_STATUSES.has(input.referenceStatus)) {
                return { published: false, reason: "reference_not_accepted",
                    state: reject(role, "reference_not_accepted", input, ownGeneration) };
            }
            if (!CONTRACT_PATTERN.test(targetContract || "") || !reference ||
                reference.contract !== targetContract || reference.sourceUrl !== sourceUrl ||
                !validDate(reference.tradingDate) || !text(reference.pageUpdatedAt) ||
                !text(input.referenceVersionKey) || !text(input.requestId) ||
                referenceCache?.contract !== targetContract ||
                referenceCache?.sourceUrl !== sourceUrl ||
                referenceCache?.versionKey !== input.referenceVersionKey ||
                !Number.isSafeInteger(input.acquisitionGeneration) ||
                !Number.isSafeInteger(input.formalPublicationGeneration) ||
                typeof input.responseHtml !== "string") {
                return { published: false, reason: "reference_identity_invalid",
                    state: reject(role, "reference_identity_invalid", input, ownGeneration) };
            }
            let canonical;
            try { canonical = ivApi?.parseQriOptionIvPage?.(input.responseHtml, sourceUrl); }
            catch (_error) {
                return { published: false, reason: "iv_parse_failed",
                    state: reject(role, "iv_parse_failed", input, ownGeneration) };
            }
            if (!ivApi?.validateCanonical?.(canonical) || canonical.contract !== targetContract ||
                canonical.tradingDate !== reference.tradingDate ||
                canonical.sourceUrl !== sourceUrl ||
                canonical.pageUpdatedAt !== reference.pageUpdatedAt) {
                return { published: false, reason: "iv_identity_mismatch",
                    state: reject(role, "iv_identity_mismatch", input, ownGeneration) };
            }
            const candidate = await ivRuntimeApi?.createCandidate?.({ canonical,
                fetchedAt: text(input.fetchedAt) || now(), requestContext: {
                    mode: "reference_session", role, requestId: input.requestId,
                    parentMarketRefreshRequestId, acquisitionGeneration: input.acquisitionGeneration,
                    formalPublicationGeneration: input.formalPublicationGeneration,
                    referenceVersionKey: input.referenceVersionKey
                } });
            if (!current()) return { published: false, reason: "stale_request", state: getState() };
            if (!candidate?.available || candidate.contract !== targetContract) {
                return { published: false, reason: candidate?.reason || "iv_canonical_invalid",
                    state: reject(role, candidate?.reason || "iv_canonical_invalid", input, ownGeneration) };
            }
            const source = freeze({ ...clone(candidate), referenceIdentity: {
                role, parentMarketRefreshRequestId, requestId: input.requestId,
                acquisitionGeneration: input.acquisitionGeneration,
                formalPublicationGeneration: input.formalPublicationGeneration,
                referenceStatus: input.referenceStatus,
                referenceVersionKey: input.referenceVersionKey,
                sourceUrl, tradingDate: reference.tradingDate,
                pageUpdatedAt: reference.pageUpdatedAt,
                completedAt: text(input.completedAt) || now()
            } });
            const nextState = publishState({ ...state.sources, [role]: source });
            return { published: true, reason: null, role, source: clone(source), state: nextState };
        }

        return Object.freeze({ beginSession, publishAccepted, getState });
    }

    return Object.freeze({ RUNTIME_VERSION, ROLES, createRuntime });
});
