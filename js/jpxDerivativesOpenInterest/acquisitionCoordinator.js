(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const source = common ? require("./sourceContract.js") : root?.OptionMapJpxDerivativesOpenInterestSourceContract;
    const parser = common ? require("./workbookParser.js") : root?.OptionMapJpxDerivativesOpenInterestWorkbookParser;
    const identity = common ? require("./identity.js") : root?.OptionMapJpxDerivativesOpenInterestIdentity;
    const sourceEvidence = common ? require("./sourceEvidence.js") : null;
    const api = factory(source, parser, identity, sourceEvidence); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestAcquisitionCoordinator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (source, parser, identity, sourceEvidence) {
    "use strict";
    function listingLink(html) { const matches = [...String(html).matchAll(/href=["']([^"']*\/(20\d{6})open_interest\.xlsx)["']/g)];
        return matches.length === 1 ? { href: new URL(matches[0][1], source.LISTING_URL).href,
            date: `${matches[0][2].slice(0, 4)}-${matches[0][2].slice(4, 6)}-${matches[0][2].slice(6)}` } : null; }
    function create({ XLSX, fetchListing, fetchWorkbook, evidenceVault = null,
        acquisitionContext = "live_original_acquisition" }) {
        async function run() { const page = await fetchListing(source.LISTING_URL), found = listingLink(page.text);
            if (!found) return { accepted: false, diagnostics: [{ severity: "blocking", code: "listing_link_invalid" }] };
            const workbook = await fetchWorkbook(found.href, { discoveredFrom: source.LISTING_URL });
            if (workbook.finalUrl && workbook.finalUrl !== found.href) return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "redirect_mismatch" }] };
            if (workbook.httpMetadata?.status !== 200 || !/^application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)$/i
                .test(workbook.httpMetadata?.contentType || "")) return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "http_metadata_invalid" }] };
            let computedSha256;
            try { computedSha256 = await source.sha256Bytes(workbook.bytes); }
            catch (error) { return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "workbook_bytes_invalid",
                    reason: error.message }] }; }
            if (workbook.sha256 && workbook.sha256 !== computedSha256) return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "workbook_sha256_mismatch" }] };
            const workbookSha256 = workbook.sha256 || computedSha256;
            let captured = null;
            if (evidenceVault) try { captured = sourceEvidence.captureOriginalWorkbook({
                bytes: workbook.bytes, workbookUrl: found.href, fetchedAt: workbook.fetchedAt,
                httpMetadata: workbook.httpMetadata, workbookSha256, acquisitionContext
            }, evidenceVault); } catch (error) { return { accepted: false,
                diagnostics: [{ severity: "blocking", code: "source_evidence_write_failed",
                    reason: error.message }], evidenceTransactionCount: 0,
                formalTransactionCount: 0, semanticWrites: 0 }; }
            let parsed = parser.parse({ XLSX, bytes: workbook.bytes, listingDate: found.date,
                workbookUrl: found.href, listingUrl: source.LISTING_URL, fetchedAt: workbook.fetchedAt,
                httpMetadata: workbook.httpMetadata, workbookSha256 });
            if (!parsed.accepted) return parsed;
            if (captured) parsed = { ...parsed,
                evidence: sourceEvidence.bindAcquisitionEvidence(parsed.evidence, captured),
                sourceEvidenceResult: { occurrenceId: captured.sourceEvidence.occurrenceId,
                    contentSha256: captured.sourceEvidence.contentSha256,
                    evidenceTransactionCount: captured.stored.occurrenceWriteCount,
                    contentClassification: captured.stored.contentClassification } };
            return { ...parsed, acquisitionRunId: captured?.acquisitionRunId || null,
                identities: await identity.derive(parsed.canonical, parsed.evidence) }; }
        return Object.freeze({ run });
    }
    function createEvidenceBound(configuration) {
        if (!configuration?.evidenceVault || !sourceEvidence)
            throw new TypeError("jpx_daily_oi_evidence_vault_required");
        return create(configuration);
    }
    return Object.freeze({ create, createEvidenceBound, listingLink });
});
