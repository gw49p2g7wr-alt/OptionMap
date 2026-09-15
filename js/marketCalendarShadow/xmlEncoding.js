(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarXmlEncoding = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const normalize = value => String(value || "").trim().toLowerCase().replace(/_/g, "-");
    function decodeUtf16Xml(bytes, contentType) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []),
            mediaType = String(contentType || "").split(";", 1)[0].trim().toLowerCase(),
            httpMatch = String(contentType || "").match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i),
            httpCharset = httpMatch ? normalize(httpMatch[1]) : null;
        if (!["application/xml", "text/xml"].includes(mediaType))
            return { ok: false, reason: "encoding_content_type_not_xml", text: null };
        let bomEncoding = null, offset = 0;
        if (data[0] === 0xff && data[1] === 0xfe) { bomEncoding = "utf-16le"; offset = 2; }
        else if (data[0] === 0xfe && data[1] === 0xff) { bomEncoding = "utf-16be"; offset = 2; }
        if (!bomEncoding) return { ok: false, reason: "encoding_bom_missing", text: null };
        if (httpCharset && !["utf-16", bomEncoding].includes(httpCharset))
            return { ok: false, reason: "encoding_http_bom_conflict", text: null };
        let text;
        try { text = new TextDecoder(bomEncoding, { fatal: true }).decode(data.slice(offset)); }
        catch (_error) { return { ok: false, reason: "encoding_decode_failed", text: null }; }
        const declaration = text.match(/^\s*<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)["'][^>]*\?>/i),
            xmlCharset = declaration ? normalize(declaration[1]) : null;
        if (!xmlCharset) return { ok: false, reason: "encoding_xml_declaration_missing", text: null };
        if (!["utf-16", bomEncoding].includes(xmlCharset))
            return { ok: false, reason: "encoding_xml_bom_conflict", text: null };
        return { ok: true, reason: null, text, encoding: bomEncoding,
            evidence: { mediaType, httpCharset, bomEncoding, xmlCharset } };
    }
    return Object.freeze({ decodeUtf16Xml });
});
