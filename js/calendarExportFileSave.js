(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapCalendarExportFileSave = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const MAX_JSON_BYTES = 50 * 1024 * 1024,
        FILE_NAME = /^OptionMap-Calendar-Export-v1-\d{4}-\d{2}-\d{2}T\d{6}-JST\.json$/;
    function validateRequest(request) {
        if (!request || typeof request !== "object" || Array.isArray(request) ||
            Object.keys(request).sort().join("|") !== "fileName|json" ||
            !FILE_NAME.test(request.fileName || "") || typeof request.json !== "string" ||
            Buffer.byteLength(request.json, "utf8") > MAX_JSON_BYTES)
            return { valid: false, reason: "invalid_calendar_export_request" };
        try {
            const value = JSON.parse(request.json);
            if (value?.schemaVersion !== "optionmap-calendar-export-v1" ||
                value?.exportMeta?.artifactType !== "calendar_formal_export" ||
                value?.exportMeta?.readOnly !== true)
                return { valid: false, reason: "invalid_calendar_export_schema" };
        } catch (_error) { return { valid: false, reason: "invalid_calendar_export_json" }; }
        return { valid: true, reason: null };
    }
    function createSaveService({ dialog, fs, path, randomUUID }) {
        async function save(browserWindow, request) {
            const validation = validateRequest(request);
            if (!validation.valid) return { success: false, cancelled: false, reason: validation.reason };
            const choice = await dialog.showSaveDialog(browserWindow, { title: "Calendar Exportを保存",
                defaultPath: request.fileName, filters: [{ name: "JSON", extensions: ["json"] }],
                properties: ["showOverwriteConfirmation", "createDirectory"] });
            if (choice.canceled || !choice.filePath)
                return { success: false, cancelled: true, reason: "save_cancelled" };
            const temporaryPath = path.join(path.dirname(choice.filePath),
                `.${path.basename(choice.filePath)}.${randomUUID()}.tmp`);
            try {
                await fs.writeFile(temporaryPath, request.json, { encoding: "utf8", flag: "wx" });
                await fs.rename(temporaryPath, choice.filePath);
                return { success: true, cancelled: false, reason: null };
            } catch (_error) {
                await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
                return { success: false, cancelled: false, reason: "file_save_failed" };
            }
        }
        return Object.freeze({ save });
    }
    return Object.freeze({ MAX_JSON_BYTES, validateRequest, createSaveService });
});
