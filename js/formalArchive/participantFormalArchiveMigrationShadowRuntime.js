(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const previewApi = commonJs ? require("./participantFormalArchiveMigrationPreview.js") :
        root?.OptionMapParticipantFormalArchiveMigrationPreview;
    const api = factory(previewApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveMigrationShadowRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function (previewApi) {
    "use strict";
    const SOURCE_KEY = "optionMapParticipantHistory";
    async function runShadowPreview(storage) { let raw;
        try { raw = storage?.getItem?.(SOURCE_KEY); } catch (_error) {
            return { status: "unavailable", reason: "source_read_failed", shadowOnly: true }; }
        if (!raw) return { status: "empty", reason: "source_missing", shadowOnly: true };
        let history; try { history = JSON.parse(raw); } catch (_error) {
            return { status: "invalid", reason: "source_json_invalid", shadowOnly: true }; }
        const result = await previewApi.previewMigration(history);
        return { status: result.semanticEquivalence ? "ready" : "blocked", result };
    }
    return Object.freeze({ SOURCE_KEY, runShadowPreview });
});
