(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const api = factory(qriApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (qriApi) {
    "use strict";

    const HISTORY_VERSION = 1;
    const SOURCE = "qri-nikkei225-options";
    const SIGNATURE_ALGORITHM = "sha256";

    const clone = value => value === undefined
        ? undefined : JSON.parse(JSON.stringify(value));
    const validDate = value => {
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    const validTimestamp = value => typeof value === "string" &&
        !Number.isNaN(new Date(value).getTime());
    const validContract = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
    const entryKeyFor = (contract, sourceDateKey) => `${contract}|${sourceDateKey}`;

    function createEmptyQriOptionsHistory(now = null) {
        const timestamp = validTimestamp(now) ? now : null;
        return {
            historyVersion: HISTORY_VERSION,
            parserVersion: qriApi?.PARSER_VERSION || 2,
            schemaVersion: qriApi?.SCHEMA_VERSION || 2,
            source: SOURCE,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            createdAt: timestamp,
            updatedAt: timestamp,
            entries: []
        };
    }

    async function createHistoryCandidate(cache) {
        if (!cache || cache.cacheVersion !== 2) {
            return { ok: false, reason: "unsupported_cache_version", candidate: null };
        }
        if (cache.parserVersion !== 2) {
            return { ok: false, reason: "parser_version_mismatch", candidate: null };
        }
        if (cache.schemaVersion !== 2) {
            return { ok: false, reason: "schema_version_mismatch", candidate: null };
        }
        const canonical = cache.canonical;
        if (canonical?.contract !== cache.contract) {
            return { ok: false, reason: "contract_mismatch", candidate: null };
        }
        if (Array.isArray(canonical?.records) && canonical.records.some(record =>
            record?.contract !== canonical.contract)) {
            return { ok: false, reason: "record_contract_mismatch", candidate: null };
        }
        if (!canonical || !qriApi?.validateCanonical?.(canonical, {
            allowUnresolvedContracts: true
        })) return { ok: false, reason: "invalid_canonical", candidate: null };
        const expectedSignature = await qriApi.createSignature(canonical);
        if (cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            cache.signature !== expectedSignature) {
            return { ok: false, reason: "signature_mismatch", candidate: null };
        }
        const expectedVersionKey = `qri-options-v2|${cache.contract}|${canonical.pageUpdatedAt}|sha256:${expectedSignature}`;
        if (cache.versionKey !== expectedVersionKey) {
            return { ok: false, reason: "version_key_mismatch", candidate: null };
        }
        if (!await qriApi?.validateCacheV2?.(cache)) {
            return { ok: false, reason: "invalid_formal_cache", candidate: null };
        }
        if (canonical.openInterestStatus !== "available") {
            return { ok: false, reason: "open_interest_unavailable", candidate: null };
        }
        if (!canonical.records.some(record => record.published === true)) {
            return { ok: false, reason: "published_records_missing", candidate: null };
        }
        const sourceDateKey = canonical.tradingDate;
        if (!validDate(sourceDateKey)) {
            return { ok: false, reason: "source_date_invalid", candidate: null };
        }
        return {
            ok: true,
            reason: null,
            candidate: {
                entryKey: entryKeyFor(canonical.contract, sourceDateKey),
                contract: canonical.contract,
                sourceDateKey,
                versionKey: cache.versionKey,
                signature: cache.signature,
                signatureAlgorithm: cache.signatureAlgorithm,
                sourceUrl: cache.sourceUrl,
                fetchedAt: cache.fetchedAt,
                pageUpdatedAt: canonical.pageUpdatedAt,
                tradingDate: canonical.tradingDate,
                openInterestAsOf: canonical.openInterestAsOf,
                lastTradingDate: canonical.lastTradingDate,
                openInterestStatus: canonical.openInterestStatus,
                canonical: clone(canonical)
            }
        };
    }

    async function validateRevision(revision, entry) {
        const errors = [];
        if (!revision || typeof revision !== "object") {
            return { valid: false, errors: ["revision_not_object"] };
        }
        if (!/^qri-options-v2\|20\d{2}-(?:0[1-9]|1[0-2])\|.+\|sha256:[0-9a-f]{64}$/.test(
            revision.versionKey || "")) errors.push("version_key_invalid");
        if (!/^[0-9a-f]{64}$/.test(revision.signature || "")) errors.push("signature_invalid");
        if (revision.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_algorithm_invalid");
        if (!validTimestamp(revision.fetchedAt)) errors.push("fetched_at_invalid");
        if (!validTimestamp(revision.confirmedAt)) errors.push("confirmed_at_invalid");
        if (revision.replacedAt !== null && !validTimestamp(revision.replacedAt)) {
            errors.push("replaced_at_invalid");
        }
        if (revision.contract !== entry.contract) errors.push("revision_contract_mismatch");
        if (revision.tradingDate !== entry.sourceDateKey) errors.push("revision_date_mismatch");
        if (revision.openInterestStatus !== "available") errors.push("open_interest_unavailable");
        if (!qriApi?.validateCanonical?.(revision.canonical, {
            allowUnresolvedContracts: true
        })) errors.push("canonical_invalid");
        if (revision.canonical?.contract !== entry.contract) errors.push("canonical_contract_mismatch");
        if (revision.canonical?.tradingDate !== entry.sourceDateKey) errors.push("canonical_date_mismatch");
        if (revision.canonical?.sourceUrl !== revision.sourceUrl ||
            revision.canonical?.pageUpdatedAt !== revision.pageUpdatedAt ||
            revision.canonical?.openInterestAsOf !== revision.openInterestAsOf ||
            revision.canonical?.lastTradingDate !== revision.lastTradingDate ||
            revision.canonical?.openInterestStatus !== revision.openInterestStatus) {
            errors.push("canonical_metadata_mismatch");
        }
        if (Array.isArray(revision.canonical?.records) && revision.canonical.records.some(record =>
            record.contract !== entry.contract)) errors.push("record_contract_mismatch");
        const signature = await qriApi?.createSignature?.(revision.canonical);
        if (!signature || signature !== revision.signature) errors.push("signature_mismatch");
        const expectedVersionKey = `qri-options-v2|${entry.contract}|${revision.pageUpdatedAt}|sha256:${signature}`;
        if (revision.versionKey !== expectedVersionKey) errors.push("version_key_mismatch");
        return { valid: errors.length === 0, errors };
    }

    async function validateHistory(history) {
        const errors = [];
        if (!history || typeof history !== "object") {
            return { valid: false, errors: ["history_not_object"] };
        }
        if (history.historyVersion !== HISTORY_VERSION) errors.push("history_version_invalid");
        if (history.parserVersion !== 2) errors.push("parser_version_invalid");
        if (history.schemaVersion !== 2) errors.push("schema_version_invalid");
        if (history.source !== SOURCE) errors.push("source_invalid");
        if (history.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_algorithm_invalid");
        if (history.createdAt !== null && !validTimestamp(history.createdAt)) errors.push("created_at_invalid");
        if (history.updatedAt !== null && !validTimestamp(history.updatedAt)) errors.push("updated_at_invalid");
        if (!Array.isArray(history.entries)) {
            return { valid: false, errors: [...errors, "entries_not_array"] };
        }
        const entryKeys = new Set();
        const globalVersions = new Set();
        for (const entry of history.entries) {
            if (!entry || typeof entry !== "object") { errors.push("entry_not_object"); continue; }
            const expectedKey = entryKeyFor(entry.contract, entry.sourceDateKey);
            if (!validContract(entry.contract)) errors.push("contract_invalid");
            if (!validDate(entry.sourceDateKey)) errors.push("source_date_key_invalid");
            if (entry.entryKey !== expectedKey) errors.push("entry_key_mismatch");
            if (entryKeys.has(entry.entryKey)) errors.push("duplicate_entry");
            entryKeys.add(entry.entryKey);
            if (!validTimestamp(entry.firstSeenAt) || !validTimestamp(entry.lastSeenAt) ||
                new Date(entry.firstSeenAt) > new Date(entry.lastSeenAt)) errors.push("seen_at_invalid");
            if (!Array.isArray(entry.revisions) || entry.revisions.length === 0) {
                errors.push("revisions_missing"); continue;
            }
            const versions = new Set();
            for (const revision of entry.revisions) {
                if (versions.has(revision?.versionKey) || globalVersions.has(revision?.versionKey)) {
                    errors.push("duplicate_version_key");
                }
                versions.add(revision?.versionKey); globalVersions.add(revision?.versionKey);
                const validation = await validateRevision(revision, entry);
                errors.push(...validation.errors.map(error => `${entry.entryKey}:${error}`));
            }
            const active = entry.revisions.filter(revision =>
                revision.versionKey === entry.activeVersionKey);
            if (active.length !== 1) errors.push("active_revision_missing");
            if (active[0]?.replacedAt !== null) errors.push("active_revision_replaced");
            if (entry.revisions.some(revision => revision.versionKey !== entry.activeVersionKey &&
                revision.replacedAt === null)) errors.push("inactive_revision_not_replaced");
        }
        return { valid: errors.length === 0, errors };
    }

    function revisionFromCandidate(candidate, confirmedAt) {
        return {
            contract: candidate.contract,
            versionKey: candidate.versionKey,
            signature: candidate.signature,
            signatureAlgorithm: candidate.signatureAlgorithm,
            sourceUrl: candidate.sourceUrl,
            fetchedAt: candidate.fetchedAt,
            confirmedAt,
            replacedAt: null,
            pageUpdatedAt: candidate.pageUpdatedAt,
            tradingDate: candidate.tradingDate,
            openInterestAsOf: candidate.openInterestAsOf,
            lastTradingDate: candidate.lastTradingDate,
            openInterestStatus: candidate.openInterestStatus,
            canonical: clone(candidate.canonical)
        };
    }

    async function mergeCandidate(history, candidate, options = {}) {
        const original = clone(history);
        const historyValidation = await validateHistory(history);
        if (!historyValidation.valid) return { changed: false, outcome: "corrupted_existing_history", history: original };
        const confirmedAt = options.confirmedAt;
        if (!validTimestamp(confirmedAt)) return { changed: false, outcome: "invalid_confirmed_at", history: original };
        const cacheLike = {
            cacheVersion: 2, parserVersion: 2, schemaVersion: 2, source: SOURCE,
            sourceUrl: candidate?.sourceUrl, contract: candidate?.contract,
            pageUpdatedAt: candidate?.pageUpdatedAt, fetchedAt: candidate?.fetchedAt,
            signatureAlgorithm: candidate?.signatureAlgorithm, signature: candidate?.signature,
            versionKey: candidate?.versionKey, canonical: candidate?.canonical
        };
        const candidateValidation = await createHistoryCandidate(cacheLike);
        if (!candidateValidation.ok || candidateValidation.candidate.entryKey !== candidate?.entryKey) {
            return { changed: false, outcome: candidateValidation.reason || "invalid_candidate", history: original };
        }
        const next = clone(history);
        const entry = next.entries.find(item => item.entryKey === candidate.entryKey);
        if (entry?.revisions.some(revision => revision.versionKey === candidate.versionKey)) {
            return { changed: false, outcome: "same_version", history: original };
        }
        if (!entry) {
            next.entries.push({ entryKey: candidate.entryKey, contract: candidate.contract,
                sourceDateKey: candidate.sourceDateKey, activeVersionKey: candidate.versionKey,
                firstSeenAt: confirmedAt, lastSeenAt: confirmedAt,
                revisions: [revisionFromCandidate(candidate, confirmedAt)] });
        } else {
            const active = entry.revisions.find(revision => revision.versionKey === entry.activeVersionKey);
            if (!active) return { changed: false, outcome: "corrupted_existing_history", history: original };
            active.replacedAt = confirmedAt;
            entry.revisions.push(revisionFromCandidate(candidate, confirmedAt));
            entry.activeVersionKey = candidate.versionKey;
            entry.lastSeenAt = confirmedAt;
        }
        next.entries.sort((a, b) => a.sourceDateKey.localeCompare(b.sourceDateKey) ||
            a.contract.localeCompare(b.contract));
        if (next.createdAt === null) next.createdAt = confirmedAt;
        next.updatedAt = confirmedAt;
        const nextValidation = await validateHistory(next);
        if (!nextValidation.valid) return { changed: false, outcome: "merged_history_invalid", history: original,
            errors: nextValidation.errors };
        return { changed: true, outcome: entry ? "revision_added" : "added", history: next };
    }

    function listContracts(history) {
        return [...new Set((history?.entries || []).map(entry => entry.contract))].sort();
    }
    function listSourceDates(history, contract) {
        return [...new Set((history?.entries || []).filter(entry => !contract || entry.contract === contract)
            .map(entry => entry.sourceDateKey))].sort();
    }
    function getActiveRevision(history, contract, sourceDateKey) {
        const entry = history?.entries?.find(item => item.contract === contract &&
            item.sourceDateKey === sourceDateKey);
        const revision = entry?.revisions?.find(item => item.versionKey === entry.activeVersionKey);
        return revision ? clone(revision) : null;
    }

    return Object.freeze({ HISTORY_VERSION, SOURCE, SIGNATURE_ALGORITHM,
        entryKeyFor, createEmptyQriOptionsHistory, createHistoryCandidate,
        validateHistory, mergeCandidate, listContracts, listSourceDates,
        getActiveRevision });
});
