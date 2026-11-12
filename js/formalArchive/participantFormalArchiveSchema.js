(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapParticipantFormalArchiveSchema = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const DATABASE_NAME = "optionMapFormalArchive";
    const DATABASE_VERSION = 1;
    const ARCHIVE_SCHEMA_VERSION = 1;
    const DATASET = "participant";
    const AUTHORITY_CLASS = "formal";
    const RETENTION_POLICY = "preserve_formal_revisions";
    const META_STORE = "archiveMetadata";
    const ENTRY_STORE = "participantEntries";
    const REVISION_STORE = "participantRevisions";
    const META_KEY = "participant";
    const STORE_DEFINITIONS = Object.freeze({
        [META_STORE]: Object.freeze({ keyPath: "id", indexes: [] }),
        [ENTRY_STORE]: Object.freeze({ keyPath: "entryKey", indexes: Object.freeze([
            Object.freeze({ name: "bySourceDate", keyPath: "sourceDate", unique: true }),
            Object.freeze({ name: "byActiveRevisionKey", keyPath: "activeRevisionKey", unique: true })
        ]) }),
        [REVISION_STORE]: Object.freeze({ keyPath: "revisionKey", indexes: Object.freeze([
            Object.freeze({ name: "byEntryKey", keyPath: "entryKey", unique: false }),
            Object.freeze({ name: "bySourceDate", keyPath: "sourceDate", unique: false }),
            Object.freeze({ name: "byVersionKey", keyPath: "versionKey", unique: true }),
            Object.freeze({ name: "byRevisionState", keyPath: "revisionState", unique: false })
        ]) })
    });
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const isoDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || "") &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const text = value => typeof value === "string" && value.length > 0;
    const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    const entryKeyFor = sourceDate => `participant|${sourceDate}`;
    const EVIDENCE_BINDING_VERSION = "participants-formal-evidence-binding-v1";
    const EVIDENCE_FIELDS = Object.freeze(["contractVersion", "state", "evidenceSetId",
        "evidenceSetHash", "sourceFamily", "sourceId", "sourceDate", "runId",
        "semanticVersionKey", "semanticSignature", "boundAt", "parserLineage",
        "authorityKeyId", "bindingHash", "authoritySignature"]);
    function validateSourceEvidence(value, revision) {
        return object(value) && Object.keys(value).length === EVIDENCE_FIELDS.length &&
            EVIDENCE_FIELDS.every(field => Object.hasOwn(value, field)) &&
            value.contractVersion === EVIDENCE_BINDING_VERSION && value.state === "available" &&
            /^participants-evidence-set-v1\|sha256:[0-9a-f]{64}$/.test(value.evidenceSetId || "") &&
            digest(value.evidenceSetHash) && value.evidenceSetId.endsWith(value.evidenceSetHash) &&
            value.sourceFamily === "participants" && value.sourceId === "jpx-daily-participant-volume" &&
            value.sourceDate === revision.sourceDate && /^participants-run-v1\|sha256:[0-9a-f]{64}$/
                .test(value.runId || "") && value.semanticVersionKey === revision.versionKey &&
            value.semanticSignature === revision.signature && timestamp(value.boundAt) &&
            object(value.parserLineage) && text(value.authorityKeyId) &&
            digest(value.bindingHash) && digest(value.authoritySignature);
    }
    function validateMetadata(value) {
        return object(value) && value.id === META_KEY && value.archiveSchemaVersion === ARCHIVE_SCHEMA_VERSION &&
            value.dataset === DATASET && value.authorityClass === AUTHORITY_CLASS &&
            value.retentionPolicy === RETENTION_POLICY && timestamp(value.createdAt) &&
            timestamp(value.updatedAt) && value.integrityAlgorithm === "sha256" &&
            Number.isInteger(value.entryCount) && value.entryCount >= 0 &&
            Number.isInteger(value.revisionCount) && value.revisionCount >= 0;
    }
    function validateEntry(value) {
        return object(value) && isoDate(value.sourceDate) && value.entryKey === entryKeyFor(value.sourceDate) &&
            text(value.activeRevisionKey) && timestamp(value.firstSeenAt) && timestamp(value.lastSeenAt) &&
            Date.parse(value.firstSeenAt) <= Date.parse(value.lastSeenAt);
    }
    function validateRevision(value) {
        if (!object(value) || !isoDate(value.sourceDate) || value.entryKey !== entryKeyFor(value.sourceDate) ||
            !text(value.revisionKey) || !text(value.versionKey) || value.revisionKey !==
                `${value.entryKey}|${value.versionKey}` || !/^[0-9a-f]{64}$/.test(value.signature || "") ||
            value.contentSignature !== value.signature ||
            value.signatureAlgorithm !== "sha256" || !timestamp(value.confirmedAt) ||
            !["active", "replaced"].includes(value.revisionState) || !object(value.completeSet) ||
            Object.hasOwn(value, "sourceEvidence") &&
                !validateSourceEvidence(value.sourceEvidence, value)) return false;
        return value.revisionState === "active" ? value.replacedAt === null : timestamp(value.replacedAt);
    }
    return Object.freeze({ DATABASE_NAME, DATABASE_VERSION, ARCHIVE_SCHEMA_VERSION, DATASET,
        AUTHORITY_CLASS, RETENTION_POLICY, META_STORE, ENTRY_STORE, REVISION_STORE, META_KEY,
        STORE_DEFINITIONS, EVIDENCE_BINDING_VERSION, EVIDENCE_FIELDS, entryKeyFor,
        validateSourceEvidence, validateMetadata, validateEntry, validateRevision });
});
