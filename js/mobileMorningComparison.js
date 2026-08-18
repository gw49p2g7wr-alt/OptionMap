(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("./qriOptionsHistory.js") : root?.OptionMapQriOptionsHistory;
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const api = factory(historyApi, qriApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMobileMorningComparison = api;
})(typeof window !== "undefined" ? window : globalThis, function (historyApi, qriApi) {
    "use strict";

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const side = value => value > 0 ? "buy" : value < 0 ? "sell" : "neutral";
    const rawSignature = value => typeof value === "string" ? value.replace(/^sha256:/, "") : null;
    const unavailable = reason => ({ available: false, reason });

    function compareOverallV2(baseline, current) {
        if (!object(baseline) || !object(current) || baseline.available !== true || current.available !== true)
            return unavailable("overall_v2_unavailable");
        const values = [baseline.direction, current.direction, baseline.confidence, current.confidence,
            baseline.coverage, current.coverage, baseline.agreement, current.agreement];
        if (values.some(value => !finite(value))) throw new Error("invalid_overall_v2_numeric_state");
        const baselineSide = side(baseline.direction); const currentSide = side(current.direction);
        let transition = "label_unchanged";
        if (baselineSide !== currentSide) transition = `${baselineSide}_to_${currentSide}`;
        else if (baseline.directionLabel !== current.directionLabel || baseline.direction !== current.direction)
            transition = "strength_changed_same_side";
        return { available: true, baselineStatus: baseline.status, currentStatus: current.status,
            baselineDirection: baseline.direction, currentDirection: current.direction,
            directionDelta: current.direction - baseline.direction,
            baselineLabel: baseline.directionLabel, currentLabel: current.directionLabel,
            labelChanged: baseline.directionLabel !== current.directionLabel,
            baselineSide, currentSide, transition,
            confidenceDelta: current.confidence - baseline.confidence,
            coverageDelta: current.coverage - baseline.coverage,
            agreementDelta: current.agreement - baseline.agreement };
    }

    function compareCurrentPrice(baseline, current) {
        if (!object(baseline) || baseline.available !== true) return unavailable("baseline_price_unavailable");
        if (!object(current) || current.available !== true) return unavailable("current_price_unavailable");
        if (!finite(baseline.value) || baseline.value < 0 || !finite(current.value) || current.value < 0)
            throw new Error("invalid_price");
        const metadata = value => ({ value: value.value, source: value.source, mode: value.mode,
            contract: value.contract, quotedAt: value.quotedAt });
        if (baseline.contract !== current.contract) return { ...unavailable("contract_mismatch"),
            baseline: metadata(baseline), current: metadata(current) };
        const delta = current.value - baseline.value;
        return { available: true, baseline: metadata(baseline), current: metadata(current), delta,
            percentChange: baseline.value === 0 ? null : delta / baseline.value * 100,
            sourceChanged: baseline.source !== current.source, modeChanged: baseline.mode !== current.mode };
    }

    function compareDataQuality(baseline, current) {
        const statuses = ["complete", "partial", "unavailable"];
        if (!object(baseline) || !object(current) || !statuses.includes(baseline.status) ||
            !statuses.includes(current.status) || !Array.isArray(baseline.warnings) ||
            !Array.isArray(current.warnings)) throw new Error("invalid_data_quality");
        const before = [...new Set(baseline.warnings)].sort();
        const after = [...new Set(current.warnings)].sort();
        const rank = { unavailable: 0, partial: 1, complete: 2 };
        return { available: true, baselineStatus: baseline.status, currentStatus: current.status,
            changed: baseline.status !== current.status || before.join("\0") !== after.join("\0"),
            transition: rank[current.status] > rank[baseline.status] ? "improved" :
                rank[current.status] < rank[baseline.status] ? "degraded" : "unchanged",
            baselineWarnings: before, currentWarnings: after,
            addedWarnings: after.filter(item => !before.includes(item)),
            resolvedWarnings: before.filter(item => !after.includes(item)) };
    }

    async function resolveBaselineQriRevision(history, baseline) {
        if (!object(baseline) || !Array.isArray(baseline.revisions)) return unavailable("morning_baseline_missing");
        const active = baseline.revisions.find(item => item.baselineId === baseline.activeBaselineId);
        if (!active) return unavailable("baseline_revision_missing");
        const availability = active.qriAvailability;
        if (!availability) return unavailable("qri_availability_unknown");
        if (availability.available !== true) {
            return unavailable(["unavailable", "partial"].includes(availability.openInterestStatus)
                ? "baseline_qri_unavailable" : "qri_reference_missing");
        }
        const reference = active.comparisonReference;
        if (!reference) return unavailable("qri_reference_missing");
        const validation = await historyApi?.validateHistory?.(history);
        if (!validation?.valid) return unavailable("history_corrupted");
        // Baseline references are immutable audit links; future retention must preserve referenced revisions.
        const entry = history.entries.find(item => item.contract === reference.contract &&
            item.sourceDateKey === reference.tradingDate);
        const revision = entry?.revisions?.find(item => item.versionKey === reference.versionKey);
        if (!revision) return unavailable("baseline_revision_missing");
        if (revision.signature !== rawSignature(reference.signature)) return unavailable("signature_mismatch");
        if (revision.contract !== reference.contract) return unavailable("contract_mismatch");
        if (revision.tradingDate !== reference.tradingDate) return unavailable("trading_date_mismatch");
        return { available: true, baselineId: active.baselineId, revision: clone(revision) };
    }

    function recordMap(canonical, optionType) {
        return new Map(canonical.records.filter(record => record.optionType === optionType)
            .map(record => [record.strike, record]));
    }
    function summarizeSide(baseline, current, optionType) {
        const morning = recordMap(baseline, optionType); const now = recordMap(current, optionType);
        const strikes = [...new Set([...morning.keys(), ...now.keys()])].sort((a, b) => a - b);
        const rows = strikes.map(strike => {
            const left = morning.get(strike); const right = now.get(strike);
            const lp = left?.published === true; const rp = right?.published === true;
            const state = lp && rp ? "comparable" : lp ? "morning_only" : rp ? "current_only" : "unobserved";
            const delta = state === "comparable" ? right.value - left.value : null;
            return { optionType: optionType.toUpperCase(), strike, state,
                morningValue: lp ? left.value : null, currentValue: rp ? right.value : null, delta,
                percentChange: state === "comparable" && left.value !== 0 ? delta / left.value * 100 : null };
        });
        const comparable = rows.filter(row => row.state === "comparable");
        const top = predicate => comparable.filter(predicate).sort((a, b) =>
            Math.abs(b.delta) - Math.abs(a.delta) || a.strike - b.strike).slice(0, 3);
        const count = state => rows.filter(row => row.state === state).length;
        return { comparableCount: count("comparable"), morningOnlyCount: count("morning_only"),
            currentOnlyCount: count("current_only"), unobservedCount: count("unobserved"), invalidCount: 0,
            increasedCount: comparable.filter(row => row.delta > 0).length,
            decreasedCount: comparable.filter(row => row.delta < 0).length,
            unchangedCount: comparable.filter(row => row.delta === 0).length,
            netDelta: comparable.reduce((sum, row) => sum + row.delta, 0),
            absoluteDeltaTotal: comparable.reduce((sum, row) => sum + Math.abs(row.delta), 0),
            topIncreases: top(row => row.delta > 0), topDecreases: top(row => row.delta < 0),
            morningOnly: rows.filter(row => row.state === "morning_only"),
            currentOnly: rows.filter(row => row.state === "current_only") };
    }

    async function validateQri(canonical, versionKey, signature) {
        if (!canonical || !qriApi?.validateCanonical?.(canonical, { allowUnresolvedContracts: true }))
            return "comparison_invalid";
        const actual = await qriApi.createSignature(canonical);
        if (actual !== rawSignature(signature)) return "signature_mismatch";
        const expected = `qri-options-v2|${canonical.contract}|${canonical.pageUpdatedAt}|sha256:${actual}`;
        return expected === versionKey ? null : "version_key_mismatch";
    }

    async function compareQriIntraday(input) {
        const baseline = input?.baselineCanonical; const current = input?.currentCanonical;
        if (!baseline) return unavailable("baseline_revision_missing");
        if (!current) return unavailable("current_qri_missing");
        const baselineError = await validateQri(baseline, input.baselineVersionKey, input.baselineSignature);
        const currentError = await validateQri(current, input.currentVersionKey, input.currentSignature);
        if (baselineError || currentError) return unavailable(baselineError || currentError);
        if (baseline.contract !== current.contract) return unavailable("contract_mismatch");
        if (baseline.tradingDate !== current.tradingDate) return unavailable("trading_date_mismatch");
        if (input.marketDate !== baseline.tradingDate) return unavailable("market_date_mismatch");
        if (baseline.openInterestStatus === "unavailable") return unavailable("baseline_qri_unavailable");
        if (current.openInterestStatus === "unavailable") return unavailable("current_qri_unavailable");
        return { available: true, contract: current.contract, tradingDate: current.tradingDate,
            baselineVersionKey: input.baselineVersionKey, currentVersionKey: input.currentVersionKey,
            CALL: summarizeSide(baseline, current, "call"), PUT: summarizeSide(baseline, current, "put") };
    }

    function summaryItems({ overallV2, currentPrice, dataQuality, optionChanges }, limit = 3) {
        const items = [];
        const add = item => { if (!items.some(existing => existing.code === item.code)) items.push(item); };
        if (overallV2?.available && overallV2.baselineSide !== overallV2.currentSide)
            add({ code: "overall_side_changed", category: "overallV2", severity: "info",
                text: formatTransition(overallV2.transition) });
        else if (overallV2?.available && overallV2.transition !== "label_unchanged")
            add({ code: "overall_strength_changed", category: "overallV2", severity: "info",
                text: formatTransition(overallV2.transition, overallV2.directionDelta) });
        if (dataQuality?.transition === "degraded") add({ code: "data_quality_degraded",
            category: "dataQuality", severity: "warning", text: "朝よりデータ状態が低下しました" });
        if (optionChanges?.available === false && ["baseline_qri_unavailable", "current_qri_unavailable"]
            .includes(optionChanges.reason)) add({ code: "qri_availability_changed", category: "options",
            severity: "info", text: formatReason(optionChanges.reason) });
        if (currentPrice?.available && currentPrice.delta !== 0) add({ code: "current_price_changed",
            category: "currentPrice", severity: "info",
            text: `現在値は朝から${currentPrice.delta > 0 ? "+" : ""}${currentPrice.delta.toLocaleString("ja-JP")}円` });
        return items.slice(0, Math.max(0, Math.min(3, limit)));
    }

    function formatTransition(transition, delta = null) {
        const texts = { buy_to_sell: "買い優勢から売り優勢へ反転しました",
            sell_to_buy: "売り優勢から買い優勢へ反転しました", neutral_to_buy: "中立から買い優勢になりました",
            neutral_to_sell: "中立から売り優勢になりました", buy_to_neutral: "買い優勢から中立になりました",
            sell_to_neutral: "売り優勢から中立になりました", label_unchanged: "総合判定の区分は変わっていません" };
        if (texts[transition]) return texts[transition];
        return delta > 0 ? "買い方向の数値が強まりました" : delta < 0 ? "売り方向の数値が強まりました" :
            "総合判定の強さ区分が変わりました";
    }
    function formatReason(reason) {
        return ({ morning_baseline_missing: "朝基準がないため比較できません",
            market_date_mismatch: "朝基準と現在の営業日が異なるため比較できません",
            qri_reference_missing: "朝のQRI参照情報がないため比較できません",
            baseline_revision_missing: "朝のQRI正式revisionを取得できないため比較できません",
            current_qri_missing: "現在のQRI正式データがないため比較できません",
            baseline_qri_unavailable: "朝のQRI建玉が未提供だったため、オプション変化は比較できません",
            current_qri_unavailable: "現在のQRI建玉が未提供のため、オプション変化は比較できません",
            contract_mismatch: "朝と現在の限月が異なるため比較できません",
            trading_date_mismatch: "朝と現在の取引日が異なるため比較できません",
            signature_mismatch: "QRI正式データの署名を確認できないため比較できません",
            version_key_mismatch: "QRI正式revisionの識別情報が一致しないため比較できません",
            history_corrupted: "QRI正式履歴を検証できないため比較できません",
            qri_availability_unknown: "朝のQRI建玉状態を確認できないため、オプション変化は比較できません",
            comparison_invalid: "比較データを検証できないため比較できません" })[reason] || "比較できません";
    }

    const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
        keys.every(key => Object.hasOwn(value, key));
    const timestamp = value => typeof value === "string" && !Number.isNaN(Date.parse(value));
    function validateChangeSinceMorning(value, baselineId = null) {
        if (!object(value) || typeof value.available !== "boolean") return false;
        if (!value.available) return typeof value.reason === "string" &&
            Object.keys(value).every(key => ["available", "reason"].includes(key));
        if (!exact(value, ["available", "reason", "baselineId", "baselineCapturedAt", "comparedAt",
            "overallV2", "currentPrice", "dataQuality", "optionAvailability", "summaryItems"]) ||
            value.reason !== null || value.baselineId !== baselineId || !timestamp(value.baselineCapturedAt) ||
            !timestamp(value.comparedAt) || typeof value.optionAvailability !== "string" ||
            !Array.isArray(value.summaryItems) || value.summaryItems.length > 3 ||
            value.summaryItems.some(item => !exact(item, ["code", "category", "severity", "text"]) ||
                [item.code, item.category, item.severity, item.text].some(field => typeof field !== "string" || !field)))
            return false;
        if (!object(value.overallV2) || typeof value.overallV2.available !== "boolean" ||
            value.overallV2.available && [value.overallV2.baselineDirection, value.overallV2.currentDirection,
                value.overallV2.directionDelta, value.overallV2.confidenceDelta,
                value.overallV2.coverageDelta, value.overallV2.agreementDelta].some(number => !finite(number))) return false;
        if (!object(value.currentPrice) || typeof value.currentPrice.available !== "boolean" ||
            value.currentPrice.available && (!finite(value.currentPrice.delta) ||
                value.currentPrice.percentChange !== null && !finite(value.currentPrice.percentChange))) return false;
        return object(value.dataQuality) && value.dataQuality.available === true &&
            ["improved", "degraded", "unchanged"].includes(value.dataQuality.transition);
    }

    function validateOptionChanges(value) {
        if (!object(value) || typeof value.available !== "boolean") return false;
        if (!value.available) return typeof value.reason === "string" &&
            Object.keys(value).every(key => ["available", "reason", "items"].includes(key)) &&
            (!Object.hasOwn(value, "items") || Array.isArray(value.items) && value.items.length === 0);
        if (!exact(value, ["available", "contract", "tradingDate", "baselineVersionKey",
            "currentVersionKey", "CALL", "PUT"]) || typeof value.contract !== "string" ||
            typeof value.tradingDate !== "string" || typeof value.baselineVersionKey !== "string" ||
            typeof value.currentVersionKey !== "string") return false;
        const sideKeys = ["comparableCount", "morningOnlyCount", "currentOnlyCount", "unobservedCount",
            "invalidCount", "increasedCount", "decreasedCount", "unchangedCount", "netDelta",
            "absoluteDeltaTotal", "topIncreases", "topDecreases", "morningOnly", "currentOnly"];
        const row = item => exact(item, ["optionType", "strike", "state", "morningValue", "currentValue",
            "delta", "percentChange"]) && ["CALL", "PUT"].includes(item.optionType) && finite(item.strike) &&
            ["comparable", "morning_only", "current_only", "unobserved"].includes(item.state) &&
            [item.morningValue, item.currentValue, item.delta, item.percentChange]
                .every(number => number === null || finite(number));
        return [value.CALL, value.PUT].every(sideValue => exact(sideValue, sideKeys) &&
            sideKeys.slice(0, 8).every(key => Number.isSafeInteger(sideValue[key]) && sideValue[key] >= 0) &&
            finite(sideValue.netDelta) && finite(sideValue.absoluteDeltaTotal) &&
            [sideValue.topIncreases, sideValue.topDecreases, sideValue.morningOnly, sideValue.currentOnly]
                .every(list => Array.isArray(list) && list.every(row)) &&
            sideValue.topIncreases.length <= 3 && sideValue.topDecreases.length <= 3);
    }

    function createComparison({ marketDate, baselineRevision, currentSummary, optionChanges, comparedAt }) {
        if (!baselineRevision || !currentSummary) return unavailable("morning_baseline_missing");
        if (currentSummary.marketDate !== marketDate) return unavailable("market_date_mismatch");
        const overallV2 = compareOverallV2(baselineRevision.overallV2, currentSummary.payload.overallV2);
        const currentPrice = compareCurrentPrice(baselineRevision.currentPrice, currentSummary.payload.currentPrice);
        const dataQuality = compareDataQuality(baselineRevision.dataQuality, currentSummary.dataQuality);
        const result = { available: true, reason: null, baselineId: baselineRevision.baselineId,
            baselineCapturedAt: baselineRevision.capturedAt, comparedAt, overallV2, currentPrice,
            dataQuality, optionAvailability: optionChanges.available ? "comparable" : optionChanges.reason,
            summaryItems: [] };
        result.summaryItems = summaryItems({ ...result, optionChanges });
        return result;
    }

    return Object.freeze({ compareOverallV2, compareCurrentPrice, compareDataQuality,
        resolveBaselineQriRevision, compareQriIntraday, summaryItems, formatReason,
        formatTransition, createComparison, validateChangeSinceMorning, validateOptionChanges });
});
