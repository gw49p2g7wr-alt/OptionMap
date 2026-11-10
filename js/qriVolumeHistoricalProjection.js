(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriVolumeHistoricalProjection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const result = (status, reason, data = {}) => freeze({ status, reason, available: status === "available",
        readOnly: true, storageWrite: false, rawEvidenceRead: false, ...clone(data) });
    const timestamp = value => typeof value === "string" && !Number.isNaN(Date.parse(value));
    const identity = (value, prefix) => typeof value === "string" &&
        new RegExp(`^${prefix}\\|sha256:[0-9a-f]{64}$`).test(value);
    const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

    function shortKey(value) {
        const hash = /(?:sha256:)?([0-9a-f]{64})$/.exec(value || "")?.[1];
        return hash ? hash.slice(0, 8) : String(value || "").slice(-8);
    }

    function label(observation) {
        const confirmed = timestamp(observation.confirmedAt)
            ? new Date(Date.parse(observation.confirmedAt) + 9 * 60 * 60 * 1000)
                .toISOString().slice(0, 16).replace("T", " ") : observation.confirmedAt;
        return `${confirmed} / ${shortKey(observation.semanticSignature)}`;
    }

    function validFact(fact) {
        return fact && typeof fact === "object" && typeof fact.published === "boolean" &&
            (fact.published ? Number.isSafeInteger(fact.value) && fact.value >= 0 : fact.value === null);
    }

    function chartData(observation, contract) {
        const records = observation?.canonical?.records;
        if (!Array.isArray(records) || records.length === 0) return null;
        let previous = -Infinity;
        const points = [];
        for (const record of records) {
            if (!record || record.contract !== contract || !Number.isFinite(record.strike) ||
                record.strike <= previous || !validFact(record.call) || !validFact(record.put)) return null;
            previous = record.strike;
            points.push({ strike: record.strike, call: clone(record.call), put: clone(record.put) });
        }
        return { strikes: points.map(point => point.strike),
            callVolume: points.map(point => point.call.published ? point.call.value : null),
            putVolume: points.map(point => point.put.published ? point.put.value : null),
            publishedByStrike: points.map(point => ({ strike: point.strike,
                call: point.call.published, put: point.put.published })), points };
    }

    function validHeader(history) {
        return history && history.historyVersion === 1 && history.authorityVersion === "qri-volume-v1" &&
            history.parserId === "qri-volume" && history.parserVersion === 1 && history.schemaVersion === 1 &&
            history.source === "qri-nikkei225-options" && history.signatureAlgorithm === "sha256" &&
            Array.isArray(history.entries);
    }

    function validObservation(observation, contract, tradingDate, versionKey) {
        return observation && observation.contract === contract && observation.tradingDate === tradingDate &&
            observation.relatedQriOiVersionKey === versionKey && timestamp(observation.confirmedAt) &&
            timestamp(observation.acquiredAt) && digest(observation.semanticSignature) &&
            identity(observation.observationId, "qri-volume-observation-v1") &&
            observation.authorityVersion === "qri-volume-v1" && observation.parserVersion === 1 &&
            observation.schemaVersion === 1 && observation.sourceEvidence?.status === "available" &&
            observation.canonical?.contract === contract && observation.canonical?.tradingDate === tradingDate;
    }

    function build({ history, historyStatus = "empty", oiProjection,
        selectedObservationId = null } = {}) {
        const context = { contract: oiProjection?.metadata?.contract || null,
            tradingDate: oiProjection?.metadata?.tradingDate || null,
            relatedQriOiVersionKey: typeof oiProjection?.selectedRevision === "string"
                ? oiProjection.selectedRevision : null, observationOptions: [], selectedObservationId: null };
        if (oiProjection?.status !== "available" || !context.contract || !context.tradingDate ||
            !context.relatedQriOiVersionKey) return result("unavailable", "oi_revision_unavailable", context);
        if (historyStatus === "corrupted") return result("invalid", "volume_history_corrupted", context);
        if (historyStatus === "read_failed") return result("unavailable", "volume_history_read_failed", context);
        if (historyStatus === "empty" || history == null) {
            return result("unavailable", "pre_activation_or_not_recorded", context);
        }
        if (historyStatus !== "ready" || !validHeader(history)) {
            return result("invalid", "volume_history_corrupted", context);
        }
        const entries = history.entries.filter(entry => entry?.contract === context.contract &&
            entry.tradingDate === context.tradingDate);
        if (entries.length > 1) return result("invalid", "volume_history_corrupted", context);
        if (entries.length === 0) return result("unavailable", "pre_activation_or_not_recorded", context);
        const entry = entries[0];
        if (entry.entryKey !== `${context.contract}|${context.tradingDate}` ||
            !Array.isArray(entry.observations)) return result("invalid", "volume_history_corrupted", context);
        const matching = entry.observations.filter(observation =>
            observation?.relatedQriOiVersionKey === context.relatedQriOiVersionKey);
        if (matching.some(observation => !validObservation(observation, context.contract,
            context.tradingDate, context.relatedQriOiVersionKey))) {
            return result("invalid", "volume_history_corrupted", context);
        }
        matching.sort((left, right) => Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt) ||
            right.observationId.localeCompare(left.observationId));
        const options = matching.map(observation => ({ value: observation.observationId,
            label: label(observation), confirmedAt: observation.confirmedAt,
            versionShort: shortKey(observation.semanticSignature) }));
        if (matching.length === 0) return result("unavailable", "oi_revision_not_recorded",
            { ...context, observationOptions: options });
        const explicitlySelected = selectedObservationId !== null && selectedObservationId !== undefined &&
            selectedObservationId !== "";
        const selected = explicitlySelected
            ? matching.find(observation => observation.observationId === selectedObservationId) : matching[0];
        if (!selected) return result("unavailable", "observation_not_found",
            { ...context, observationOptions: options });
        const chart = chartData(selected, context.contract);
        if (!chart) return result("invalid", "volume_history_corrupted",
            { ...context, observationOptions: options });
        return result("available", null, { ...context, observationOptions: options,
            selectedObservationId: selected.observationId, chartData: chart,
            metadata: { contract: context.contract, tradingDate: context.tradingDate,
                relatedQriOiVersionKey: context.relatedQriOiVersionKey,
                observationId: selected.observationId, confirmedAt: selected.confirmedAt,
                acquiredAt: selected.acquiredAt, pageUpdatedAt: selected.pageUpdatedAt,
                semanticSignature: selected.semanticSignature,
                volumeVersionShort: shortKey(selected.semanticSignature),
                evidenceStatus: selected.sourceEvidence.status,
                occurrenceId: selected.occurrenceId, acquisitionId: selected.acquisitionId } });
    }

    return Object.freeze({ build, shortKey });
});
