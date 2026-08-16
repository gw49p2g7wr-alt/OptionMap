(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.OptionMapParticipantHistory = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const HISTORY_VERSION = 1;
    const PARSER_VERSION = 1;
    const HISTORY_SOURCE = "jpx-daily-participant-volume-history";
    const MAX_ENTRIES = 30;
    const SIGNATURE_ALGORITHM = "sha256";
    const ALLOWED_ASSESSMENTS = new Set([
        "same_version",
        "new_version",
        "revised_same_date"
    ]);

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

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function createEmptyHistory() {
        return {
            version: HISTORY_VERSION,
            parserVersion: PARSER_VERSION,
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

    async function validateParticipantHistory(
        history,
        validateCompleteSet
    ) {
        if (
            !isPlainObject(history) ||
            history.version !== HISTORY_VERSION ||
            history.parserVersion !== PARSER_VERSION ||
            history.source !== HISTORY_SOURCE ||
            history.maxEntries !== MAX_ENTRIES ||
            !Array.isArray(history.entries) ||
            history.entries.length > history.maxEntries ||
            typeof validateCompleteSet !== "function"
        ) {
            return false;
        }

        const sourceDates = new Set();
        let previousSourceDate = null;

        for (const entry of history.entries) {
            if (
                !isPlainObject(entry) ||
                !isIsoDate(entry.sourceDate) ||
                sourceDates.has(entry.sourceDate) ||
                (previousSourceDate && entry.sourceDate <= previousSourceDate) ||
                typeof entry.activeVersionKey !== "string" ||
                !isIsoDateTime(entry.firstSeenAt) ||
                !isIsoDateTime(entry.lastSeenAt) ||
                new Date(entry.lastSeenAt) < new Date(entry.firstSeenAt) ||
                !Array.isArray(entry.revisions) ||
                entry.revisions.length === 0
            ) {
                return false;
            }

            sourceDates.add(entry.sourceDate);
            previousSourceDate = entry.sourceDate;
            const revisionKeys = new Set();
            let activeRevisionCount = 0;

            for (const revision of entry.revisions) {
                if (
                    !isPlainObject(revision) ||
                    typeof revision.versionKey !== "string" ||
                    revisionKeys.has(revision.versionKey) ||
                    revision.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
                    typeof revision.signature !== "string" ||
                    !/^[0-9a-f]{64}$/.test(revision.signature) ||
                    !isIsoDateTime(revision.confirmedAt) ||
                    !(revision.replacedAt === null ||
                        isIsoDateTime(revision.replacedAt)) ||
                    !isPlainObject(revision.completeSet)
                ) {
                    return false;
                }

                revisionKeys.add(revision.versionKey);
                const expectedVersionKey =
                    `participant-set|${entry.sourceDate}|sha256:${revision.signature}`;
                if (
                    revision.versionKey !== expectedVersionKey ||
                    revision.completeSet.sourceDate !== entry.sourceDate ||
                    revision.completeSet.versionKey !== revision.versionKey ||
                    revision.completeSet.signature !== revision.signature ||
                    !(await validateCompleteSet(revision.completeSet))
                ) {
                    return false;
                }

                if (revision.versionKey === entry.activeVersionKey) {
                    if (revision.replacedAt !== null) return false;
                    activeRevisionCount += 1;
                } else if (revision.replacedAt === null) {
                    return false;
                }
            }

            if (activeRevisionCount !== 1) return false;
        }

        return true;
    }

    async function parseParticipantHistory(serialized, validateCompleteSet) {
        if (serialized === null || serialized === undefined || serialized === "") {
            return { status: "empty", history: createEmptyHistory() };
        }

        try {
            const history = normalizeHistory(JSON.parse(serialized));
            return await validateParticipantHistory(history, validateCompleteSet)
                ? { status: history.entries.length ? "ready" : "empty", history }
                : { status: "invalid", history: null };
        } catch (error) {
            return { status: "invalid", history: null };
        }
    }

    function createRevision(completeSet, confirmedAt) {
        return {
            versionKey: completeSet.versionKey,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            signature: completeSet.signature,
            confirmedAt,
            replacedAt: null,
            completeSet: clone(completeSet)
        };
    }

    function hasCurrentOfficialEvidence(candidate) {
        if (!isPlainObject(candidate) || !isPlainObject(candidate.officialMetadata)) {
            return false;
        }
        const metadata = candidate.officialMetadata;
        const evidence = metadata.dateEvidence;
        return metadata.origin === "jpx_participant_month_listing" &&
            metadata.currentOfficialRefetch === true &&
            isIsoDate(metadata.listingTradeDate) &&
            metadata.listingTradeDate === candidate.completeSet?.sourceDate &&
            isPlainObject(evidence) &&
            evidence.consistent === true &&
            Array.isArray(evidence.excelSourceDates) &&
            evidence.excelSourceDates.length === 4 &&
            evidence.excelSourceDates.every(date => date === metadata.listingTradeDate) &&
            Array.isArray(evidence.excelDateKinds) &&
            evidence.excelDateKinds.length === 4 &&
            evidence.excelDateKinds.every(kind => kind === "excel") &&
            Array.isArray(evidence.urlDates) &&
            evidence.urlDates.length === 4 &&
            evidence.urlDates.every(date => date === metadata.listingTradeDate);
    }

    async function mergeOfficialCandidates(
        history,
        candidates,
        confirmedAt,
        validateCompleteSet
    ) {
        const normalized = normalizeHistory(history);
        if (
            !(await validateParticipantHistory(normalized, validateCompleteSet)) ||
            !isIsoDateTime(confirmedAt) ||
            !Array.isArray(candidates)
        ) {
            return { history: normalized, changed: false, outcome: "invalid_input" };
        }

        const next = clone(normalized);
        const results = [];
        const ordered = [...candidates].sort((left, right) =>
            String(left?.completeSet?.sourceDate || "").localeCompare(
                String(right?.completeSet?.sourceDate || "")
            )
        );

        for (const candidate of ordered) {
            const completeSet = candidate?.completeSet;
            if (
                !hasCurrentOfficialEvidence(candidate) ||
                !(await validateCompleteSet(completeSet))
            ) {
                return {
                    history: normalized,
                    changed: false,
                    outcome: "candidate_validation_failed",
                    results
                };
            }

            let entry = next.entries.find(item =>
                item.sourceDate === completeSet.sourceDate
            );
            if (!entry) {
                next.entries.push({
                    sourceDate: completeSet.sourceDate,
                    activeVersionKey: completeSet.versionKey,
                    firstSeenAt: confirmedAt,
                    lastSeenAt: confirmedAt,
                    revisions: [createRevision(completeSet, confirmedAt)]
                });
                results.push({ sourceDate: completeSet.sourceDate, outcome: "entry_added" });
                continue;
            }

            const existing = entry.revisions.find(revision =>
                revision.versionKey === completeSet.versionKey
            );
            if (existing) {
                if (entry.activeVersionKey !== existing.versionKey) {
                    return {
                        history: normalized,
                        changed: false,
                        outcome: "inactive_version_conflict",
                        results
                    };
                }
                entry.lastSeenAt = confirmedAt;
                results.push({ sourceDate: completeSet.sourceDate, outcome: "same_version" });
                continue;
            }

            const active = entry.revisions.find(revision =>
                revision.versionKey === entry.activeVersionKey
            );
            if (!active) {
                return {
                    history: normalized,
                    changed: false,
                    outcome: "active_revision_missing",
                    results
                };
            }
            active.replacedAt = confirmedAt;
            entry.revisions.push(createRevision(completeSet, confirmedAt));
            entry.activeVersionKey = completeSet.versionKey;
            entry.lastSeenAt = confirmedAt;
            results.push({ sourceDate: completeSet.sourceDate, outcome: "revision_added" });
        }

        next.entries.sort((left, right) =>
            left.sourceDate.localeCompare(right.sourceDate)
        );
        const pruneCount = Math.max(0, next.entries.length - next.maxEntries);
        if (pruneCount > 0) next.entries.splice(0, pruneCount);

        if (!(await validateParticipantHistory(next, validateCompleteSet))) {
            return {
                history: normalized,
                changed: false,
                outcome: "history_validation_failed",
                results
            };
        }
        return {
            history: next,
            changed: results.length > 0,
            outcome: "merged",
            results,
            pruneCount
        };
    }

    async function upsertCompleteVersion(
        history,
        completeSet,
        { assessment, confirmedAt } = {},
        validateCompleteSet
    ) {
        const normalized = normalizeHistory(history);
        if (!(await validateParticipantHistory(normalized, validateCompleteSet))) {
            return { history: normalized, changed: false, outcome: "invalid_history" };
        }
        if (
            !ALLOWED_ASSESSMENTS.has(assessment) ||
            !isIsoDateTime(confirmedAt) ||
            !(await validateCompleteSet(completeSet))
        ) {
            return { history: normalized, changed: false, outcome: "rejected" };
        }

        const next = clone(normalized);
        let entry = next.entries.find(item =>
            item.sourceDate === completeSet.sourceDate
        );

        if (entry) {
            const existingRevision = entry.revisions.find(revision =>
                revision.versionKey === completeSet.versionKey
            );
            if (existingRevision) {
                if (entry.activeVersionKey !== existingRevision.versionKey) {
                    return {
                        history: normalized,
                        changed: false,
                        outcome: "older_or_inconsistent"
                    };
                }
                entry.lastSeenAt = confirmedAt;
                if (!(await validateParticipantHistory(next, validateCompleteSet))) {
                    return {
                        history: normalized,
                        changed: false,
                        outcome: "validation_failed"
                    };
                }
                return {
                    history: next,
                    changed: true,
                    outcome: "same_version"
                };
            }
            if (assessment !== "revised_same_date") {
                return { history: normalized, changed: false, outcome: "rejected_revision" };
            }

            const activeRevision = entry.revisions.find(revision =>
                revision.versionKey === entry.activeVersionKey
            );
            activeRevision.replacedAt = confirmedAt;
            entry.revisions.push(createRevision(completeSet, confirmedAt));
            entry.activeVersionKey = completeSet.versionKey;
            entry.lastSeenAt = confirmedAt;
        } else {
            const latestSourceDate = next.entries.at(-1)?.sourceDate || null;
            if (
                latestSourceDate &&
                completeSet.sourceDate < latestSourceDate
            ) {
                return { history: normalized, changed: false, outcome: "older_or_inconsistent" };
            }
            if (assessment === "revised_same_date") {
                return { history: normalized, changed: false, outcome: "rejected_revision" };
            }

            entry = {
                sourceDate: completeSet.sourceDate,
                activeVersionKey: completeSet.versionKey,
                firstSeenAt: confirmedAt,
                lastSeenAt: confirmedAt,
                revisions: [createRevision(completeSet, confirmedAt)]
            };
            next.entries.push(entry);
        }

        next.entries.sort((left, right) =>
            left.sourceDate.localeCompare(right.sourceDate)
        );
        while (next.entries.length > next.maxEntries) {
            next.entries.shift();
        }

        if (!(await validateParticipantHistory(next, validateCompleteSet))) {
            return { history: normalized, changed: false, outcome: "validation_failed" };
        }

        return {
            history: next,
            changed: true,
            outcome: assessment === "revised_same_date"
                ? "revision_added"
                : "entry_added"
        };
    }

    function summarizeHistory(history) {
        const entries = Array.isArray(history?.entries) ? history.entries : [];
        return {
            entryCount: entries.length,
            earliestSourceDate: entries[0]?.sourceDate || null,
            latestSourceDate: entries.at(-1)?.sourceDate || null,
            revisionCount: entries.reduce(
                (total, entry) => total + (entry.revisions?.length || 0),
                0
            ),
            lastSavedAt: entries.reduce(
                (latest, entry) => !latest || entry.lastSeenAt > latest
                    ? entry.lastSeenAt
                    : latest,
                null
            )
        };
    }

    return Object.freeze({
        HISTORY_VERSION,
        PARSER_VERSION,
        HISTORY_SOURCE,
        MAX_ENTRIES,
        createEmptyHistory,
        normalizeHistory,
        validateParticipantHistory,
        parseParticipantHistory,
        upsertCompleteVersion,
        mergeOfficialCandidates,
        summarizeHistory
    });
});
