(function (root) {
    "use strict";
    const rawIndexedDB = root.indexedDB;
    if (!rawIndexedDB || typeof rawIndexedDB.databases !== "function")
        throw new Error("audit_indexeddb_unavailable");
    Object.defineProperty(root, "indexedDB", { value: undefined, writable: false,
        configurable: false });
    let taken = false;
    Object.defineProperty(root, "OptionMapMarketCalendarTakeReadOnlyGuard", { configurable: false,
        writable: false, value: (log, options) => {
            if (taken) throw new Error("audit_guard_already_taken");
            taken = true;
            return root.OptionMapMarketCalendarReadOnlyProbe.createGuard(rawIndexedDB,
                "optionMapMarketCalendarHistory", log, options);
        } });
})(typeof window !== "undefined" ? window : globalThis);
