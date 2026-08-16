(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const participant = commonJs
        ? require("../../participantData.js")
        : root.OptionMapParticipantData;
    const historyApi = commonJs
        ? require("../../participantHistory.js")
        : root.OptionMapParticipantHistory;
    const api = factory(participant, historyApi);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapParticipantBackfill = api;
})(typeof window !== "undefined" ? window : globalThis, function (
    participant,
    historyApi
) {
    "use strict";

    const JPX_ORIGIN = "https://www.jpx.co.jp";
    const MONTH_LIST_URL = `${JPX_ORIGIN}/automation/markets/derivatives/` +
        "participant-volume/json/participant-volume_monthlylist.json";
    const FIELD_BY_FILE_KEY = Object.freeze({
        dayAuction: "WholeDay",
        dayJnet: "WholeDayJNet",
        nightAuction: "Night",
        nightJnet: "NightJNet"
    });

    function isoDate(compact) {
        return participant.normalizeSourceDate(String(compact || ""));
    }

    function isMonth(value) {
        if (!/^20\d{4}$/.test(String(value || ""))) return false;
        const month = Number(String(value).slice(4));
        return month >= 1 && month <= 12;
    }

    function listingUpdatedAt(value) {
        const match = String(value || "").match(
            /^(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/
        );
        return match
            ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`
            : null;
    }

    function monthListingUrl(month) {
        return isMonth(month)
            ? `${JPX_ORIGIN}/automation/markets/derivatives/participant-volume/` +
                `json/participant_volume_${month}.json`
            : null;
    }

    function parseMonthList(listing) {
        if (!Array.isArray(listing?.TableDatas) || !listingUpdatedAt(listing.UpdateDate)) {
            return [];
        }
        return [...new Set(listing.TableDatas
            .map(row => String(row?.Month || ""))
            .filter(isMonth))].sort();
    }

    function monthsInRange(startDate, endDate) {
        if (!isoDate(startDate) || !isoDate(endDate) || startDate > endDate) return [];
        const months = [];
        let year = Number(startDate.slice(0, 4));
        let month = Number(startDate.slice(5, 7));
        const end = Number(endDate.slice(0, 4)) * 12 + Number(endDate.slice(5, 7));
        while (year * 12 + month <= end) {
            months.push(`${year}${String(month).padStart(2, "0")}`);
            month += 1;
            if (month === 13) {
                year += 1;
                month = 1;
            }
        }
        return months;
    }

    function parseSourceUrlDate(sourceUrl, fileKey) {
        try {
            const url = new URL(sourceUrl, JPX_ORIGIN);
            const match = url.pathname.match(/\/(20\d{6})_volume_by_participant_[^/]+\.xlsx$/);
            const sourceDate = isoDate(match?.[1]);
            return url.protocol === "https:" &&
                url.hostname === "www.jpx.co.jp" &&
                sourceDate &&
                url.pathname.endsWith(
                    `/${sourceDate.replaceAll("-", "")}_${{
                        dayAuction: "volume_by_participant_whole_day.xlsx",
                        dayJnet: "volume_by_participant_whole_day_J-NET.xlsx",
                        nightAuction: "volume_by_participant_night.xlsx",
                        nightJnet: "volume_by_participant_night_J-NET.xlsx"
                    }[fileKey]}`
                ) ? sourceDate : null;
        } catch (_error) {
            return null;
        }
    }

    function parseMonthlyManifest(listing, listingUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(listingUrl);
        } catch (_error) {
            return [];
        }
        const monthMatch = parsedUrl.pathname.match(
            /^\/automation\/markets\/derivatives\/participant-volume\/json\/participant_volume_(20\d{4})\.json$/
        );
        const updatedAt = listingUpdatedAt(listing?.UpdateDate);
        if (
            parsedUrl.origin !== JPX_ORIGIN || !monthMatch || !updatedAt ||
            !Array.isArray(listing?.TableDatas)
        ) return [];

        const candidates = [];
        for (const row of listing.TableDatas) {
            const sourceDate = isoDate(row?.TradeDate);
            if (!sourceDate || sourceDate.replaceAll("-", "").slice(0, 6) !== monthMatch[1]) {
                continue;
            }
            const sourceUrls = {};
            let complete = true;
            for (const fileKey of participant.FILE_KEYS) {
                const value = row?.[FIELD_BY_FILE_KEY[fileKey]];
                if (typeof value !== "string" || value === "-") {
                    complete = false;
                    continue;
                }
                let sourceUrl;
                try {
                    sourceUrl = new URL(value, JPX_ORIGIN).href;
                } catch (_error) {
                    complete = false;
                    continue;
                }
                if (parseSourceUrlDate(sourceUrl, fileKey) !== sourceDate) {
                    complete = false;
                    continue;
                }
                sourceUrls[fileKey] = sourceUrl;
            }
            if (!complete || participant.FILE_KEYS.some(key => !sourceUrls[key])) continue;
            candidates.push({
                sourceDate,
                sourceUrls,
                listingUrl: parsedUrl.href,
                listingUpdatedAt: updatedAt,
                listingTradeDate: sourceDate
            });
        }
        const unique = new Map(candidates.map(candidate => [
            `${candidate.sourceDate}|${participant.FILE_KEYS
                .map(key => candidate.sourceUrls[key]).join("|")}`,
            candidate
        ]));
        return [...unique.values()].sort((left, right) =>
            left.sourceDate.localeCompare(right.sourceDate)
        );
    }

    async function enumerateCandidates({ startDate, endDate, fetchJson }) {
        if (typeof fetchJson !== "function" || !isoDate(startDate) ||
            !isoDate(endDate) || startDate > endDate) {
            throw new Error("invalid_range_or_fetcher");
        }
        const master = await fetchJson(MONTH_LIST_URL);
        const requestedMonths = monthsInRange(startDate, endDate);
        const officialMonths = new Set(parseMonthList(master));
        const months = requestedMonths.filter(month => officialMonths.has(month));
        const candidates = [];
        const failures = [];
        for (const month of months) {
            const listingUrl = monthListingUrl(month);
            try {
                const listing = await fetchJson(listingUrl);
                candidates.push(...parseMonthlyManifest(listing, listingUrl));
            } catch (error) {
                failures.push({ month, listingUrl, error: error?.message || String(error) });
            }
        }
        const filtered = candidates.filter(candidate =>
            candidate.sourceDate >= startDate && candidate.sourceDate <= endDate
        );
        return {
            candidates: filtered,
            failures,
            listedMonths: months,
            unavailableMonths: requestedMonths.filter(month => !officialMonths.has(month))
        };
    }

    function previewImpact(history, candidates) {
        const existingDates = new Set(
            Array.isArray(history?.entries)
                ? history.entries.map(entry => entry.sourceDate)
                : []
        );
        const candidateDates = new Set(
            (Array.isArray(candidates) ? candidates : [])
                .map(candidate => candidate.sourceDate)
        );
        const combinedDates = new Set([...existingDates, ...candidateDates]);
        const projectedBeforePrune = combinedDates.size;
        return {
            officialCandidateCount: candidateDates.size,
            estimatedFileCount: candidateDates.size * participant.FILE_KEYS.length,
            potentialNewDateCount: [...candidateDates]
                .filter(date => !existingDates.has(date)).length,
            projectedBeforePrune,
            projectedSavedCount: Math.min(historyApi.MAX_ENTRIES, projectedBeforePrune),
            projectedPruneCount: Math.max(0,
                projectedBeforePrune - historyApi.MAX_ENTRIES)
        };
    }

    async function buildHistoryCandidate(candidate, parsedFiles, fetchedAt) {
        const excelSourceDates = participant.FILE_KEYS.map(key =>
            parsedFiles?.[key]?.sourceDate || null
        );
        const excelDateKinds = participant.FILE_KEYS.map(key =>
            parsedFiles?.[key]?.sourceDateKind || null
        );
        const urlDates = participant.FILE_KEYS.map(key =>
            parseSourceUrlDate(candidate?.sourceUrls?.[key], key)
        );
        if (
            candidate?.listingTradeDate !== candidate?.sourceDate ||
            excelDateKinds.some(kind => kind !== "excel") ||
            excelSourceDates.some(date => date !== candidate.sourceDate) ||
            urlDates.some(date => date !== candidate.sourceDate)
        ) throw new Error("date_or_schema_mismatch");

        const completeSet = await participant.createCompleteCache({
            data: parsedFiles,
            sourceUrls: candidate.sourceUrls,
            sourceDate: candidate.sourceDate,
            fetchedAt
        });
        if (!completeSet || !(await participant.validateParticipantCache(completeSet))) {
            throw new Error("complete_validation_failed");
        }
        return {
            completeSet,
            officialMetadata: {
                origin: "jpx_participant_month_listing",
                listingUrl: candidate.listingUrl,
                listingUpdatedAt: candidate.listingUpdatedAt,
                listingTradeDate: candidate.sourceDate,
                sourceUrls: { ...candidate.sourceUrls },
                currentOfficialRefetch: true,
                dateEvidence: {
                    listingTradeDate: candidate.sourceDate,
                    excelSourceDates,
                    excelDateKinds,
                    urlDates,
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
            const settled = await Promise.allSettled(participant.FILE_KEYS.map(
                async fileKey => {
                    const bytes = await fetchExcel(candidate.sourceUrls[fileKey], fileKey);
                    if (isCancelled()) throw new Error("cancelled");
                    onProgress({ phase: "parse", current: index + 1,
                        total: candidates.length, sourceDate: candidate.sourceDate,
                        fileKey });
                    return parseExcel(bytes, candidate, fileKey);
                }
            ));
            if (isCancelled()) {
                return { status: "cancelled", history, results, stagedCount: 0 };
            }
            const successCount = settled.filter(item => item.status === "fulfilled").length;
            if (successCount !== participant.FILE_KEYS.length) {
                results.push({
                    sourceDate: candidate.sourceDate,
                    status: successCount > 0 ? "partial" : "failed",
                    successCount,
                    errors: settled.map((item, fileIndex) => item.status === "rejected"
                        ? { fileKey: participant.FILE_KEYS[fileIndex],
                            error: item.reason?.message || String(item.reason) }
                        : null).filter(Boolean)
                });
                continue;
            }
            try {
                const parsedFiles = Object.fromEntries(settled.map((item, fileIndex) =>
                    [participant.FILE_KEYS[fileIndex], item.value]
                ));
                const stagedCandidate = await buildHistoryCandidate(
                    candidate, parsedFiles, now()
                );
                staged.push(stagedCandidate);
                results.push({ sourceDate: candidate.sourceDate,
                    status: "success", successCount: 4 });
                onProgress({ phase: "validated", current: index + 1,
                    total: candidates.length, sourceDate: candidate.sourceDate });
            } catch (error) {
                results.push({ sourceDate: candidate.sourceDate,
                    status: "validation_failed", successCount: 4,
                    error: error?.message || String(error) });
            }
        }

        if (isCancelled()) {
            return { status: "cancelled", history, results, stagedCount: 0 };
        }
        onProgress({ phase: "staging", current: candidates.length,
            total: candidates.length, sourceDate: null });
        const merged = await historyApi.mergeOfficialCandidates(
            history, staged, now(), participant.validateParticipantCache
        );
        if (merged.outcome !== "merged") {
            return { status: "staging_failed", history, results,
                stagedCount: staged.length, merged };
        }
        return {
            status: results.every(result => result.status === "success")
                ? "success" : "partial",
            history: merged.history,
            results,
            stagedCount: staged.length,
            merged
        };
    }

    async function commitHistory(storage, storageKey, history) {
        if (!(await historyApi.validateParticipantHistory(
            history, participant.validateParticipantCache
        ))) return { saved: false, reason: "invalid_history" };
        try {
            storage.setItem(storageKey, JSON.stringify(history));
            return { saved: true };
        } catch (error) {
            return { saved: false, reason: "storage_failed",
                error: error?.message || String(error) };
        }
    }

    return Object.freeze({
        MONTH_LIST_URL,
        FIELD_BY_FILE_KEY,
        monthListingUrl,
        parseMonthList,
        monthsInRange,
        parseSourceUrlDate,
        parseMonthlyManifest,
        enumerateCandidates,
        previewImpact,
        buildHistoryCandidate,
        runBackfill,
        commitHistory
    });
});
