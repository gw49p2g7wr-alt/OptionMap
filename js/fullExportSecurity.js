(function (root, factory) {
    const api = factory();
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportSecurity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PUBLIC_SOURCE_HOSTS = Object.freeze(["www.jpx.co.jp", "svc.qri.jp"]);
    const DENIED_KEYS = new Set([
        "token", "accesstoken", "refreshtoken", "idtoken", "authorization",
        "bearer", "cookie", "password", "secret", "credential", "email", "uid",
        "rawhtml", "innerhtml", "stack", "stacktrace", "env", "memo", "tags",
        "optionmapaitemplates", "nightdata", "daydata", "optiondata", "rawinput",
        "rawstorage", "storagedump", "localstoragedump", "indexeddbdump",
        "rawexcel", "workbook", "worksheet", "binary", "sessiontoken", "sessionid"
    ]);
    const TRADE_SIGNAL_KEYS = new Set([
        "tradesignal", "buysignal", "sellsignal", "entrysignal", "tradingrecommendation"
    ]);
    const SAFE_INTERPRETATION = "supply_demand_assessment_not_trade_signal";

    const normalizeKey = value => String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
    const pathFor = (parent, key) => `${parent}.${String(key)}`;
    const jsonPointer = (value, key, path) => {
        if (!["sourcePointer", "pointer", "authoritativeRoot"].includes(String(key))) return false;
        if (!path.startsWith("$.sections.aiSummary.") &&
            !path.startsWith("$.summary.") && !path.startsWith("$.details.")) return false;
        return value === "/sections" || /^\/sections\/(?:marketSnapshot|overallV2|qriOptions|qriOptionsNextContract|qriOptionsMajorSqNextContract|qriOptionIv|qriHistoryComparison|weeklyFutures|weeklyOptions|participants|morning|importantLevels|intelligence)(?:\/freshness)?$/.test(value) ||
            /^\/(?:warnings|compactSummary\/freshnessIssues)\/\d+$/.test(value);
    };
    const plainObject = value => {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    };

    function publicUrlError(value) {
        let url;
        try { url = new URL(value); } catch (_error) { return "public_url_invalid"; }
        if (url.protocol !== "https:" || !PUBLIC_SOURCE_HOSTS.includes(url.hostname)) {
            return "public_url_not_allowlisted";
        }
        if (url.username || url.password) return "public_url_credentials";
        if (url.search) return "public_url_query";
        if (url.hash) return "public_url_fragment";
        return null;
    }

    function inspectFullExportSecurity(value) {
        const errors = [];
        const ancestors = new WeakSet();
        const add = (code, path) => errors.push({ code, path });

        function visit(current, path, key = null) {
            const type = typeof current;
            if (["undefined", "function", "symbol", "bigint"].includes(type)) {
                add(`json_${type}`, path); return;
            }
            if (type === "number" && !Number.isFinite(current)) {
                add("json_non_finite_number", path); return;
            }
            if (current === null || ["string", "number", "boolean"].includes(type)) {
                if (type !== "string") return;
                if (/^(?:[A-Za-z]:[\\/]|~[\\/]|\\\\[^\\]+\\|\/(?!\/))/i.test(current) &&
                    !jsonPointer(current, key, path))
                    add("absolute_local_path", path);
                if (/<(?:!doctype|html|head|body|script|table)\b/i.test(current))
                    add("raw_html", path);
                if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(current))
                    add("email", path);
                if (/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(current))
                    add("bearer", path);
                if (/\b(?:Error|TypeError|ReferenceError):[^\n]*(?:\n|\\n)\s*at\s/i.test(current))
                    add("stack_trace", path);
                if (/(?:PK\x03\x04|raw.?excel|raw.?binary|storage.?dump|indexeddb.?dump)/i.test(current))
                    add("raw_payload", path);
                if (current !== SAFE_INTERPRETATION &&
                    /(?:trade.?signal|売買シグナル|今すぐ買|今すぐ売|買い推奨|売り推奨)/i.test(current))
                    add("trade_signal_language", path);
                if (/^https?:\/\//i.test(current)) {
                    const urlError = publicUrlError(current);
                    if (urlError) add(urlError, path);
                }
                return;
            }
            if (ancestors.has(current)) { add("circular_reference", path); return; }
            if (!Array.isArray(current) && !plainObject(current)) {
                add("json_non_plain_object", path); return;
            }
            ancestors.add(current);
            if (Array.isArray(current)) {
                current.forEach((item, index) => visit(item, `${path}[${index}]`));
            } else {
                for (const [childKey, child] of Object.entries(current)) {
                    const normalized = normalizeKey(childKey);
                    const childPath = pathFor(path, childKey);
                    const allowedMarketSession = normalized === "session" &&
                        childPath === "$.compactSummary.session";
                    if (DENIED_KEYS.has(normalized) || normalized.endsWith("token") ||
                        normalized.endsWith("password") || normalized.endsWith("credential") ||
                        normalized.includes("email") || normalized.endsWith("uid") ||
                        normalized.startsWith("cookie") || normalized.endsWith("secret") ||
                        normalized.endsWith("rawinput") || normalized.endsWith("storagedump") ||
                        normalized.endsWith("rawhtml") || normalized.endsWith("rawexcel") ||
                        normalized === "session" && !allowedMarketSession) {
                        add(`denied_key:${normalized}`, childPath);
                    }
                    if (TRADE_SIGNAL_KEYS.has(normalized)) add("trade_signal_field", childPath);
                    visit(child, childPath, childKey);
                }
            }
            ancestors.delete(current);
        }

        visit(value, "$", null);
        return Object.freeze({ valid: errors.length === 0,
            errors: Object.freeze(errors.map(error => Object.freeze(error))) });
    }

    return Object.freeze({ PUBLIC_SOURCE_HOSTS, SAFE_INTERPRETATION,
        inspectFullExportSecurity, publicUrlError });
});
