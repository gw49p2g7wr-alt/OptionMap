(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const securityApi = commonJs ? require("./fullExportSecurity.js") :
        root?.OptionMapFullExportSecurity;
    const api = factory(securityApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportAiSummary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (securityApi) {
    "use strict";

    const SUMMARY_VERSION = 1;
    const PURPOSE = "index_only_not_authoritative_data";
    const SECTION_ORDER = Object.freeze([
        "marketSnapshot", "overallV2", "qriOptions", "qriOptionsNextContract",
        "qriOptionsMajorSqNextContract", "qriOptionIv", "qriHistoryComparison", "weeklyFutures",
        "weeklyOptions", "participants", "morning", "morningV5Formal", "importantLevels", "intelligence"
    ]);
    const READING_PURPOSES = Object.freeze({
        marketSnapshot: "current_market_snapshot",
        overallV2: "existing_overall_assessment",
        qriOptions: "active_contract_formal_details",
        qriOptionsNextContract: "next_contract_formal_details",
        qriOptionsMajorSqNextContract: "major_sq_contract_formal_details",
        qriOptionIv: "three_contract_formal_iv_inventory",
        qriHistoryComparison: "formal_qri_history_comparison",
        weeklyFutures: "formal_weekly_futures_details",
        weeklyOptions: "formal_weekly_options_details",
        participants: "participant_data_details",
        morning: "formal_morning_comparison",
        morningV5Formal: "saved_formal_morning_v5_observation",
        importantLevels: "existing_important_levels_projection",
        intelligence: "existing_intelligence_summary"
    });
    const IDENTITY_FIELDS = Object.freeze([
        "baselineVersion", "schemaVersion", "baselineId", "versionKey",
        "contentSignature", "signature", "capturedAt"
    ]);

    const object = value => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    };
    const scalar = value => value === null || ["string", "boolean"].includes(typeof value) ||
        typeof value === "number" && Number.isFinite(value) ? value : null;
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }
    const pointer = section => `/sections/${section}`;
    const sectionAt = (sections, name) => object(sections?.[name]) ? sections[name] : null;
    const field = (value, key) => object(value) && Object.hasOwn(value, key)
        ? scalar(value[key]) : null;
    const status = section => field(section, "status");
    const reason = section => field(section, "reason");
    const freshnessStatus = section => field(section?.freshness, "status");
    const freshnessReason = section => field(section?.freshness, "reason");

    function freshnessProvenance(freshness) {
        const result = {
            dataTradingDate: field(freshness, "dataTradingDate"),
            expectedTradingDate: field(freshness, "expectedTradingDate"),
            expectedTradingDateSource: field(freshness, "expectedTradingDateSource"),
            origin: field(freshness, "origin"),
            payloadValidation: field(freshness, "payloadValidation"),
            dateRelation: field(freshness, "dateRelation"),
            consumerState: field(freshness, "consumerState"),
            staleReason: field(freshness, "staleReason")
        };
        return Object.values(result).some(value => value !== null) ? result : null;
    }

    function sourceBase(section, name) {
        const provenance = freshnessProvenance(section?.freshness);
        return {
            sourceSection: name,
            sourcePointer: pointer(name),
            status: status(section),
            reason: reason(section),
            freshnessStatus: freshnessStatus(section),
            freshnessReason: freshnessReason(section),
            ...(provenance ? { freshnessProvenance: provenance } : {})
        };
    }

    function identity(value) {
        if (!object(value)) return null;
        const result = {};
        for (const key of IDENTITY_FIELDS) result[key] = field(value, key);
        return result;
    }

    function market(sections) {
        const section = sectionAt(sections, "marketSnapshot");
        const summary = object(section?.summary) ? section.summary : null;
        return { ...sourceBase(section, "marketSnapshot"),
            tradingDate: field(section?.asOf, "tradingDate"),
            currentPrice: field(summary, "value"),
            currentPriceMode: field(summary, "mode"),
            currentContract: field(summary, "contract") };
    }

    function overall(sections) {
        const section = sectionAt(sections, "overallV2");
        const summary = object(section?.summary) ? section.summary : null;
        const components = object(section?.details?.result?.components)
            ? section.details.result.components : null;
        let availableComponents = null; let unavailableComponents = null;
        if (components) {
            availableComponents = [];
            unavailableComponents = [];
            for (const name of ["option", "weekly"]) {
                const component = object(components[name]) ? components[name] : null;
                if (component?.available === true) availableComponents.push(name);
                else if (component?.available === false) unavailableComponents.push(name);
            }
        }
        return { ...sourceBase(section, "overallV2"),
            direction: field(summary, "direction"), confidence: field(summary, "confidence"),
            coverage: field(summary, "coverage"), availableComponents, unavailableComponents };
    }

    function qriSource(sections, name) {
        const section = sectionAt(sections, name);
        const summary = object(section?.summary) ? section.summary : null;
        return { ...sourceBase(section, name), contract: field(summary, "contract"),
            tradingDate: field(section?.asOf, "tradingDate") };
    }

    function qriComparison(sections) {
        const name = "qriHistoryComparison";
        const section = sectionAt(sections, name);
        const summary = object(section?.summary) ? section.summary : null;
        return { ...sourceBase(section, name),
            previousSourceDate: field(summary, "previousTradingDate"),
            currentSourceDate: field(summary, "currentTradingDate") };
    }

    function qriOptionIv(sections) {
        const name = "qriOptionIv";
        const section = sectionAt(sections, name);
        const roles = object(section?.summary?.roles) ? section.summary.roles : {};
        const project = role => {
            const provenance = freshnessProvenance(role?.freshness);
            return { status: field(role, "status"), contract: field(role, "contract"),
                tradingDate: field(role, "tradingDate"),
                freshnessStatus: field(role?.freshness, "status"),
                freshnessReason: field(role?.freshness, "reason"),
                ...(provenance ? { freshnessProvenance: provenance } : {}),
                payloadId: field(role, "payloadId") };
        };
        return { sourceSection: name, sourcePointer: pointer(name), status: status(section),
            reason: reason(section), roles: { active: project(roles.active),
                next: project(roles.next), majorSq: project(roles.major_sq) } };
    }

    function datedSource(sections, name) {
        const section = sectionAt(sections, name);
        return { ...sourceBase(section, name),
            sourceDate: field(section?.asOf, "sourceDate") };
    }

    function morning(sections) {
        const name = "morning";
        const section = sectionAt(sections, name);
        return { ...sourceBase(section, name),
            baselineIdentity: identity(section?.details?.baselineIdentity),
            currentIdentity: identity(section?.details?.currentIdentity) };
    }
    function morningV5(sections) {
        const name = "morningV5Formal", section = sectionAt(sections, name);
        const summary = object(section?.summary) ? section.summary : null;
        return { ...sourceBase(section, name), observationId: field(summary, "observationId"),
            observedAt: field(summary, "observedAt"), qriContract: field(summary, "qriContract"),
            futuresContract: field(summary, "futuresContract"),
            contractRelation: field(summary, "contractRelation"),
            aggregateComparison: field(summary, "aggregateComparison") };
    }

    function consumerReadiness(sections) {
        const name = "consumerReadiness", section = sectionAt(sections, name);
        if (!section) return null;
        return { sourceSection: name, sourcePointer: pointer(name), status: status(section),
            reason: reason(section), vocabularyVersion: field(section?.summary,
                "vocabularyVersion"), authoritativeRoot: field(section?.summary,
                "authoritativeRoot") };
    }

    function changeSummary(sections) {
        const name = "changeSummary", section = sectionAt(sections, name);
        if (!section) return null;
        return { sourceSection: name, sourcePointer: pointer(name), status: status(section),
            reason: reason(section), comparisonVocabularyVersion: field(section?.summary,
                "comparisonVocabularyVersion"), comparisonStatus: field(section?.summary,
                "comparisonStatus"), changedDomainCount: field(section?.summary,
                "changedDomainCount") };
    }

    function topChanges(sections) {
        const name = "topChanges", section = sectionAt(sections, name);
        if (!section) return null;
        const buckets = object(section.summary?.buckets) ? section.summary.buckets : {};
        const counts = {};
        for (const bucket of ["availabilityChanges", "readinessChanges", "contractChanges",
            "freshnessChanges", "valueChanges", "newObservations"]) {
            const value = object(buckets[bucket]) ? buckets[bucket] : {};
            counts[bucket] = { totalCount: field(value, "totalCount"),
                shownCount: field(value, "shownCount"),
                omittedCount: field(value, "omittedCount") };
        }
        return { sourceSection: name, sourcePointer: pointer(name), status: status(section),
            reason: reason(section), digestVocabularyVersion: field(section?.summary,
                "digestVocabularyVersion"), changeCount: field(section?.summary, "changeCount"),
            bucketCounts: counts };
    }

    function issueKey(issue) {
        return [issue.section, issue.issueType, issue.status, issue.reason]
            .map(value => String(value ?? "")).join("|");
    }

    function dataQuality(source) {
        const issues = []; const seen = new Set();
        const add = issue => {
            const key = issueKey(issue);
            if (!seen.has(key)) { seen.add(key); issues.push(issue); }
        };
        for (const name of SECTION_ORDER) {
            const section = sectionAt(source.sections, name);
            if (!section) continue;
            if (["partial", "unavailable", "invalid"].includes(status(section))) {
                add({ section: name, sourcePointer: pointer(name), issueType: "section_status",
                    status: status(section), reason: reason(section) });
            }
            if (freshnessStatus(section) !== "fresh") {
                const provenance = freshnessProvenance(section?.freshness) || {};
                add({ section: name, sourcePointer: `${pointer(name)}/freshness`,
                    issueType: "freshness", status: freshnessStatus(section),
                    reason: freshnessReason(section), ...provenance });
            }
        }
        const ivSection = sectionAt(source.sections, "qriOptionIv");
        const ivRoles = object(ivSection?.summary?.roles) ? ivSection.summary.roles : {};
        for (const role of ["active", "next", "major_sq"]) {
            const roleValue = object(ivRoles[role]) ? ivRoles[role] : null;
            if (["unavailable", "invalid"].includes(field(roleValue, "status"))) {
                add({ section: `qriOptionIv.${role}`, sourcePointer: pointer("qriOptionIv"),
                    issueType: "role_status", status: field(roleValue, "status"),
                    reason: field(roleValue, "reason") });
            }
            const roleFreshness = field(roleValue?.freshness, "status");
            if (roleValue && roleFreshness !== "fresh") {
                const provenance = freshnessProvenance(roleValue.freshness) || {};
                add({ section: `qriOptionIv.${role}`, sourcePointer: pointer("qriOptionIv"),
                    issueType: "freshness", status: roleFreshness,
                    reason: field(roleValue.freshness, "reason"), ...provenance });
            }
        }
        const freshnessIssues = Array.isArray(source.compactSummary?.freshnessIssues)
            ? source.compactSummary.freshnessIssues : [];
        freshnessIssues.forEach((value, index) => {
            if (!object(value)) return;
            const name = field(value, "section");
            if (typeof name !== "string" || !SECTION_ORDER.includes(name)) return;
            const provenance = freshnessProvenance(value) || {};
            add({ section: name,
                sourcePointer: `/compactSummary/freshnessIssues/${index}`,
                issueType: "freshness", status: field(value, "status"),
                reason: field(value, "reason"), ...provenance });
        });
        const sourceWarnings = Array.isArray(source.warnings) ? source.warnings : [];
        const warnings = [];
        sourceWarnings.forEach((value, index) => {
            if (!object(value)) return;
            warnings.push({ sourcePointer: `/warnings/${index}`, code: field(value, "code"),
                section: field(value, "section"), status: field(value, "status"),
                reason: field(value, "reason") });
        });
        return { affectedSections: issues, warnings };
    }

    function unavailable(reasonCode) {
        return deepFreeze({ status: "unavailable", reason: reasonCode,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: null, details: { pointerFormat: "rfc6901_json_pointer",
                authoritativeRoot: "/sections" } });
    }

    function buildFullExportAiSummary(source = {}) {
        const inspected = securityApi?.inspectFullExportSecurity?.(source);
        if (!object(source) || !object(source.exportMeta) || !object(source.compactSummary) ||
            !object(source.sections) || !Array.isArray(source.warnings) || inspected?.valid !== true) {
            return unavailable("ai_summary_source_invalid");
        }
        const generatedAt = field(source.exportMeta, "generatedAt");
        if (generatedAt === null) return unavailable("ai_summary_source_invalid");
        const readiness = consumerReadiness(source.sections);
        const changes = changeSummary(source.sections);
        const top = topChanges(source.sections);
        const summary = {
            summaryVersion: SUMMARY_VERSION, purpose: PURPOSE, generatedAt,
            market: market(source.sections), overallV2: overall(source.sections),
            qriContracts: {
                active: qriSource(source.sections, "qriOptions"),
                next: qriSource(source.sections, "qriOptionsNextContract"),
                majorSq: qriSource(source.sections, "qriOptionsMajorSqNextContract")
            },
            qriOptionIv: qriOptionIv(source.sections),
            qriHistoryComparison: qriComparison(source.sections),
            weekly: {
                futures: datedSource(source.sections, "weeklyFutures"),
                options: datedSource(source.sections, "weeklyOptions"),
                participants: datedSource(source.sections, "participants")
            },
            morning: morning(source.sections), morningV5Formal: morningV5(source.sections),
            ...(readiness ? { consumerReadiness: readiness } : {}),
            ...(changes ? { changeSummary: changes } : {}),
            ...(top ? { topChanges: top } : {}),
            dataQuality: dataQuality(source),
            readingOrder: SECTION_ORDER.filter(name => sectionAt(source.sections, name))
                .map(name => ({ section: name,
                pointer: pointer(name), purpose: READING_PURPOSES[name] }))
        };
        const result = { status: "available", reason: null,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" }, summary,
            details: { pointerFormat: "rfc6901_json_pointer", authoritativeRoot: "/sections" } };
        const outputSecurity = securityApi?.inspectFullExportSecurity?.(result);
        return outputSecurity?.valid === true ? deepFreeze(result)
            : unavailable("ai_summary_security_validation_failed");
    }

    return Object.freeze({ SUMMARY_VERSION, PURPOSE, SECTION_ORDER,
        buildFullExportAiSummary });
});
