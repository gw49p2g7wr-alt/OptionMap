(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weekly = commonJs
        ? require("../../weeklyFutures.js")
        : root.OptionMapWeeklyFutures;
    const historyApi = commonJs
        ? require("../../weeklyFuturesHistory.js")
        : root.OptionMapWeeklyFuturesHistory;
    const api = factory(weekly, historyApi);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesBackfill = api;
})(typeof window !== "undefined" ? window : globalThis, function (weekly, historyApi) {
    "use strict";

    const JPX_ORIGIN = "https://www.jpx.co.jp";

    function isoDate(compact) {
        const match = String(compact || "").match(/^(20\d{2})(\d{2})(\d{2})$/);
        if (!match) return null;
        const result = `${match[1]}-${match[2]}-${match[3]}`;
        const date = new Date(`${result}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === result ? result : null;
    }

    function listingUpdatedAt(value) {
        const match = String(value || "").match(
            /^(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/
        );
        return match
            ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`
            : null;
    }

    function parseSourceUrlDate(sourceUrl) {
        try {
            const url = new URL(sourceUrl);
            const match = url.pathname.match(
                /\/(20\d{6})_indexfut_oi_by_tp\.xlsx$/
            );
            return url.protocol === "https:" &&
                url.hostname === "www.jpx.co.jp" ? isoDate(match?.[1]) : null;
        } catch (_error) {
            return null;
        }
    }

    function listingUrlForYear(year) {
        return `${JPX_ORIGIN}/automation/markets/derivatives/` +
            `open-interest/json/open_interest_${year}.json`;
    }

    function parseListingManifest(listing, listingUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(listingUrl);
        } catch (_error) {
            return [];
        }
        if (
            parsedUrl.origin !== JPX_ORIGIN ||
            !/^\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_20\d{2}\.json$/.test(
                parsedUrl.pathname
            ) ||
            !Array.isArray(listing?.TableDatas)
        ) return [];

        const updatedAt = listingUpdatedAt(listing.UpdateDate);
        if (!updatedAt) return [];
        const candidates = new Map();
        for (const row of listing.TableDatas) {
            const sourceDate = isoDate(row?.TradeDate);
            if (!sourceDate || typeof row?.IndexFutures !== "string") continue;
            let sourceUrl;
            try {
                sourceUrl = new URL(row.IndexFutures, JPX_ORIGIN).href;
            } catch (_error) {
                continue;
            }
            if (parseSourceUrlDate(sourceUrl) !== sourceDate) continue;
            const key = `${sourceDate}|${sourceUrl}`;
            candidates.set(key, {
                sourceDate,
                sourceUrl,
                listingUrl: parsedUrl.href,
                listingUpdatedAt: updatedAt
            });
        }
        return [...candidates.values()].sort((left, right) =>
            left.sourceDate.localeCompare(right.sourceDate)
        );
    }

    function filterCandidates(candidates, startDate, endDate) {
        return [...(Array.isArray(candidates) ? candidates : [])]
            .filter(item => item.sourceDate >= startDate && item.sourceDate <= endDate)
            .sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
    }

    function yearsForRange(startDate, endDate) {
        const startYear = Number(String(startDate).slice(0, 4));
        const endYear = Number(String(endDate).slice(0, 4));
        if (!Number.isInteger(startYear) || !Number.isInteger(endYear) ||
            startYear > endYear) return [];
        return Array.from(
            { length: endYear - startYear + 1 },
            (_value, index) => startYear + index
        );
    }

    async function enumerateCandidates({ startDate, endDate, fetchListing }) {
        const all = [];
        const failures = [];
        for (const year of yearsForRange(startDate, endDate)) {
            const listingUrl = listingUrlForYear(year);
            try {
                const listing = await fetchListing(listingUrl);
                all.push(...parseListingManifest(listing, listingUrl));
            } catch (error) {
                failures.push({ year, listingUrl, error: error?.message || String(error) });
            }
        }
        const unique = new Map();
        for (const candidate of filterCandidates(all, startDate, endDate)) {
            unique.set(`${candidate.sourceDate}|${candidate.sourceUrl}`, candidate);
        }
        return { candidates: [...unique.values()], failures };
    }

    async function createHistoryCandidate(candidate, parsed, fetchedAt) {
        const urlDate = parseSourceUrlDate(candidate.sourceUrl);
        if (
            parsed?.excelSourceDate !== candidate.sourceDate ||
            urlDate !== candidate.sourceDate ||
            !weekly.validateWeeklyFuturesData(parsed?.data)
        ) throw new Error("date_or_schema_mismatch");
        const signature = await weekly.createSignature(parsed.data);
        if (!signature) throw new Error("signature_failed");
        return {
            sourceDate: candidate.sourceDate,
            sourceUrl: candidate.sourceUrl,
            fetchedAt,
            signature,
            versionKey: `weekly-futures-v2|${candidate.sourceDate}|sha256:${signature}`,
            data: parsed.data,
            officialMetadata: {
                origin: "jpx_open_interest_year_listing",
                listingUrl: candidate.listingUrl,
                listingUpdatedAt: candidate.listingUpdatedAt,
                tradeDate: candidate.sourceDate,
                indexFuturesUrl: candidate.sourceUrl,
                publishedDate: parsed.publishedDate || null,
                currentOfficialRefetch: true,
                dateEvidence: {
                    listingTradeDate: candidate.sourceDate,
                    excelSourceDate: parsed.excelSourceDate,
                    urlDate,
                    consistent: true
                }
            }
        };
    }

    async function runBackfill({
        history,
        candidates,
        fetchExcel,
        parseExcel,
        isCancelled = () => false,
        onProgress = () => {},
        now = () => new Date().toISOString()
    }) {
        const staged = [];
        const results = [];
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            if (isCancelled()) {
                return { status: "cancelled", history, results, stagedCount: 0 };
            }
            onProgress({ phase: "fetch", current: index + 1,
                total: candidates.length, sourceDate: candidate.sourceDate });
            try {
                const bytes = await fetchExcel(candidate.sourceUrl);
                if (isCancelled()) {
                    return { status: "cancelled", history, results, stagedCount: 0 };
                }
                onProgress({ phase: "parse", current: index + 1,
                    total: candidates.length, sourceDate: candidate.sourceDate });
                const parsed = await parseExcel(bytes, candidate);
                const fetchedAt = now();
                const historyCandidate = await createHistoryCandidate(
                    candidate, parsed, fetchedAt
                );
                staged.push(historyCandidate);
                results.push({ sourceDate: candidate.sourceDate, status: "success" });
                onProgress({ phase: "validated", current: index + 1,
                    total: candidates.length, sourceDate: candidate.sourceDate });
            } catch (error) {
                results.push({
                    sourceDate: candidate.sourceDate,
                    status: "failed",
                    error: error?.message || String(error)
                });
            }
        }
        if (isCancelled()) {
            return { status: "cancelled", history, results, stagedCount: 0 };
        }
        const confirmedAt = now();
        const merged = await historyApi.mergeCandidates(
            history, staged, confirmedAt
        );
        if (merged.outcome !== "merged") {
            return { status: "staging_failed", history, results, merged };
        }
        return {
            status: results.some(result => result.status === "failed")
                ? "partial" : "success",
            history: merged.history,
            results,
            stagedCount: staged.length,
            merged
        };
    }

    async function commitHistory(storage, storageKey, history) {
        if (!(await historyApi.validateHistory(history))) {
            return { saved: false, reason: "invalid_history" };
        }
        try {
            storage.setItem(storageKey, JSON.stringify(history));
            return { saved: true };
        } catch (error) {
            return { saved: false, reason: "storage_failed",
                error: error?.message || String(error) };
        }
    }

    return Object.freeze({
        listingUrlForYear,
        parseSourceUrlDate,
        parseListingManifest,
        filterCandidates,
        yearsForRange,
        enumerateCandidates,
        createHistoryCandidate,
        runBackfill,
        commitHistory
    });
});
