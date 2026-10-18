(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory();
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportChangeSummary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VOCABULARY_VERSION = 1;
    const CHANGE_CATEGORIES = Object.freeze([
        "added", "removed", "changed", "unchanged", "first_observation", "not_comparable"
    ]);
    const PREDECESSOR_SELECTION_POLICY = Object.freeze([
        "same_domain_formal_history", "prior_valid_saved_reference",
        "accepted_persisted_export"
    ]);
    const DOMAIN_TARGETS = Object.freeze([
        "marketSnapshot", "qriOptions", "qriOptionsNextContract",
        "qriOptionsMajorSqNextContract", "qriOptionIv.active", "qriOptionIv.next",
        "qriOptionIv.major_sq", "weeklyFutures", "weeklyOptions", "participants",
        "overallV2", "morning", "morningV5Formal", "importantLevels",
        "consumerReadiness", "qriHistoryComparison", "intelligence"
    ]);
    const NON_COMPARABLE_WITHOUT_PREDECESSOR = new Set([
        "qriHistoryComparison", "intelligence"
    ]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const scalar = value => value === null || typeof value === "string" ||
        typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }
    function canonical(value) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }
    const same = (left, right) => canonical(left) === canonical(right);
    const sourcePointer = domain => domain.startsWith("qriOptionIv.")
        ? "/sections/qriOptionIv" : `/sections/${domain}`;
    const nullableText = value => text(value) || null;
    const valueAt = (value, keys) => {
        let cursor = value;
        for (const key of keys) {
            if (!object(cursor) || !Object.hasOwn(cursor, key)) return undefined;
            cursor = cursor[key];
        }
        return scalar(cursor) ? cursor : undefined;
    };

    function domainValue(sections, domain) {
        if (!object(sections)) return null;
        if (!domain.startsWith("qriOptionIv.")) return object(sections[domain])
            ? sections[domain] : null;
        const role = domain.slice("qriOptionIv.".length);
        return object(sections.qriOptionIv?.summary?.roles?.[role])
            ? sections.qriOptionIv.summary.roles[role] : null;
    }

    function authorityFor(sections, domain, value) {
        if (domain.startsWith("qriOptionIv.")) return {
            source: "qri-nikkei225-option-iv", sourceClass: nullableText(value?.sourceClass),
            origin: nullableText(value?.origin), formalStatus: nullableText(value?.formalStatus),
            versionKey: nullableText(value?.payloadId), signature: null
        };
        const authority = object(value?.authority) ? value.authority : {};
        return { source: nullableText(authority.source), sourceClass: nullableText(authority.sourceClass),
            origin: nullableText(authority.origin), formalStatus: nullableText(authority.formalStatus),
            versionKey: nullableText(authority.versionKey), signature: nullableText(authority.signature) };
    }

    function contractFor(domain, value) {
        if (domain.startsWith("qriOptionIv.")) return nullableText(value?.contract);
        if (["morning", "morningV5Formal"].includes(domain)) {
            const qriContract = nullableText(value?.summary?.qriContract);
            const futuresContract = nullableText(value?.summary?.futuresContract);
            const relation = nullableText(value?.summary?.contractRelation);
            return qriContract || futuresContract || relation
                ? { qriContract, futuresContract, relation } : null;
        }
        return nullableText(value?.summary?.contract) ||
            (domain === "weeklyOptions" ? nullableText(value?.summary?.expiry) : null);
    }

    function readinessFor(sections, domain) {
        if (domain === "consumerReadiness") return null;
        const entry = sections?.consumerReadiness?.summary?.entries?.[domain];
        if (!object(entry)) return null;
        return { readiness: nullableText(entry.readiness), reason: nullableText(entry.reason),
            freshnessReason: nullableText(entry.freshnessReason) };
    }

    function valuesFor(domain, value) {
        const definitions = {
            marketSnapshot: { value: ["summary", "value"] },
            overallV2: { direction: ["summary", "direction"], confidence: ["summary", "confidence"] },
            morning: { priceDelta: ["summary", "priceDelta"],
                supplyDemandDelta: ["summary", "supplyDemandDelta"] },
            morningV5Formal: { supplyDirection: ["details", "sourceIdentities", "overall", "direction"],
                supplyConfidence: ["details", "sourceIdentities", "overall", "confidence"],
                futuresPrice: ["details", "sourceIdentities", "futures", "value"] },
            importantLevels: { upper: ["summary", "upper", "price"],
                lower: ["summary", "lower", "price"] },
            qriOptionsNextContract: { callOpenInterest: ["summary", "callAggregate", "value"],
                putOpenInterest: ["summary", "putAggregate", "value"] },
            qriOptionsMajorSqNextContract: { callOpenInterest: ["summary", "callAggregate", "value"],
                putOpenInterest: ["summary", "putAggregate", "value"] },
            participants: { recordCount: ["summary", "recordCount"] }
        };
        const fields = definitions[domain];
        if (!fields) return {};
        const values = {};
        for (const [name, path] of Object.entries(fields)) {
            const candidate = valueAt(value, path);
            if (candidate !== undefined) values[name] = candidate;
        }
        return values;
    }

    function descriptor(sections, domain) {
        const value = domainValue(sections, domain);
        if (!value) return null;
        const authority = authorityFor(sections, domain, value);
        const status = nullableText(value.status) || "unavailable";
        const freshness = object(value.freshness) ? {
            status: nullableText(value.freshness.status),
            reason: nullableText(value.freshness.reason)
        } : null;
        const observationId = domain === "morningV5Formal"
            ? nullableText(value.summary?.observationId) : null;
        const identity = authority.versionKey || authority.signature || observationId ? {
            source: authority.source, versionKey: authority.versionKey,
            signature: authority.signature, observationId
        } : null;
        return { status, reason: nullableText(value.reason), freshness,
            readiness: readinessFor(sections, domain), contract: contractFor(domain, value),
            identity, authority, values: valuesFor(domain, value) };
    }

    function transition(previous, current) {
        if (previous === undefined || current === undefined || previous === null || current === null) {
            return { category: "not_comparable", previous: previous ?? null,
                current: current ?? null };
        }
        return { category: same(previous, current) ? "unchanged" : "changed",
            previous: clone(previous), current: clone(current) };
    }

    function statusTransition(previous, current) {
        const result = transition(previous, current);
        if (result.category !== "changed") return result;
        const priorAvailable = ["available", "partial"].includes(previous?.status);
        const currentAvailable = ["available", "partial"].includes(current?.status);
        if (!priorAvailable && currentAvailable) result.category = "added";
        else if (priorAvailable && !currentAvailable) result.category = "removed";
        return result;
    }

    function valueTransition(previous, current) {
        if (previous.contract !== null && current.contract !== null &&
            !same(previous.contract, current.contract)) return { category: "not_comparable",
            reason: "contract_transition", fields: {} };
        if (previous.authority.source && current.authority.source &&
            previous.authority.source !== current.authority.source) return {
            category: "not_comparable", reason: "unrelated_source_authority", fields: {} };
        const keys = Object.keys(current.values).filter(key => Object.hasOwn(previous.values, key));
        if (!keys.length) return { category: "not_comparable",
            reason: "no_formally_comparable_value_fields", fields: {} };
        const fields = {};
        for (const key of keys) {
            const prior = previous.values[key], next = current.values[key];
            fields[key] = { category: same(prior, next) ? "unchanged" : "changed",
                previous: prior, current: next,
                delta: typeof prior === "number" && typeof next === "number" ? next - prior : null };
        }
        return { category: Object.values(fields).some(field => field.category === "changed")
            ? "changed" : "unchanged", reason: null, fields };
    }

    function acceptedPredecessor(domain, current, candidate) {
        if (!object(candidate) || candidate.domain !== domain ||
            !PREDECESSOR_SELECTION_POLICY.includes(candidate.selection) ||
            !object(candidate.sections)) return null;
        const previous = descriptor(candidate.sections, domain);
        if (!previous) return null;
        if (previous.authority.source && current.authority.source &&
            previous.authority.source !== current.authority.source) return null;
        if (candidate.selection === "accepted_persisted_export") {
            const proof = candidate.persistence;
            if (!object(proof) || proof.contract !== "optionmap-full-export-predecessor-v1" ||
                proof.contractVersion !== 1 || proof.status !== "accepted" ||
                !text(proof.versionKey) || !text(proof.signature)) return null;
        } else if (candidate.selection === "same_domain_formal_history") {
            if (previous.authority.sourceClass !== "formal_history" ||
                previous.authority.formalStatus !== "verified" || !previous.identity ||
                !["available", "partial"].includes(previous.status)) return null;
        } else if (!previous.identity || !["history", "cache", "reference"].includes(
            previous.authority.origin) || !["verified", "validated"].includes(
            previous.authority.formalStatus) ||
            !["available", "partial"].includes(previous.status)) return null;
        return { selection: candidate.selection, previous };
    }

    function firstObservation(domain, current = null) {
        const category = NON_COMPARABLE_WITHOUT_PREDECESSOR.has(domain)
            ? "not_comparable" : "first_observation";
        return { sourcePointer: sourcePointer(domain), category,
            predecessorSelection: null,
            statusTransition: { category, previous: null, current: current ? {
                status: current.status, reason: current.reason } : null },
            freshnessTransition: { category, previous: null,
                current: clone(current?.freshness || null) },
            readinessTransition: { category, previous: null,
                current: clone(current?.readiness || null) },
            contractTransition: { category, previous: null,
                current: clone(current?.contract || null) },
            identityTransition: { category, previous: null,
                current: clone(current?.identity || null) },
            valueTransition: { category, reason: category === "not_comparable"
                ? "meaningful_same_domain_predecessor_unavailable" : "first_observation",
                fields: {} } };
    }

    function compareAccepted(domain, current, selected) {
        const previous = selected.previous;
        const transitions = {
            statusTransition: statusTransition({ status: previous.status, reason: previous.reason },
                { status: current.status, reason: current.reason }),
            freshnessTransition: transition(previous.freshness, current.freshness),
            readinessTransition: transition(previous.readiness, current.readiness),
            contractTransition: transition(previous.contract, current.contract),
            identityTransition: transition(previous.identity, current.identity),
            valueTransition: valueTransition(previous, current)
        };
        const comparable = Object.values(transitions).filter(value =>
            value.category !== "not_comparable");
        const category = transitions.statusTransition.category === "added" ? "added" :
            transitions.statusTransition.category === "removed" ? "removed" :
            comparable.some(value => value.category === "changed") ? "changed" :
            comparable.length ? "unchanged" : "not_comparable";
        return { sourcePointer: sourcePointer(domain), category,
            predecessorSelection: selected.selection, ...transitions };
    }

    function reusedTransition({ domain, previousIdentity, currentIdentity, contract,
        valueCategory = "not_comparable", valueReason, evidencePointer, reusedEvidence }) {
        const identityTransition = transition(previousIdentity, currentIdentity);
        return { sourcePointer: sourcePointer(domain),
            category: identityTransition.category === "changed" || valueCategory === "changed"
                ? "changed" : identityTransition.category === "unchanged" &&
                    valueCategory === "unchanged" ? "unchanged" : "not_comparable",
            predecessorSelection: "same_domain_formal_history",
            statusTransition: { category: "unchanged", previous: { status: "available" },
                current: { status: "available" } },
            freshnessTransition: { category: "not_comparable", previous: null, current: null },
            readinessTransition: { category: "not_comparable", previous: null, current: null },
            contractTransition: contract === undefined
                ? { category: "not_comparable", previous: null, current: null }
                : { category: "unchanged", previous: clone(contract), current: clone(contract) },
            identityTransition,
            valueTransition: { category: valueCategory, reason: valueReason || null, fields: {},
                evidencePointer, reusedEvidence: clone(reusedEvidence) } };
    }

    function qriIntrinsic(sections) {
        const qri = sections.qriOptions, comparison = sections.qriHistoryComparison;
        const previous = comparison?.details?.previousIdentity;
        const current = comparison?.details?.currentIdentity;
        if (qri?.status !== "available" || comparison?.status !== "available" ||
            comparison?.authority?.formalStatus !== "verified" || !text(previous?.versionKey) ||
            !text(current?.versionKey) || current.versionKey !== qri.authority?.versionKey) return null;
        const highlights = Array.isArray(comparison.summary?.highlights)
            ? comparison.summary.highlights : [];
        const changed = highlights.some(item => Number(item?.netDelta) !== 0 ||
            ["topIncreases", "topDecreases", "newlyPublished", "noLongerPublished"]
                .some(key => Array.isArray(item?.[key]) && item[key].length));
        return reusedTransition({ domain: "qriOptions", previousIdentity: clone(previous),
            currentIdentity: clone(current), contract: qri.summary?.contract || null,
            valueCategory: changed ? "changed" : "unchanged",
            evidencePointer: "/sections/qriHistoryComparison/details/comparison",
            reusedEvidence: { previousTradingDate: comparison.summary?.previousTradingDate || null,
                currentTradingDate: comparison.summary?.currentTradingDate || null, highlights } });
    }

    function weeklyIntrinsic(sections, domain) {
        const section = sections[domain];
        const previous = section?.details?.previousIdentity ||
            (domain === "weeklyOptions" ? {
                sourceDate: section?.details?.comparison?.previousSourceDate,
                versionKey: section?.details?.comparison?.previousVersionKey } : null);
        const current = section?.details?.currentIdentity ||
            (domain === "weeklyOptions" ? {
                sourceDate: section?.details?.comparison?.currentSourceDate,
                versionKey: section?.details?.comparison?.currentVersionKey } : null);
        if (section?.status !== "available" || section?.authority?.formalStatus !== "verified" ||
            !text(previous?.versionKey) || !text(current?.versionKey)) return null;
        const comparison = domain === "weeklyOptions" ? section.details?.comparison : section.summary;
        const comparable = domain === "weeklyOptions" && comparison?.available === true;
        const strikeChanges = Array.isArray(comparison?.changes?.strikeChanges)
            ? comparison.changes.strikeChanges : [];
        const changed = comparable && strikeChanges.some(value => value?.status !== "continued" ||
            typeof value?.delta === "number" && value.delta !== 0);
        const compactEvidence = domain === "weeklyOptions" ? {
            status: comparison?.status || null, reason: comparison?.reason || null,
            previousSourceDate: comparison?.previousSourceDate || null,
            currentSourceDate: comparison?.currentSourceDate || null,
            previousVersionKey: comparison?.previousVersionKey || null,
            currentVersionKey: comparison?.currentVersionKey || null,
            counts: clone(comparison?.counts || null)
        } : { major5Status: section.summary?.major5Status || null,
            twelveGroupStatus: section.summary?.twelveGroupStatus || null,
            major5: clone(section.summary?.major5 ? {
                direction: section.summary.major5.direction ?? null,
                buyScore: section.summary.major5.buyScore ?? null,
                sellScore: section.summary.major5.sellScore ?? null,
                scoreDiff: section.summary.major5.scoreDiff ?? null
            } : null),
            twelveGroup: clone(section.summary?.twelveGroup ? {
                available: section.summary.twelveGroup.available ?? null,
                availableGroupCount: section.summary.twelveGroup.availableGroupCount ?? null,
                requiredGroupCount: section.summary.twelveGroup.requiredGroupCount ?? null,
                direction: section.summary.twelveGroup.direction ?? null
            } : null), agreement: clone(section.summary?.agreement || null) };
        return reusedTransition({ domain, previousIdentity: clone(previous),
            currentIdentity: clone(current),
            valueCategory: comparable ? changed ? "changed" : "unchanged" : "not_comparable",
            valueReason: comparable ? null : "existing_pair_has_no_independent_value_delta_axis",
            evidencePointer: domain === "weeklyOptions"
                ? "/sections/weeklyOptions/details/comparison" : "/sections/weeklyFutures/summary",
            reusedEvidence: compactEvidence });
    }

    function morningIntrinsic(sections) {
        const section = sections.morning;
        const previous = section?.details?.baselineIdentity;
        const current = section?.details?.currentIdentity;
        if (section?.status !== "available" || !object(previous) || !object(current)) return null;
        const comparison = section.details?.comparison;
        const divergence = comparison?.divergence || {};
        const changed = [divergence.priceDelta, divergence.supplyDemandDelta]
            .some(value => typeof value === "number" && value !== 0);
        return reusedTransition({ domain: "morning", previousIdentity: clone(previous),
            currentIdentity: clone(current), contract: contractFor("morning", section),
            valueCategory: changed ? "changed" : "unchanged",
            evidencePointer: "/sections/morning/details/comparison",
            reusedEvidence: comparison ? { status: comparison.status || null,
                divergence: clone(comparison.divergence || null),
                dataQuality: clone(comparison.dataQuality || null),
                comparability: clone(comparison.comparability || null) } : null });
    }

    function observationDescriptor(observation) {
        if (!object(observation) || !text(observation.observationId) ||
            !text(observation.versionKey) || !text(observation.signature)) return null;
        return { status: "available", reason: null,
            freshness: object(observation.freshness) ? {
                status: nullableText(observation.freshness.status),
                reason: nullableText(observation.freshness.reason) } : null,
            readiness: null, contract: object(observation.contractContext)
                ? { qriContract: nullableText(observation.contractContext.qriContract),
                    futuresContract: nullableText(observation.contractContext.futuresContract),
                    relation: nullableText(observation.contractContext.relation) } : null,
            identity: { source: "formal-morning-v5", versionKey: observation.versionKey,
                signature: observation.signature, observationId: observation.observationId },
            authority: { source: "formal-morning-v5", sourceClass: "formal_history",
                origin: "history", formalStatus: "verified", versionKey: observation.versionKey,
                signature: observation.signature },
            values: { supplyDirection: observation.result?.supplyDirection,
                supplyConfidence: observation.result?.supplyConfidence,
                futuresPrice: observation.result?.futuresPrice } };
    }

    function morningV5Intrinsic(sections, evidence) {
        const section = sections.morningV5Formal;
        if (section?.status !== "available") return null;
        const baselineId = nullableText(section.details?.baselineSelection?.baselineObservationId);
        if (!baselineId) return firstObservation("morningV5Formal",
            descriptor(sections, "morningV5Formal"));
        const observations = Array.isArray(evidence?.morningV5Observations)
            ? evidence.morningV5Observations : [];
        const previousObservation = observations.find(value => value?.observationId === baselineId);
        const currentObservation = observations.find(value => value?.observationId ===
            section.summary?.observationId);
        const previous = observationDescriptor(previousObservation);
        const current = observationDescriptor(currentObservation);
        if (!previous || !current || current.identity.versionKey !== section.authority?.versionKey ||
            current.identity.signature !== section.authority?.signature) return {
            ...firstObservation("morningV5Formal", descriptor(sections, "morningV5Formal")),
            category: "not_comparable",
            valueTransition: { category: "not_comparable",
                reason: "formal_baseline_observation_unavailable", fields: {} } };
        const result = compareAccepted("morningV5Formal", current,
            { selection: "same_domain_formal_history", previous });
        const comparison = section.details?.comparison;
        const comparableLanes = [comparison?.supply, comparison?.price].filter(lane =>
            lane?.comparable === true && typeof lane.delta === "number" &&
            Number.isFinite(lane.delta));
        const valueCategory = comparison?.aggregateClass === "first_observation"
            ? "first_observation" : comparableLanes.length === 0 ? "not_comparable" :
                comparableLanes.some(lane => lane.delta !== 0) ? "changed" : "unchanged";
        result.valueTransition = { category: valueCategory,
            reason: valueCategory === "not_comparable"
                ? "existing_formal_comparison_not_comparable" : null, fields: {},
            evidencePointer: "/sections/morningV5Formal/details/comparison",
            reusedEvidence: clone(comparison || null) };
        result.category = result.contractTransition.category === "changed" ||
            result.identityTransition.category === "changed" ||
            result.valueTransition.category === "changed" ? "changed" : result.category;
        return result;
    }

    function intrinsic(domain, sections, evidence) {
        if (domain === "qriOptions") return qriIntrinsic(sections);
        if (["weeklyFutures", "weeklyOptions"].includes(domain))
            return weeklyIntrinsic(sections, domain);
        if (domain === "morning") return morningIntrinsic(sections);
        if (domain === "morningV5Formal") return morningV5Intrinsic(sections, evidence);
        return null;
    }

    function unchangedCritical(domains) {
        const values = [];
        const qri = domains.qriOptions;
        if (qri?.contractTransition?.category === "unchanged" &&
            qri.contractTransition.current !== null) values.push({
            fact: "active_qri_contract", value: clone(qri.contractTransition.current),
            sourcePointer: qri.sourcePointer });
        const weekly = domains.weeklyFutures;
        if (weekly?.identityTransition?.category === "unchanged") values.push({
            fact: "weekly_formal_pair", value: clone(weekly.identityTransition.current),
            sourcePointer: weekly.sourcePointer });
        const morning = domains.morningV5Formal;
        if (morning?.identityTransition?.category === "unchanged") values.push({
            fact: "morning_v5_formal_observation", value: clone(morning.identityTransition.current),
            sourcePointer: morning.sourcePointer });
        return values.slice(0, 4);
    }

    function unavailable(reason) {
        return freeze({ status: "unavailable", reason,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: null, details: { comparisonVocabularyVersion: VOCABULARY_VERSION,
                authority: "derived_non_authoritative" } });
    }

    function buildChangeSummary(input = {}) {
        const sections = input.sections;
        if (!object(sections) || DOMAIN_TARGETS.some(domain => !domainValue(sections, domain))) {
            return unavailable("change_summary_source_invalid");
        }
        const domains = {};
        for (const domain of DOMAIN_TARGETS) {
            const current = descriptor(sections, domain);
            const selected = acceptedPredecessor(domain, current,
                input.predecessors?.[domain]);
            domains[domain] = selected ? compareAccepted(domain, current, selected) :
                intrinsic(domain, sections, input.evidence) || firstObservation(domain, current);
        }
        const categories = Object.values(domains).map(value => value.category);
        const comparisonStatus = categories.some(value => ["changed", "unchanged"].includes(value))
            ? "comparable" : categories.some(value => value === "first_observation")
                ? "first_observation" : "not_comparable";
        const roots = new Set(["/sections"]);
        for (const value of Object.values(domains)) {
            const pointer = value.valueTransition?.evidencePointer;
            if (pointer) roots.add(pointer);
        }
        return freeze({ status: "available", reason: null,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: { comparisonVocabularyVersion: VOCABULARY_VERSION, comparisonStatus,
                authority: "derived_non_authoritative",
                changedDomainCount: categories.filter(value =>
                    ["added", "removed", "changed"].includes(value)).length,
                domains, unchangedCritical: unchangedCritical(domains) },
            details: { vocabulary: [...CHANGE_CATEGORIES],
                authoritativeRootsUsed: [...roots].sort().map(value => ({ authoritativeRoot: value })),
                predecessorSelectionPolicy: [...PREDECESSOR_SELECTION_POLICY],
                noEligiblePredecessor: "first_observation",
                interpretation: "objective_facts_only_no_trade_interpretation" } });
    }

    return freeze({ VOCABULARY_VERSION, CHANGE_CATEGORIES, PREDECESSOR_SELECTION_POLICY,
        DOMAIN_TARGETS, buildChangeSummary });
});
