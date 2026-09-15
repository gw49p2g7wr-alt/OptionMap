(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarHtmlEncoding = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const RESOLUTION_POLICY_VERSION = 1;
    const labels = Object.freeze({ "utf-8": "utf-8", utf8: "utf-8",
        "iso-8859-1": "windows-1252", latin1: "windows-1252", "windows-1252": "windows-1252" });
    const normalize = value => labels[String(value || "").trim().toLowerCase()] || null;
    function bomFor(bytes) { if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"; return null; }
    function declarations(bytes) {
        const ascii = new TextDecoder("windows-1252").decode(bytes), prescan = ascii.slice(0, 1024),
            html5 = ascii.match(/<meta(?![^>]*http-equiv)[^>]*\bcharset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1] || null,
            legacy = ascii.match(/<meta\s+[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)/i)?.[1] || null,
            candidates = [...prescan.matchAll(/<meta\s+[^>]*>/gi)].map(match => { const tag = match[0],
                direct = tag.match(/\bcharset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1], pragma =
                    /\bhttp-equiv\s*=\s*["']?content-type/i.test(tag) ? tag.match(
                        /\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)/i)?.[1] : null;
                return direct || pragma || null; }).filter(Boolean);
        return { html5MetaCharset: html5, legacyMetaCharset: legacy,
            prescanCharset: candidates[0] || null };
    }
    function decodeHtml(bytes, contentType) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []),
            httpCharset = String(contentType || "").match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] || null,
            bom = bomFor(data), declared = declarations(data), normalizedBom = normalize(bom) || bom,
            normalizedHttp = normalize(httpCharset), normalizedPrescan = normalize(declared.prescanCharset),
            resolvedEncoding = normalizedBom || normalizedHttp || normalizedPrescan, warnings = [];
        const evidence = { httpCharset, bom, html5MetaCharset: declared.html5MetaCharset,
            legacyMetaCharset: declared.legacyMetaCharset, resolvedEncoding,
            resolutionPolicyVersion: RESOLUTION_POLICY_VERSION };
        if (httpCharset && !normalizedHttp) return { ok: false, reason: "http_charset_unsupported", evidence };
        if (!resolvedEncoding) return { ok: false, reason: "encoding_not_determined", evidence };
        const declarationsNormalized = [declared.html5MetaCharset, declared.legacyMetaCharset]
            .map(normalize).filter(Boolean);
        if (declarationsNormalized.some(value => value !== resolvedEncoding))
            warnings.push("encoding_declaration_conflict_resolved_by_higher_precedence");
        try { const text = new TextDecoder(resolvedEncoding, { fatal: true }).decode(data);
            return { ok: true, text, encoding: resolvedEncoding, evidence, warnings }; }
        catch (_error) { return { ok: false, reason: "decode_failed", evidence, warnings }; }
    }
    return Object.freeze({ RESOLUTION_POLICY_VERSION, decodeHtml });
});
