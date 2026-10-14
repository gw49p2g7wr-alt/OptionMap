(function (root, factory) {
    const api = factory();
    if (root) root.OptionMapMobileSummaryPreview = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    let latestQri = null;
    let latestSummary = null;
    let latestBaselineResolution = null;
    let latestPresentation = null;
    let updateSequence = 0;
    let saveInProgress = false;

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const text = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };
    const price = value => Number.isFinite(value) ? `${value.toLocaleString("ja-JP")}円` : "利用不可";
    const time = value => value ? new Date(value).toLocaleString("ja-JP") : "時刻なし";
    const signed = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "--";
    const roundedPercent = value => Number.isFinite(value) ? `${Math.round(value)}%` : "--%";
    const generatedAtJst = value => {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "生成時刻：不明";
        return `生成時刻：${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo",
            hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}（JST）`;
    };
    const morningBaselineUpdateConfirmation = (marketDate, capturedAt) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
            timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false
        }).formatToParts(new Date(capturedAt)).map(part => [part.type, part.value]));
        const savedAt = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
        return `取引日${marketDate}の朝基準が保存済みです。\n` +
            `保存日時：${savedAt}\n現在の状態で更新しますか？`;
    };
    const qualityLabel = value => ({ complete: "データ良好", partial: "一部データ不足",
        unavailable: "データ利用不可" })[value] || "状態不明";
    const morningQualityLabel = value => ({ complete: "良好", partial: "一部データ不足",
        unavailable: "利用不可" })[value] || "状態不明";
    const freshnessLabel = key => ({ currentPriceAt: "現在値", qriAt: "QRIオプション",
        weeklyFuturesAt: "週次先物", weeklyOptionsAt: "週次オプション",
        participantAt: "参加者別" })[key] || key;
    const reasonLabel = reason => ({ candidate_missing: "現在値付近に該当候補がありません",
        legacy_exact_match_only: "従来形式の朝基準のため、現在は比較対象外です",
        session_mismatch: "保存済みの朝基準は現在の比較時間外です",
        not_captured: "朝基準はまだ保存されていません",
        current_state_invalid: "現在の市場状態を確認できません" })[reason] ||
        window.OptionMapMobileMorningComparison.formatReason(reason);
    const setCardState = (id, state, states) => {
        const element = document.getElementById(id);
        if (!element) return;
        states.forEach(item => element.classList.toggle(`is-${item}`, item === state));
    };

    function captureFormalComparisonV4(runtimeState = window.getMorningComparisonV4RuntimeState?.() || null) {
        const adapter = window.OptionMapMorningComparisonV4View;
        if (!adapter?.createViewModel) return null;
        return adapter.createViewModel(runtimeState);
    }

    function captureFormalStatusV4() {
        return window.OptionMapMorningBaselineV4StatusView?.createViewModel(
            window.getMorningBaselineV4RestoreRuntimeState?.() || null,
            window.getMorningBaselineV4AutomaticCaptureOutcome?.() || null,
            window.getMorningBaselineV4SchedulerState?.() || null) || null;
    }

    function applyFormalComparisonV4(model, formalStatus = captureFormalStatusV4()) {
        const container = document.getElementById("morningComparisonV4Formal");
        if (!container) return model;
        container.classList.toggle("is-available", model.available);
        container.classList.toggle("is-unavailable", !model.available);
        container.dataset.baselineId = model.identity.selectedBaselineId || "";
        container.dataset.comparisonBaselineId = model.identity.comparisonBaselineId || "";
        container.dataset.publicationGeneration = String(model.identity.publicationGeneration || 0);
        container.dataset.scopeId = model.identity.scopeId || "";
        container.dataset.formalTradingDate = model.identity.formalTradingDate || "";
        container.dataset.contract = model.identity.contract || "";
        container.dataset.qriContract = model.identity.qriContract || "";
        container.dataset.futuresContract = model.identity.futuresContract || "";
        container.dataset.contractRelation = model.identity.contractRelation || "";
        container.dataset.inputFingerprint = model.identity.formalSnapshotInputFingerprint || "";
        container.dataset.restoreBindingVerified = String(model.identity.restoreBindingVerified === true);
        text("morningComparisonV4Status", model.status);
        text("morningComparisonV4Reason", model.reason || "同じ取引日の朝基準と現在を比較しています");
        text("morningBaselineV4AutomaticStatus", formalStatus?.storageLabel || "正式朝基準：状態確認待ち");
        text("morningBaselineV4AutomaticWindowStatus", formalStatus?.automaticLabel ||
            "自動保存：状態確認待ち");
        text("morningComparisonV4CapturedAt", model.capturedAt);
        text("morningComparisonV4Contracts", model.identity.qriContract &&
            model.identity.futuresContract
            ? `QRI ${model.identity.qriContract} / 先物 ${model.identity.futuresContract}` : "—");
        text("morningComparisonV4Score", model.score ?
            `朝 ${model.score.baselineLabel} ${model.score.baseline} → 現在 ${model.score.currentLabel} ${model.score.current}` : "—");
        text("morningComparisonV4ScoreDelta", model.score ?
            `変化：${model.score.movement}` : "—");
        text("morningComparisonV4ScoreScale", model.score?.scale ||
            "-100（売り最大）／0（中立）／+100（買い最大）／確率ではありません");
        text("morningComparisonV4Price", model.price ?
            `朝 ${model.price.baseline} → 現在 ${model.price.current}` : "—");
        text("morningComparisonV4PriceDelta", model.price ?
            `朝基準比 ${model.price.delta}（${model.price.percent}）` : "—");
        text("morningComparisonV4Relation", model.relation);
        text("morningComparisonV4Quality", model.dataQuality?.current || "利用不可");
        text("morningComparisonV4QualityTransition", model.dataQuality ?
            `朝 ${model.dataQuality.baseline} → 現在 ${model.dataQuality.current}：${model.dataQuality.transition}` : "—");
        const components = document.getElementById("morningComparisonV4Components");
        if (components) components.replaceChildren(...model.components.map(item => {
            const row = document.createElement("p");
            row.textContent = item.available ?
                `${item.label}：朝 ${item.baseline} → 現在 ${item.current}（${item.movement}）` :
                `${item.label}：利用不可`;
            return row;
        }), ...(model.dataQuality ? [(() => {
            const row = document.createElement("p");
            const informational = model.dataQuality.warnings.length > 0 &&
                model.dataQuality.warnings.every(item => item === "週次データ：検証済みの正式履歴を使用");
            const warnings = model.dataQuality.warnings.length
                ? `／${informational ? "" : "注意："}${model.dataQuality.warnings.join("、")}` : "";
            row.textContent = `データ品質：朝 ${model.dataQuality.baseline} → 現在 ${model.dataQuality.current}` +
                `（${model.dataQuality.transition}）${warnings}`;
            return row;
        })()] : []));
        if (!model.available) document.getElementById("morningComparisonV4Details")?.removeAttribute("open");
        return model;
    }

    function renderFormalComparisonV4() {
        // Once a verified summary is on screen, Formal is part of that immutable
        // presentation bundle. Runtime callbacks may request another render, but
        // must not partially replace the displayed generation.
        if (latestPresentation) return clone(latestPresentation.formalModel);
        return applyFormalComparisonV4(captureFormalComparisonV4(
            window.getMorningComparisonV4RuntimeState?.() || null));
    }

    const elapsedLabel = milliseconds => {
        const minutes = Math.floor(milliseconds / 60000);
        if (minutes < 60) return `${minutes}分`;
        return `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`;
    };
    const observationTime = value => new Date(value).toLocaleTimeString("ja-JP",
        { hour: "2-digit", minute: "2-digit" });
    const snapshotReasonLabel = reason => ({
        current_snapshot_unavailable: "価格観測データがありません",
        previous_comparable_unavailable: "比較データ待ち",
        contract_unavailable: "限月を確認できないため比較できません",
        contract_mismatch: "比較対象なし",
        invalid_snapshot: "価格観測データを検証できません",
        history_invalid: "価格観測履歴を確認できません",
        snapshot_invalid: "価格観測データを検証できません",
        observation_order_invalid: "観測時刻を比較できません"
    })[reason] || "価格観測を比較できません";

    function renderSnapshotComparison(comparison) {
        const states = ["up", "down", "neutral", "unavailable"];
        if (!comparison?.available) {
            text("mobileSummaryPreviewSnapshotComparison", snapshotReasonLabel(comparison?.reason));
            text("mobileSummaryPreviewSnapshotComparisonMeta", comparison?.reason === "contract_mismatch"
                ? "同一限月の過去価格がありません" : "同一限月の価格観測が2件必要です");
            setCardState("mobileSummaryPreviewSnapshotComparisonCard", "unavailable", states);
            return;
        }
        const percent = `${comparison.percentChange > 0 ? "+" : ""}${comparison.percentChange.toFixed(2)}%`;
        text("mobileSummaryPreviewSnapshotComparison",
            `${comparison.arrow} ${signed(comparison.priceDelta)}円　${percent}`);
        text("mobileSummaryPreviewSnapshotComparisonMeta",
            `前回 ${observationTime(comparison.previous.observedAt)} → 現在 ${observationTime(comparison.current.observedAt)} ・ 経過 ${elapsedLabel(comparison.elapsedMs)}`);
        setCardState("mobileSummaryPreviewSnapshotComparisonCard", comparison.direction, states);
    }

    function renderMultiTimeframe(summary, comparison, records) {
        const view = window.OptionMapMobileMultiTimeframeView.createView(summary, comparison, records);
        text("mobileSummaryPreviewTimeframeDirections", view.summary);
        text("mobileSummaryPreviewAlignmentMeta", view.relationship);
        text("mobileSummaryPreviewTimeframeQuality", view.quality);
    }

    async function refreshSnapshotComparison(summary) {
        try {
            const records = await window.OptionMapPriceSnapshotStore.listAll();
            const comparison = await window.OptionMapPriceSnapshotComparison
                .createPriceSnapshotComparison(records);
            renderSnapshotComparison(comparison);
            renderMultiTimeframe(summary, comparison, records);
        } catch (error) {
            const comparison = { available: false, reason: "history_invalid" };
            renderSnapshotComparison(comparison);
            renderMultiTimeframe(summary, comparison, []);
            console.warn("Price Snapshot Comparisonを表示できません。表示は継続します:", error);
        }
    }

    function render(summary) {
        const payload = summary.payload;
        text("mobileSummaryPreviewStatus", `生成済み ${time(summary.generatedAt)}`);
        text("mobileSummaryPreviewOverall", payload.overallV2.available
            ? `${payload.overallV2.directionLabel} (${payload.overallV2.direction > 0 ? "+" : ""}${payload.overallV2.direction})`
            : "総合判定v2：利用不可");
        text("mobileSummaryPreviewOverallGeneratedAt", generatedAtJst(summary.generatedAt));
        const overallState = !payload.overallV2.available ? "neutral" : payload.overallV2.direction > 0
            ? "buy" : payload.overallV2.direction < 0 ? "sell" : "neutral";
        setCardState("mobileSummaryPreviewOverallCard", overallState, ["buy", "sell", "neutral"]);
        text("mobileSummaryPreviewMetrics", `信頼度 ${payload.overallV2.confidence ?? "--"}% ・ ` +
            `網羅率 ${payload.overallV2.coverage ?? "--"}% ・ 一致度 ${roundedPercent(payload.overallV2.agreement)}`);
        text("mobileSummaryPreviewPrice", price(payload.currentPrice.value));
        text("mobileSummaryPreviewPriceMeta", `${payload.currentPrice.source || "取得元不明"} ・ ` +
            `${payload.currentPrice.mode || "方式不明"} ・ ${payload.currentPrice.contract || "限月不明"}`);
        const levelText = level => level.available
            ? `${price(level.price)}（距離 ${price(level.distance)} / 建玉 ${level.openInterest.toLocaleString("ja-JP")} / ${level.sourceContract}限）`
            : reasonLabel(level.reason);
        text("mobileSummaryPreviewUpper", levelText(payload.nearestLevels.upper));
        text("mobileSummaryPreviewLower", levelText(payload.nearestLevels.lower));
        const change = payload.changeSinceMorning;
        const baselineOverall = change.available && change.overallV2.available
            ? `${change.overallV2.baselineLabel} ${signed(change.overallV2.baselineDirection)}`
            : "v2利用不可";
        const currentOverall = change.available && change.overallV2.available
            ? `${change.overallV2.currentLabel} ${signed(change.overallV2.currentDirection)}`
            : "v2利用不可";
        text("mobileSummaryPreviewBaseline", payload.morningBaseline.available
            ? `${time(payload.morningBaseline.capturedAt)} / ${latestBaselineResolution?.activeRevision?.baselineDay
                ? `運用日 ${latestBaselineResolution.activeRevision.baselineDay} / 比較時間内 / ` : ""}` +
                `${change.available ? `${baselineOverall} / ` : ""}` +
                `${qualityLabel(payload.morningBaseline.dataQuality.status)} / 朝QRI：${
                    payload.morningBaseline.qriAvailability?.available ? "正式建玉あり" :
                        payload.morningBaseline.qriAvailability?.openInterestStatus === "unavailable" ? "未提供" :
                            payload.morningBaseline.qriAvailability === null ? "状態不明" : "比較不可"}`
            : latestBaselineResolution?.baseline
                ? "保存済み（現在の比較対象外）"
                : "未設定（朝基準はまだ保存していません）");
        const demandArrow = change.available && change.overallV2.available
            ? change.overallV2.directionDelta > 0 ? "↑" : change.overallV2.directionDelta < 0 ? "↓" : "→" : "--";
        const priceArrow = change.available && change.currentPrice.available
            ? change.currentPrice.delta > 0 ? "↑" : change.currentPrice.delta < 0 ? "↓" : "→" : "--";
        text("mobileSummaryPreviewChange", change.available
            ? `需給 ${demandArrow}　価格 ${priceArrow}` : reasonLabel(change.reason));
        text("mobileSummaryPreviewChangeMeta", change.available
            ? `${baselineOverall} → ${currentOverall} ・ ` +
                `${change.currentPrice.available ? `価格差 ${signed(change.currentPrice.delta)}円 ・ ` : ""}` +
                `品質 ${qualityLabel(change.dataQuality.baselineStatus)} → ${qualityLabel(change.dataQuality.currentStatus)} ・ ` +
                `${change.summaryItems.map(item => item.text).join(" / ") || "区分変化なし"}` : "比較情報なし");
        const timeframe = window.OptionMapMobileTimeframeObservation
            .createTimeframeObservation(summary);
        const shortDelta = timeframe.shortTerm.available
            ? `朝から ${signed(timeframe.shortTerm.delta)}円` : "朝基準との比較ができません";
        text("mobileSummaryPreviewShortTerm",
            `${timeframe.shortTerm.arrow} ${timeframe.shortTerm.label}`);
        text("mobileSummaryPreviewShortTermMeta", shortDelta);
        setCardState("mobileSummaryPreviewShortTermCard", timeframe.shortTerm.direction,
            ["up", "down", "neutral", "unavailable"]);
        text("mobileSummaryPreviewMediumTerm", timeframe.mediumTerm.available
            ? `${timeframe.mediumTerm.arrow} ${timeframe.mediumTerm.label} ${signed(timeframe.mediumTerm.score)}`
            : "判定不能");
        setCardState("mobileSummaryPreviewMediumTermCard", timeframe.mediumTerm.direction,
            ["up", "down", "neutral", "unavailable"]);
        text("mobileSummaryPreviewAlignment", timeframe.alignment.status === "diverged"
            ? `⚠ ${timeframe.alignment.label}` : timeframe.alignment.label);
        text("mobileSummaryPreviewAlignmentMeta", timeframe.alignment.message);
        setCardState("mobileSummaryPreviewAlignmentCard", timeframe.alignment.status,
            ["aligned", "diverged", "neutral_mixed", "unavailable"]);
        const options = payload.optionChanges;
        const topText = side => {
            const up = side.topIncreases[0]; const down = side.topDecreases[0];
            return `増加 ${up ? `${up.strike.toLocaleString("ja-JP")}（+${up.delta}）` : "なし"} / ` +
                `減少 ${down ? `${down.strike.toLocaleString("ja-JP")}（${down.delta}）` : "なし"}`;
        };
        text("mobileSummaryPreviewOptionChanges", options.available
            ? `CALL ${topText(options.CALL)}、PUT ${topText(options.PUT)}`
            : reasonLabel(options.reason));
        text("mobileSummaryPreviewQuality", qualityLabel(summary.dataQuality.status));
        setCardState("mobileSummaryPreviewQualityCard", summary.dataQuality.status,
            ["complete", "partial", "unavailable"]);
        const alerts = document.getElementById("mobileSummaryPreviewAlerts");
        if (alerts) alerts.replaceChildren(...payload.alerts.map(alert => {
            const item = document.createElement("li"); item.textContent = alert.message; return item;
        }));
        const freshness = document.getElementById("mobileSummaryPreviewFreshness");
        if (freshness) freshness.replaceChildren(...Object.entries(summary.freshness).map(([key, value]) => {
            const item = document.createElement("li"); item.textContent = `${freshnessLabel(key)}：${time(value)}`; return item;
        }));
        text("mobileSummaryPreviewJson", JSON.stringify(summary, null, 2));
        const saveButton = document.getElementById("saveMorningBaselineButton");
        if (saveButton) saveButton.disabled = summary.dataQuality.status === "unavailable" || saveInProgress;
    }

    async function createInput(qri, comparison = null) {
        const state = window.getMobileSummaryRendererState?.();
        if (!state) throw new Error("renderer_state_unavailable");
        const overallAuthority = captureOverallAuthority();
        const canonical = qri?.canonicalV2 || null;
        let qriSignature = null;
        let versionKey = null;
        if (canonical) {
            qriSignature = await window.OptionMapQriOptions.createSignature(canonical);
            versionKey = `qri-options-v2|${canonical.contract}|${canonical.pageUpdatedAt}|sha256:${qriSignature}`;
        }
        const sourceVersions = [];
        if (canonical) sourceVersions.push({ source: "qri-options", sourceDate: canonical.tradingDate,
            tradingDate: canonical.tradingDate, contract: canonical.contract, versionKey,
            signature: `sha256:${qriSignature}` });
        const weekly = state.weeklyCandidate?.metadata?.current;
        if (weekly) sourceVersions.push({ source: "weekly-futures-history", sourceDate: weekly.sourceDate,
            tradingDate: null, contract: null, versionKey: weekly.versionKey, signature: null });
        const marketDate = canonical?.tradingDate;
        if (!marketDate) throw new Error("formal_market_date_unavailable");
        const generatedAt = new Date().toISOString();
        const morningBaseline = await window.OptionMapMorningBaselineStorage
            .resolveApplicable({ generatedAt, marketDate, qriTradingDate: canonical.tradingDate,
                contract: canonical.contract });
        const input = { generatedAt, marketDate,
        producer: { appVersion: "1.0.0", platform: navigator.platform || null },
        overallV2: state.overallV2, currentPrice: state.currentPrice,
        qri: { available: Boolean(canonical), canonical, activeContract: canonical?.contract || null,
            versionKey, pageUpdatedAt: canonical?.pageUpdatedAt || null, fetchedAt: qri?.fetchedAt || null,
            usingFallback: state.qriOpenInterest?.usingFallback === true }, sourceVersions,
        morningBaseline,
        freshness: state.freshness, comparison, baselineResolution: clone(morningBaseline),
        observationState: { overallV2: state.overallV2, currentPrice: state.currentPrice,
            qriOpenInterest: state.qriOpenInterest } };
        assertOverallAuthority(input, overallAuthority);
        input.renderAuthority = overallAuthority;
        return input;
    }

    const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    function captureOverallAuthority() {
        const state = window.getOverallV2FormalEnvelope?.() || null;
        const envelope = state?.status === "available" ? state.envelope : null;
        if (!envelope?.identityVerified || envelope.formalApplied !== true || !envelope.inputFingerprint ||
            !Number.isSafeInteger(envelope.publicationGeneration) || !envelope.requestId)
            throw new Error("overall_v2_render_authority_unavailable");
        return clone({ publicationGeneration: envelope.publicationGeneration,
            requestId: envelope.requestId, inputFingerprint: envelope.inputFingerprint,
            result: envelope.result, optionSourceIdentity: envelope.optionSourceIdentity,
            weeklySourceIdentity: envelope.weeklySourceIdentity });
    }

    function assertOverallAuthority(input, authority) {
        if (!sameJson(input.overallV2, authority.result))
            throw new Error("overall_v2_result_identity_mismatch");
        const qri = input.sourceVersions.find(item => item.source === "qri-options");
        const weekly = input.sourceVersions.find(item => item.source === "weekly-futures-history");
        if (authority.optionSourceIdentity && qri?.versionKey !==
            authority.optionSourceIdentity.canonicalVersionKey)
            throw new Error("overall_v2_qri_identity_mismatch");
        if (authority.weeklySourceIdentity && weekly?.versionKey !==
            authority.weeklySourceIdentity.currentVersionKey)
            throw new Error("overall_v2_weekly_identity_mismatch");
    }

    function assertCurrentOverallAuthority(expected) {
        const current = captureOverallAuthority();
        if (current.publicationGeneration !== expected.publicationGeneration ||
            current.requestId !== expected.requestId ||
            current.inputFingerprint !== expected.inputFingerprint ||
            !sameJson(current.result, expected.result))
            throw new Error("stale_overall_v2_authority_rejected");
    }

    function commitPresentation(bundle) {
        const panel = document.getElementById("mobileSummaryPreviewPanel");
        latestBaselineResolution = clone(bundle.baselineResolution);
        render(bundle.summary);
        renderMorningBaselineState(bundle.summary.marketDate, bundle.baselineResolution);
        applyFormalComparisonV4(bundle.formalModel, bundle.formalStatus);
        if (panel) {
            panel.dataset.summaryId = bundle.summary.summaryId;
            panel.dataset.summarySignature = bundle.summary.signature;
            panel.dataset.summaryGeneratedAt = bundle.summary.generatedAt;
            panel.dataset.overallPublicationGeneration = String(
                bundle.overallAuthority.publicationGeneration);
            panel.dataset.overallInputFingerprint = bundle.overallAuthority.inputFingerprint;
        }
        latestSummary = clone(bundle.summary);
        latestPresentation = clone(bundle);
    }

    async function resolveFormalQriReference(summary) {
        const source = summary.sourceVersions.find(item => item.source === "qri-options");
        if (!source?.versionKey) return { formalRevisionAvailable: false, confirmedAt: null };
        try {
            const loaded = await window.OptionMapQriOptionsHistoryStore?.loadHistory();
            const revision = loaded?.status === "ready" ? loaded.history.entries
                .flatMap(entry => entry.revisions).find(item => item.versionKey === source.versionKey) : null;
            return { formalRevisionAvailable: Boolean(revision), confirmedAt: revision?.confirmedAt || null };
        } catch (_error) {
            return { formalRevisionAvailable: false, confirmedAt: null };
        }
    }

    async function createComparison(qri, initialSummary, input) {
        const baselineResult = input.morningBaseline;
        if (!baselineResult?.available) return null;
        const baseline = baselineResult.baseline;
        const active = window.OptionMapMorningBaseline.activeRevision(baseline);
        if (!active) return {
            changeSinceMorning: { available: false, reason: "morning_baseline_corrupted" },
            optionChanges: { available: false, reason: "morning_baseline_corrupted" } };
        let resolved;
        try {
            const loaded = await window.OptionMapQriOptionsHistoryStore.loadHistory();
            resolved = loaded?.status === "corrupted"
                ? { available: false, reason: "history_corrupted" }
                : await window.OptionMapMobileMorningComparison
                    .resolveBaselineQriRevision(loaded?.history, baseline);
        } catch (_error) {
            resolved = { available: false, reason: "history_corrupted" };
        }
        const qriSource = initialSummary.sourceVersions.find(item => item.source === "qri-options");
        let optionChanges = { available: false, reason: resolved.reason || "baseline_revision_missing" };
        if (resolved.available) optionChanges = await window.OptionMapMobileMorningComparison.compareQriIntraday({
            marketDate: initialSummary.marketDate, baselineCanonical: resolved.revision.canonical,
            baselineVersionKey: active.comparisonReference.versionKey,
            baselineSignature: active.comparisonReference.signature,
            currentCanonical: qri?.canonicalV2 || null, currentVersionKey: qriSource?.versionKey || null,
            currentSignature: qriSource?.signature || null,
            sessionApplicable: baseline.baselineVersion === 3 });
        const changeSinceMorning = window.OptionMapMobileMorningComparison.createComparison({
            marketDate: initialSummary.marketDate, baselineRevision: active,
            currentSummary: initialSummary, optionChanges, comparedAt: initialSummary.generatedAt });
        return { changeSinceMorning, optionChanges,
            pins: { baselineId: active.baselineId,
                baselineSignature: active.sourceSummarySignature,
                baselineQriVersionKey: active.comparisonReference?.versionKey || null,
                currentSummaryId: initialSummary.summaryId, currentSummarySignature: initialSummary.signature,
                currentQriVersionKey: qriSource?.versionKey || null } };
    }

    async function captureQriAvailability(summary) {
        const canonical = latestQri?.canonicalV2 || null;
        const persistence = window.getQriOptionsHistoryPersistenceState?.() || {};
        const source = summary.sourceVersions.find(item => item.source === "qri-options");
        if (!canonical || !source) return { qriAvailability: { canonicalExists: false,
            available: false, openInterestStatus: null, reason: "canonical_missing",
            publishedCount: null, formalRevisionAvailable: false,
            persistenceStatus: persistence.status || null, persistenceReason: persistence.reason || null },
        comparisonReference: null };
        const publishedCount = canonical.records.filter(record => record.published === true).length;
        let formalRevisionAvailable = false;
        try {
            const loaded = await window.OptionMapQriOptionsHistoryStore.loadHistory();
            formalRevisionAvailable = loaded.status === "ready" && loaded.history.entries.some(entry =>
                entry.contract === canonical.contract && entry.sourceDateKey === canonical.tradingDate &&
                entry.revisions.some(revision => revision.versionKey === source.versionKey &&
                    `sha256:${revision.signature}` === source.signature));
        } catch (_error) { formalRevisionAvailable = false; }
        const formallyComparable = canonical.openInterestStatus === "available" &&
            publishedCount > 0 && formalRevisionAvailable;
        const reason = formallyComparable ? null : canonical.openInterestStatus === "unavailable"
            ? "open_interest_unavailable" : canonical.openInterestStatus === "partial"
                ? "open_interest_partial" : "formal_revision_missing_at_capture";
        return { qriAvailability: { canonicalExists: true, available: formallyComparable,
            openInterestStatus: canonical.openInterestStatus, reason, publishedCount,
            formalRevisionAvailable, persistenceStatus: persistence.status || null,
            persistenceReason: persistence.reason || null }, comparisonReference: formallyComparable
            ? { contract: source.contract, tradingDate: source.tradingDate,
                versionKey: source.versionKey, signature: source.signature,
                pageUpdatedAt: summary.freshness.qriAt } : null };
    }

    async function update(qriPayload) {
        const ownSequence = ++updateSequence;
        if (qriPayload) latestQri = clone(qriPayload);
        try {
            const input = await createInput(latestQri);
            const initial = await window.OptionMapMobileSummary.buildMobileSummary(input);
            const comparison = await createComparison(latestQri, initial, input);
            if (comparison?.pins) {
                const currentBaseline = await window.OptionMapMorningBaselineStorage.resolveApplicable({
                    generatedAt: initial.generatedAt, marketDate: initial.marketDate });
                const currentActive = currentBaseline.available
                    ? window.OptionMapMorningBaseline.activeRevision(currentBaseline.baseline) : null;
                const liveInput = await createInput(latestQri);
                const liveQriVersion = liveInput.sourceVersions.find(item => item.source === "qri-options")?.versionKey || null;
                const liveCandidate = await window.OptionMapMobileSummary.buildMobileSummary(liveInput);
                if (currentActive?.baselineId !== comparison.pins.baselineId ||
                    currentActive?.sourceSummarySignature !== comparison.pins.baselineSignature ||
                    (currentActive?.comparisonReference?.versionKey || null) !==
                        comparison.pins.baselineQriVersionKey ||
                    liveQriVersion !== comparison.pins.currentQriVersionKey ||
                    liveCandidate.summaryId !== comparison.pins.currentSummaryId ||
                    liveCandidate.signature !== comparison.pins.currentSummarySignature)
                    throw new Error("stale_comparison_rejected");
            }
            const finalInput = clone(input); finalInput.comparison = comparison;
            const summary = comparison ? await window.OptionMapMobileSummary.buildMobileSummary(finalInput) : initial;
            const validation = await window.OptionMapMobileSummary.validateMobileSummary(summary);
            if (!validation.valid) throw new Error(`mobile_summary_invalid:${validation.errors.join(",")}`);
            assertCurrentOverallAuthority(input.renderAuthority);
            if (ownSequence !== updateSequence) throw new Error("stale_presentation_rejected");
            const bundle = { summary: clone(summary), overallAuthority: clone(input.renderAuthority),
                baselineResolution: clone(input.baselineResolution),
                formalModel: clone(captureFormalComparisonV4()),
                formalStatus: clone(captureFormalStatusV4()) };
            // No await is permitted inside this commit: all cards change in one JS turn.
            commitPresentation(bundle);
            const formalQri = await resolveFormalQriReference(summary);
            await window.OptionMapMarketObservation?.persistBestEffort({
                summary, rendererState: input.observationState,
                qri: { ...input.qri, ...formalQri, canonicalV2: input.qri.canonical },
                observedAt: new Date().toISOString()
            }, window.OptionMapMarketObservationStore, observationError => {
                console.warn("Observation historyの保存に失敗しました。表示は継続します:",
                    observationError);
            });
            await window.OptionMapPriceSnapshot?.persistBestEffort({
                summary, rendererState: input.observationState,
                observedAt: new Date().toISOString()
            }, window.OptionMapPriceSnapshotStore, snapshotError => {
                console.warn("Price Snapshot Historyの保存に失敗しました。表示は継続します:",
                    snapshotError);
            });
            await refreshSnapshotComparison(summary);
            return { success: true, summary: clone(summary) };
        } catch (error) {
            text("mobileSummaryPreviewStatus", latestSummary
                ? `更新失敗（前回の正常previewを維持）: ${error.message}`
                : `生成できません: ${error.message}`);
            if (latestSummary) {
                const overall = latestSummary.payload?.overallV2;
                text("mobileSummaryPreviewOverall", overall?.available
                    ? `前回生成値：${overall.directionLabel} (${overall.direction > 0 ? "+" : ""}${overall.direction})`
                    : "前回生成値：総合判定v2 利用不可");
                text("mobileSummaryPreviewOverallGeneratedAt",
                    `更新失敗・${generatedAtJst(latestSummary.generatedAt)}`);
            }
            console.warn("MobileSummary previewの更新に失敗しました:", error);
            return { success: false, error: error.message };
        }
    }

    function renderMorningBaselineState(marketDate, baselineResolution = latestBaselineResolution) {
        const result = baselineResolution;
        if (!result) return;
        if (!result.available) {
            text("morningBaselineSaveStatus", result.reason === "morning_baseline_corrupted"
                ? "スマホ版朝基準：保存データが壊れているため利用できません"
                : result.baseline ? `スマホ版朝基準：保存済み（現在の比較対象外）— ${reasonLabel(result.reason)}`
                    : "スマホ版朝基準：未設定");
            return;
        }
        const baseline = result.baseline;
        const active = window.OptionMapMorningBaseline.activeRevision(baseline);
        const format = value => new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
        const session = active.baselineDay ? ` / 運用日 ${active.baselineDay} / 比較時間内 / 市場日 ${marketDate}` : "";
        text("morningBaselineSaveStatus", baseline.revisions.length > 1
            ? `スマホ版朝基準：現在 ${format(active.capturedAt)} / 最初 ${format(baseline.firstCapturedAt)} / 品質：${morningQualityLabel(active.dataQuality.status)}`
            : `スマホ版朝基準：${format(active.capturedAt)}に保存済み / 品質：${morningQualityLabel(active.dataQuality.status)}${session}`);
    }

    async function saveMorningBaseline() {
        if (saveInProgress) return { success: false, reason: "save_in_progress" };
        saveInProgress = true;
        const button = document.getElementById("saveMorningBaselineButton");
        if (button) button.disabled = true;
        try {
            if (window.isMarketRefreshInProgress?.()) throw new Error("データ更新中は保存できません");
            const refreshed = await update();
            if (!refreshed.success) throw new Error("最新summaryを生成できません");
            const summary = clone(refreshed.summary);
            const validation = await window.OptionMapMobileSummary.validateMobileSummary(summary);
            if (!validation.valid) throw new Error("最新summaryの検証に失敗しました");
            if (summary.dataQuality.status === "unavailable") throw new Error("利用不能なsummaryは保存できません");
            if (summary.dataQuality.status === "partial" && !window.confirm(
                "一部データが不足しています。この状態を今日の朝基準として保存しますか？")) {
                return { success: false, reason: "partial_cancelled" };
            }
            const qriCapture = await captureQriAvailability(summary);
            const capturedAt = new Date().toISOString();
            const session = window.OptionMapMorningBaseline.createSessionMetadata(capturedAt);
            const candidate = await window.OptionMapMorningBaseline.createCandidate(
                summary, capturedAt, { ...qriCapture, session });
            const existingResult = await window.OptionMapMorningBaselineStorage
                .getForMarketDate(summary.marketDate);
            if (existingResult.reason === "morning_baseline_corrupted")
                throw new Error("朝基準storageが壊れているため保存できません");
            let allowUpdate = false;
            if (existingResult.available) {
                const active = window.OptionMapMorningBaseline.activeRevision(existingResult.baseline);
                allowUpdate = window.confirm(morningBaselineUpdateConfirmation(
                    summary.marketDate, active.capturedAt));
                if (!allowUpdate) return { success: false, reason: "update_cancelled" };
            }
            const saved = await window.OptionMapMorningBaseline.saveCandidate(
                existingResult.baseline, candidate, summary.marketDate, { allowUpdate });
            await window.OptionMapMorningBaselineStorage.save(saved.baseline);
            await update();
            const legacyMessage = saved.status === "unchanged"
                ? "スマホ版朝基準は同じ内容のためrevisionを追加しませんでした。" :
                    "スマホ版朝基準を保存しました。";
            text("morningBaselineSaveMessage", legacyMessage);
            return { success: true, status: saved.status };
        } catch (error) {
            text("morningBaselineSaveMessage", error.message);
            return { success: false, reason: error.message };
        } finally {
            saveInProgress = false;
            if (button) button.disabled = latestSummary?.dataQuality?.status === "unavailable";
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        renderFormalComparisonV4();
        document.getElementById("saveMorningBaselineButton")?.addEventListener("click", () => {
            void saveMorningBaseline();
        });
    });

    return Object.freeze({ update, saveMorningBaseline, renderFormalComparisonV4,
        morningBaselineUpdateConfirmation,
        getLatestSummary: () => clone(latestSummary) });
});
