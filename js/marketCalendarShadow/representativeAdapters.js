(function (root, factory) {
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const parsers = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./representativeParsers.js") : root?.OptionMapMarketCalendarRepresentativeParsers;
    const encoding = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./xmlEncoding.js") : root?.OptionMapMarketCalendarXmlEncoding;
    const api = factory(registry, parsers, encoding);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarRepresentativeAdapters = api;
})(typeof window !== "undefined" ? window : globalThis, function (registry, parsers, encoding) {
    "use strict";
    const text = bytes => new TextDecoder("utf-8").decode(bytes);
    const context = (source, fetchResult, runId, sourceUrl = fetchResult.finalUrl,
        rawContentHash = fetchResult.contentHash) => ({ sourceId: source.sourceId,
        sourceUrl, fetchedAt: fetchResult.fetchedAt, parserId: source.parserId,
        parserVersion: source.parserVersion, rawContentHash, requestId: fetchResult.requestId || null,
        runId: runId || null, httpMetadata: { httpStatus: fetchResult.httpStatus,
            finalUrl: fetchResult.finalUrl, contentType: fetchResult.contentType,
            redirects: fetchResult.redirects || [] } });
    function htmlAdapter(sourceId, parse) { return Object.freeze({ sourceId,
        async acquire({ fetcher, runId }) { const source = registry.getSource(sourceId), primary =
            await fetcher(sourceId, source.canonicalUrl); if (primary.status !== "success")
            return { fetches: [primary], records: [], diagnostics: [`fetch:${primary.reason}`] };
            const parsed = parse(text(primary.bytes), context(source, primary, runId));
            return { fetches: [primary], ...parsed }; } }); }
    function jpxAdapter({ XLSX }) { const sourceId = "jp-jpx-derivatives-calendar"; return Object.freeze({ sourceId,
        async acquire({ fetcher, runId }) { const source = registry.getSource(sourceId), landing =
            await fetcher(sourceId, source.canonicalUrl); if (landing.status !== "success")
            return { fetches: [landing], records: [], diagnostics: [`fetch:${landing.reason}`] };
            const year = Number(landing.fetchedAt.slice(0, 4)), workbookUrl = parsers.discoverJpxWorkbook(
                text(landing.bytes), year, landing.finalUrl); if (!workbookUrl) return { fetches: [landing],
                records: [], diagnostics: ["jpx_workbook_not_discovered"] };
            const workbookFetch = await fetcher(sourceId, workbookUrl); if (workbookFetch.status !== "success")
                return { fetches: [landing, workbookFetch], records: [],
                    diagnostics: [`child_fetch:${workbookFetch.reason}`] };
            try { const workbook = XLSX.read(workbookFetch.bytes, { type: "array" }), sheet =
                workbook.Sheets[workbook.SheetNames[0]], rows = XLSX.utils.sheet_to_json(sheet,
                    { header: 1, raw: false }); const parsed = parsers.parseJpxWorkbook(rows,
                        context(source, workbookFetch, runId, workbookUrl, workbookFetch.contentHash));
                return { fetches: [landing, workbookFetch], ...parsed }; }
            catch (error) { return { fetches: [landing, workbookFetch], records: [],
                diagnostics: [`jpx_workbook_parse_failed:${error.message}`] }; } } }); }
    function create({ XLSX } = {}) { return Object.freeze([
        htmlAdapter("jp-boj-calendar", parsers.parseBoj),
        htmlAdapter("us-bls-calendar", parsers.parseBls),
        htmlAdapter("us-fed-fomc-calendar", parsers.parseFed),
        jpxAdapter({ XLSX })]); }
    function createStatCpi() { const sourceId = "jp-stat-cpi"; return Object.freeze({ sourceId,
        async acquire({ fetcher, runId }) { const source = registry.getSource(sourceId), landing =
            await fetcher(sourceId, source.canonicalUrl); if (landing.status !== "success")
            return { fetches: [landing], records: [], diagnostics: [`fetch:${landing.reason}`] };
            const xmlUrl = new URL("/data/kouhyou/e-stat_cpi.xml", source.canonicalUrl).href,
                xmlFetch = await fetcher(sourceId, xmlUrl); if (xmlFetch.status !== "success")
                return { fetches: [landing, xmlFetch], records: [], diagnostics:
                    [`child_fetch:${xmlFetch.reason}`] };
            const decoded = encoding.decodeUtf16Xml(xmlFetch.bytes, xmlFetch.contentType);
            if (!decoded.ok) return { fetches: [landing, xmlFetch], records: [],
                diagnostics: [`encoding:${decoded.reason}`], encoding: decoded };
            const parsed = parsers.parseStatCpiXml(decoded.text, context(source, xmlFetch, runId,
                xmlUrl, xmlFetch.contentHash));
            return { fetches: [landing, xmlFetch], ...parsed, encoding: { ok: true,
                encoding: decoded.encoding, evidence: decoded.evidence } }; } }); }
    function createStatLabor() { const sourceId = "jp-stat-labor"; return Object.freeze({ sourceId,
        async acquire({ fetcher, runId }) { const source = registry.getSource(sourceId), landing =
            await fetcher(sourceId, source.canonicalUrl); if (landing.status !== "success")
            return { fetches: [landing], records: [], diagnostics: [`fetch:${landing.reason}`] };
            const xmlUrl = new URL("/data/kouhyou/e-stat_roudou.xml", source.canonicalUrl).href,
                xmlFetch = await fetcher(sourceId, xmlUrl); if (xmlFetch.status !== "success")
                return { fetches: [landing, xmlFetch], records: [], diagnostics:
                    [`child_fetch:${xmlFetch.reason}`] };
            const decoded = encoding.decodeUtf16Xml(xmlFetch.bytes, xmlFetch.contentType);
            if (!decoded.ok) return { fetches: [landing, xmlFetch], records: [],
                diagnostics: [`encoding:${decoded.reason}`], encoding: decoded };
            const parsed = parsers.parseStatLaborXml(decoded.text, context(source, xmlFetch, runId,
                xmlUrl, xmlFetch.contentHash));
            return { fetches: [landing, xmlFetch], ...parsed, encoding: { ok: true,
                encoding: decoded.encoding, evidence: decoded.evidence } }; } }); }
    return Object.freeze({ create, createStatCpi, createStatLabor });
});
