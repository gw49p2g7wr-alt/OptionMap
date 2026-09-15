(function (root, factory) {
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const api = factory(registry);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarReadOnlyFetch = api;
})(typeof window !== "undefined" ? window : globalThis, function (registry) {
    "use strict";
    async function hash(bytes) { const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (globalThis.crypto?.subtle) { const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
            return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""); }
        return require("node:crypto").createHash("sha256").update(data).digest("hex"); }
    async function acquire(sourceId, requestedUrl, { fetchImpl = globalThis.fetch, maxRedirects = 3 } = {}) {
        const startedAt = new Date().toISOString(), requestId = globalThis.crypto?.randomUUID
            ? globalThis.crypto.randomUUID() : require("node:crypto").randomUUID(), hops = []; let url = requestedUrl;
        const requested = registry.validateSourceUrl(sourceId, url);
        if (!requested.valid) return Object.freeze({ status: "rejected", reason: requested.reason,
            sourceId, requestId, requestedUrl, finalUrl: null, startedAt, fetchedAt: null, httpStatus: null,
            redirects: Object.freeze(hops), contentType: null, contentHash: null, bytes: null });
        try { for (let count = 0; count <= maxRedirects; count += 1) {
            const response = await fetchImpl(url, { method: "GET", redirect: "manual",
                headers: { accept: "application/json,text/html,application/xhtml+xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
            if (response.status >= 300 && response.status < 400) { const location = response.headers.get("location");
                if (!location) throw new Error("redirect_location_missing"); const next = new URL(location, url).href,
                    allowed = registry.validateSourceUrl(sourceId, next);
                hops.push(Object.freeze({ from: url, to: next, status: response.status, allowed: allowed.valid }));
                if (!allowed.valid) throw new Error("redirect_not_allowed"); url = next; continue; }
            const buffer = await response.arrayBuffer(), bytes = new Uint8Array(buffer), fetchedAt = new Date().toISOString();
            return Object.freeze({ status: response.ok ? "success" : "failure",
                reason: response.ok ? null : "http_status_rejected", sourceId, requestId, requestedUrl,
                finalUrl: response.url || url, startedAt, fetchedAt, httpStatus: response.status,
                redirects: Object.freeze(hops), contentType: response.headers.get("content-type"),
                contentHash: await hash(bytes), bytes }); }
            throw new Error("redirect_limit_exceeded"); }
        catch (error) { return Object.freeze({ status: "failure", reason: error.message || "network_failed",
            sourceId, requestId, requestedUrl, finalUrl: url, startedAt, fetchedAt: null, httpStatus: null,
            redirects: Object.freeze(hops), contentType: null, contentHash: null, bytes: null }); }
    }
    return Object.freeze({ hash, acquire });
});
