(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const weekly = commonJs
        ? require("./weeklyFutures.js")
        : root.OptionMapWeeklyFutures;
    const api = factory(weekly);

    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (weekly) {
    "use strict";

    const HISTORY_VERSION = 1;
    const HISTORY_SOURCE = "jpx-weekly-index-futures-open-interest-history";
    const SIGNATURE_ALGORITHM = "sha256";
    const MAX_ENTRIES = 52;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isIsoDate(value) {
        if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === value;
    }

    function isIsoDateTime(value) {
        return typeof value === "string" &&
            /^20\d{2}-\d{2}-\d{2}T/.test(value) &&
            !Number.isNaN(new Date(value).getTime());
    }

    function createEmptyHistory() {
        return {
            version: HISTORY_VERSION,
            parserVersion: weekly.PARSER_VERSION,
            schemaVersion: weekly.SCHEMA_VERSION,
            brokerSetVersion: weekly.BROKER_SET_VERSION,
            scoringVersion: weekly.SCORING_VERSION,
            source: HISTORY_SOURCE,
            maxEntries: MAX_ENTRIES,
            entries: []
        };
    }

    function normalizeHistory(history) {
        if (!isPlainObject(history)) return history;
        const normalized = clone(history);
        if (Array.isArray(normalized.entries)) {
            normalized.entries.sort((left, right) =>
                String(left?.sourceDate || "").localeCompare(
                    String(right?.sourceDate || "")
                )
            );
        }
        return normalized;
    }

    function isOfficialMetadata(metadata, sourceDate, sourceUrl) {
        return Boolean(
            isPlainObject(metadata) &&
            metadata.origin === "jpx_open_interest_year_listing" &&
            typeof metadata.listingUrl === "string" &&
            /^https:\/\/www\.jpx\.co\.jp\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_20\d{2}\.json$/.test(
                metadata.listingUrl
            ) &&
            isIsoDateTime(metadata.listingUpdatedAt) &&
            metadata.tradeDate === sourceDate &&
            metadata.indexFuturesUrl === sourceUrl &&
            isPlainObject(metadata.dateEvidence) &&
            metadata.dateEvidence.consistent === true &&
            metadata.dateEvidence.listingTradeDate === sourceDate &&
            metadata.dateEvidence.excelSourceDate === sourceDate &&
            metadata.dateEvidence.urlDate === sourceDate
        );
    }

    async function validateRevision(revision, sourceDate) {
        if (
            !isPlainObject(revision) ||
            typeof revision.versionKey !== "string" ||
            revision.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^[0-9a-f]{64}$/.test(revision.signature || "") ||
            typeof revision.sourceUrl !== "string" ||
            !isIsoDateTime(revision.fetchedAt) ||
            !isIsoDateTime(revision.confirmedAt) ||
            !(revision.replacedAt === null || isIsoDateTime(revision.replacedAt)) ||
            !weekly.hydrateCanonicalData(revision.data) ||
            !isOfficialMetadata(
                revision.officialMetadata,
                sourceDate,
                revision.sourceUrl
            )
        ) {
            return false;
        }

        const hydrated = weekly.hydrateCanonicalData(revision.data);
        const signature = await weekly.createSignature(hydrated);
        const versionKey =
            `weekly-futures-v2|${sourceDate}|sha256:${signature}`;
        return signature === revision.signature &&
            revision.versionKey === versionKey;
    }

    async function validateHistory(history) {
        if (
            !isPlainObject(history) ||
            history.version !== HISTORY_VERSION ||
            history.parserVersion !== weekly.PARSER_VERSION ||
            history.schemaVersion !== weekly.SCHEMA_VERSION ||
            history.brokerSetVersion !== weekly.BROKER_SET_VERSION ||
            history.scoringVersion !== weekly.SCORING_VERSION ||
            history.source !== HISTORY_SOURCE ||
            history.maxEntries !== MAX_ENTRIES ||
            !Array.isArray(history.entries) ||
            history.entries.length > MAX_ENTRIES
        ) return false;

        let previousDate = null;
        const dates = new Set();
        for (const entry of history.entries) {
            if (
                !isPlainObject(entry) || !isIsoDate(entry.sourceDate) ||
                dates.has(entry.sourceDate) ||
                (previousDate && entry.sourceDate <= previousDate) ||
                typeof entry.activeVersionKey !== "string" ||
                !isIsoDateTime(entry.firstSeenAt) ||
                !isIsoDateTime(entry.lastSeenAt) ||
                new Date(entry.lastSeenAt) < new Date(entry.firstSeenAt) ||
                !Array.isArray(entry.revisions) || entry.revisions.length === 0
            ) return false;

            dates.add(entry.sourceDate);
            previousDate = entry.sourceDate;
            const revisionKeys = new Set();
            let activeCount = 0;
            for (const revision of entry.revisions) {
                if (
                    revisionKeys.has(revision?.versionKey) ||
                    !(await validateRevision(revision, entry.sourceDate))
                ) return false;
                revisionKeys.add(revision.versionKey);
                if (revision.versionKey === entry.activeVersionKey) {
                    if (revision.replacedAt !== null) return false;
                    activeCount += 1;
                } else if (revision.replacedAt === null) {
                    return false;
                }
            }
            if (activeCount !== 1) return false;
        }
        return true;
    }

    async function parseHistory(serialized) {
        if (serialized === null || serialized === undefined || serialized === "") {
            return { status: "empty", history: createEmptyHistory() };
        }
        try {
            const history = normalizeHistory(JSON.parse(serialized));
            return await validateHistory(history)
                ? { status: history.entries.length ? "ready" : "empty", history }
                : { status: "invalid", history: null };
        } catch (_error) {
            return { status: "invalid", history: null };
        }
    }

    function createRevision(candidate, confirmedAt) {
        return {
            versionKey: candidate.versionKey,
            signature: candidate.signature,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            sourceUrl: candidate.sourceUrl,
            fetchedAt: candidate.fetchedAt,
            confirmedAt,
            replacedAt: null,
            data: weekly.toCanonicalData(candidate.data),
            officialMetadata: clone(candidate.officialMetadata)
        };
    }

    async function mergeCandidates(history, candidates, confirmedAt) {
        const normalized = normalizeHistory(history);
        if (!(await validateHistory(normalized)) || !isIsoDateTime(confirmedAt)) {
            return { changed: false, outcome: "invalid_history", history: normalized };
        }

        const next = clone(normalized);
        let added = 0;
        let revised = 0;
        let repeated = 0;
        const ordered = [...(Array.isArray(candidates) ? candidates : [])]
            .sort((left, right) => String(left?.sourceDate || "")
                .localeCompare(String(right?.sourceDate || "")));

        for (const candidate of ordered) {
            const candidateRevision = createRevision(candidate, confirmedAt);
            if (!(await validateRevision(candidateRevision, candidate.sourceDate))) {
                return { changed: false, outcome: "invalid_candidate", history: normalized };
            }
            let entry = next.entries.find(item =>
                item.sourceDate === candidate.sourceDate
            );
            if (!entry) {
                next.entries.push({
                    sourceDate: candidate.sourceDate,
                    activeVersionKey: candidate.versionKey,
                    firstSeenAt: confirmedAt,
                    lastSeenAt: confirmedAt,
                    revisions: [candidateRevision]
                });
                added += 1;
                continue;
            }
            const duplicate = entry.revisions.find(revision =>
                revision.versionKey === candidate.versionKey
            );
            if (duplicate) {
                if (entry.activeVersionKey !== duplicate.versionKey) {
                    return { changed: false, outcome: "inactive_duplicate", history: normalized };
                }
                entry.lastSeenAt = confirmedAt;
                repeated += 1;
                continue;
            }

            const active = entry.revisions.find(revision =>
                revision.versionKey === entry.activeVersionKey
            );
            if (!active || !candidate.officialMetadata?.currentOfficialRefetch) {
                return { changed: false, outcome: "unconfirmed_revision", history: normalized };
            }
            active.replacedAt = confirmedAt;
            entry.revisions.push(candidateRevision);
            entry.activeVersionKey = candidate.versionKey;
            entry.lastSeenAt = confirmedAt;
            revised += 1;
        }

        next.entries.sort((left, right) =>
            left.sourceDate.localeCompare(right.sourceDate)
        );
        while (next.entries.length > MAX_ENTRIES) next.entries.shift();
        if (!(await validateHistory(next))) {
            return { changed: false, outcome: "validation_failed", history: normalized };
        }
        return {
            changed: added > 0 || revised > 0 || repeated > 0,
            outcome: "merged",
            history: next,
            added,
            revised,
            repeated
        };
    }

    function summarizeHistory(history) {
        const entries = Array.isArray(history?.entries) ? history.entries : [];
        return {
            entryCount: entries.length,
            revisionCount: entries.reduce(
                (sum, entry) => sum + (entry.revisions?.length || 0), 0
            ),
            earliestSourceDate: entries[0]?.sourceDate || null,
            latestSourceDate: entries.at(-1)?.sourceDate || null,
            serializedBytes: new TextEncoder().encode(JSON.stringify(history)).length
        };
    }

    return Object.freeze({
        HISTORY_VERSION,
        HISTORY_SOURCE,
        SIGNATURE_ALGORITHM,
        MAX_ENTRIES,
        createEmptyHistory,
        normalizeHistory,
        validateRevision,
        validateHistory,
        parseHistory,
        mergeCandidates,
        summarizeHistory
    });
});
