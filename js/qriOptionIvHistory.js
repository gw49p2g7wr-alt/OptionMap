(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const ivApi = commonJs ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv;
    const api = factory(ivApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (ivApi) {
    "use strict";

    const HISTORY_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const FORMAL_STATUSES = Object.freeze(["saved", "unchanged"]);
    const ORIGINS = Object.freeze(["formal_live"]);
    const ACQUISITION_ROLES = Object.freeze(["active", "next", "major_sq"]);
    const HISTORY_FIELDS = Object.freeze(["historyVersion", "parserVersion", "schemaVersion",
        "source", "signatureAlgorithm", "createdAt", "updatedAt", "entries"]);
    const ENTRY_FIELDS = Object.freeze(["entryKey", "contract", "tradingDate", "activeVersionKey",
        "firstSeenAt", "lastSeenAt", "revisions"]);
    const REVISION_FIELDS = Object.freeze(["contract", "tradingDate", "versionKey", "signature",
        "signatureAlgorithm", "sourceUrl", "pageUpdatedAt", "lastTradingDate", "fetchedAt",
        "confirmedAt", "snapshotDate", "replacedAt", "formalStatus", "origin", "canonical",
        "confirmations"]);
    const CANDIDATE_FIELDS = Object.freeze(["entryKey", ...REVISION_FIELDS]);
    const CONFIRMATION_FIELDS = Object.freeze(["acquisitionRole", "parentMarketRefreshRequestId",
        "requestId", "acquisitionGeneration", "formalPublicationGeneration",
        "parentOptionsVersionKey", "confirmedAt"]);

    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    const result = value => freeze(clone(value));
    const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === fields.length && fields.every(field =>
            Object.prototype.hasOwnProperty.call(value, field));
    const validText = value => typeof value === "string" && value.trim() === value && value.length > 0;
    const validDate = value => {
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    const validTimestamp = value => typeof value === "string" && value.length > 0 &&
        !Number.isNaN(new Date(value).getTime());
    const validContract = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
    const entryKeyFor = (contract, tradingDate) => `${contract}|${tradingDate}`;
    const snapshotDateFromConfirmedAt = confirmedAt => validTimestamp(confirmedAt)
        ? new Date(new Date(confirmedAt).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : null;
    const confirmationKey = confirmation => [confirmation.acquisitionRole,
        confirmation.parentMarketRefreshRequestId, confirmation.requestId,
        confirmation.acquisitionGeneration, confirmation.formalPublicationGeneration,
        confirmation.parentOptionsVersionKey].join("|");
    const confirmationSort = (left, right) => left.acquisitionRole.localeCompare(right.acquisitionRole) ||
        left.confirmedAt.localeCompare(right.confirmedAt) || left.requestId.localeCompare(right.requestId) ||
        confirmationKey(left).localeCompare(confirmationKey(right));
    const revisionSort = (left, right) => left.confirmedAt.localeCompare(right.confirmedAt) ||
        left.versionKey.localeCompare(right.versionKey);
    const entrySort = (left, right) => left.contract.localeCompare(right.contract) ||
        left.tradingDate.localeCompare(right.tradingDate);

    function createEmptyHistory(now = null) {
        const timestamp = validTimestamp(now) ? now : null;
        return result({ historyVersion: HISTORY_VERSION,
            parserVersion: ivApi?.PARSER_VERSION || 1, schemaVersion: ivApi?.SCHEMA_VERSION || 1,
            source: ivApi?.SOURCE || "qri-nikkei225-option-iv",
            signatureAlgorithm: SIGNATURE_ALGORITHM, createdAt: timestamp,
            updatedAt: timestamp, entries: [] });
    }

    function validateConfirmation(confirmation) {
        const errors = [];
        if (!exact(confirmation, CONFIRMATION_FIELDS)) errors.push("confirmation_fields_invalid");
        if (!ACQUISITION_ROLES.includes(confirmation?.acquisitionRole)) errors.push("acquisition_role_invalid");
        for (const field of ["parentMarketRefreshRequestId", "requestId", "parentOptionsVersionKey"])
            if (!validText(confirmation?.[field])) errors.push(`${field}_invalid`);
        for (const field of ["acquisitionGeneration", "formalPublicationGeneration"])
            if (!Number.isSafeInteger(confirmation?.[field]) || confirmation[field] < 0)
                errors.push(`${field}_invalid`);
        if (!validTimestamp(confirmation?.confirmedAt)) errors.push("confirmation_confirmed_at_invalid");
        return result({ valid: errors.length === 0, errors });
    }

    async function validateRevision(revision, entry = null) {
        const errors = [];
        if (!exact(revision, REVISION_FIELDS)) errors.push("revision_fields_invalid");
        if (!validContract(revision?.contract)) errors.push("contract_invalid");
        if (!validDate(revision?.tradingDate)) errors.push("trading_date_invalid");
        if (entry && revision?.contract !== entry.contract) errors.push("revision_contract_mismatch");
        if (entry && revision?.tradingDate !== entry.tradingDate) errors.push("revision_trading_date_mismatch");
        if (!/^[0-9a-f]{64}$/.test(revision?.signature || "")) errors.push("signature_invalid");
        if (revision?.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_algorithm_invalid");
        for (const field of ["fetchedAt", "confirmedAt"])
            if (!validTimestamp(revision?.[field])) errors.push(`${field}_invalid`);
        if (!validDate(revision?.snapshotDate) || revision?.snapshotDate !==
            snapshotDateFromConfirmedAt(revision?.confirmedAt)) errors.push("snapshot_date_mismatch");
        if (revision?.replacedAt !== null && !validTimestamp(revision?.replacedAt))
            errors.push("replaced_at_invalid");
        if (!FORMAL_STATUSES.includes(revision?.formalStatus)) errors.push("formal_status_invalid");
        if (!ORIGINS.includes(revision?.origin)) errors.push("origin_invalid");
        if (!ivApi?.validateCanonical?.(revision?.canonical)) errors.push("canonical_invalid");
        if (revision?.canonical?.contract !== revision?.contract) errors.push("canonical_contract_mismatch");
        if (revision?.canonical?.tradingDate !== revision?.tradingDate) errors.push("canonical_trading_date_mismatch");
        for (const field of ["sourceUrl", "pageUpdatedAt", "lastTradingDate"])
            if (revision?.canonical?.[field] !== revision?.[field]) errors.push(`${field}_mismatch`);
        const expectedSignature = await ivApi?.createSignature?.(revision?.canonical);
        const expectedVersionKey = await ivApi?.createVersionKey?.(revision?.canonical);
        if (!expectedSignature || revision?.signature !== expectedSignature) errors.push("signature_mismatch");
        if (!expectedVersionKey || revision?.versionKey !== expectedVersionKey) errors.push("version_key_mismatch");
        if (!Array.isArray(revision?.confirmations) || revision.confirmations.length === 0) {
            errors.push("confirmations_missing");
        } else {
            const keys = new Set();
            for (const confirmation of revision.confirmations) {
                const validation = validateConfirmation(confirmation);
                errors.push(...validation.errors);
                if (validation.valid) {
                    const key = confirmationKey(confirmation);
                    if (keys.has(key)) errors.push("duplicate_confirmation");
                    keys.add(key);
                }
            }
            if (JSON.stringify(revision.confirmations) !==
                JSON.stringify([...revision.confirmations].sort(confirmationSort)))
                errors.push("confirmation_order_invalid");
        }
        return result({ valid: errors.length === 0, errors });
    }

    async function validateHistory(history) {
        const errors = [];
        if (!exact(history, HISTORY_FIELDS)) errors.push("history_fields_invalid");
        if (history?.historyVersion !== HISTORY_VERSION) errors.push("history_version_invalid");
        if (history?.parserVersion !== (ivApi?.PARSER_VERSION || 1)) errors.push("parser_version_invalid");
        if (history?.schemaVersion !== (ivApi?.SCHEMA_VERSION || 1)) errors.push("schema_version_invalid");
        if (history?.source !== (ivApi?.SOURCE || "qri-nikkei225-option-iv")) errors.push("source_invalid");
        if (history?.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_algorithm_invalid");
        if (history?.createdAt !== null && !validTimestamp(history?.createdAt)) errors.push("created_at_invalid");
        if (history?.updatedAt !== null && !validTimestamp(history?.updatedAt)) errors.push("updated_at_invalid");
        if (validTimestamp(history?.createdAt) && validTimestamp(history?.updatedAt) &&
            new Date(history.createdAt) > new Date(history.updatedAt)) errors.push("history_timestamp_order_invalid");
        if (!Array.isArray(history?.entries)) return result({ valid: false,
            errors: [...errors, "entries_not_array"] });
        const entryKeys = new Set();
        const globalVersions = new Set();
        for (const entry of history.entries) {
            if (!exact(entry, ENTRY_FIELDS)) errors.push("entry_fields_invalid");
            if (!validContract(entry?.contract)) errors.push("entry_contract_invalid");
            if (!validDate(entry?.tradingDate)) errors.push("entry_trading_date_invalid");
            if (entry?.entryKey !== entryKeyFor(entry?.contract, entry?.tradingDate))
                errors.push("entry_key_mismatch");
            if (entryKeys.has(entry?.entryKey)) errors.push("duplicate_entry");
            entryKeys.add(entry?.entryKey);
            if (!validTimestamp(entry?.firstSeenAt) || !validTimestamp(entry?.lastSeenAt) ||
                new Date(entry.firstSeenAt) > new Date(entry.lastSeenAt)) errors.push("seen_at_invalid");
            if (!Array.isArray(entry?.revisions) || entry.revisions.length === 0) {
                errors.push("revisions_missing"); continue;
            }
            const versions = new Set();
            for (const revision of entry.revisions) {
                if (versions.has(revision?.versionKey) || globalVersions.has(revision?.versionKey))
                    errors.push("duplicate_version_key");
                versions.add(revision?.versionKey); globalVersions.add(revision?.versionKey);
                const validation = await validateRevision(revision, entry);
                errors.push(...validation.errors.map(error => `${entry.entryKey}:${error}`));
            }
            const active = entry.revisions.filter(item => item.versionKey === entry.activeVersionKey);
            if (active.length !== 1) errors.push("active_revision_missing");
            if (active[0]?.replacedAt !== null) errors.push("active_revision_replaced");
            if (entry.revisions.some(item => item.versionKey !== entry.activeVersionKey &&
                item.replacedAt === null)) errors.push("inactive_revision_not_replaced");
            if (JSON.stringify(entry.revisions) !== JSON.stringify([...entry.revisions].sort(revisionSort)))
                errors.push("revision_order_invalid");
        }
        if (JSON.stringify(history.entries) !== JSON.stringify([...history.entries].sort(entrySort)))
            errors.push("entry_order_invalid");
        return result({ valid: errors.length === 0, errors });
    }

    async function createHistoryCandidate(canonical, context = {}) {
        const fail = reason => result({ ok: false, reason, candidate: null });
        if (!ivApi?.validateCanonical?.(canonical)) return fail("canonical_invalid");
        const signature = await ivApi.createSignature(canonical);
        const versionKey = await ivApi.createVersionKey(canonical);
        if (!signature || !versionKey) return fail("canonical_identity_invalid");
        const confirmation = { acquisitionRole: context.acquisitionRole,
            parentMarketRefreshRequestId: context.parentMarketRefreshRequestId,
            requestId: context.requestId, acquisitionGeneration: context.acquisitionGeneration,
            formalPublicationGeneration: context.formalPublicationGeneration,
            parentOptionsVersionKey: context.parentOptionsVersionKey,
            confirmedAt: context.confirmedAt };
        if (!validateConfirmation(confirmation).valid) return fail("confirmation_invalid");
        if (!validTimestamp(context.fetchedAt)) return fail("fetched_at_invalid");
        if (!FORMAL_STATUSES.includes(context.formalStatus)) return fail("formal_status_invalid");
        if (!ORIGINS.includes(context.origin)) return fail("origin_invalid");
        const candidate = { entryKey: entryKeyFor(canonical.contract, canonical.tradingDate),
            contract: canonical.contract, tradingDate: canonical.tradingDate, versionKey, signature,
            signatureAlgorithm: SIGNATURE_ALGORITHM, sourceUrl: canonical.sourceUrl,
            pageUpdatedAt: canonical.pageUpdatedAt, lastTradingDate: canonical.lastTradingDate,
            fetchedAt: context.fetchedAt, confirmedAt: context.confirmedAt,
            snapshotDate: snapshotDateFromConfirmedAt(context.confirmedAt), replacedAt: null,
            formalStatus: context.formalStatus, origin: context.origin, canonical: clone(canonical),
            confirmations: [confirmation] };
        if (!exact(candidate, CANDIDATE_FIELDS)) return fail("candidate_fields_invalid");
        const revision = clone(candidate); delete revision.entryKey;
        const validation = await validateRevision(revision,
            { contract: candidate.contract, tradingDate: candidate.tradingDate });
        return validation.valid ? result({ ok: true, reason: null, candidate })
            : result({ ok: false, reason: "candidate_invalid", candidate: null,
                errors: validation.errors });
    }

    function mergeConfirmations(existing, incoming) {
        const byKey = new Map(existing.map(item => [confirmationKey(item), clone(item)]));
        let changed = false;
        for (const item of incoming) {
            const key = confirmationKey(item); const prior = byKey.get(key);
            if (!prior) { byKey.set(key, clone(item)); changed = true; }
            else if (item.confirmedAt < prior.confirmedAt) {
                byKey.set(key, clone(item)); changed = true;
            }
        }
        return { changed, confirmations: [...byKey.values()].sort(confirmationSort) };
    }

    async function mergeCandidate(history, candidate, options = {}) {
        const original = result(history);
        const historyValidation = await validateHistory(history);
        if (!historyValidation.valid) return result({ changed: false,
            outcome: "corrupted_existing_history", history: original });
        if (!exact(candidate, CANDIDATE_FIELDS)) return result({ changed: false,
            outcome: "invalid_candidate", history: original });
        const candidateRevision = clone(candidate); delete candidateRevision.entryKey;
        const candidateValidation = await validateRevision(candidateRevision,
            { contract: candidate.contract, tradingDate: candidate.tradingDate });
        if (!candidateValidation.valid || candidate.entryKey !==
            entryKeyFor(candidate.contract, candidate.tradingDate)) return result({ changed: false,
                outcome: "invalid_candidate", history: original });
        const changedAt = validTimestamp(options.changedAt) ? options.changedAt : candidate.confirmedAt;
        if (!validTimestamp(changedAt)) return result({ changed: false,
            outcome: "invalid_changed_at", history: original });
        const next = clone(history);
        let entry = next.entries.find(item => item.entryKey === candidate.entryKey);
        let outcome;
        if (!entry) {
            entry = { entryKey: candidate.entryKey, contract: candidate.contract,
                tradingDate: candidate.tradingDate, activeVersionKey: candidate.versionKey,
                firstSeenAt: candidate.confirmedAt, lastSeenAt: candidate.confirmedAt,
                revisions: [candidateRevision] };
            next.entries.push(entry); outcome = "added";
        } else {
            const existing = entry.revisions.find(item => item.versionKey === candidate.versionKey);
            if (existing) {
                const merged = mergeConfirmations(existing.confirmations, candidate.confirmations);
                if (!merged.changed) return result({ changed: false, outcome: "same_version",
                    history: original });
                existing.confirmations = merged.confirmations;
                entry.lastSeenAt = [entry.lastSeenAt, ...candidate.confirmations.map(item => item.confirmedAt)]
                    .sort().at(-1);
                outcome = "confirmation_added";
            } else {
                const active = entry.revisions.find(item => item.versionKey === entry.activeVersionKey);
                if (!active) return result({ changed: false, outcome: "corrupted_existing_history",
                    history: original });
                active.replacedAt = candidate.confirmedAt;
                entry.revisions.push(candidateRevision);
                entry.activeVersionKey = candidate.versionKey;
                entry.lastSeenAt = candidate.confirmedAt;
                outcome = "revision_added";
            }
        }
        entry.revisions.sort(revisionSort); next.entries.sort(entrySort);
        if (next.createdAt === null) next.createdAt = changedAt;
        next.updatedAt = [next.updatedAt, changedAt].filter(validTimestamp).sort().at(-1);
        const validation = await validateHistory(next);
        return validation.valid ? result({ changed: true, outcome, history: next })
            : result({ changed: false, outcome: "merged_history_invalid", history: original,
                errors: validation.errors });
    }

    function getEntry(history, contract, tradingDate) {
        const entry = history?.entries?.find(item => item.contract === contract &&
            item.tradingDate === tradingDate);
        return entry ? result(entry) : null;
    }
    function getActiveRevision(history, contract, tradingDate) {
        const entry = getEntry(history, contract, tradingDate);
        const revision = entry?.revisions.find(item => item.versionKey === entry.activeVersionKey);
        return revision ? result(revision) : null;
    }
    const listContracts = history => result([...new Set((history?.entries || [])
        .map(entry => entry.contract))].sort());
    const listTradingDates = (history, contract) => result([...new Set((history?.entries || [])
        .filter(entry => entry.contract === contract).map(entry => entry.tradingDate))].sort());
    const serialize = history => JSON.stringify(history);

    return freeze({ HISTORY_VERSION, SIGNATURE_ALGORITHM, FORMAL_STATUSES, ORIGINS,
        ACQUISITION_ROLES, HISTORY_FIELDS, ENTRY_FIELDS, REVISION_FIELDS,
        CONFIRMATION_FIELDS, entryKeyFor, snapshotDateFromConfirmedAt, confirmationKey,
        createEmptyHistory, createHistoryCandidate, validateConfirmation, validateRevision,
        validateHistory, mergeCandidate, getEntry, getActiveRevision, listContracts,
        listTradingDates, serialize });
});
