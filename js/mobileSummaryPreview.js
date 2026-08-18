(function (root, factory) {
    const api = factory();
    if (root) root.OptionMapMobileSummaryPreview = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    let latestQri = null;
    let latestSummary = null;

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
        return { generatedAt: new Date().toISOString(), marketDate: canonical?.tradingDate ||
            new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()),
        producer: { appVersion: "1.0.0", platform: navigator.platform || null },
        overallV2: state.overallV2, currentPrice: state.currentPrice,
        qri: { available: Boolean(canonical), canonical, activeContract: canonical?.contract || null,
            versionKey, pageUpdatedAt: canonical?.pageUpdatedAt || null, fetchedAt: qri?.fetchedAt || null,
            usingFallback: state.qriOpenInterest?.usingFallback === true }, sourceVersions,
        freshness: state.freshness };
    }

    async function update(qriPayload) {
        if (qriPayload) latestQri = clone(qriPayload);
        try {
            const summary = await window.OptionMapMobileSummary.buildMobileSummary(
                await createInput(latestQri));
            latestSummary = summary;
            render(summary);
            return { success: true, summary: clone(summary) };
        } catch (error) {
            text("mobileSummaryPreviewStatus", latestSummary
                ? `更新失敗（前回の正常previewを維持）: ${error.message}`
                : `生成できません: ${error.message}`);
            console.warn("MobileSummary previewの更新に失敗しました:", error);
            return { success: false, error: error.message };
        }
    }

    return Object.freeze({ update, getLatestSummary: () => clone(latestSummary) });
});
