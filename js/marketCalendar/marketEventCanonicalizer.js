(function (root, factory) {
    const identity = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./marketEventIdentity.js") : root?.OptionMapMarketEventIdentity;
    const schedule = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./marketEventSchedule.js") : root?.OptionMapMarketEventSchedule;
    const policy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./authorityPolicy.js") : root?.OptionMapMarketEventAuthorityPolicy;
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const contract = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceContract.js") : root?.OptionMapMarketEventSourceContract;
    const api = factory(identity, schedule, policy, registry, contract);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventCanonicalizer = api;
})(typeof window !== "undefined" ? window : globalThis, function factory(identity, schedules, policy, registry, contract) {
    "use strict";
    const stable = value => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };
    async function sha256(value) { const text = new TextEncoder().encode(stable(value));
        if (globalThis.crypto?.subtle) { const result = await globalThis.crypto.subtle.digest("SHA-256", text);
            return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
        return require("node:crypto").createHash("sha256").update(text).digest("hex"); }
    async function canonicalize(record) {
        const validation = contract.validateSourceRecord(record);
        if (!validation.valid) return { ok: false, reason: validation.errors[0], event: null,
            errors: validation.errors };
        const source = registry.getSource(record?.sourceId), eligibility =
            policy.evaluateFormalEligibility(record, source);
        if (!eligibility.eligible) return { ok: false, reason: eligibility.reason, event: null };
        let logical, eventSchedule;
        try { logical = identity.create({ jurisdiction: source.jurisdiction, authority: source.authority,
            eventType: record.eventType, referencePeriod: record.referencePeriod,
            edition: record.edition || "initial", scope: record.scope,
            authorityEventId: record.authorityEventId });
            eventSchedule = schedules.canonicalize(record.sourceLocalSchedule); }
        catch (error) { return { ok: false, reason: error.message, event: null }; }
        const semanticContent = { schemaVersion: 1, logical, schedule: eventSchedule,
            lifecycleStatus: record.sourceStatus || "scheduled",
            title: { ja: record.titleJa || record.sourceTitle, en: record.titleEn || null },
            change: { reason: record.changeReason || null, supersedesRevisionKey: null } };
        const acquisitionEvidence = { sourceId: source.sourceId, authority: source.authority,
            sourceUrl: record.sourceUrl, sourcePublishedAt: record.sourcePublishedAt,
            sourceUpdatedAt: record.sourceUpdatedAt, fetchedAt: record.fetchedAt,
            rawContentHash: record.rawContentHash, parserId: record.parserId,
            parserVersion: record.parserVersion, requestId: record.requestId || null,
            runId: record.runId || null, httpMetadata: record.httpMetadata || null };
        const canonicalContentHash = await sha256(semanticContent),
            acquisitionEvidenceHash = await sha256(acquisitionEvidence);
        const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
            Object.values(value).forEach(freeze); return Object.freeze(value); };
        return { ok: true, reason: null, event: freeze({ ...semanticContent,
            source: acquisitionEvidence, acquisitionEvidence,
            eventKey: logical.eventKey, revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`,
            acquisitionEvidenceKey: `${source.sourceId}|sha256:${acquisitionEvidenceHash}`,
            validFrom: null, validTo: null, canonicalContentHash, acquisitionEvidenceHash }) };
    }
    const isolatedFactory = typeof module === "object" && module.exports &&
        !(typeof window !== "undefined" && window.document)
        ? { createCanonicalizer: sourceRegistry => factory(identity, schedules, policy, sourceRegistry,
            contract.createSourceContract(sourceRegistry)) } : {};
    return Object.freeze({ stable, sha256, canonicalize, ...isolatedFactory });
});
