(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const manifestApi = commonJs ? require("./runManifestV1.js") : root?.OptionMapMarketCalendarRunManifestV1;
    const api = factory(manifestApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarVirtualRunManifestV1 = api;
})(typeof window !== "undefined" ? window : globalThis, function (manifestApi) {
    "use strict";
    const frozen = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(frozen); return Object.freeze(value); };
    async function build({ run, runs = [], evidence = [], observations = [], revisions = [] } = {}) {
        const errors = [], identity = run || null;
        if (!identity) return frozen({ ok: false, manifest: null, errors: ["source_run_missing"] });
        const matchingRuns = runs.filter(item => item.sourceId === identity.sourceId && item.runId === identity.runId);
        if (matchingRuns.length !== 1 || matchingRuns[0] !== identity && JSON.stringify(matchingRuns[0]) !==
            JSON.stringify(identity)) errors.push(matchingRuns.length ? "source_run_conflict" : "source_run_missing");
        const ownObservations = observations.filter(item => item.sourceId === identity.sourceId &&
            item.runId === identity.runId), ownEvidence = evidence.filter(item => item.sourceId === identity.sourceId &&
            item.runId === identity.runId), revisionByKey = new Map();
        for (const revision of revisions) {
            if (revisionByKey.has(revision.revisionKey)) errors.push("revision_conflict");
            revisionByKey.set(revision.revisionKey, revision);
        }
        const evidenceByEvent = new Map();
        for (const item of ownEvidence) { const list = evidenceByEvent.get(item.eventKey) || [];
            list.push(item); evidenceByEvent.set(item.eventKey, list);
            if (item.acceptedAt !== identity.acceptedAt) errors.push("evidence_accepted_at_mismatch");
        }
        const items = [], seen = new Set();
        for (const observation of ownObservations) {
            if (seen.has(observation.eventKey)) errors.push("duplicate_item");
            seen.add(observation.eventKey);
            if (observation.acceptedAt !== identity.acceptedAt) errors.push("observation_accepted_at_mismatch");
            const links = evidenceByEvent.get(observation.eventKey) || [];
            if (observation.state === "observed") {
                if (links.length !== 1) errors.push(links.length ? "revision_conflict" : "observed_evidence_missing");
                const link = links[0], revision = link && revisionByKey.get(link.revisionKey);
                if (link && !revision) errors.push("revision_missing");
                if (link && revision && (link.eventKey !== revision.eventKey ||
                    revision.sourceId && revision.sourceId !== identity.sourceId)) errors.push("revision_conflict");
                items.push({ eventKey: observation.eventKey, revisionKey: link?.revisionKey || null,
                    state: observation.state });
            } else {
                if (links.length) errors.push("non_observed_evidence_present");
                items.push({ eventKey: observation.eventKey, revisionKey: null, state: observation.state });
            }
        }
        for (const eventKey of evidenceByEvent.keys()) if (!seen.has(eventKey)) errors.push("observation_missing");
        if (!items.length) errors.push("manifest_items_missing");
        if (errors.length) return frozen({ ok: false, manifest: null, errors });
        const coverageStatus = items.some(item => item.state === "not_evaluated") ? "partial" : "complete";
        return manifestApi.create({ run: identity, coverage: { status: coverageStatus, scopeVersion: 1 }, items });
    }
    async function buildAll(snapshot = {}) {
        const results = [];
        for (const run of snapshot.runs || []) results.push(await build({ run, runs: snapshot.runs,
            evidence: snapshot.evidence, observations: snapshot.observations, revisions: snapshot.revisions }));
        return frozen({ ok: results.every(item => item.ok), results });
    }
    return Object.freeze({ build, buildAll });
});
