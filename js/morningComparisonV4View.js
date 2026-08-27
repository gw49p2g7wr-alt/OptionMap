(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningComparisonV4View = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const finite = value => typeof value === "number" && Number.isFinite(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }
    const signed = value => finite(value) ? `${value > 0 ? "+" : ""}${value}` : "—";
    const scoreMovement = value => !finite(value) ? "比較不可" : value > 0
        ? `買い方向へ +${value}` : value < 0 ? `売り方向へ ${value}` : "変化なし";
    const quality = value => ({ complete: "良好", partial: "一部データ不足" })[value] || "利用不可";
    const transition = value => ({ unchanged: "変化なし", improved: "改善",
        degraded: "低下", changed_unclassified: "構成変化あり" })[value] || "比較不可";
    const relation = value => ({ same_direction: "需給変化と価格変化：同方向",
        opposite_direction: "需給変化と価格変化：逆方向",
        zero_involved: "需給変化と価格変化：変化なしを含む",
        unavailable: "需給変化と価格変化：比較不可" })[value] || "需給変化と価格変化：比較不可";
    const reason = value => ({ not_published: "正式比較の公開待ちです",
        new_market_refresh: "市場データ更新中です", refresh_in_progress: "市場データ更新中です",
        restore_missing: "有効なMorning v4朝基準がありません",
        restore_invalid: "Morning v4朝基準を検証できません",
        restore_not_applicable: "保存済み朝基準は現在の正式scopeに適用できません",
        active_revision_invalid: "有効な朝基準revisionを確認できません",
        active_revision_changed: "朝基準revisionが変更されたため比較を無効化しました",
        baseline_identity_mismatch: "朝基準identityを確認できません",
        collector_not_ready: "正式データが揃うまで比較できません",
        mixed_acquisition: "取得世代が混在したため比較を無効化しました",
        request_mismatch: "取得requestが一致しないため比較を無効化しました",
        generation_mismatch: "取得世代が一致しないため比較を無効化しました",
        fingerprint_mismatch: "正式入力fingerprintが一致しません",
        scope_mismatch: "正式scopeが一致しません", trading_date_mismatch: "取引日が一致しません",
        contract_mismatch: "限月が一致しません", logic_version_mismatch: "判定logicが一致しません",
        comparison_unavailable: "正式比較を利用できません",
        identity_binding_failed: "正式朝基準のidentity bindingを確認できません" })[value] ||
        "正式比較を利用できません";
    const jst = value => {
        if (!text(value) || Number.isNaN(Date.parse(value))) return "時刻不明";
        return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric",
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            second: "2-digit", hour12: false }).format(new Date(value));
    };
    const price = value => finite(value) ? `${value.toLocaleString("ja-JP")}円` : "—";
    const component = (label, value) => value?.available === true ? { label, available: true,
        baseline: signed(value.baselineDirection), current: signed(value.currentDirection),
        delta: signed(value.directionDelta), movement: scoreMovement(value.directionDelta) } :
        { label, available: false, baseline: "—", current: "—", delta: "—", movement: "利用不可" };

    function unavailable(value = null) {
        return deepFreeze({ available: false, status: "利用不可",
            reason: reason(value?.reason), identity: { selectedBaselineId: value?.selectedBaselineId || null,
                comparisonBaselineId: null, capturedAt: null,
                publicationGeneration: value?.publicationGeneration || 0, scopeId: value?.scopeId || null,
                formalTradingDate: value?.formalTradingDate || null, contract: value?.contract || null,
                formalSnapshotInputFingerprint: value?.formalSnapshotInputFingerprint || null,
                restoreBindingVerified: false }, capturedAt: "—", score: null, price: null,
            relation: "需給変化と価格変化：比較不可", dataQuality: null, components: [] });
    }

    function createViewModel(runtimeState) {
        const comparison = runtimeState?.comparison;
        if (runtimeState?.status !== "available" || runtimeState.available !== true ||
            comparison?.available !== true || comparison.status !== "comparable") return unavailable(runtimeState);
        const selected = text(runtimeState.selectedBaselineId);
        const runtimeBaseline = text(runtimeState.baselineIdentity?.baselineId);
        const comparisonBaseline = text(comparison.baselineIdentity?.baselineId);
        const identityValid = selected && selected === runtimeBaseline && selected === comparisonBaseline &&
            text(runtimeState.scopeId) && text(runtimeState.formalTradingDate) && text(runtimeState.contract) &&
            text(runtimeState.formalSnapshotInputFingerprint) &&
            Number.isInteger(runtimeState.publicationGeneration) && runtimeState.publicationGeneration > 0 &&
            runtimeState.diagnostics?.baselineIdentityMatched === true &&
            runtimeState.diagnostics?.raceGuardPassed === true;
        if (!identityValid) return unavailable({ ...runtimeState, reason: "identity_binding_failed" });
        const overall = comparison.overallV2;
        const priceComparison = comparison.price;
        const dataQuality = comparison.dataQuality;
        if (![overall?.baselineScore, overall?.currentScore, overall?.delta,
            priceComparison?.baselineValue, priceComparison?.currentValue, priceComparison?.delta,
            priceComparison?.percentDelta].every(finite) || !dataQuality) return unavailable({
            ...runtimeState, reason: "comparison_unavailable" });
        return deepFreeze({ available: true, status: "正式比較 利用可能", reason: null,
            identity: { selectedBaselineId: selected, comparisonBaselineId: comparisonBaseline,
                capturedAt: runtimeState.baselineIdentity.capturedAt,
                publicationGeneration: runtimeState.publicationGeneration, scopeId: runtimeState.scopeId,
                formalTradingDate: runtimeState.formalTradingDate, contract: runtimeState.contract,
                formalSnapshotInputFingerprint: runtimeState.formalSnapshotInputFingerprint,
                restoreBindingVerified: true }, capturedAt: jst(runtimeState.baselineIdentity.capturedAt),
            score: { baseline: signed(overall.baselineScore), current: signed(overall.currentScore),
                baselineLabel: overall.baselineLabel, currentLabel: overall.currentLabel,
                delta: signed(overall.delta), movement: scoreMovement(overall.delta),
                scale: "-100（売り最大）／0（中立）／+100（買い最大）／確率ではありません" },
            price: { baseline: price(priceComparison.baselineValue), current: price(priceComparison.currentValue),
                delta: `${signed(priceComparison.delta)}円`,
                percent: `${signed(Number(priceComparison.percentDelta.toFixed(2)))}%` },
            relation: relation(comparison.divergence?.relation), dataQuality: {
                current: quality(dataQuality.currentStatus), baseline: quality(dataQuality.baselineStatus),
                transition: transition(dataQuality.transition), warnings: [...(dataQuality.currentWarnings || [])] },
            components: [component("オプション需給寄与", comparison.optionComponent),
                component("週次先物需給", comparison.weeklyComponent)] });
    }

    return deepFreeze({ createViewModel, scoreMovement, relation, reason });
});
