(function (root, factory) {
    const api = factory(root);
    if (root) root.OptionMapMorningBaselineStorage = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
    "use strict";
    const STORAGE_KEY = "optionMapMobileMorningBaselinesV1";
    const api = () => root.OptionMapMorningBaseline;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    async function load() {
        const raw = root.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { status: "empty", storage: api().createEmptyStorage() };
        try {
            const storage = JSON.parse(raw); const validation = await api().validateStorage(storage);
            return validation.valid ? { status: "ready", storage: clone(storage) } :
                { status: "corrupted", storage: null, errors: validation.errors };
        } catch (_error) { return { status: "corrupted", storage: null, errors: ["json_invalid"] }; }
    }
    async function getForMarketDate(marketDate) {
        const loaded = await load();
        if (!loaded.storage) return { available: false, reason: "morning_baseline_corrupted", baseline: null };
        return api().getForMarketDate(loaded.storage, marketDate);
    }
    async function save(baseline) {
        const loaded = await load();
        if (!loaded.storage) throw new Error("morning_baseline_storage_corrupted");
        const next = await api().upsertStorage(loaded.storage, baseline);
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return clone(next);
    }
    return Object.freeze({ STORAGE_KEY, load, getForMarketDate, save });
});
