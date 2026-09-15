(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const contract = commonJs ? require("./historyContract.js") : root?.OptionMapMarketCalendarHistoryContract;
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") :
        root?.OptionMapMarketEventCanonicalizer;
    const revisionApi = commonJs ? require("../marketCalendar/marketEventRevision.js") :
        root?.OptionMapMarketEventRevision;
    const api = factory(contract, canonicalizer, revisionApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarHistoryIntegrity = api;
})(typeof window !== "undefined" ? window : globalThis, function (contract, canonicalizer, revisionApi) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function semanticContent(revision) { return { schemaVersion: revision.schemaVersion,
        logical: revision.logical, schedule: revision.schedule, lifecycleStatus: revision.lifecycleStatus,
        title: revision.title, change: revision.change }; }
    async function audit(snapshot = {}) {
        const errors = [], entries = snapshot.entries || [], revisions = snapshot.revisions || [],
            evidence = snapshot.evidence || [], observations = snapshot.observations || [];
        const entryByKey = new Map(), revisionByKey = new Map();
        for (const entry of entries) { const prior = entryByKey.get(entry.eventKey);
            if (prior) errors.push(prior.sourceId === entry.sourceId ? "entry_duplicate" :
                "cross_source_identity_collision"); entryByKey.set(entry.eventKey, entry); }
        for (const revision of revisions) {
            const shape = contract.validateRevisionShape(revision);
            errors.push(...shape.errors.map(error => `${revision.revisionKey || "revision"}:${error}`));
            if (revisionByKey.has(revision.revisionKey)) errors.push("revision_duplicate");
            revisionByKey.set(revision.revisionKey, revision);
            const hash = await canonicalizer.sha256(semanticContent(revision));
            if (hash !== revision.canonicalContentHash) errors.push("canonical_hash_mismatch");
            if (revision.revisionKey !== `${revision.eventKey}|sha256:${hash}`)
                errors.push("revision_key_mismatch");
        }
        for (const entry of entries) {
            const own = revisions.filter(item => item.eventKey === entry.eventKey)
                .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
            const active = own.filter(item => item.validTo === null);
            if (active.length !== 1) errors.push("active_revision_count_invalid");
            if (active[0]?.revisionKey !== entry.activeRevisionKey) errors.push("active_pointer_mismatch");
            for (let index = 1; index < own.length; index += 1) {
                if (own[index - 1].validTo !== own[index].validFrom) errors.push(
                    own[index - 1].validTo > own[index].validFrom ? "revision_interval_overlap" :
                        "revision_interval_gap");
            }
        }
        for (const item of evidence) {
            const shape = contract.validateEvidenceShape(item);
            errors.push(...shape.errors.map(error => `${item.acquisitionEvidenceKey || "evidence"}:${error}`));
            if (!revisionByKey.has(item.revisionKey)) errors.push("orphan_evidence");
            const hash = await canonicalizer.sha256(item.acquisitionEvidence);
            if (hash !== item.acquisitionEvidenceHash) errors.push("acquisition_hash_mismatch");
            if (item.acquisitionEvidenceKey !== `${item.sourceId}|sha256:${hash}`)
                errors.push("acquisition_key_mismatch");
        }
        for (const item of observations) { const shape = contract.validateObservation(item);
            errors.push(...shape.errors.map(error => `${item.eventKey || "observation"}:${error}`)); }
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors),
            counts: Object.freeze({ entries: entries.length, revisions: revisions.length,
                evidence: evidence.length, observations: observations.length }) });
    }
    async function queryAsKnownAt(snapshot, { calendarDate, knowledgeAt,
        displayTimeZone = "Asia/Tokyo" } = {}) {
        const integrity = await audit(snapshot);
        if (!integrity.valid) return Object.freeze({ status: "corrupted", events: Object.freeze([]),
            errors: integrity.errors });
        const grouped = new Map();
        for (const revision of snapshot.revisions || []) { const list = grouped.get(revision.eventKey) || [];
            list.push(revision); grouped.set(revision.eventKey, list); }
        const entries = [...grouped].map(([eventKey, revisions]) => ({ eventKey, revisions }));
        let projected;
        try { projected = revisionApi.projectForCalendarDate({ entries, calendarDate, knowledgeAt,
            displayTimeZone }); }
        catch (error) { return Object.freeze({ status: "invalid", events: Object.freeze([]),
            errors: Object.freeze([error.message]) }); }
        const events = projected.map(revision => { const observation = (snapshot.observations || [])
            .filter(item => item.eventKey === revision.eventKey && item.acceptedAt <= knowledgeAt)
            .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.runId.localeCompare(a.runId))[0] || null;
            return Object.freeze({ revision: clone(revision), observation: clone(observation) }); });
        return Object.freeze({ status: "available", calendarDate, knowledgeAt,
            events: Object.freeze(events) });
    }
    return Object.freeze({ semanticContent, audit, queryAsKnownAt });
});
