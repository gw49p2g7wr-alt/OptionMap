(function (root, factory) {
    const ivApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv;
    const api = factory(ivApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionIvRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function (ivApi) {
    "use strict";

    const RUNTIME_VERSION = 1;

    function clone(value) {
        if (value === undefined) return undefined;
        return typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }

    function createState() {
        return { runtimeVersion: RUNTIME_VERSION, active: null, selected: null };
    }

    function unavailable(reason, input = {}) {
        return {
            available: false,
            sourceStatus: "unavailable",
            reason,
            error: input.error ? String(input.error) : null,
            canonical: null,
            signature: null,
            versionKey: null,
            fetchedAt: input.fetchedAt || null,
            contract: input.contract || null,
            requestContext: clone(input.requestContext || null)
        };
    }

    async function createCandidate(input = {}) {
        if (input.sourceAvailable === false) {
            return unavailable("source_unavailable", input);
        }
        if (input.parserError) {
            return unavailable("parser_error", { ...input, error: input.parserError });
        }
        const canonical = input.canonical;
        if (!canonical) return unavailable("parser_error", input);
        if (!ivApi?.validateCanonical?.(canonical)) {
            return unavailable("canonical_invalid", {
                ...input, contract: canonical?.contract || input.contract
            });
        }
        try {
            const signature = await ivApi.createSignature(canonical);
            const versionKey = await ivApi.createVersionKey(canonical);
            if (!/^[0-9a-f]{64}$/.test(signature || "") ||
                typeof versionKey !== "string" || !versionKey.endsWith(`sha256:${signature}`)) {
                return unavailable("canonical_invalid", {
                    ...input, contract: canonical.contract
                });
            }
            return {
                available: true,
                sourceStatus: "acquired",
                reason: null,
                error: null,
                canonical: clone(canonical),
                signature,
                versionKey,
                fetchedAt: input.fetchedAt || null,
                contract: canonical.contract,
                requestContext: clone(input.requestContext || null)
            };
        } catch (error) {
            return unavailable("canonical_invalid", {
                ...input, contract: canonical.contract, error: error?.message || error
            });
        }
    }

    function stale(state, channel) {
        return { state, status: "stale_ignored", channel, adopted: false };
    }

    function adopt(state, channel, candidate, guard = {}) {
        if (!state || state.runtimeVersion !== RUNTIME_VERSION ||
            !["active", "selected"].includes(channel) || !candidate) {
            return stale(state, channel);
        }
        if (guard.isCurrent !== true) return stale(state, channel);
        if (candidate.available && guard.responseContract &&
            candidate.contract !== guard.responseContract) return stale(state, channel);
        if (channel === "active") {
            if (candidate.available && guard.activeContract &&
                candidate.contract !== guard.activeContract) return stale(state, channel);
        } else {
            if (!guard.requestedContract || !guard.selectedContract ||
                guard.requestedContract !== guard.selectedContract) return stale(state, channel);
            if (candidate.available && candidate.contract !== guard.requestedContract) {
                return stale(state, channel);
            }
        }
        return {
            state: { ...state, [channel]: clone(candidate) },
            status: candidate.available ? "available" : candidate.reason,
            channel,
            adopted: true
        };
    }

    return Object.freeze({ RUNTIME_VERSION, createState, unavailable,
        createCandidate, adopt });
});
