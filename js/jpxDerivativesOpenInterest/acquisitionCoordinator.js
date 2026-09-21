(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const source = common ? require("./sourceContract.js") : root?.OptionMapJpxDerivativesOpenInterestSourceContract;
    const parser = common ? require("./workbookParser.js") : root?.OptionMapJpxDerivativesOpenInterestWorkbookParser;
    const identity = common ? require("./identity.js") : root?.OptionMapJpxDerivativesOpenInterestIdentity;
    const api = factory(source, parser, identity); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestAcquisitionCoordinator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (source, parser, identity) {
    "use strict";
    function listingLink(html) { const matches = [...String(html).matchAll(/href=["']([^"']*\/(20\d{6})open_interest\.xlsx)["']/g)];
        return matches.length === 1 ? { href: new URL(matches[0][1], source.LISTING_URL).href,
            date: `${matches[0][2].slice(0, 4)}-${matches[0][2].slice(4, 6)}-${matches[0][2].slice(6)}` } : null; }
    function create({ XLSX, fetchListing, fetchWorkbook }) {
        async function run() { const page = await fetchListing(source.LISTING_URL), found = listingLink(page.text);
            if (!found) return { accepted: false, diagnostics: [{ severity: "blocking", code: "listing_link_invalid" }] };
            const workbook = await fetchWorkbook(found.href, { discoveredFrom: source.LISTING_URL });
            if (workbook.finalUrl && workbook.finalUrl !== found.href) return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "redirect_mismatch" }] };
            if (workbook.httpMetadata?.status !== 200 || !/^application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)$/i
                .test(workbook.httpMetadata?.contentType || "")) return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "http_metadata_invalid" }] };
            const workbookSha256 = workbook.sha256 || await source.sha256([...new Uint8Array(workbook.bytes)]);
            const parsed = parser.parse({ XLSX, bytes: workbook.bytes, listingDate: found.date,
                workbookUrl: found.href, listingUrl: source.LISTING_URL, fetchedAt: workbook.fetchedAt,
                httpMetadata: workbook.httpMetadata, workbookSha256 });
            if (!parsed.accepted) return parsed;
            return { ...parsed, identities: await identity.derive(parsed.canonical, parsed.evidence) }; }
        return Object.freeze({ run });
    }
    return Object.freeze({ create, listingLink });
});
