(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const evidenceApi = commonJs ? require("./qriOptionsHistory.js")
        : root?.OptionMapQriOptionsHistory;
    const api = factory(qriApi, evidenceApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriVolumeHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (qriApi, evidenceApi) {
    "use strict";

    const AUTHORITY_VERSION = "qri-volume-v1";
    const HISTORY_VERSION = 1;
    const PARSER_ID = "qri-volume";
    const PARSER_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SOURCE = "qri-nikkei225-options";
    const SIGNATURE_ALGORITHM = "sha256";
    const CANDIDATE_VERSION = "qri-volume-candidate-v1";
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const validTimestamp = value => typeof value === "string" &&
        !Number.isNaN(new Date(value).getTime());
    const validDate = value => {
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    const validContract = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
    const identity = (value, prefix) => typeof value === "string" &&
        new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
            .test(value);
    const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    const entryKeyFor = (contract, tradingDate) => `${contract}|${tradingDate}`;

    function text(value) {
        return String(value ?? "").replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
    }

    function parsePublishedCell(value) {
        const normalized = text(value);
        if (normalized === "" || /^[－—–-]$/.test(normalized)) {
            return { published: false, value: null };
        }
        const compact = normalized.replace(/,/g, "");
        if (!/^\d+$/.test(compact)) throw new Error("invalid_volume_cell");
        const number = Number(compact);
        if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid_volume_cell");
        return { published: true, value: number };
    }

    function parseVolumeCanonical(parserInput, qriCanonical) {
        if (typeof parserInput !== "string" || !qriApi?.validateCanonical?.(qriCanonical,
            { allowUnresolvedContracts: true })) throw new Error("volume_parser_input_invalid");
        const records = [], strikes = new Set();
        for (const row of parserInput.matchAll(
            /<tr\b[^>]*class=["'][^"']*\brow-num\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
                .map(item => item[1]);
            if (cells.length < 16) throw new Error("volume_row_structure_invalid");
            const strikeText = text(cells[8]).replace(/リスク指標/g, "")
                .replace(/\bA\s*T\s*M\b/gi, "").replace(/,/g, "").trim();
            if (!/^\d+(?:\.\d+)?$/.test(strikeText)) throw new Error("invalid_strike");
            const strike = Number(strikeText);
            if (!Number.isFinite(strike) || strike <= 0 || strikes.has(strike)) {
                throw new Error(strikes.has(strike) ? "duplicate_strike" : "invalid_strike");
            }
            strikes.add(strike);
            records.push({ contract: qriCanonical.contract, strike,
                call: parsePublishedCell(cells[2]), put: parsePublishedCell(cells[14]) });
        }
        if (!records.length) throw new Error("volume_rows_missing");
        const canonical = { authorityVersion: AUTHORITY_VERSION, parserId: PARSER_ID,
            parserVersion: PARSER_VERSION, schemaVersion: SCHEMA_VERSION, source: SOURCE,
            sourceUrl: qriCanonical.sourceUrl, contract: qriCanonical.contract,
            tradingDate: qriCanonical.tradingDate, pageUpdatedAt: qriCanonical.pageUpdatedAt,
            records: records.sort((a, b) => a.strike - b.strike) };
        if (!validateCanonical(canonical)) throw new Error("volume_canonical_invalid");
        return canonical;
    }

    function validPublishedFact(value) {
        return object(value) && Object.keys(value).length === 2 &&
            typeof value.published === "boolean" &&
            (value.published ? Number.isSafeInteger(value.value) && value.value >= 0
                : value.value === null);
    }

    function validateCanonical(value) {
        const fields = ["authorityVersion", "parserId", "parserVersion", "schemaVersion",
            "source", "sourceUrl", "contract", "tradingDate", "pageUpdatedAt", "records"];
        if (!object(value) || Object.keys(value).length !== fields.length ||
            !fields.every(field => Object.hasOwn(value, field)) ||
            value.authorityVersion !== AUTHORITY_VERSION ||
            value.parserId !== PARSER_ID || value.parserVersion !== PARSER_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION || value.source !== SOURCE ||
            qriApi?.normalizeSourceUrl?.(value.sourceUrl) !== value.sourceUrl ||
            !validContract(value.contract) || !validDate(value.tradingDate) ||
            !validTimestamp(value.pageUpdatedAt) || !Array.isArray(value.records) ||
            value.records.length === 0) return false;
        const strikes = new Set(); let previous = -Infinity;
        for (const record of value.records) {
            if (!object(record) || Object.keys(record).length !== 4 ||
                record.contract !== value.contract || !Number.isFinite(record.strike) ||
                record.strike <= 0 || record.strike <= previous || strikes.has(record.strike) ||
                !validPublishedFact(record.call) || !validPublishedFact(record.put)) return false;
            previous = record.strike; strikes.add(record.strike);
        }
        return true;
    }

    function normalizedForSignature(canonical) {
        if (!validateCanonical(canonical)) return null;
        return { authorityVersion: AUTHORITY_VERSION, parserId: PARSER_ID,
            parserVersion: PARSER_VERSION, schemaVersion: SCHEMA_VERSION,
            contract: canonical.contract, tradingDate: canonical.tradingDate,
            records: canonical.records.map(record => [record.contract, record.strike,
                record.call.published, record.call.value, record.put.published, record.put.value]) };
    }

    async function sha256(value) {
        const serialized = JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const bytes = new TextEncoder().encode(serialized);
            const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
            return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
    }

    async function createSemanticSignature(canonical) {
        const normalized = normalizedForSignature(canonical);
        return normalized ? sha256(normalized) : null;
    }

    async function createObservationId(input) {
        return `qri-volume-observation-v1|sha256:${await sha256({
            authorityVersion: AUTHORITY_VERSION, contract: input.contract,
            tradingDate: input.tradingDate, acquisitionId: input.acquisitionId,
            pageUpdatedAt: input.pageUpdatedAt, semanticSignature: input.semanticSignature
        })}`;
    }

    function createSourceEvidence(receipt) {
        return { contractVersion: "qri-formal-revision-evidence-v1", status: "available",
            receipt: clone(receipt) };
    }

    async function createEvidenceCandidate(input) {
        const canonical = parseVolumeCanonical(input?.parserInput, input?.qriCanonical);
        const receipt = input?.receipt;
        if (!object(receipt) || receipt.contractIdentity?.contract !== canonical.contract ||
            receipt.acceptedFinalUrl !== canonical.sourceUrl || !validTimestamp(receipt.fetchedAt)) {
            throw new Error("volume_receipt_identity_mismatch");
        }
        const semanticSignature = await createSemanticSignature(canonical);
        const observationId = await createObservationId({ contract: canonical.contract,
            tradingDate: canonical.tradingDate, acquisitionId: receipt.acquisitionId,
            pageUpdatedAt: canonical.pageUpdatedAt, semanticSignature });
        const candidate = { contractVersion: CANDIDATE_VERSION,
            authorityVersion: AUTHORITY_VERSION, parserId: PARSER_ID,
            parserVersion: PARSER_VERSION, schemaVersion: SCHEMA_VERSION,
            source: SOURCE, sourceUrl: canonical.sourceUrl, contract: canonical.contract,
            tradingDate: canonical.tradingDate, pageUpdatedAt: canonical.pageUpdatedAt,
            acquiredAt: receipt.fetchedAt, acquisitionId: receipt.acquisitionId,
            occurrenceId: receipt.evidenceStatus?.occurrenceId || null,
            relatedQriOiVersionKey: input.relatedQriOiVersionKey || null,
            signatureAlgorithm: SIGNATURE_ALGORITHM, semanticSignature,
            observationId, canonical: clone(canonical),
            sourceEvidence: createSourceEvidence(receipt) };
        if (!await validateCandidate(candidate)) throw new Error("volume_candidate_invalid");
        return candidate;
    }

    async function validateCandidate(candidate) {
        const fields = ["contractVersion", "authorityVersion", "parserId", "parserVersion",
            "schemaVersion", "source", "sourceUrl", "contract", "tradingDate",
            "pageUpdatedAt", "acquiredAt", "acquisitionId", "occurrenceId",
            "relatedQriOiVersionKey", "signatureAlgorithm", "semanticSignature",
            "observationId", "canonical", "sourceEvidence"];
        const keys = object(candidate) ? Object.keys(candidate) : [];
        if (!object(candidate) || !keys.every(field => fields.includes(field) ||
            field === "confirmedAt") || !fields.every(field => Object.hasOwn(candidate, field)) ||
            candidate.contractVersion !== CANDIDATE_VERSION ||
            candidate.authorityVersion !== AUTHORITY_VERSION || candidate.parserId !== PARSER_ID ||
            candidate.parserVersion !== PARSER_VERSION || candidate.schemaVersion !== SCHEMA_VERSION ||
            candidate.source !== SOURCE || candidate.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !digest(candidate.semanticSignature) ||
            !identity(candidate.observationId, "qri-volume-observation-v1") ||
            !identity(candidate.acquisitionId, "qri-acquisition-v1") ||
            !identity(candidate.occurrenceId, "source-occurrence-v1") ||
            !validTimestamp(candidate.acquiredAt) || !validateCanonical(candidate.canonical) ||
            candidate.contract !== candidate.canonical.contract ||
            candidate.tradingDate !== candidate.canonical.tradingDate ||
            candidate.pageUpdatedAt !== candidate.canonical.pageUpdatedAt ||
            candidate.sourceUrl !== candidate.canonical.sourceUrl ||
            !(candidate.relatedQriOiVersionKey === null ||
                candidate.relatedQriOiVersionKey.startsWith(
                    `qri-options-v2|${candidate.contract}|`) &&
                /^qri-options-v2\|20\d{2}-(?:0[1-9]|1[0-2])\|.+\|sha256:[0-9a-f]{64}$/.test(
                    candidate.relatedQriOiVersionKey))) return false;
        if (!evidenceApi?.validateFormalEvidenceBinding?.(candidate.sourceEvidence, candidate)) return false;
        const receipt = candidate.sourceEvidence.receipt;
        if (receipt.acquisitionId !== candidate.acquisitionId ||
            receipt.evidenceStatus?.occurrenceId !== candidate.occurrenceId ||
            receipt.fetchedAt !== candidate.acquiredAt) return false;
        const signature = await createSemanticSignature(candidate.canonical);
        if (signature !== candidate.semanticSignature) return false;
        return candidate.observationId === await createObservationId({ contract: candidate.contract,
            tradingDate: candidate.tradingDate, acquisitionId: candidate.acquisitionId,
            pageUpdatedAt: candidate.pageUpdatedAt, semanticSignature: signature });
    }

    function createEmptyHistory(now = null) {
        return { historyVersion: HISTORY_VERSION, authorityVersion: AUTHORITY_VERSION,
            parserId: PARSER_ID, parserVersion: PARSER_VERSION, schemaVersion: SCHEMA_VERSION,
            source: SOURCE, signatureAlgorithm: SIGNATURE_ALGORITHM,
            createdAt: validTimestamp(now) ? now : null,
            updatedAt: validTimestamp(now) ? now : null, entries: [] };
    }

    async function validateHistory(history) {
        const errors = [];
        if (!object(history) || history.historyVersion !== HISTORY_VERSION ||
            history.authorityVersion !== AUTHORITY_VERSION || history.parserId !== PARSER_ID ||
            history.parserVersion !== PARSER_VERSION || history.schemaVersion !== SCHEMA_VERSION ||
            history.source !== SOURCE || history.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !Array.isArray(history.entries)) return { valid: false, errors: ["history_contract_invalid"] };
        if (history.createdAt !== null && !validTimestamp(history.createdAt)) errors.push("created_at_invalid");
        if (history.updatedAt !== null && !validTimestamp(history.updatedAt)) errors.push("updated_at_invalid");
        const keys = new Set(), ids = new Set();
        for (const entry of history.entries) {
            if (!object(entry) || entry.entryKey !== entryKeyFor(entry.contract, entry.tradingDate) ||
                !validContract(entry.contract) || !validDate(entry.tradingDate) ||
                !validTimestamp(entry.firstObservedAt) || !validTimestamp(entry.lastObservedAt) ||
                new Date(entry.firstObservedAt) > new Date(entry.lastObservedAt) ||
                !Array.isArray(entry.observations) || !entry.observations.length) {
                errors.push("entry_invalid"); continue;
            }
            if (keys.has(entry.entryKey)) errors.push("duplicate_entry");
            keys.add(entry.entryKey);
            let previous = -Infinity;
            for (const observation of entry.observations) {
                if (ids.has(observation?.observationId)) errors.push("duplicate_observation");
                ids.add(observation?.observationId);
                if (!validTimestamp(observation?.confirmedAt) ||
                    new Date(observation.confirmedAt).getTime() < previous ||
                    observation.contract !== entry.contract || observation.tradingDate !== entry.tradingDate ||
                    !await validateCandidate(observation)) errors.push("observation_invalid");
                previous = new Date(observation.confirmedAt).getTime();
            }
        }
        return { valid: errors.length === 0, errors };
    }

    async function mergeCandidate(history, candidate, options = {}) {
        const original = clone(history), validation = await validateHistory(history);
        if (!validation.valid) return { changed: false, outcome: "corrupted_existing_history", history: original };
        if (!validTimestamp(options.confirmedAt)) return { changed: false, outcome: "invalid_confirmed_at", history: original };
        if (!await validateCandidate(candidate)) return { changed: false, outcome: "invalid_candidate", history: original };
        const next = clone(history), key = entryKeyFor(candidate.contract, candidate.tradingDate);
        let entry = next.entries.find(item => item.entryKey === key);
        const latest = entry?.observations.at(-1);
        if (latest?.semanticSignature === candidate.semanticSignature) {
            return { changed: false, outcome: "same_semantic_volume", history: original };
        }
        const observation = { ...clone(candidate), confirmedAt: options.confirmedAt };
        if (!entry) {
            entry = { entryKey: key, contract: candidate.contract, tradingDate: candidate.tradingDate,
                firstObservedAt: options.confirmedAt, lastObservedAt: options.confirmedAt,
                observations: [observation] };
            next.entries.push(entry);
        } else {
            entry.observations.push(observation); entry.lastObservedAt = options.confirmedAt;
        }
        next.entries.sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) ||
            a.contract.localeCompare(b.contract));
        if (next.createdAt === null) next.createdAt = options.confirmedAt;
        next.updatedAt = options.confirmedAt;
        return { changed: true, outcome: latest ? "observation_appended" : "entry_created", history: next };
    }

    function getAvailability(history, contract, tradingDate) {
        const entry = history?.entries?.find(item => item.contract === contract &&
            item.tradingDate === tradingDate);
        return entry ? { status: "available", reason: null, entry: clone(entry) }
            : { status: "unavailable", reason: "pre_activation_or_not_recorded", entry: null };
    }

    return Object.freeze({ AUTHORITY_VERSION, HISTORY_VERSION, PARSER_ID, PARSER_VERSION,
        SCHEMA_VERSION, SOURCE, CANDIDATE_VERSION, parsePublishedCell, parseVolumeCanonical,
        validateCanonical, normalizedForSignature, createSemanticSignature, createObservationId,
        createEvidenceCandidate, validateCandidate, createEmptyHistory, validateHistory,
        mergeCandidate, getAvailability, entryKeyFor });
});
