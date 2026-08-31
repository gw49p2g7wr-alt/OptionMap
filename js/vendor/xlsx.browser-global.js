(function exposePinnedXlsxBrowserGlobal(root) {
    "use strict";

    const isPinnedXlsx = value => value?.version === "0.20.3" &&
        typeof value.read === "function" &&
        typeof value.utils?.sheet_to_json === "function";

    if (isPinnedXlsx(root?.XLSX)) return;

    const commonJsExport = typeof module === "object" && module?.exports;
    if (isPinnedXlsx(commonJsExport)) {
        root.XLSX = commonJsExport;
    }
})(typeof window !== "undefined" ? window : globalThis);
