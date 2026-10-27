(function (root, factory) {
    const node = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(node ? require("./calendarExportV1.js") : root?.OptionMapCalendarExportV1,
        root);
    if (node) module.exports = api;
    if (root) root.OptionMapCalendarExportUi = api;
})(typeof window !== "undefined" ? window : globalThis, function (ExportV1, root) {
    "use strict";
    function jstParts(value) {
        return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            second: "2-digit", hour12: false }).formatToParts(new Date(value))
            .map(part => [part.type, part.value]));
    }
    function createFileName(value) {
        const parts = jstParts(value);
        return `OptionMap-Calendar-Export-v1-${parts.year}-${parts.month}-${parts.day}T` +
            `${parts.hour}${parts.minute}${parts.second}-JST.json`;
    }
    function createController(configuration) {
        let running = false;
        async function run() {
            if (running) return { success: false, reason: "already_running" };
            running = true; configuration.setBusy?.(true);
            configuration.setStatus?.("collecting", "保存済みカレンダーを書き出しています…");
            try {
                const generatedAt = new Date().toISOString(), metadata = await configuration.metadata();
                if (metadata?.success !== true || typeof metadata.appVersion !== "string" ||
                    !metadata.appVersion.trim()) throw new Error("runtime_metadata_unavailable");
                const artifact = await configuration.collect({ appVersion: metadata.appVersion, generatedAt });
                const json = ExportV1.serialize(artifact, 2) + "\n", fileName = createFileName(generatedAt),
                    saved = await configuration.save({ fileName, json });
                if (saved?.cancelled) { configuration.setStatus?.("cancelled", "保存をキャンセルしました");
                    return { success: false, cancelled: true, reason: "save_cancelled" }; }
                if (saved?.success !== true) throw new Error("file_save_failed");
                configuration.setStatus?.("success", `Calendar Exportを書き出しました（${artifact.events.length}件）`);
                return { success: true, cancelled: false, fileName, eventCount: artifact.events.length };
            } catch (_error) {
                configuration.setStatus?.("failure", "Calendar Exportを書き出せませんでした");
                return { success: false, cancelled: false, reason: "calendar_export_failed" };
            } finally { running = false; configuration.setBusy?.(false); }
        }
        return Object.freeze({ run, isRunning: () => running });
    }
    function initialize() {
        const button = root.document?.getElementById?.("marketCalendarExportButton"),
            status = root.document?.getElementById?.("marketCalendarExportStatus");
        if (!button || !status || !root.OptionMapCalendarExportRuntime || !root.optionMapBridge) return null;
        const runtime = root.OptionMapCalendarExportRuntime.create({ indexedDB: root.indexedDB }),
            controller = createController({ collect: input => runtime.exportCurrent(input),
                metadata: () => root.optionMapBridge.getRuntimeMetadata(),
                save: request => root.optionMapBridge.saveCalendarExportJson(request),
                setBusy: busy => { button.disabled = busy; button.setAttribute("aria-busy", String(busy)); },
                setStatus: (state, message) => { status.dataset.state = state; status.textContent = message; } });
        button.addEventListener("click", () => { void controller.run(); });
        return controller;
    }
    root.document?.addEventListener?.("DOMContentLoaded", initialize);
    return Object.freeze({ createFileName, createController, initialize });
});
