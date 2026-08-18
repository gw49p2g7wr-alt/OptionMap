(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsSelection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const CONTRACT_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
    const STATUSES = Object.freeze(["loading", "ready", "unavailable", "fetch_failed",
        "validation_failed", "stale_ignored"]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const unresolvedSelectionKey = url => `url:${url}`;

    function createPartialManifest(canonical) {
        if (!canonical || !CONTRACT_PATTERN.test(canonical.contract || "") ||
            typeof canonical.gengetsu !== "string" ||
            typeof canonical.lastTradingDate !== "string" ||
            !Array.isArray(canonical.availableContracts) || canonical.availableContracts.length === 0) {
            return null;
        }
        const active = canonical.availableContracts.filter(item => item?.active === true);
        if (active.length !== 1 || active[0].contract !== canonical.contract ||
            active[0].url !== canonical.sourceUrl || active[0].label !== canonical.contractLabel) return null;
        return { manifestVersion: 2, defaultContract: canonical.contract,
            availableContracts: canonical.availableContracts.map(item => item.active ? {
                contract: canonical.contract, gengetsu: canonical.gengetsu,
                label: item.label, url: item.url, active: true,
                lastTradingDate: canonical.lastTradingDate, resolution: "resolved",
                selectionKey: canonical.contract
            } : {
                contract: null, gengetsu: null, label: item.label, url: item.url,
                active: false, lastTradingDate: null, resolution: "unresolved",
                selectionKey: unresolvedSelectionKey(item.url)
            }) };
    }

    function validateManifest(manifest) {
        if (!manifest || !CONTRACT_PATTERN.test(manifest.defaultContract || "") ||
            manifest.manifestVersion !== undefined && manifest.manifestVersion !== 2 ||
            !Array.isArray(manifest.availableContracts) || manifest.availableContracts.length === 0) return false;
        const contracts = new Set(); const urls = new Set();
        for (const item of manifest.availableContracts) {
            const resolution = item?.resolution || (item?.contract ? "resolved" : "unresolved");
            const resolved = resolution === "resolved" && CONTRACT_PATTERN.test(item?.contract || "");
            const unresolved = resolution === "unresolved" && item?.contract === null &&
                item?.gengetsu === null && item?.lastTradingDate === null && item?.active === false &&
                item?.selectionKey === unresolvedSelectionKey(item?.url);
            if ((!resolved && !unresolved) || typeof item.label !== "string" || !item.label.trim() ||
                typeof item.url !== "string" || typeof item.active !== "boolean" ||
                urls.has(item.url) || resolved && contracts.has(item.contract)) return false;
            if (resolved) contracts.add(item.contract);
            urls.add(item.url);
        }
        const active = manifest.availableContracts.filter(item => item.active);
        return active.length === 1 && active[0].contract === manifest.defaultContract &&
            (active[0].resolution || "resolved") === "resolved";
    }
    function createSelectOptions(manifest) {
        if (!validateManifest(manifest)) return [];
        const active = manifest.availableContracts.find(item => item.active);
        return [{ value: "auto", mode: "auto", contract: null,
            label: `自動（QRI既定：${active.contract}）` },
        ...manifest.availableContracts.map(item => item.contract ? {
            value: item.contract, mode: "specific", contract: item.contract,
            label: `${item.contract}${item.active ? "（QRI既定）" : ""}`, disabled: false
        } : {
            value: item.selectionKey, mode: "unresolved", contract: null, url: item.url,
            label: `${item.label}（未確認）`, disabled: false
        })];
    }

    function resolveManifestEntry(manifest, entry, canonical, validateCanonical) {
        if (!canonical || canonical.sourceUrl !== entry.url || canonical.contractLabel !== entry.label ||
            !CONTRACT_PATTERN.test(canonical.contract || "") ||
            canonical.gengetsu !== canonical.contract.replace("-", "") ||
            typeof canonical.lastTradingDate !== "string" || canonical.isActiveContract !== true ||
            typeof validateCanonical !== "function" ||
            validateCanonical(canonical, { allowUnresolvedContracts: true }) !== true) {
            throw new Error("lazy_canonical_mismatch");
        }
        const selected = canonical.availableContracts?.filter(item => item.active === true) || [];
        if (selected.length !== 1 || selected[0].url !== entry.url ||
            selected[0].label !== entry.label || selected[0].contract !== canonical.contract) {
            throw new Error("lazy_navigation_mismatch");
        }
        const next = clone(manifest);
        const index = next.availableContracts.findIndex(item => item.url === entry.url &&
            item.selectionKey === entry.selectionKey && item.contract === null);
        if (index < 0) throw new Error("lazy_entry_stale");
        next.availableContracts[index] = { contract: canonical.contract, gengetsu: canonical.gengetsu,
            label: entry.label, url: entry.url, active: false,
            lastTradingDate: canonical.lastTradingDate, resolution: "resolved",
            selectionKey: canonical.contract };
        if (next.defaultContract !== manifest.defaultContract || !validateManifest(next)) {
            throw new Error("lazy_manifest_invalid");
        }
        return next;
    }

    function createLazyManifestResolver() {
        const inflight = new Map();
        function resolve({ manifest, selectionKey, load, validateCanonical }) {
            if (!validateManifest(manifest) || typeof load !== "function") {
                return Promise.reject(new Error("lazy_request_invalid"));
            }
            const entry = manifest.availableContracts.find(item => item.contract === null &&
                item.resolution === "unresolved" && item.selectionKey === selectionKey);
            if (!entry) return Promise.reject(new Error("lazy_entry_missing"));
            const existing = inflight.get(entry.url);
            if (existing) return existing;
            const request = Promise.resolve().then(() => load(entry.url)).then(result => {
                const canonical = result?.canonical;
                const resolvedManifest = resolveManifestEntry(manifest, entry, canonical, validateCanonical);
                return { manifest: resolvedManifest, canonical, payload: result?.payload || null,
                    sourceUrl: entry.url };
            });
            const shared = request.finally(() => {
                if (inflight.get(entry.url) === shared) inflight.delete(entry.url);
            });
            inflight.set(entry.url, shared);
            return shared;
        }
        return Object.freeze({ resolve, pendingCount: () => inflight.size });
    }
    function createState() {
        return { mode: "auto", contract: null, status: "unavailable", requestSequence: 0,
            selectionKey: null, displayedContract: null, error: null };
    }
    function selectMode(state, value, manifest) {
        const next = clone(state || createState());
        if (value === "auto") return { ...next, mode: "auto", contract: null, selectionKey: null,
            status: validateManifest(manifest) ? "ready" : "unavailable",
            displayedContract: validateManifest(manifest) ? manifest.defaultContract : null, error: null };
        const unresolved = manifest?.availableContracts?.find(item =>
            item.contract === null && item.selectionKey === value);
        if (unresolved) return { ...next, mode: "unresolved", contract: null,
            selectionKey: unresolved.selectionKey, status: "unavailable",
            displayedContract: null, error: "contract_unresolved" };
        if (!CONTRACT_PATTERN.test(value || "")) return { ...next, status: "validation_failed",
            displayedContract: null, error: "invalid_contract" };
        return { ...next, mode: "specific", contract: value, selectionKey: null,
            status: manifest?.availableContracts?.some(item => item.contract === value) ? "loading" : "unavailable",
            displayedContract: null, error: manifest?.availableContracts?.some(item => item.contract === value)
                ? null : "contract_not_listed" };
    }
    function beginRequest(state) {
        return { ...clone(state), status: "loading", requestSequence: Number(state?.requestSequence || 0) + 1,
            displayedContract: null, error: null };
    }
    function invalidateRequest(state) {
        return { ...clone(state || createState()),
            requestSequence: Number(state?.requestSequence || 0) + 1 };
    }
    function validateSpecificResult({ requestedContract, requestedUrl, manifest, canonical, validateCanonical }) {
        if (!validateManifest(manifest) || !CONTRACT_PATTERN.test(requestedContract || "")) return false;
        const listed = manifest.availableContracts.find(item => item.contract === requestedContract);
        if (!listed || listed.url !== requestedUrl || !canonical || canonical.contract !== requestedContract ||
            canonical.sourceUrl !== requestedUrl || canonical.gengetsu !== requestedContract.replace("-", "") ||
            canonical.records?.some(record => record.contract !== requestedContract) ||
            canonical.availableContracts?.filter(item => item.active).length !== 1) return false;
        return typeof validateCanonical === "function" &&
            validateCanonical(canonical, { allowUnresolvedContracts: true }) === true;
    }
    function finishRequest(state, sequence, result) {
        if (!STATUSES.includes(result?.status)) throw new Error("invalid_selection_status");
        if (sequence !== state.requestSequence) return { ...clone(state), status: "stale_ignored" };
        return { ...clone(state), status: result.status,
            displayedContract: result.status === "ready" ? state.contract : null,
            error: result.error || null };
    }
    function fallbackPolicy(mode) {
        return { allowLegacyV1: mode === "auto", unavailableMessage: mode === "specific"
            ? "この限月の建玉残は現在利用できません" : null };
    }
    return Object.freeze({ STATUSES, createPartialManifest, validateManifest, createSelectOptions,
        createLazyManifestResolver, createState, selectMode, beginRequest, validateSpecificResult,
        finishRequest, invalidateRequest, fallbackPolicy });
});
