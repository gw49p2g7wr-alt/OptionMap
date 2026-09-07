(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.OptionMapJpxSnapshotSafety = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    function parseSnapshotList(serialized) {
        try {
            const value = JSON.parse(serialized || "[]");
            if (!Array.isArray(value) || value.some(snapshot =>
                !isRecord(snapshot) || typeof snapshot.sourceDate !== "string" ||
                snapshot.sourceDate.length === 0
            )) return { ok: false, value: null, reason: "invalid_snapshot_list" };
            return { ok: true, value, reason: null };
        } catch (_error) {
            return { ok: false, value: null, reason: "malformed_json" };
        }
    }
    function copyDefined(base, incoming) {
        const result = { ...base };
        for (const [key, value] of Object.entries(incoming || {})) {
            if (value !== undefined) result[key] = value;
        }
        return result;
    }
    function mergeManualSnapshot(existing, incoming) {
        if (!isRecord(existing)) return copyDefined({}, incoming);
        const merged = { ...existing };
        for (const [key, value] of Object.entries(incoming || {})) {
            if (value !== undefined && value !== null) merged[key] = value;
        }
        const newMemo = typeof incoming?.memo === "string" ? incoming.memo : "";
        merged.memo = newMemo.length > 0 ? newMemo :
            (typeof existing.memo === "string" ? existing.memo : "");
        merged.tags = Array.isArray(existing.tags) ? [...existing.tags] : [];
        return merged;
    }
    function mergeHistoricalSnapshot(existing, incoming) {
        if (!isRecord(existing)) return copyDefined({}, incoming);
        const merged = copyDefined(existing, incoming);
        merged.sourceDate = existing.sourceDate;
        merged.memo = typeof existing.memo === "string" ? existing.memo : "";
        merged.tags = Array.isArray(existing.tags) ? [...existing.tags] : [];
        return merged;
    }
    function appendTextElement(document, parent, tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }
    function buildSnapshotItemContent(document, snapshot, index) {
        const wrapper = document.createElement("div");
        const main = document.createElement("div");
        wrapper.appendChild(main);
        const date = new Date(snapshot?.sourceDate);
        const savedAt = new Date(snapshot?.savedAt);
        const dateText = Number.isNaN(date.getTime()) ? "日時不明" : date.toLocaleString("ja-JP", {
            year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
        appendTextElement(document, main, "div", "saved-snapshot-date", `${index + 1}.　${dateText}`);
        const tags = document.createElement("div");
        tags.className = "snapshot-tags";
        if (Array.isArray(snapshot?.tags)) {
            for (const tag of snapshot.tags) {
                if (typeof tag === "string") appendTextElement(document, tags, "span", "snapshot-tag", tag);
            }
        }
        main.appendChild(tags);
        if (typeof snapshot?.memo === "string" && snapshot.memo.length > 0) {
            appendTextElement(document, main, "div", "snapshot-memo", `📝 ${snapshot.memo}`);
        }
        const editButton = appendTextElement(document, main, "button",
            "edit-snapshot-memo-button", "メモを編集");
        editButton.type = "button";
        editButton.dataset.index = String(index);
        const dataCount = Array.isArray(snapshot?.labels) ? snapshot.labels.length : 0;
        const savedText = Number.isNaN(savedAt.getTime()) ? "日時不明" : savedAt.toLocaleString("ja-JP", {
            month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
        appendTextElement(document, main, "div", "saved-snapshot-detail",
            `${dataCount.toLocaleString()}価格帯 ・保存： ${savedText}`);
        for (const [className, label] of [["show-snapshot-button", "表示"],
            ["compare-snapshot-button", "比較"]]) {
            const button = appendTextElement(document, wrapper, "button", className, label);
            button.type = "button";
        }
        return wrapper;
    }
    function formatBackfillStatus(counts) {
        const saved = Number.isInteger(counts?.saved) ? counts.saved : 0;
        const skipped = Number.isInteger(counts?.skipped) ? counts.skipped : 0;
        const failed = Number.isInteger(counts?.failed) ? counts.failed : 0;
        const prefix = failed > 0
            ? (saved > 0 ? "一部の取得・保存が完了しました" : "取得・保存に失敗しました")
            : "取得・保存が完了しました";
        return `${prefix}（保存 ${saved}件、スキップ ${skipped}件、失敗 ${failed}件）`;
    }
    return Object.freeze({ parseSnapshotList, mergeManualSnapshot,
        mergeHistoricalSnapshot, buildSnapshotItemContent, formatBackfillStatus });
});
