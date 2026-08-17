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

    function validateManifest(manifest) {
        if (!manifest || !CONTRACT_PATTERN.test(manifest.defaultContract || "") ||
            !Array.isArray(manifest.availableContracts) || manifest.availableContracts.length === 0) return false;
        const contracts = new Set(); const urls = new Set();
        for (const item of manifest.availableContracts) {
            if (!CONTRACT_PATTERN.test(item?.contract || "") || typeof item.label !== "string" ||
                typeof item.url !== "string" || typeof item.active !== "boolean" ||
                contracts.has(item.contract) || urls.has(item.url)) return false;
            contracts.add(item.contract); urls.add(item.url);
        }
        const active = manifest.availableContracts.filter(item => item.active);
        return active.length === 1 && active[0].contract === manifest.defaultContract;
    }
    function createSelectOptions(manifest) {
        if (!validateManifest(manifest)) return [];
        const active = manifest.availableContracts.find(item => item.active);
        return [{ value: "auto", mode: "auto", contract: null,
            label: `自動（QRI既定：${active.contract}）` },
        ...manifest.availableContracts.map(item => ({ value: item.contract, mode: "specific",
            contract: item.contract, label: `${item.contract}${item.active ? "（QRI既定）" : ""}` }))];
    }
    function createState() {
        return { mode: "auto", contract: null, status: "unavailable", requestSequence: 0,
            displayedContract: null, error: null };
    }
    function selectMode(state, value, manifest) {
        const next = clone(state || createState());
        if (value === "auto") return { ...next, mode: "auto", contract: null,
            status: validateManifest(manifest) ? "ready" : "unavailable",
            displayedContract: validateManifest(manifest) ? manifest.defaultContract : null, error: null };
        if (!CONTRACT_PATTERN.test(value || "")) return { ...next, status: "validation_failed",
            displayedContract: null, error: "invalid_contract" };
        return { ...next, mode: "specific", contract: value,
            status: manifest?.availableContracts?.some(item => item.contract === value) ? "loading" : "unavailable",
            displayedContract: null, error: manifest?.availableContracts?.some(item => item.contract === value)
                ? null : "contract_not_listed" };
    }
    function beginRequest(state) {
        return { ...clone(state), status: "loading", requestSequence: Number(state?.requestSequence || 0) + 1,
            displayedContract: null, error: null };
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
    return Object.freeze({ STATUSES, validateManifest, createSelectOptions, createState,
        selectMode, beginRequest, validateSpecificResult, finishRequest, fallbackPolicy });
});
