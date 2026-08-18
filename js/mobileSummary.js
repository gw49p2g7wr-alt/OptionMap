(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapMobileSummary = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SCHEMA_VERSION = 1;
    const SOURCE_CATEGORY = "options";
    const QUALITY_STATUSES = Object.freeze(["complete", "partial", "unavailable"]);
    const SUMMARY_KEYS = Object.freeze([
        "schemaVersion", "summaryId", "signature", "generatedAt", "marketDate",
        "producer", "sourceVersions", "dataQuality", "freshness", "payload"
    ]);
    const PAYLOAD_KEYS = Object.freeze([
        "overallV2", "currentPrice", "nearestLevels", "morningBaseline",
        "changeSinceMorning", "optionChanges", "alerts"
    ]);
    const PRICE_KEYS = Object.freeze(["available", "status", "value", "source", "mode",
        "quotedAt", "fetchedAt", "contract"]);
    const LEVEL_KEYS = Object.freeze(["available", "reason", "price", "distance", "optionType",
        "openInterest", "sourceCategory", "sourceContract", "sourceVersionKey"]);
    const SOURCE_VERSION_KEYS = Object.freeze(["source", "sourceDate", "tradingDate", "contract",
        "versionKey", "signature"]);
    const FRESHNESS_KEYS = Object.freeze(["currentPriceAt", "qriAt", "weeklyFuturesAt",
        "weeklyOptionsAt", "participantAt"]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const hasExactKeys = (value, keys) => isObject(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const validTimestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const finite = value => typeof value === "number" && Number.isFinite(value);

    function canonicalize(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (isObject(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }

    async function sha256(value) {
        const text = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(text).digest("hex");
        }
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function semanticContent(summary) {
        const payload = clone(summary.payload);
        if (Array.isArray(payload?.alerts)) {
            payload.alerts = payload.alerts.map(({ observedAt: _observedAt, ...alert }) => alert);
        }
        return {
            schemaVersion: summary.schemaVersion,
            marketDate: summary.marketDate,
            producer: summary.producer,
            sourceVersions: summary.sourceVersions,
            dataQuality: summary.dataQuality,
            freshness: summary.freshness,
            payload
        };
    }

    async function createSignature(summary) {
        return sha256(semanticContent(summary));
    }

    function validateCanonicalV2(canonical, activeContract) {
        if (!isObject(canonical) || canonical.parserVersion !== 2 || canonical.schemaVersion !== 2 ||
            canonical.source !== "qri-nikkei225-options" || canonical.isActiveContract !== true ||
            !/^20\d{2}-(0[1-9]|1[0-2])$/.test(canonical.contract || "") ||
            canonical.contract !== activeContract || !Array.isArray(canonical.records)) return false;
        const active = canonical.availableContracts?.filter(item => item?.active === true) || [];
        if (active.length !== 1 || active[0].contract !== activeContract) return false;
        return canonical.records.every(record => record?.contract === activeContract &&
            ["call", "put"].includes(record.optionType) && finite(record.strike) && record.strike > 0 &&
            typeof record.published === "boolean" && (record.published
                ? Number.isSafeInteger(record.value) && record.value >= 0 : record.value === null));
    }

    function unavailableLevel(side, reason) {
        return { available: false, reason, price: null, distance: null, optionType: null,
            openInterest: null, sourceCategory: SOURCE_CATEGORY, sourceContract: null,
            sourceVersionKey: null };
    }

    function selectNearestLevels({ canonical, activeContract, versionKey, currentPrice }) {
        const upperMissing = unavailableLevel("upper", "candidate_missing");
        const lowerMissing = unavailableLevel("lower", "candidate_missing");
        if (!finite(currentPrice) || currentPrice <= 0) {
            return { upper: unavailableLevel("upper", "current_price_unavailable"),
                lower: unavailableLevel("lower", "current_price_unavailable") };
        }
        if (!validateCanonicalV2(canonical, activeContract)) {
            throw new Error(canonical?.contract !== activeContract
                ? "qri_contract_mismatch" : "invalid_qri_canonical");
        }
        const choose = (optionType, predicate) => {
            const candidates = canonical.records.filter(record => record.optionType === optionType &&
                record.published === true && predicate(record.strike))
                .sort((left, right) => right.value - left.value || left.strike - right.strike)
                .slice(0, 3)
                .sort((left, right) => Math.abs(left.strike - currentPrice) -
                    Math.abs(right.strike - currentPrice) || left.strike - right.strike);
            const selected = candidates[0];
            return selected ? { available: true, reason: null, price: selected.strike,
                distance: Math.abs(selected.strike - currentPrice), optionType: optionType.toUpperCase(),
                openInterest: selected.value, sourceCategory: SOURCE_CATEGORY,
                sourceContract: activeContract, sourceVersionKey: versionKey || null } : null;
        };
        // Equality is intentionally excluded: upper is strictly above, lower strictly below.
        return { upper: choose("call", strike => strike > currentPrice) || upperMissing,
            lower: choose("put", strike => strike < currentPrice) || lowerMissing };
    }

    function buildOverallV2(result) {
        const available = isObject(result) && ["complete", "partial"].includes(result.status) &&
            finite(result.direction);
        return { available, status: isObject(result) && typeof result.status === "string"
            ? result.status : "unavailable", direction: available ? result.direction : null,
        directionLabel: available ? result.directionLabel : null,
        confidence: isObject(result) && finite(result.confidence) ? result.confidence : null,
        coverage: isObject(result) && finite(result.metadata?.coverage) ? result.metadata.coverage : null,
        agreement: isObject(result) && finite(result.confidenceFactors?.agreement)
            ? result.confidenceFactors.agreement : null };
    }

    function buildCurrentPrice(state) {
        const available = isObject(state) && finite(state.value) && state.value > 0;
        return { available, status: available ? "available" : "unavailable",
            value: available ? state.value : null, source: available && typeof state.source === "string"
                ? state.source : null, mode: available && typeof state.mode === "string" ? state.mode : null,
        quotedAt: available && validTimestamp(state.quotedAt) ? state.quotedAt : null,
        fetchedAt: available && validTimestamp(state.fetchedAt) ? state.fetchedAt : null,
        contract: available && typeof state.contract === "string" ? state.contract : null };
    }

    function buildAlerts({ overallV2, currentPrice, nearestLevels, qri, morningBaseline, observedAt }) {
        const alerts = [];
        const add = (code, severity, category, message, source) => {
            if (!alerts.some(alert => alert.code === code)) alerts.push({ code, severity, category,
                message, source, observedAt });
        };
        if (!overallV2.available) add("v2_unavailable", "warning", "judgment", "総合判定v2を利用できません", "overallV2");
        else if (overallV2.status === "partial") add("v2_partial", "info", "judgment", "総合判定v2は一部材料で算出しています", "overallV2");
        if (!currentPrice.available) add("current_price_unavailable", "warning", "price", "現在値を利用できません", "currentPrice");
        else if (currentPrice.mode === "manual") add("current_price_manual", "info", "price", "現在値は手動入力です", "currentPrice");
        if (qri?.usingFallback === true) add("qri_fallback", "warning", "options", "QRI建玉は直近正常値を使用中です", "qri");
        if (!qri?.available) add("qri_unavailable", "warning", "options", "QRI canonicalを利用できません", "qri");
        if (!nearestLevels.upper.available || !nearestLevels.lower.available)
            add("nearest_levels_partial", "info", "options", "上下の重要帯候補が一部ありません", "nearestLevels");
        if (!morningBaseline.available) add("morning_baseline_missing", "info", "baseline", "朝基準は未設定です", "morningBaseline");
        return alerts;
    }

    function determineDataQuality({ overallV2, currentPrice, nearestLevels }) {
        const missing = [];
        if (!overallV2.available) missing.push("overallV2");
        if (!currentPrice.available) missing.push("currentPrice");
        if (!nearestLevels.upper.available) missing.push("nearestLevels.upper");
        if (!nearestLevels.lower.available) missing.push("nearestLevels.lower");
        const coreAvailable = Number(overallV2.available) + Number(currentPrice.available);
        return { status: coreAvailable === 0 ? "unavailable" : missing.length ? "partial" : "complete",
            warnings: missing };
    }

    function buildMorningBaseline(input, marketDate) {
        const baseline = input?.baseline;
        if (input?.available !== true || !isObject(baseline)) {
            return { available: false, reason: typeof input?.reason === "string"
                ? input.reason : "not_captured", baselineId: null, capturedAt: null,
            dataQuality: null, sourceSummaryId: null, sourceSummarySignature: null };
        }
        if (baseline.marketDate !== marketDate) {
            return { available: false, reason: "market_date_mismatch", baselineId: null,
                capturedAt: null, dataQuality: null, sourceSummaryId: null, sourceSummarySignature: null };
        }
        const revision = baseline.revisions?.find(item => item.baselineId === baseline.activeBaselineId);
        if (!revision) {
            return { available: false, reason: "morning_baseline_corrupted", baselineId: null,
                capturedAt: null, dataQuality: null, sourceSummaryId: null, sourceSummarySignature: null };
        }
        return { available: true, reason: null, baselineId: revision.baselineId,
            capturedAt: revision.capturedAt, dataQuality: clone(revision.dataQuality),
            sourceSummaryId: revision.sourceSummaryId,
            sourceSummarySignature: revision.sourceSummarySignature };
    }

    function compactSourceVersions(input) {
        const output = [];
        for (const source of input || []) {
            if (!isObject(source) || typeof source.source !== "string") continue;
            output.push({ source: source.source, sourceDate: source.sourceDate || null,
                tradingDate: source.tradingDate || null, contract: source.contract || null,
                versionKey: source.versionKey || null, signature: source.signature || null });
        }
        return output;
    }

    async function buildMobileSummary(input) {
        const source = clone(input || {});
        const generatedAt = source.generatedAt || new Date().toISOString();
        if (!validTimestamp(generatedAt)) throw new Error("invalid_generated_at");
        const overallV2 = buildOverallV2(source.overallV2);
        const currentPrice = buildCurrentPrice(source.currentPrice);
        const qri = source.qri || {};
        let nearestLevels;
        if (qri.available === true) {
            nearestLevels = selectNearestLevels({ canonical: qri.canonical,
                activeContract: qri.activeContract, versionKey: qri.versionKey,
                currentPrice: currentPrice.value });
        } else {
            nearestLevels = { upper: unavailableLevel("upper", currentPrice.available
                ? "qri_unavailable" : "current_price_unavailable"), lower: unavailableLevel("lower",
            currentPrice.available ? "qri_unavailable" : "current_price_unavailable") };
        }
        const morningBaseline = buildMorningBaseline(source.morningBaseline, source.marketDate);
        const changeSinceMorning = { available: false, reason: morningBaseline.available
            ? "comparison_not_implemented" : "morning_baseline_missing" };
        const optionChanges = { available: false, reason: morningBaseline.available
            ? "comparison_not_implemented" : "morning_baseline_missing", items: [] };
        const alerts = buildAlerts({ overallV2, currentPrice, nearestLevels, qri,
            morningBaseline, observedAt: generatedAt });
        const payload = { overallV2, currentPrice, nearestLevels, morningBaseline,
            changeSinceMorning, optionChanges, alerts };
        const dataQuality = determineDataQuality({ overallV2, currentPrice, nearestLevels });
        const summary = { schemaVersion: SCHEMA_VERSION, summaryId: "", signature: "",
            generatedAt, marketDate: source.marketDate, producer: { appVersion:
            source.producer?.appVersion || null, platform: source.producer?.platform || null },
        sourceVersions: compactSourceVersions(source.sourceVersions), dataQuality,
        freshness: { currentPriceAt: currentPrice.quotedAt || currentPrice.fetchedAt || null,
            qriAt: qri.pageUpdatedAt || qri.fetchedAt || null,
            weeklyFuturesAt: source.freshness?.weeklyFuturesAt || null,
            weeklyOptionsAt: source.freshness?.weeklyOptionsAt || null,
            participantAt: source.freshness?.participantAt || null }, payload };
        summary.signature = await createSignature(summary);
        summary.summaryId = `ms1-${summary.signature.slice(0, 24)}`;
        const validation = await validateMobileSummary(summary);
        if (!validation.valid) throw new Error(`mobile_summary_invalid:${validation.errors.join(",")}`);
        return summary;
    }

    function sensitiveContentErrors(summary) {
        const text = JSON.stringify(summary);
        const errors = [];
        const patterns = [
            [/([A-Za-z]:\\|\/(?:Users|home|var|private|tmp)\/)/i, "absolute_path"],
            [/(api[_-]?key|credential|service.?account|password|auth.?token|bearer\s+[\w.-]+)/i, "credential"],
            [/(git\s*(?:branch|commit)|refs\/heads\/)/i, "git_information"],
            [/(<!doctype|<html|<script|<table)/i, "raw_html"],
            [/(PK\x03\x04|workbook|worksheet|raw.?excel)/i, "raw_excel"],
            [/(local\s*storage.*(?:dump|history)|indexeddb.*(?:dump|history)|full.?history)/i, "storage_dump"],
            [/\b(?:Error|TypeError|ReferenceError):.*(?:\n|\\n).*\bat\s/i, "debug_stack"]
        ];
        patterns.forEach(([pattern, code]) => { if (pattern.test(text)) errors.push(code); });
        return errors;
    }

    async function validateMobileSummary(summary) {
        const errors = [];
        if (!hasExactKeys(summary, SUMMARY_KEYS)) errors.push("summary_fields_invalid");
        if (summary?.schemaVersion !== SCHEMA_VERSION) errors.push("schema_version_invalid");
        if (!validTimestamp(summary?.generatedAt)) errors.push("generated_at_invalid");
        if (!validDate(summary?.marketDate)) errors.push("market_date_invalid");
        if (!hasExactKeys(summary?.payload, PAYLOAD_KEYS)) errors.push("payload_fields_invalid");
        const overall = summary?.payload?.overallV2;
        if (!isObject(overall) || typeof overall.available !== "boolean" ||
            (overall.direction !== null && (!finite(overall.direction) || overall.direction < -100 || overall.direction > 100)) ||
            [overall.confidence, overall.coverage, overall.agreement].some(value =>
                value !== null && (!finite(value) || value < 0 || value > 100))) errors.push("overall_v2_invalid");
        const price = summary?.payload?.currentPrice;
        if (!hasExactKeys(price, PRICE_KEYS) || typeof price.available !== "boolean" ||
            (price.available ? !finite(price.value) || price.value <= 0 || price.status !== "available" :
                price.value !== null || price.status !== "unavailable" || price.source !== null ||
                price.mode !== null || price.quotedAt !== null || price.fetchedAt !== null || price.contract !== null) ||
            [price.quotedAt, price.fetchedAt].some(value => value !== null && !validTimestamp(value)))
            errors.push("current_price_invalid");
        const levels = summary?.payload?.nearestLevels;
        for (const side of ["upper", "lower"]) {
            const level = levels?.[side];
            if (!hasExactKeys(level, LEVEL_KEYS) || ![SOURCE_CATEGORY].includes(level.sourceCategory)) {
                errors.push(`nearest_${side}_invalid`); continue;
            }
            if (level.available) {
                const expectedType = side === "upper" ? "CALL" : "PUT";
                const relation = side === "upper" ? level.price > price?.value : level.price < price?.value;
                if (!price?.available || !finite(level.price) || !relation || level.optionType !== expectedType ||
                    !finite(level.distance) || level.distance !== Math.abs(level.price - price.value) ||
                    !Number.isSafeInteger(level.openInterest) || level.openInterest < 0) errors.push(`nearest_${side}_invalid`);
            } else if (level.price !== null || level.distance !== null || typeof level.reason !== "string") {
                errors.push(`nearest_${side}_invalid`);
            }
        }
        const baseline = summary?.payload?.morningBaseline;
        const baselineKeys = ["available", "reason", "baselineId", "capturedAt", "dataQuality",
            "sourceSummaryId", "sourceSummarySignature"];
        if (!hasExactKeys(baseline, baselineKeys) || typeof baseline.available !== "boolean" ||
            baseline.available && (baseline.reason !== null || !/^mb1-[a-f0-9]{24}$/.test(baseline.baselineId || "") ||
                !validTimestamp(baseline.capturedAt) || !["complete", "partial"].includes(baseline.dataQuality?.status) ||
                !/^ms1-[a-f0-9]{24}$/.test(baseline.sourceSummaryId || "") ||
                !/^[a-f0-9]{64}$/.test(baseline.sourceSummarySignature || "")) ||
            !baseline.available && (typeof baseline.reason !== "string" || baseline.baselineId !== null ||
                baseline.capturedAt !== null || baseline.dataQuality !== null || baseline.sourceSummaryId !== null ||
                baseline.sourceSummarySignature !== null)) errors.push("morning_baseline_invalid");
        const change = summary?.payload?.changeSinceMorning;
        if (!isObject(change) || change.available !== false || change.reason !==
            (baseline?.available ? "comparison_not_implemented" : "morning_baseline_missing"))
            errors.push("change_since_morning_invalid");
        const optionChanges = summary?.payload?.optionChanges;
        if (!isObject(optionChanges) || optionChanges.available !== false ||
            optionChanges.reason !== (baseline?.available ? "comparison_not_implemented" : "morning_baseline_missing") ||
            !Array.isArray(optionChanges.items) || optionChanges.items.length)
            errors.push("option_changes_invalid");
        const alerts = summary?.payload?.alerts;
        if (!Array.isArray(alerts) || new Set(alerts?.map(alert => alert?.code)).size !== alerts?.length ||
            alerts.some(alert => !hasExactKeys(alert, ["code", "severity", "category", "message", "source", "observedAt"]) ||
                !["info", "warning", "critical"].includes(alert.severity) ||
                [alert.code, alert.category, alert.message, alert.source].some(value => typeof value !== "string" || !value) ||
                !validTimestamp(alert.observedAt)))
            errors.push("alerts_invalid");
        if (!QUALITY_STATUSES.includes(summary?.dataQuality?.status) || !Array.isArray(summary?.dataQuality?.warnings))
            errors.push("data_quality_invalid");
        if (!hasExactKeys(summary?.producer, ["appVersion", "platform"]) ||
            [summary?.producer?.appVersion, summary?.producer?.platform].some(value =>
                value !== null && typeof value !== "string")) errors.push("producer_invalid");
        if (!Array.isArray(summary?.sourceVersions) || summary?.sourceVersions.some(item =>
            !hasExactKeys(item, SOURCE_VERSION_KEYS) || typeof item.source !== "string" ||
            [item.sourceDate, item.tradingDate].some(value => value !== null && !validDate(value)) ||
            [item.contract, item.versionKey, item.signature].some(value => value !== null && typeof value !== "string")))
            errors.push("source_versions_invalid");
        if (!hasExactKeys(summary?.freshness, FRESHNESS_KEYS) || Object.values(summary.freshness || {})
            .some(value => value !== null && !validTimestamp(value))) errors.push("freshness_invalid");
        errors.push(...sensitiveContentErrors(summary));
        if (typeof summary?.signature !== "string" || !/^[a-f0-9]{64}$/.test(summary.signature) ||
            summary.signature !== await createSignature(summary)) errors.push("signature_mismatch");
        if (summary?.summaryId !== `ms1-${String(summary?.signature).slice(0, 24)}`)
            errors.push("summary_id_mismatch");
        return { valid: errors.length === 0, errors: [...new Set(errors)] };
    }

    return Object.freeze({ SCHEMA_VERSION, canonicalize, createSignature, semanticContent,
        selectNearestLevels, determineDataQuality, buildAlerts, buildMobileSummary,
        validateMobileSummary, sensitiveContentErrors });
});
