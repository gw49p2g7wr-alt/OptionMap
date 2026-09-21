(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const fullExportApi = commonJs ? require("./fullExport.js") : root?.OptionMapFullExport;
    const fullExportV2Api = commonJs ? require("./fullExportV2.js") : root?.OptionMapFullExportV2;
    const api = factory(fullExportApi, fullExportV2Api, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportUi = api;
})(typeof window !== "undefined" ? window : globalThis,
function (fullExportApi, fullExportV2Api, root) {
    "use strict";
    let browserConfiguration = null;

    function jstParts(value) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error("invalid_generation_time");
        return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).formatToParts(date).map(part => [part.type, part.value]));
    }

    function generatedAtJst(value) {
        const parts = jstParts(value);
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:` +
            `${parts.second}+09:00`;
    }

    function createFileName(generatedAt) {
        const parts = jstParts(generatedAt);
        return `OptionMap-Full-Export-${parts.year}-${parts.month}-${parts.day}T` +
            `${parts.hour}${parts.minute}${parts.second}-JST.json`;
    }

    function createV2FileName(generatedAt) {
        const parts = jstParts(generatedAt);
        return `OptionMap-Full-Export-v2-${parts.year}-${parts.month}-${parts.day}T` +
            `${parts.hour}${parts.minute}${parts.second}-JST.json`;
    }

    function safeReason(error) {
        const message = typeof error?.message === "string" ? error.message : "";
        if (message.startsWith("security_validation_failed:")) return "安全性検査に失敗しました";
        if (message.startsWith("full_export_invalid:")) return "データ形式を確認できませんでした";
        return "必要なデータを確認できませんでした";
    }

    function statusCounts(value) {
        const counts = { available: 0, partial: 0, unavailable: 0, invalid: 0 };
        Object.values(value.sections).forEach(section => { counts[section.status] += 1; });
        return counts;
    }

    function createController(configuration) {
        let running = false;
        async function run(requestedFormat = "v1") {
            if (running) return { success: false, cancelled: false, reason: "already_running" };
            running = true;
            configuration.setBusy?.(true);
            configuration.setStatus?.("collecting", "AI用データを準備しています…");
            try {
                const v1Value = await configuration.collect();
                const exportValue = requestedFormat === "v2"
                    ? await configuration.collectV2?.(v1Value) : v1Value;
                const api = requestedFormat === "v2" ? fullExportV2Api : fullExportApi;
                const validation = api?.validate?.(exportValue) ||
                    api?.validateFullExport?.(exportValue);
                if (!validation.valid) throw new Error("full_export_invalid");
                const json = (api?.serialize?.(exportValue, 2) ||
                    api?.serializeFullExport?.(exportValue, 2)) + "\n";
                if (new TextEncoder().encode(json).byteLength > 50 * 1024 * 1024)
                    throw new Error("full_export_size_limit");
                const fileName = requestedFormat === "v2"
                    ? createV2FileName(exportValue.exportMeta.generatedAt)
                    : createFileName(exportValue.exportMeta.generatedAt);
                const saved = await configuration.save({ fileName, json });
                if (saved?.cancelled) {
                    configuration.setStatus?.("cancelled", "保存をキャンセルしました");
                    return { success: false, cancelled: true, reason: "save_cancelled" };
                }
                if (saved?.success !== true) throw new Error("file_save_failed");
                const counts = statusCounts(exportValue);
                configuration.setStatus?.("success", "AI用データを書き出しました", {
                    ...counts, warnings: exportValue.warnings.length, fileName });
                return { success: true, cancelled: false, fileName, counts,
                    warnings: exportValue.warnings.length };
            } catch (error) {
                const reason = safeReason(error);
                configuration.setStatus?.("failure", `AI用データを書き出せませんでした：${reason}`);
                return { success: false, cancelled: false, reason };
            } finally {
                running = false;
                configuration.setBusy?.(false);
            }
        }
        return Object.freeze({ run, isRunning: () => running });
    }

    function configure(configuration) { browserConfiguration = configuration; }

    function initialize() {
        const button = root.document?.getElementById?.("fullExportJsonButton");
        const status = root.document?.getElementById?.("fullExportStatus");
        if (!button || !status || !browserConfiguration) return null;
        const controller = createController({
            collect: browserConfiguration.collect,
            collectV2: browserConfiguration.collectV2,
            save: request => root.optionMapBridge.saveFullExportJson(request),
            setBusy: busy => { button.disabled = busy; button.setAttribute("aria-busy", String(busy)); },
            setStatus: (state, message, summary) => {
                status.dataset.state = state;
                status.textContent = summary ? `${message}（利用可 ${summary.available}・一部 ${summary.partial}` +
                    `・利用不可 ${summary.unavailable}・警告 ${summary.warnings}）` : message;
            }
        });
        button.addEventListener("click", () => {
            const selected = root.document?.querySelector?.(
                'input[name="fullExportFormat"]:checked')?.value;
            void controller.run(selected === "v2" ? "v2" : "v1");
        });
        return controller;
    }

    root.document?.addEventListener?.("DOMContentLoaded", initialize);
    return Object.freeze({ generatedAtJst, createFileName, createV2FileName,
        safeReason, statusCounts,
        createController, configure, initialize });
});
