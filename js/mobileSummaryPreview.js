(function (root, factory) {
    const api = factory();
    if (root) root.OptionMapMobileSummaryPreview = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    let latestQri = null;
    let latestSummary = null;
    let saveInProgress = false;

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const text = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };
    const price = value => Number.isFinite(value) ? `${value.toLocaleString("ja-JP")}円` : "利用不可";
    const time = value => value ? new Date(value).toLocaleString("ja-JP") : "時刻なし";
    const signed = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "--";

    function render(summary) {
        const payload = summary.payload;
        text("mobileSummaryPreviewStatus", `生成済み ${time(summary.generatedAt)}`);
        text("mobileSummaryPreviewOverall", payload.overallV2.available
            ? `${payload.overallV2.directionLabel} (${payload.overallV2.direction > 0 ? "+" : ""}${payload.overallV2.direction})`
            : "総合判定v2：利用不可");
        text("mobileSummaryPreviewMetrics", `信頼度 ${payload.overallV2.confidence ?? "--"}% / ` +
            `coverage ${payload.overallV2.coverage ?? "--"}% / agreement ${payload.overallV2.agreement ?? "--"}%`);
        text("mobileSummaryPreviewPrice", `${price(payload.currentPrice.value)} / ` +
            `${payload.currentPrice.source || "source不明"} / ${payload.currentPrice.mode || "mode不明"}`);
        const levelText = level => level.available
            ? `${price(level.price)}（距離 ${price(level.distance)} / 建玉 ${level.openInterest.toLocaleString("ja-JP")} / ${level.sourceContract}限）`
            : `候補なし（${level.reason}）`;
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
            ? `${time(payload.morningBaseline.capturedAt)} / ${change.available ? `${baselineOverall} / ` : ""}` +
                `品質 ${payload.morningBaseline.dataQuality.status} / 朝QRI：${
                    payload.morningBaseline.qriAvailability?.available ? "正式建玉あり" :
                        payload.morningBaseline.qriAvailability?.openInterestStatus === "unavailable" ? "未提供" :
                            payload.morningBaseline.qriAvailability === null ? "状態不明" : "比較不可"}`
            : "未設定（朝基準はまだ保存していません）");
        text("mobileSummaryPreviewChange", change.available
            ? `${baselineOverall} → ${currentOverall} / ` +
                `${change.currentPrice.available ? `現在値 ${change.currentPrice.delta > 0 ? "+" : ""}` +
                    `${change.currentPrice.delta.toLocaleString("ja-JP")}円 / ` : ""}` +
                `品質 ${change.dataQuality.baselineStatus} → ${change.dataQuality.currentStatus} / ` +
                `${change.summaryItems.map(item => item.text).join(" / ") || "区分変化なし"}`
            : window.OptionMapMobileMorningComparison.formatReason(change.reason));
        const options = payload.optionChanges;
        const topText = side => {
            const up = side.topIncreases[0]; const down = side.topDecreases[0];
            return `${up ? `${up.strike} +${up.delta}` : "増加なし"} / ${down ? `${down.strike} ${down.delta}` : "減少なし"}`;
        };
        text("mobileSummaryPreviewOptionChanges", options.available
            ? `CALL ${topText(options.CALL)}、PUT ${topText(options.PUT)}`
            : window.OptionMapMobileMorningComparison.formatReason(options.reason));
        text("mobileSummaryPreviewQuality", `${summary.dataQuality.status} / ` +
            (summary.dataQuality.warnings.join(", ") || "不足componentなし"));
        const alerts = document.getElementById("mobileSummaryPreviewAlerts");
        if (alerts) alerts.replaceChildren(...payload.alerts.map(alert => {
            const item = document.createElement("li"); item.textContent = alert.message; return item;
        }));
        const freshness = document.getElementById("mobileSummaryPreviewFreshness");
        if (freshness) freshness.replaceChildren(...Object.entries(summary.freshness).map(([key, value]) => {
            const item = document.createElement("li"); item.textContent = `${key}: ${time(value)}`; return item;
        }));
        text("mobileSummaryPreviewJson", JSON.stringify(summary, null, 2));
        const saveButton = document.getElementById("saveMorningBaselineButton");
        if (saveButton) saveButton.disabled = summary.dataQuality.status === "unavailable" || saveInProgress;
    }

    async function createInput(qri, comparison = null) {
        const state = window.getMobileSummaryRendererState?.();
        if (!state) throw new Error("renderer_state_unavailable");
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
        const morningBaseline = await window.OptionMapMorningBaselineStorage
            .getForMarketDate(marketDate);
        return { generatedAt: new Date().toISOString(), marketDate,
        producer: { appVersion: "1.0.0", platform: navigator.platform || null },
        overallV2: state.overallV2, currentPrice: state.currentPrice,
        qri: { available: Boolean(canonical), canonical, activeContract: canonical?.contract || null,
            versionKey, pageUpdatedAt: canonical?.pageUpdatedAt || null, fetchedAt: qri?.fetchedAt || null,
            usingFallback: state.qriOpenInterest?.usingFallback === true }, sourceVersions,
        morningBaseline,
        freshness: state.freshness, comparison };
    }

    async function createComparison(qri, initialSummary, input) {
        const baselineResult = input.morningBaseline;
        if (!baselineResult?.available) return null;
        const baseline = baselineResult.baseline;
        const active = window.OptionMapMorningBaseline.activeRevision(baseline);
        if (!active || baseline.marketDate !== initialSummary.marketDate) return {
            changeSinceMorning: { available: false, reason: "market_date_mismatch" },
            optionChanges: { available: false, reason: "market_date_mismatch" } };
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
            currentSignature: qriSource?.signature || null });
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
        if (qriPayload) latestQri = clone(qriPayload);
        try {
            const input = await createInput(latestQri);
            const initial = await window.OptionMapMobileSummary.buildMobileSummary(input);
            const comparison = await createComparison(latestQri, initial, input);
            if (comparison?.pins) {
                const currentBaseline = await window.OptionMapMorningBaselineStorage
                    .getForMarketDate(initial.marketDate);
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
            latestSummary = summary;
            render(summary);
            await renderMorningBaselineState(summary.marketDate);
            return { success: true, summary: clone(summary) };
        } catch (error) {
            text("mobileSummaryPreviewStatus", latestSummary
                ? `更新失敗（前回の正常previewを維持）: ${error.message}`
                : `生成できません: ${error.message}`);
            console.warn("MobileSummary previewの更新に失敗しました:", error);
            return { success: false, error: error.message };
        }
    }

    async function renderMorningBaselineState(marketDate) {
        const result = await window.OptionMapMorningBaselineStorage.getForMarketDate(marketDate);
        if (!result.available) {
            text("morningBaselineSaveStatus", result.reason === "morning_baseline_corrupted"
                ? "朝基準：保存データが壊れているため利用できません"
                : "朝基準：未設定");
            return;
        }
        const baseline = result.baseline;
        const active = window.OptionMapMorningBaseline.activeRevision(baseline);
        const format = value => new Date(value).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
        text("morningBaselineSaveStatus", baseline.revisions.length > 1
            ? `朝基準：現在 ${format(active.capturedAt)} / 最初 ${format(baseline.firstCapturedAt)} / 品質 ${active.dataQuality.status}`
            : `朝基準：${format(active.capturedAt)}に保存済み / 品質 ${active.dataQuality.status}`);
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
            const candidate = await window.OptionMapMorningBaseline.createCandidate(
                summary, new Date().toISOString(), qriCapture);
            const existingResult = await window.OptionMapMorningBaselineStorage
                .getForMarketDate(summary.marketDate);
            if (existingResult.reason === "morning_baseline_corrupted")
                throw new Error("朝基準storageが壊れているため保存できません");
            let allowUpdate = false;
            if (existingResult.available) {
                const active = window.OptionMapMorningBaseline.activeRevision(existingResult.baseline);
                const savedAt = new Date(active.capturedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
                allowUpdate = window.confirm(`今日の朝基準は${savedAt}に保存済みです。現在の状態で更新しますか？`);
                if (!allowUpdate) return { success: false, reason: "update_cancelled" };
            }
            const saved = await window.OptionMapMorningBaseline.saveCandidate(
                existingResult.baseline, candidate, summary.marketDate, { allowUpdate });
            await window.OptionMapMorningBaselineStorage.save(saved.baseline);
            await update();
            text("morningBaselineSaveMessage", saved.status === "unchanged"
                ? "同じ内容のためrevisionは追加しませんでした。" : "今日の朝基準を保存しました。");
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
        document.getElementById("saveMorningBaselineButton")?.addEventListener("click", () => {
            void saveMorningBaseline();
        });
    });

    return Object.freeze({ update, saveMorningBaseline,
        getLatestSummary: () => clone(latestSummary) });
});
