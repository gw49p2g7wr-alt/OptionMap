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
        text("mobileSummaryPreviewBaseline", "未設定（朝基準はまだ保存していません）");
        text("mobileSummaryPreviewChange", "比較なし（朝基準未設定）");
        text("mobileSummaryPreviewOptionChanges", "未生成（朝基準未設定）");
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

    async function createInput(qri) {
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
        freshness: state.freshness };
    }

    async function update(qriPayload) {
        if (qriPayload) latestQri = clone(qriPayload);
        try {
            const summary = await window.OptionMapMobileSummary.buildMobileSummary(
                await createInput(latestQri));
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
            const candidate = await window.OptionMapMorningBaseline.createCandidate(summary);
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
