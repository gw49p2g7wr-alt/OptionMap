(function (root, factory) {
    const contractApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./storage/currentPriceLastValidStore.js")
        : root?.OptionMapCurrentPriceLastValidStore;
    const api = factory(contractApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceSavedUiState = api;
})(typeof window !== "undefined" ? window : globalThis, function (contractApi) {
    "use strict";

    const UI_STATE_VERSION = 1;
    const SOURCE = "boot_restore_shadow";
    const TITLE = "保存済み価格";
    const NOTE = "参考表示・現在値には未反映";
    const HIDDEN_BOOT_STATUSES = new Set([
        "missing", "invalid", "tampered", "unavailable", "not_started", "pending"
    ]);

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        for (const nested of Object.values(value)) deepFreeze(nested);
        return Object.freeze(value);
    }

    function liveStatus(value) {
        const candidate = text(typeof value === "string" ? value : value?.status);
        return new Set(["success", "pending", "failed", "not_started", "unknown"])
            .has(candidate) ? candidate : "unknown";
    }

    function formatJst(value) {
        const candidate = text(value);
        if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
        const parts = new Intl.DateTimeFormat("ja-JP", {
            timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23"
        }).formatToParts(new Date(candidate));
        const part = type => parts.find(item => item.type === type)?.value;
        const month = part("month"); const day = part("day");
        const hour = part("hour"); const minute = part("minute");
        return month && day && hour && minute ? `${month}/${day} ${hour}:${minute}` : null;
    }

    function formatContract(value) {
        const match = text(value)?.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}年${Number(match[2])}月限` : null;
    }

    function formatPrice(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0
            ? `${numeric.toLocaleString("ja-JP")}円` : null;
    }

    function hidden(reason, facts = {}) {
        return deepFreeze({
            visible: false,
            state: "hidden",
            title: null,
            priceText: null,
            contractText: null,
            metadataLines: [],
            message: null,
            note: null,
            severity: "neutral",
            source: SOURCE,
            diagnostics: { uiStateVersion: UI_STATE_VERSION, hiddenReason: reason, ...facts }
        });
    }

    function visible(state, severity, candidate, message, facts) {
        const quoteTime = formatJst(candidate.quotedAtNormalized) ||
            text(candidate.quotedAtRaw);
        const fetchedTime = formatJst(candidate.fetchedAt);
        return deepFreeze({
            visible: true,
            state,
            title: TITLE,
            priceText: formatPrice(candidate.value),
            contractText: formatContract(candidate.contract),
            metadataLines: [
                quoteTime ? `価格時刻：${quoteTime}` : null,
                fetchedTime ? `最終取得：${fetchedTime}` : null
            ].filter(Boolean),
            message,
            note: NOTE,
            severity,
            source: SOURCE,
            diagnostics: { uiStateVersion: UI_STATE_VERSION, hiddenReason: null, ...facts }
        });
    }

    function buildCurrentPriceSavedUiState({ bootShadowState = null, liveFetchState = null,
        currentPriceMode = null, activeContract = null } = {}) {
        const boot = bootShadowState && typeof bootShadowState === "object"
            ? bootShadowState : {};
        const bootStatus = text(boot.status) || "unknown";
        const currentLiveStatus = liveStatus(liveFetchState);
        const candidate = boot.candidate && typeof boot.candidate === "object"
            ? boot.candidate : null;
        const contractContext = text(activeContract) ? "available" : "unknown";
        const facts = {
            bootStatus,
            liveStatus: currentLiveStatus,
            contractContext,
            freshnessStatus: text(boot.freshness?.status),
            freshnessReason: text(boot.freshness?.reason)
        };

        if (currentPriceMode === "manual") return hidden("manual_mode", facts);
        if (currentLiveStatus === "success") return hidden("live_success", facts);
        if (bootStatus === "superseded" || boot.reason === "replaced_by_live") {
            return hidden("replaced_by_live", facts);
        }
        if (HIDDEN_BOOT_STATUSES.has(bootStatus)) return hidden(`boot_${bootStatus}`, facts);
        if (!candidate) return hidden("candidate_missing", facts);
        if (boot.diagnostics?.integrityVerified === false ||
            boot.diagnostics?.restoreStatus === "rejected") {
            return hidden("candidate_invalid", facts);
        }
        if (boot.displayEligible !== true) return hidden("display_ineligible", facts);

        const priceText = formatPrice(candidate.value);
        const contractText = formatContract(candidate.contract);
        if (!priceText || !contractText || candidate.origin !== "cache" ||
            candidate.mode !== "automatic" || candidate.source !== "qri-nikkei225-futures") {
            return hidden("candidate_invalid", facts);
        }

        const active = text(activeContract);
        if (active) {
            if (!contractApi?.contractsMatch ||
                !contractApi.contractsMatch(active, candidate.contract)) {
                return hidden("contract_mismatch", { ...facts, contractContext: "mismatch" });
            }
            facts.contractContext = "matched";
        }
        if (boot.freshness?.staleReason === "contract_mismatch") {
            return hidden("contract_mismatch", { ...facts, contractContext: "mismatch" });
        }

        const unresolved = !text(candidate.quoteDate) ||
            !formatJst(candidate.quotedAtNormalized);
        if (unresolved) {
            return visible("saved_unresolved", "caution", candidate,
                "価格日時の年を確認できません", facts);
        }
        if (currentLiveStatus === "failed") {
            return visible("saved_fallback", "caution", candidate,
                "価格取得に失敗しました。保存済み価格を表示しています。", facts);
        }
        return visible("saved_pending", "neutral", candidate,
            currentLiveStatus === "pending" ? "最新価格を確認中…"
                : "最新価格は未確認です", facts);
    }

    return Object.freeze({ UI_STATE_VERSION, SOURCE, buildCurrentPriceSavedUiState,
        formatPrice, formatContract, formatJst });
});
