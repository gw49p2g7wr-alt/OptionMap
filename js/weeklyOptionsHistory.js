(function (root, factory) {
    const weeklyOptions = typeof module === "object" && module.exports
        ? require("./weeklyOptions.js")
        : root?.OptionMapWeeklyOptions;
    const api = factory(weeklyOptions);

    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (weeklyOptions) {
    "use strict";

    const HISTORY_VERSION = 1;
    const HISTORY_SOURCE = "jpx-weekly-nikkei225-options-open-interest-history";
    const SIGNATURE_ALGORITHM = "sha256";
    const VERSION_PREFIX = "weekly-options-v2";

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
        return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T/.test(value) &&
            !Number.isNaN(new Date(value).getTime());
    }

    function sourceUrlDate(value) {
        if (typeof value !== "string") return null;
        try {
            const url = new URL(value);
            const match = url.pathname.match(/\/(20\d{6})_nk225op_oi_by_tp\.xlsx$/);
            if (url.protocol !== "https:" || url.hostname !== "www.jpx.co.jp" || !match) {
                return null;
            }
            const compact = match[1];
            const result = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
            return isIsoDate(result) ? result : null;
        } catch (_error) {
            return null;
        }
    }

    function canonicalExpiry(canonical) {
        if (!weeklyOptions?.validateWeeklyOptionsData?.(canonical)) return null;
        const put = canonical.optionExpiries?.put;
        const call = canonical.optionExpiries?.call;
        return put && put === call ? put : null;
    }

    function createEmptyWeeklyOptionsHistory(retentionPolicy = {}) {
        return {
            historyVersion: HISTORY_VERSION,
            source: HISTORY_SOURCE,
            canonicalParserVersion: weeklyOptions.PARSER_VERSION,
            canonicalSchemaVersion: weeklyOptions.SCHEMA_VERSION,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            retentionPolicy: {
                configuredMaxEntries: null,
                automaticPruning: false,
                ...clone(retentionPolicy)
            },
            entries: []
        };
    }

    function validRetentionPolicy(value) {
        return isPlainObject(value) && value.automaticPruning === false &&
            (value.configuredMaxEntries === null ||
                (Number.isSafeInteger(value.configuredMaxEntries) &&
                    value.configuredMaxEntries > 0));
    }

    function validateOfficialMetadata(metadata, sourceDate, sourceUrl) {
        if (!isPlainObject(metadata)) return false;
        const evidence = metadata.dateEvidence;
        return metadata.origin === "jpx_open_interest_year_listing" &&
            typeof metadata.listingUrl === "string" &&
            /^https:\/\/www\.jpx\.co\.jp\/automation\/markets\/derivatives\/open-interest\/json\/open_interest_20\d{2}\.json$/.test(metadata.listingUrl) &&
            isIsoDateTime(metadata.listingUpdatedAt) &&
            metadata.tradeDate === sourceDate &&
            metadata.indexOptionsUrl === sourceUrl &&
            isPlainObject(evidence) && evidence.consistent === true &&
            evidence.excelAsOf === sourceDate &&
            evidence.listingTradeDate === sourceDate &&
            evidence.urlDate === sourceDate;
    }

    async function validateRevision(revision, sourceDate) {
        const errors = [];
        if (!isPlainObject(revision)) {
            return { valid: false, errors: ["revision_not_object"] };
        }
        if (revision.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
            errors.push("signature_algorithm_invalid");
        }
        if (!/^[0-9a-f]{64}$/.test(revision.signature || "")) {
            errors.push("signature_format_invalid");
        }
        if (revision.parserVersion !== weeklyOptions.PARSER_VERSION) {
            errors.push("parser_version_invalid");
        }
        if (revision.schemaVersion !== weeklyOptions.SCHEMA_VERSION) {
            errors.push("schema_version_invalid");
        }
        if (!isIsoDateTime(revision.fetchedAt)) errors.push("fetched_at_invalid");
        if (!isIsoDateTime(revision.confirmedAt)) errors.push("confirmed_at_invalid");
        if (!(revision.replacedAt === null || isIsoDateTime(revision.replacedAt))) {
            errors.push("replaced_at_invalid");
        }
        if (sourceUrlDate(revision.sourceUrl) !== sourceDate) {
            errors.push("source_url_date_mismatch");
        }
        if (!validateOfficialMetadata(
            revision.officialMetadata, sourceDate, revision.sourceUrl
        )) errors.push("official_metadata_invalid");
        if (!weeklyOptions?.validateWeeklyOptionsData?.(revision.canonical)) {
            errors.push("canonical_invalid");
        } else {
            if (revision.canonical.sourceDate !== sourceDate) {
                errors.push("canonical_source_date_mismatch");
            }
            if (!canonicalExpiry(revision.canonical)) {
                errors.push("canonical_expiry_mismatch");
            }
            const signature = await weeklyOptions.createSignature(revision.canonical);
            if (signature !== revision.signature) errors.push("signature_mismatch");
            if (revision.versionKey !==
                `${VERSION_PREFIX}|${sourceDate}|sha256:${signature}`) {
                errors.push("version_key_mismatch");
            }
        }
        return { valid: errors.length === 0, errors };
    }

    async function validateEntry(entry, index) {
        const errors = [];
        const validRevisions = [];
        const invalidRevisions = [];
        if (!isPlainObject(entry)) {
            return {
                valid: false, index, sourceDate: null,
                errors: ["entry_not_object"], validRevisions, invalidRevisions,
                activeRevisionStatus: "missing", recoveryRequired: true
            };
        }
        if (!isIsoDate(entry.sourceDate)) errors.push("source_date_invalid");
        if (!Array.isArray(entry.expiries) || entry.expiries.length !== 1 ||
            !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(entry.expiries[0] || "")) {
            errors.push("expiries_invalid");
        }
        if (typeof entry.activeVersionKey !== "string") {
            errors.push("active_version_key_invalid");
        }
        if (!isIsoDateTime(entry.firstSeenAt)) errors.push("first_seen_at_invalid");
        if (!isIsoDateTime(entry.lastSeenAt) ||
            (isIsoDateTime(entry.firstSeenAt) &&
                new Date(entry.lastSeenAt) < new Date(entry.firstSeenAt))) {
            errors.push("last_seen_at_invalid");
        }
        if (!Array.isArray(entry.revisions) || entry.revisions.length === 0) {
            errors.push("revisions_invalid");
        } else {
            const keys = new Set();
            for (let revisionIndex = 0; revisionIndex < entry.revisions.length;
                revisionIndex += 1) {
                const revision = entry.revisions[revisionIndex];
                const result = await validateRevision(revision, entry.sourceDate);
                if (keys.has(revision?.versionKey)) result.errors.push("duplicate_version_key");
                keys.add(revision?.versionKey);
                result.valid = result.errors.length === 0;
                const detail = {
                    index: revisionIndex,
                    versionKey: revision?.versionKey || null,
                    errors: result.errors
                };
                (result.valid ? validRevisions : invalidRevisions).push(detail);
            }
        }
        const activeIndex = entry.revisions?.findIndex(revision =>
            revision?.versionKey === entry.activeVersionKey
        ) ?? -1;
        const activeIsValid = activeIndex >= 0 && validRevisions.some(revision =>
            revision.index === activeIndex
        );
        const activeRevisionStatus = activeIndex < 0
            ? "missing" : activeIsValid ? "valid" : "invalid";
        if (!activeIsValid) errors.push("active_revision_invalid");
        if (activeIsValid && entry.revisions[activeIndex].replacedAt !== null) {
            errors.push("active_revision_replaced");
        }
        for (let revisionIndex = 0; revisionIndex < (entry.revisions?.length || 0);
            revisionIndex += 1) {
            if (revisionIndex !== activeIndex &&
                validRevisions.some(item => item.index === revisionIndex) &&
                entry.revisions[revisionIndex].replacedAt === null) {
                errors.push("inactive_revision_not_replaced");
            }
        }
        if (activeIsValid && canonicalExpiry(entry.revisions[activeIndex].canonical) !==
            entry.expiries[0]) errors.push("entry_expiry_mismatch");
        return {
            valid: errors.length === 0 && invalidRevisions.length === 0,
            index,
            sourceDate: entry.sourceDate || null,
            errors,
            validRevisions,
            invalidRevisions,
            activeRevisionStatus,
            recoveryRequired: activeRevisionStatus !== "valid"
        };
    }

    async function validateWeeklyOptionsHistory(history) {
        const topLevelErrors = [];
        const validEntries = [];
        const invalidEntries = [];
        if (!isPlainObject(history)) {
            return {
                valid: false, topLevelErrors: ["history_not_object"],
                validEntries, invalidEntries, recoveryRequired: false
            };
        }
        if (history.historyVersion !== HISTORY_VERSION) topLevelErrors.push("history_version_invalid");
        if (history.source !== HISTORY_SOURCE) topLevelErrors.push("source_invalid");
        if (history.canonicalParserVersion !== weeklyOptions.PARSER_VERSION) {
            topLevelErrors.push("canonical_parser_version_invalid");
        }
        if (history.canonicalSchemaVersion !== weeklyOptions.SCHEMA_VERSION) {
            topLevelErrors.push("canonical_schema_version_invalid");
        }
        if (history.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
            topLevelErrors.push("signature_algorithm_invalid");
        }
        if (!validRetentionPolicy(history.retentionPolicy)) {
            topLevelErrors.push("retention_policy_invalid");
        }
        if (!Array.isArray(history.entries)) {
            topLevelErrors.push("entries_invalid");
        } else {
            const dates = new Set();
            let previousDate = null;
            for (let index = 0; index < history.entries.length; index += 1) {
                const detail = await validateEntry(history.entries[index], index);
                if (dates.has(detail.sourceDate)) detail.errors.push("duplicate_source_date");
                if (previousDate && detail.sourceDate <= previousDate) {
                    detail.errors.push("source_date_order_invalid");
                }
                detail.valid = detail.errors.length === 0 &&
                    detail.invalidRevisions.length === 0;
                dates.add(detail.sourceDate);
                previousDate = detail.sourceDate;
                (detail.valid ? validEntries : invalidEntries).push(detail);
            }
        }
        return {
            valid: topLevelErrors.length === 0 && invalidEntries.length === 0,
            topLevelErrors,
            validEntries,
            invalidEntries,
            validRevisionCount: [...validEntries, ...invalidEntries]
                .reduce((sum, entry) => sum + entry.validRevisions.length, 0),
            invalidRevisionCount: [...validEntries, ...invalidEntries]
                .reduce((sum, entry) => sum + entry.invalidRevisions.length, 0),
            recoveryRequired: invalidEntries.some(entry => entry.recoveryRequired)
        };
    }

    async function createWeeklyOptionsHistoryCandidate(cache) {
        if (!isPlainObject(cache) || cache.version !== weeklyOptions.CACHE_VERSION) {
            return { ok: false, reason: "unsupported_cache_version", candidate: null };
        }
        if (cache.parserVersion !== weeklyOptions.PARSER_VERSION ||
            cache.schemaVersion !== weeklyOptions.SCHEMA_VERSION) {
            return { ok: false, reason: "canonical_version_mismatch", candidate: null };
        }
        if (
            cache.source !== "jpx-weekly-nikkei225-options-open-interest" ||
            cache.sourceDateKind !== "jpx_open_interest_as_of" ||
            cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            cache.versionAssessment !== "confirmed" ||
            !isIsoDateTime(cache.fetchedAt)
        ) {
            return { ok: false, reason: "invalid_formal_cache", candidate: null };
        }
        if (!(await weeklyOptions.validateVersionedCacheData(cache)) ||
            !canonicalExpiry(cache.data)) {
            return { ok: false, reason: "invalid_canonical_cache", candidate: null };
        }
        const officialMetadata = {
            origin: "jpx_open_interest_year_listing",
            listingUrl: cache.listingUrl,
            listingUpdatedAt: cache.listingUpdatedAt,
            tradeDate: cache.dateEvidence?.listingTradeDate,
            indexOptionsUrl: cache.sourceUrl,
            currentOfficialRefetch: cache.currentOfficialRefetch === true,
            dateEvidence: clone(cache.dateEvidence)
        };
        if (cache.sourceDate !== cache.data.sourceDate ||
            sourceUrlDate(cache.sourceUrl) !== cache.sourceDate ||
            !validateOfficialMetadata(officialMetadata, cache.sourceDate, cache.sourceUrl)) {
            return { ok: false, reason: "date_evidence_invalid", candidate: null };
        }
        return {
            ok: true,
            reason: null,
            candidate: {
                sourceDate: cache.sourceDate,
                expiries: [canonicalExpiry(cache.data)],
                versionKey: cache.versionKey,
                signature: cache.signature,
                signatureAlgorithm: SIGNATURE_ALGORITHM,
                parserVersion: cache.parserVersion,
                schemaVersion: cache.schemaVersion,
                sourceUrl: cache.sourceUrl,
                fetchedAt: cache.fetchedAt,
                officialMetadata,
                canonical: clone(cache.data)
            }
        };
    }

    function normalizeHistory(history) {
        const result = clone(history);
        if (Array.isArray(result?.entries)) {
            result.entries.sort((left, right) =>
                String(left?.sourceDate || "").localeCompare(String(right?.sourceDate || ""))
            );
        }
        return result;
    }

    function createRevision(candidate, confirmedAt) {
        return {
            versionKey: candidate.versionKey,
            signature: candidate.signature,
            signatureAlgorithm: candidate.signatureAlgorithm,
            parserVersion: candidate.parserVersion,
            schemaVersion: candidate.schemaVersion,
            sourceUrl: candidate.sourceUrl,
            fetchedAt: candidate.fetchedAt,
            confirmedAt,
            replacedAt: null,
            officialMetadata: clone(candidate.officialMetadata),
            canonical: clone(candidate.canonical)
        };
    }

    async function mergeWeeklyOptionsHistory(history, candidate, options = {}) {
        const original = clone(history);
        const normalized = normalizeHistory(history);
        const validation = await validateWeeklyOptionsHistory(normalized);
        const confirmedAt = options.confirmedAt;
        if (!validation.valid || !isIsoDateTime(confirmedAt)) {
            return { changed: false, outcome: "invalid_history", history: original };
        }
        const candidateRevision = isPlainObject(candidate)
            ? createRevision(candidate, confirmedAt) : null;
        const revisionValidation = await validateRevision(
            candidateRevision, candidate?.sourceDate
        );
        if (!revisionValidation.valid || !Array.isArray(candidate?.expiries) ||
            candidate.expiries.length !== 1 ||
            candidate.expiries[0] !== canonicalExpiry(candidate.canonical)) {
            return { changed: false, outcome: "invalid_candidate", history: original };
        }
        const next = clone(normalized);
        let entry = next.entries.find(item => item.sourceDate === candidate.sourceDate);
        if (!entry) {
            next.entries.push({
                sourceDate: candidate.sourceDate,
                expiries: clone(candidate.expiries),
                activeVersionKey: candidate.versionKey,
                firstSeenAt: confirmedAt,
                lastSeenAt: confirmedAt,
                revisions: [candidateRevision]
            });
            next.entries.sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
            return { changed: true, outcome: "added", history: next };
        }
        if (entry.activeVersionKey === candidate.versionKey) {
            entry.lastSeenAt = confirmedAt;
            return { changed: true, outcome: "same_version", history: next };
        }
        if (!candidate.officialMetadata.currentOfficialRefetch) {
            return { changed: false, outcome: "unconfirmed_revision", history: original };
        }
        const active = entry.revisions.find(revision =>
            revision.versionKey === entry.activeVersionKey
        );
        if (!active) {
            return { changed: false, outcome: "recovery_required", history: original };
        }
        active.replacedAt = confirmedAt;
        entry.revisions.push(candidateRevision);
        entry.activeVersionKey = candidate.versionKey;
        entry.expiries = clone(candidate.expiries);
        entry.lastSeenAt = confirmedAt;
        const resultValidation = await validateWeeklyOptionsHistory(next);
        return resultValidation.valid
            ? { changed: true, outcome: "revised", history: next }
            : { changed: false, outcome: "validation_failed", history: original };
    }

    async function getActiveWeeklyOptionsRevision(history, sourceDate) {
        const entry = history?.entries?.find(item => item?.sourceDate === sourceDate);
        if (!entry) return { status: "unavailable", reason: "entry_not_found", revision: null };
        const active = entry.revisions?.find(revision =>
            revision?.versionKey === entry.activeVersionKey
        );
        if (!active) return { status: "recovery_required", reason: "active_revision_missing", revision: null };
        const result = await validateRevision(active, sourceDate);
        return result.valid
            ? { status: "available", reason: null, revision: clone(active) }
            : { status: "recovery_required", reason: "active_revision_invalid", revision: null, errors: result.errors };
    }

    async function getLatestActiveWeeklyOptionsRevision(history) {
        const dates = (history?.entries || []).map(entry => entry?.sourceDate)
            .filter(isIsoDate).sort().reverse();
        for (const sourceDate of dates) {
            const result = await getActiveWeeklyOptionsRevision(history, sourceDate);
            if (result.status === "available") return { ...result, sourceDate };
            if (result.status === "recovery_required") return { ...result, sourceDate };
        }
        return { status: "unavailable", reason: "history_empty", revision: null };
    }

    async function findPreviousWeeklyOptionsRevision(history, currentSourceDate) {
        const current = await getActiveWeeklyOptionsRevision(history, currentSourceDate);
        if (current.status !== "available") {
            return { status: current.status, previousCalendar: null, previousSameExpiry: null };
        }
        const currentExpiry = canonicalExpiry(current.revision.canonical);
        const dates = (history?.entries || []).map(entry => entry?.sourceDate)
            .filter(date => isIsoDate(date) && date < currentSourceDate).sort().reverse();
        let previousCalendar = null;
        let previousSameExpiry = null;
        for (const sourceDate of dates) {
            const result = await getActiveWeeklyOptionsRevision(history, sourceDate);
            if (result.status !== "available") continue;
            const value = { sourceDate, revision: result.revision };
            if (!previousCalendar) previousCalendar = value;
            if (!previousSameExpiry &&
                canonicalExpiry(result.revision.canonical) === currentExpiry) {
                previousSameExpiry = value;
            }
        }
        return {
            status: previousCalendar ? "available" : "unavailable",
            currentSourceDate,
            currentExpiry,
            previousCalendar,
            previousSameExpiry
        };
    }

    function classifyWeeklyOptionsComparison(previous, current) {
        const previousCanonical = previous?.canonical || previous;
        const currentCanonical = current?.canonical || current;
        if (!weeklyOptions?.validateWeeklyOptionsData?.(previousCanonical) ||
            !weeklyOptions?.validateWeeklyOptionsData?.(currentCanonical) ||
            previousCanonical.sourceDate >= currentCanonical.sourceDate) {
            return { status: "unavailable", sameExpiry: null, reason: "invalid_comparison" };
        }
        const previousExpiry = canonicalExpiry(previousCanonical);
        const currentExpiry = canonicalExpiry(currentCanonical);
        if (!previousExpiry || !currentExpiry) {
            return { status: "unavailable", sameExpiry: null, reason: "internal_expiry_mismatch" };
        }
        return previousExpiry === currentExpiry
            ? { status: "same_expiry", sameExpiry: true, previousExpiry, currentExpiry }
            : { status: "roll_transition", sameExpiry: false, previousExpiry, currentExpiry };
    }

    return Object.freeze({
        HISTORY_VERSION,
        HISTORY_SOURCE,
        SIGNATURE_ALGORITHM,
        createEmptyWeeklyOptionsHistory,
        validateWeeklyOptionsHistory,
        createWeeklyOptionsHistoryCandidate,
        mergeWeeklyOptionsHistory,
        getActiveWeeklyOptionsRevision,
        getLatestActiveWeeklyOptionsRevision,
        findPreviousWeeklyOptionsRevision,
        classifyWeeklyOptionsComparison
    });
});
