(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weekly = commonJs ? require("../../weeklyOptions.js") : root.OptionMapWeeklyOptions;
    const historyApi = commonJs
        ? require("../../weeklyOptionsHistory.js") : root.OptionMapWeeklyOptionsHistory;
    const api = factory(weekly, historyApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsBackfill = api;
})(typeof window !== "undefined" ? window : globalThis, function (weekly, historyApi) {
    "use strict";
    const JPX_ORIGIN = "https://www.jpx.co.jp";

    function isoDate(value) {
        const match = String(value || "").match(/^(20\d{2})(\d{2})(\d{2})$/);
        if (!match) return null;
        const result = `${match[1]}-${match[2]}-${match[3]}`;
        const date = new Date(`${result}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === result
            ? result : null;
    }
    function parseListingUpdatedAt(value) {
        const match = String(value || "").match(
            /^(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/
        );
        return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00` : null;
    }
    function listingUrlForYear(year) {
        return `${JPX_ORIGIN}/automation/markets/derivatives/open-interest/json/open_interest_${year}.json`;
    }
    function parseSourceUrlDate(sourceUrl) {
        try {
            const url = new URL(sourceUrl);
            const match = url.pathname.match(/\/(20\d{6})_nk225op_oi_by_tp\.xlsx$/);
            return url.origin === JPX_ORIGIN ? isoDate(match?.[1]) : null;
        } catch (_error) { return null; }
    }
    function parseListingManifest(listing, listingUrl) {
        let parsedUrl;
        try { parsedUrl = new URL(listingUrl); } catch (_error) { return []; }
        if (parsedUrl.origin !== JPX_ORIGIN ||
            !/^\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_20\d{2}\.json$/.test(parsedUrl.pathname) ||
            !Array.isArray(listing?.TableDatas)) return [];
        const updatedAt = parseListingUpdatedAt(listing.UpdateDate);
        if (!updatedAt) return [];
        const unique = new Map();
        for (const row of listing.TableDatas) {
            const sourceDate = isoDate(row?.TradeDate);
            if (!sourceDate || typeof row?.IndexOptions !== "string") continue;
            let sourceUrl;
            try { sourceUrl = new URL(row.IndexOptions, JPX_ORIGIN).href; }
            catch (_error) { continue; }
            if (parseSourceUrlDate(sourceUrl) !== sourceDate) continue;
            unique.set(`${sourceDate}|${sourceUrl}`, {
                sourceDate, sourceUrl, listingUrl: parsedUrl.href, listingUpdatedAt: updatedAt
            });
        }
        return [...unique.values()].sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));
    }
    function filterCandidates(candidates, startDate, endDate) {
        return [...(Array.isArray(candidates) ? candidates : [])]
            .filter(item => item.sourceDate >= startDate && item.sourceDate <= endDate)
            .sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));
    }
    function yearsForRange(startDate, endDate) {
        const start = Number(String(startDate).slice(0, 4));
        const end = Number(String(endDate).slice(0, 4));
        return Number.isInteger(start) && Number.isInteger(end) && start <= end
            ? Array.from({ length: end - start + 1 }, (_v, i) => start + i) : [];
    }
    async function enumerateCandidates({ startDate, endDate, fetchListing }) {
        const all = [], failures = [];
        for (const year of yearsForRange(startDate, endDate)) {
            const listingUrl = listingUrlForYear(year);
            try { all.push(...parseListingManifest(await fetchListing(listingUrl), listingUrl)); }
            catch (error) { failures.push({ year, listingUrl, error: error?.message || String(error) }); }
        }
        const unique = new Map();
        for (const item of filterCandidates(all, startDate, endDate)) {
            unique.set(`${item.sourceDate}|${item.sourceUrl}`, item);
        }
        return { candidates: [...unique.values()], failures };
    }
    async function createHistoryCandidate(candidate, parsed, fetchedAt) {
        const data = parsed?.data;
        const urlDate = parseSourceUrlDate(candidate?.sourceUrl);
        if (!weekly.validateWeeklyOptionsData(data) || data.sourceDate !== candidate?.sourceDate ||
            urlDate !== candidate.sourceDate) throw new Error("date_or_schema_mismatch");
        const signature = await weekly.createSignature(data);
        const cache = {
            version: 2, parserVersion: 2, schemaVersion: 2,
            source: "jpx-weekly-nikkei225-options-open-interest",
            sourceDate: candidate.sourceDate, sourceDateKind: "jpx_open_interest_as_of",
            publishedDate: data.publishedDate, publishedAt: null,
            listingUpdatedAt: candidate.listingUpdatedAt,
            listingUpdatedAtKind: "jpx_listing_updated_at",
            listingUrl: candidate.listingUrl, fetchedAt, sourceUrl: candidate.sourceUrl,
            signatureAlgorithm: "sha256", signature,
            versionKey: `weekly-options-v2|${candidate.sourceDate}|sha256:${signature}`,
            dateEvidence: { excelAsOf: data.sourceDate,
                listingTradeDate: candidate.sourceDate, urlDate, consistent: true },
            versionAssessment: "confirmed", currentOfficialRefetch: true, data
        };
        if (!await weekly.validateVersionedCacheData(cache)) throw new Error("cache_validation_failed");
        const result = await historyApi.createWeeklyOptionsHistoryCandidate(cache);
        if (!result?.ok) throw new Error(result?.reason || "history_candidate_failed");
        return result.candidate;
    }
    async function runBackfill({ history, candidates, fetchExcel, parseExcel,
        isCancelled = () => false, onProgress = () => {}, now = () => new Date().toISOString() }) {
        const staged = [], results = [];
        const counts = { fetched: 0, parsed: 0, validated: 0 };
        for (let index = 0; index < candidates.length; index += 1) {
            const item = candidates[index];
            if (isCancelled()) return { status: "cancelled", staged: [], results, history };
            try {
                onProgress({ phase: "fetch", current: index + 1, total: candidates.length,
                    sourceDate: item.sourceDate });
                const bytes = await fetchExcel(item.sourceUrl);
                counts.fetched += 1;
                onProgress({ phase: "fetched", current: index + 1,
                    total: candidates.length, sourceDate: item.sourceDate, ...counts });
                if (isCancelled()) return { status: "cancelled", staged: [], results, history };
                onProgress({ phase: "parse", current: index + 1, total: candidates.length,
                    sourceDate: item.sourceDate });
                const parsed = await parseExcel(bytes, item);
                counts.parsed += 1;
                onProgress({ phase: "parsed", current: index + 1,
                    total: candidates.length, sourceDate: item.sourceDate, ...counts });
                const candidate = await createHistoryCandidate(item, parsed, now());
                staged.push(candidate);
                counts.validated += 1;
                results.push({ sourceDate: item.sourceDate, status: "success" });
                onProgress({ phase: "validated", current: index + 1,
                    total: candidates.length, sourceDate: item.sourceDate, ...counts });
            } catch (error) {
                results.push({ sourceDate: item.sourceDate, status: "failed",
                    error: error?.message || String(error) });
            }
        }
        if (isCancelled()) return { status: "cancelled", staged: [], results, history };
        let preview = history;
        try {
            for (const candidate of staged) {
                preview = (await historyApi.mergeWeeklyOptionsHistory(preview, candidate,
                    { confirmedAt: now() })).history;
            }
            if (!(await historyApi.validateWeeklyOptionsHistory(preview)).valid) {
                throw new Error("merged_history_invalid");
            }
        } catch (error) {
            return { status: "staging_failed", staged: [], results, history,
                error: error?.message || String(error) };
        }
        return { status: results.some(item => item.status === "failed") ? "partial" : "success",
            staged, results, history: preview };
    }
    return Object.freeze({ listingUrlForYear, parseSourceUrlDate, parseListingManifest,
        filterCandidates, yearsForRange, enumerateCandidates, createHistoryCandidate, runBackfill });
});
