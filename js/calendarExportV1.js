(function (root, factory) {
    const node = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        node ? require("./marketCalendarHistory/calendarPartialCoverage.js") :
            root?.OptionMapMarketCalendarPartialCoverage,
        node ? require("./marketCalendar/importancePolicy.js") :
            root?.OptionMapMarketEventImportancePolicy,
        node ? require("./marketCalendar/calendarSourceLabels.js") :
            root?.OptionMapMarketCalendarSourceLabels
    );
    if (node) module.exports = api;
    if (root) root.OptionMapCalendarExportV1 = api;
})(typeof window !== "undefined" ? window : globalThis,
function (Coverage, Importance, SourceLabels) {
    "use strict";
    const SCHEMA_VERSION = "optionmap-calendar-export-v1";
    const TOP_LEVEL_KEYS = Object.freeze(["calendarSourceStatus", "coverage", "events",
        "exportMeta", "schemaVersion", "selection"]);
    const clone = value => value == null ? value : structuredClone(value);
    const compare = (...fields) => (left, right) => {
        for (const field of fields) {
            const result = String(left?.[field] ?? "").localeCompare(String(right?.[field] ?? ""));
            if (result) return result;
        }
        return 0;
    };
    function emptyCoverage(formalAvailability, reason) {
        const invalid = formalAvailability === "invalid";
        return Object.freeze({ sourceSetVersion: Coverage.SOURCE_SET_ID,
            expectedSourceCount: Coverage.EXPECTED_SOURCE_IDS.length, persistedSourceCount: 0,
            completeness: invalid ? "invalid" : "none", formalAvailability,
            persistedSourceIds: Object.freeze([]),
            absentSourceIds: Object.freeze(invalid ? [] : [...Coverage.EXPECTED_SOURCE_IDS]),
            invalidSourceIds: Object.freeze(invalid ? [...Coverage.EXPECTED_SOURCE_IDS] : []),
            reason: reason || null });
    }
    function projectCoverage(result) {
        const value = result?.coverage;
        if (result?.status === "available" && value) return Object.freeze({
            sourceSetVersion: value.sourceSetIdentity,
            expectedSourceCount: value.expectedCount,
            persistedSourceCount: value.coverageCount,
            completeness: value.completeness === "complete" ? "full" : value.completeness,
            formalAvailability: value.formalAvailability,
            persistedSourceIds: Object.freeze([...value.persistedSourceIds]),
            absentSourceIds: Object.freeze([...value.absentSourceIds]),
            invalidSourceIds: Object.freeze([...value.invalidSourceIds]), reason: null });
        if (["invalid", "schema_mismatch", "unavailable"].includes(result?.status))
            return emptyCoverage("invalid", result?.reason || "formal_read_failed");
        return emptyCoverage("absent", result?.reason || "database_absent");
    }
    function safeHttpMetadata(value) {
        if (!value || typeof value !== "object") return null;
        const output = {};
        for (const key of ["httpStatus", "mimeType", "redirectCount", "contentLength"])
            if (["string", "number", "boolean"].includes(typeof value[key])) output[key] = value[key];
        return Object.keys(output).length ? output : null;
    }
    function evidenceProjection(value) {
        const fact = value.acquisitionEvidence || {};
        return Object.freeze({ evidenceLinkKey: value.evidenceLinkKey,
            acquisitionEvidenceKey: value.acquisitionEvidenceKey,
            acquisitionEvidenceHash: value.acquisitionEvidenceHash,
            sourceId: value.sourceId, runId: value.runId, acceptedAt: value.acceptedAt,
            fetchedAt: value.fetchedAt || fact.fetchedAt || null,
            sourceUrl: fact.sourceUrl || null, sourcePublishedAt: fact.sourcePublishedAt || null,
            sourceUpdatedAt: fact.sourceUpdatedAt || null, authority: fact.authority || null,
            parserId: fact.parserId || null, parserVersion: fact.parserVersion ?? null,
            rawContentHash: fact.rawContentHash || null,
            documentRole: fact.documentRole || fact.role || null,
            groupedDocumentIdentity: fact.groupedDocumentIdentity || fact.documentSetId || null,
            httpMetadata: safeHttpMetadata(fact.httpMetadata) });
    }
    function officialFacts(revision) {
        return Object.freeze({ title: clone(revision.title), lifecycleStatus: revision.lifecycleStatus,
            schedule: clone(revision.schedule), sourceTimeZone: revision.schedule?.sourceLocal?.timeZone || null,
            referencePeriod: revision.logical?.referencePeriod ?? null,
            officialSourceIdentifier: revision.logical?.authorityEventId ?? null,
            officialSourceUrl: revision.acquisitionEvidence?.sourceUrl || null,
            economicValues: Object.freeze({ status: "unavailable", reason: "not_acquired" }) });
    }
    function derivedFacts(revision) {
        return Object.freeze({ importance: Importance.classify(revision.logical?.eventType) });
    }
    function revisionProjection(revision, activeRevisionKey, evidence) {
        const acceptedEvidence = evidence.filter(value => value.revisionKey === revision.revisionKey)
            .sort(compare("acceptedAt", "evidenceLinkKey"));
        return Object.freeze({ revision: Object.freeze({ revisionKey: revision.revisionKey,
            eventKey: revision.eventKey, canonicalContentHash: revision.canonicalContentHash,
            acceptedAt: acceptedEvidence[0]?.acceptedAt || revision.validFrom,
            validFrom: revision.validFrom, validTo: revision.validTo,
            active: revision.revisionKey === activeRevisionKey,
            revisionOrigin: revision.revisionOrigin, change: clone(revision.change) }),
            officialFacts: officialFacts(revision), optionMapDerived: derivedFacts(revision),
            provenance: Object.freeze({ evidence: Object.freeze(acceptedEvidence.map(evidenceProjection)) }) });
    }
    function eventProjection(entry, snapshot) {
        const revisions = snapshot.revisions.filter(value => value.eventKey === entry.eventKey)
            .sort(compare("validFrom", "revisionKey")), active = revisions.find(value =>
                value.revisionKey === entry.activeRevisionKey), observations = snapshot.observations
            .filter(value => value.eventKey === entry.eventKey).sort(compare("acceptedAt", "observationKey")),
            runKeys = new Set(observations.map(value => `${value.sourceId}|${value.runId}`)), runs = snapshot.runs
            .filter(value => runKeys.has(`${value.sourceId}|${value.runId}`))
            .sort(compare("acceptedAt", "runKey"));
        return Object.freeze({ identity: Object.freeze({ eventKey: entry.eventKey,
            sourceId: entry.sourceId, country: active.logical?.jurisdiction || null,
            authority: active.logical?.authority || null, eventType: active.logical?.eventType || null,
            referencePeriod: active.logical?.referencePeriod ?? null,
            edition: active.logical?.edition ?? null, scope: active.logical?.scope ?? null,
            authorityEventId: active.logical?.authorityEventId ?? null,
            activeRevisionKey: entry.activeRevisionKey }),
            officialFacts: officialFacts(active), optionMapDerived: derivedFacts(active),
            provenance: Object.freeze({ firstKnownAt: entry.firstKnownAt,
                lastObservedAt: entry.lastObservedAt,
                observations: Object.freeze(observations.map(clone)),
                sourceRuns: Object.freeze(runs.map(value => Object.freeze({ runKey: value.runKey,
                    sourceId: value.sourceId, runId: value.runId, acceptedAt: value.acceptedAt,
                    fetchedAt: clone(value.fetchedAt), status: value.status,
                    semanticSetHash: value.semanticSetHash, contractVersion: value.contractVersion }))) }),
            revisions: Object.freeze(revisions.map(value => revisionProjection(value,
                entry.activeRevisionKey, snapshot.evidence))),
            readiness: Object.freeze({ status: "formal_reference_limited",
                reason: "economic_values_not_acquired" }) });
    }
    function sourceStatuses(archiveResult, runtimeStates) {
        const rows = archiveResult?.coverage?.sources || [], bySource = new Map(rows.map(row =>
            [row.sourceId, row])), runtimeBySource = new Map((runtimeStates || []).map(value =>
            [value.sourceId, value]));
        return Object.freeze(Coverage.EXPECTED_SOURCE_IDS.map(sourceId => {
            const row = bySource.get(sourceId), runtime = row?.runtime,
                rawRuntime = runtimeBySource.get(sourceId), rawOutcome = rawRuntime?.lastOutcome ||
                    rawRuntime?.status || rawRuntime?.acquisitionStatus,
                latestAcquisition = runtime?.state === "runtime_success" ? "success" :
                    runtime?.state === "runtime_failed" ? "failed" :
                    runtime?.state === "runtime_not_attempted" ? "not_attempted" :
                    ["success", "available"].includes(rawOutcome) ? "success" :
                    ["failure", "failed", "unavailable", "rejected"].includes(rawOutcome) ? "failed" :
                    ["not_attempted", "none"].includes(rawOutcome) ? "not_attempted" : "unknown",
                invalid = ["invalid", "schema_mismatch",
                    "unavailable"].includes(archiveResult?.status), formalAvailability = invalid ? "invalid" :
                    row?.formalState === "formal_present" ? "available" : "absent";
            return Object.freeze({ sourceId, label: SourceLabels.getLabel(sourceId), formalAvailability,
                latestAcquisition,
                reason: invalid ? archiveResult.reason || "formal_read_failed" :
                    runtime?.reason || rawRuntime?.reason || rawRuntime?.reasonClass ||
                    rawRuntime?.lastDiagnosticClass || row?.formal?.reason || null,
                lastAttemptAt: runtime?.lastAttemptAt || rawRuntime?.lastAttemptAt || null,
                lastSuccessAt: runtime?.lastSuccessAt || rawRuntime?.lastSuccessAt || null,
                lastAcceptedAt: row?.formal?.cursor?.acceptedAt || null,
                formalAuthority: "formal_history", runtimeAuthority: "runtime_state" });
        }));
    }
    function create({ appVersion, generatedAt, selection = { mode: "current" }, archiveResult,
        runtimeStates = [] } = {}) {
        if (typeof appVersion !== "string" || !appVersion.trim() ||
            !Number.isFinite(Date.parse(generatedAt || "")) || selection?.mode !== "current")
            throw new TypeError("calendar_export_input_invalid");
        const available = archiveResult?.status === "available" && archiveResult.snapshot,
            events = available ? [...archiveResult.snapshot.entries].sort(compare("sourceId", "eventKey"))
                .map(entry => eventProjection(entry, archiveResult.snapshot)) : [];
        return Object.freeze({ schemaVersion: SCHEMA_VERSION,
            exportMeta: Object.freeze({ appVersion, generatedAt, timeZone: "Asia/Tokyo",
                readOnly: true, artifactType: "calendar_formal_export", schemaVersion: SCHEMA_VERSION }),
            selection: Object.freeze({ mode: "current" }), coverage: projectCoverage(archiveResult),
            events: Object.freeze(events),
            calendarSourceStatus: sourceStatuses(archiveResult, runtimeStates) });
    }
    function validate(value) {
        const errors = [];
        if (!value || typeof value !== "object" || Array.isArray(value)) errors.push("artifact_invalid");
        else {
            if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...TOP_LEVEL_KEYS].sort()))
                errors.push("top_level_keys_invalid");
            if (value.schemaVersion !== SCHEMA_VERSION || value.exportMeta?.schemaVersion !== SCHEMA_VERSION)
                errors.push("schema_version_invalid");
            if (value.exportMeta?.readOnly !== true ||
                value.exportMeta?.artifactType !== "calendar_formal_export") errors.push("meta_invalid");
            if (value.selection?.mode !== "current" || Object.keys(value.selection || {}).length !== 1)
                errors.push("selection_invalid");
            if (!Array.isArray(value.events) || !Array.isArray(value.calendarSourceStatus) ||
                value.calendarSourceStatus.length !== Coverage.EXPECTED_SOURCE_IDS.length)
                errors.push("content_invalid");
            if (Array.isArray(value.calendarSourceStatus) && value.calendarSourceStatus.some((row, index) =>
                row.sourceId !== Coverage.EXPECTED_SOURCE_IDS[index])) errors.push("source_order_invalid");
        }
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function serialize(value, spacing = 2) {
        const checked = validate(value);
        if (!checked.valid) throw new TypeError(`calendar_export_invalid:${checked.errors.join(",")}`);
        return JSON.stringify(value, null, spacing);
    }
    return Object.freeze({ SCHEMA_VERSION, TOP_LEVEL_KEYS, create, validate, serialize });
});
