(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const changeSummaryApi = commonJs ? require("./fullExportChangeSummary.js") :
        root?.OptionMapFullExportChangeSummary;
    const api = factory(changeSummaryApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportTopChanges = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (changeSummaryApi) {
    "use strict";

    const DIGEST_VOCABULARY_VERSION = 1;
    const MAX_ITEMS_PER_BUCKET = 5;
    const ORDERING_RULE = "p18_stable_domain_transition_field_v1";
    const SOURCE_AUTHORITY = "/sections/changeSummary";
    const BUCKET_ORDER = Object.freeze([
        "availabilityChanges", "readinessChanges", "contractChanges",
        "freshnessChanges", "valueChanges", "newObservations"
    ]);
    const TRANSITION_ORDER = Object.freeze([
        "status_transition", "readiness_transition", "contract_transition",
        "freshness_transition", "value_transition", "qri_oi_top_increase",
        "qri_oi_top_decrease", "qri_oi_newly_published",
        "qri_oi_no_longer_published", "first_observation",
        "superseding_observation", "identity_transition"
    ]);
    const DOMAIN_ORDER = Object.freeze([...(changeSummaryApi?.DOMAIN_TARGETS || [])]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    function item({ domain, changeType, category, current, previous, reason,
        evidencePointer, field, optionType, strike, contract, delta }) {
        const result = { domain, changeType, category, sourcePointer: SOURCE_AUTHORITY };
        if (current !== undefined) result.current = clone(current);
        if (previous !== undefined) result.previous = clone(previous);
        if (reason !== undefined && reason !== null) result.reason = reason;
        if (evidencePointer) result.evidencePointer = evidencePointer;
        if (field) result.field = field;
        if (optionType) result.optionType = optionType;
        if (Number.isFinite(strike)) result.strike = strike;
        if (contract !== undefined && contract !== null) result.contract = clone(contract);
        if (delta !== undefined) result.delta = delta;
        return result;
    }

    function transitionItem(domain, changeType, transition, evidencePointer) {
        if (!object(transition) || !["added", "removed", "changed"].includes(
            transition.category) || transition.previous === null || transition.current === null) {
            return null;
        }
        return item({ domain, changeType, category: transition.category,
            previous: transition.previous, current: transition.current, evidencePointer });
    }

    function observationValue(identity) {
        if (!object(identity)) return null;
        const result = {};
        for (const key of ["source", "versionKey", "signature", "observationId"]) {
            if (identity[key] !== undefined && identity[key] !== null) result[key] = identity[key];
        }
        return Object.keys(result).length ? result : null;
    }

    function observationItems(domain, change) {
        const transition = change.identityTransition;
        const current = observationValue(transition?.current);
        const previous = observationValue(transition?.previous);
        if (change.category === "first_observation" && current) return [item({
            domain, changeType: "first_observation", category: "first_observation",
            previous: null, current, evidencePointer: change.sourcePointer
        })];
        if (transition?.category !== "changed" || !previous || !current) return [];
        return [item({ domain, changeType: domain === "morningV5Formal"
            ? "superseding_observation" : "identity_transition",
        category: "changed", previous, current, evidencePointer: change.sourcePointer })];
    }

    const observationValueAt = value => object(value) &&
        typeof value.value === "number" && Number.isFinite(value.value) ? value.value :
        typeof value === "number" && Number.isFinite(value) ? value : null;

    function qriItems(domain, change) {
        if (domain !== "qriOptions" || change.valueTransition?.category !== "changed") return [];
        const evidence = change.valueTransition.reusedEvidence;
        const highlights = Array.isArray(evidence?.highlights) ? evidence.highlights : [];
        const evidencePointer = text(change.valueTransition.evidencePointer) || change.sourcePointer;
        const contract = change.contractTransition?.current ?? null;
        const definitions = [
            ["topIncreases", "qri_oi_top_increase", "changed"],
            ["topDecreases", "qri_oi_top_decrease", "changed"],
            ["newlyPublished", "qri_oi_newly_published", "added"],
            ["noLongerPublished", "qri_oi_no_longer_published", "removed"]
        ];
        const results = [];
        for (const highlight of highlights) {
            const optionType = text(highlight?.optionType);
            if (!optionType) continue;
            for (const [key, changeType, category] of definitions) {
                const entries = Array.isArray(highlight[key]) ? highlight[key] : [];
                for (const entry of entries) {
                    if (!object(entry) || !Number.isFinite(Number(entry.strike))) continue;
                    const previous = observationValueAt(entry.previous);
                    const current = observationValueAt(entry.current);
                    const delta = typeof entry.delta === "number" && Number.isFinite(entry.delta)
                        ? entry.delta : null;
                    results.push(item({ domain, changeType, category, optionType,
                        strike: Number(entry.strike), contract: entry.contract ?? contract,
                        previous, current, delta, evidencePointer }));
                }
            }
        }
        return results;
    }

    function valueItems(domain, change) {
        const transition = change.valueTransition;
        if (transition?.category !== "changed") return [];
        const evidencePointer = text(transition.evidencePointer) || change.sourcePointer;
        const results = [];
        for (const field of Object.keys(object(transition.fields) ? transition.fields : {}).sort()) {
            const value = transition.fields[field];
            if (!object(value) || value.category !== "changed") continue;
            results.push(item({ domain, changeType: "value_transition", category: "changed",
                field, previous: value.previous, current: value.current,
                delta: value.delta, reason: transition.reason, evidencePointer }));
        }
        return results;
    }

    function validSource(changeSummary) {
        return object(changeSummary) && changeSummary.status === "available" &&
            changeSummary.authority?.source === "optionmap-full-export" &&
            changeSummary.authority?.sourceClass === "derived_index" &&
            changeSummary.authority?.formalStatus === "derived" &&
            changeSummary.summary?.comparisonVocabularyVersion ===
                changeSummaryApi?.VOCABULARY_VERSION &&
            changeSummary.summary?.authority === "derived_non_authoritative" &&
            object(changeSummary.summary?.domains) && DOMAIN_ORDER.length > 0 &&
            DOMAIN_ORDER.every(domain => object(changeSummary.summary.domains[domain]));
    }

    function unavailable(reason) {
        return freeze({ status: "unavailable", reason,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: null, details: { digestVocabularyVersion: DIGEST_VOCABULARY_VERSION,
                sourceAuthority: SOURCE_AUTHORITY, authority: "derived_non_authoritative" } });
    }

    function buildTopChanges(changeSummary) {
        if (!validSource(changeSummary)) return unavailable("top_changes_source_invalid");
        const collected = Object.fromEntries(BUCKET_ORDER.map(bucket => [bucket, []]));
        for (const domain of DOMAIN_ORDER) {
            const change = changeSummary.summary.domains[domain];
            const evidencePointer = text(change.sourcePointer);
            const statusItem = transitionItem(domain, "status_transition",
                change.statusTransition, evidencePointer);
            if (statusItem) collected.availabilityChanges.push(statusItem);
            const readiness = transitionItem(domain, "readiness_transition",
                change.readinessTransition, evidencePointer);
            if (readiness) collected.readinessChanges.push(readiness);
            const contract = transitionItem(domain, "contract_transition",
                change.contractTransition, evidencePointer);
            if (contract) collected.contractChanges.push(contract);
            const freshness = transitionItem(domain, "freshness_transition",
                change.freshnessTransition, evidencePointer);
            if (freshness) collected.freshnessChanges.push(freshness);
            collected.valueChanges.push(...valueItems(domain, change), ...qriItems(domain, change));
            collected.newObservations.push(...observationItems(domain, change));
        }
        const buckets = {};
        let changeCount = 0;
        for (const bucket of BUCKET_ORDER) {
            const values = collected[bucket];
            const items = values.slice(0, MAX_ITEMS_PER_BUCKET);
            changeCount += values.length;
            buckets[bucket] = { totalCount: values.length, shownCount: items.length,
                omittedCount: values.length - items.length, items };
        }
        return freeze({ status: "available", reason: changeCount === 0 ? "no_changes" : null,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: { digestVocabularyVersion: DIGEST_VOCABULARY_VERSION,
                sourceAuthority: SOURCE_AUTHORITY, authority: "derived_non_authoritative",
                maxItemsPerBucket: MAX_ITEMS_PER_BUCKET,
                deterministicOrderingRule: ORDERING_RULE, changeCount, buckets },
            details: { bucketOrder: [...BUCKET_ORDER], transitionTypeOrder: [...TRANSITION_ORDER],
                domainOrder: [...DOMAIN_ORDER], qriOrdering: "reuse_p16_formal_comparison_order",
                interpretation: "objective_change_navigation_only_no_trade_interpretation" } });
    }

    return freeze({ DIGEST_VOCABULARY_VERSION, MAX_ITEMS_PER_BUCKET, ORDERING_RULE,
        SOURCE_AUTHORITY, BUCKET_ORDER, TRANSITION_ORDER, DOMAIN_ORDER, buildTopChanges });
});
