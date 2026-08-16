(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsChangesView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const STATUS_TEXT = Object.freeze({
        comparable: "comparable（比較可能）",
        partial: "partial（一部比較）",
        roll_transition: "roll_transition（限月切替）",
        unavailable: "unavailable（比較不可）",
        waiting_previous: "前週データ待ち",
        invalid: "データ検証エラー"
    });

    const WARNING_TEXT = Object.freeze({
        published_rankings_only: "公表順位内のデータだけを集計しています。",
        absence_is_not_zero: "非掲載は数量0ではなく、観測されていない状態です。",
        weekly_not_realtime: "週次データであり、リアルタイム需給ではありません。",
        hedging_spreads_and_market_making_not_identified:
            "ヘッジ、スプレッド、マーケットメイクを区別できません。",
        no_direction_forecast: "方向予測には使用していません。",
        no_common_strikes:
            "共通strikeがないため、同一strikeの数量差は比較できません。",
        strike_window_changed: "前週から掲載strike窓が移動しています。",
        translated_bucket_is_not_exact_strike:
            "掲載窓内の相対bucket比較は、同一strike比較ではありません。",
        support_resistance_reference_unavailable:
            "日付対応価格がないため、支持・抵抗候補の週次比較はできません。",
        roll_transition: "限月切替のため、前週との数量比較を行いません。",
        different_expiries_not_compared: "異なる限月は直接比較していません。"
    });

    function formatNumber(value, digits = 0) {
        if (!Number.isFinite(value)) return "—";
        return value.toLocaleString("ja-JP", {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        });
    }

    function signed(value, digits = 0, suffix = "") {
        if (!Number.isFinite(value)) return "—";
        const prefix = value > 0 ? "+" : "";
        return `${prefix}${formatNumber(value, digits)}${suffix}`;
    }

    function statusText(status) {
        return STATUS_TEXT[status] || status || "unavailable（比較不可）";
    }

    function distributionSummary(change, step) {
        const shift = change?.windowRelativeCentroidShift;
        if (!Number.isFinite(shift)) return "比較不可";
        const tolerance = Number.isFinite(step) ? step * 0.25 : 25;
        if (Math.abs(shift) <= tolerance) {
            return `ほぼ不変（${signed(shift, 1, "円")}）`;
        }
        return `${shift > 0 ? "上方" : "下方"}（${signed(shift, 1, "円")}）`;
    }

    function breadthSummary(changes) {
        const values = [];
        for (const optionType of ["put", "call"]) {
            for (const side of ["sell", "buy"]) {
                const delta = changes?.[optionType]?.[side]?.delta;
                if (Number.isFinite(delta)) values.push(delta);
            }
        }
        if (values.length === 0) return "比較不可";
        if (values.every(value => value === 0)) return "ほぼ不変";
        if (values.every(value => value >= 0) && values.some(value => value > 0)) {
            return `増加（区分別合計 ${signed(values.reduce((a, b) => a + b, 0))}）`;
        }
        if (values.every(value => value <= 0) && values.some(value => value < 0)) {
            return `減少（区分別合計 ${signed(values.reduce((a, b) => a + b, 0))}）`;
        }
        return "区分ごとに増減が混在";
    }

    function concentrationRows(changes) {
        const rows = [];
        for (const optionType of ["put", "call"]) {
            for (const side of ["sell", "buy"]) {
                const change = changes?.[optionType]?.[side] || {};
                const delta = change.delta;
                rows.push({
                    label: `${optionType.toUpperCase()} ${side}`,
                    previous: formatNumber(change.previous, 3),
                    current: formatNumber(change.current, 3),
                    change: Number.isFinite(delta)
                        ? `${delta > 0 ? "集中増加" : delta < 0 ? "集中低下" : "ほぼ不変"}` +
                            `（${signed(delta, 3)}）`
                        : "比較不可"
                });
            }
        }
        return rows;
    }

    function breadthRows(changes) {
        const rows = [];
        for (const optionType of ["put", "call"]) {
            for (const side of ["sell", "buy"]) {
                const change = changes?.[optionType]?.[side] || {};
                rows.push({
                    label: `${optionType.toUpperCase()} ${side}`,
                    previous: formatNumber(change.previous),
                    current: formatNumber(change.current),
                    change: signed(change.delta)
                });
            }
        }
        return rows;
    }

    function candidateSummary(change, name) {
        if (!change?.available) {
            return {
                label: name,
                value: change?.reason === "reference_prices_unavailable"
                    ? "日付対応価格がないため比較不可" : "比較不可",
                detail: null
            };
        }
        const maintained = change.relativeStepShift === 0;
        return {
            label: name,
            value: `${formatNumber(change.previous.strike)}円 → ` +
                `${formatNumber(change.current.strike)}円`,
            detail: `絶対移動 ${signed(change.absoluteStrikeShift, 0, "円")} ／ ` +
                `相対位置 ${maintained ? "維持" : "移動"}` +
                `（${signed(change.relativeStepShift, 1, " step")}）`
        };
    }

    function labelText(label) {
        const facts = label?.facts || {};
        const mappings = {
            strike_window_moved_up:
                `掲載strike窓が上へ${formatNumber(facts.translation)}円移動`,
            strike_window_moved_down:
                `掲載strike窓が下へ${formatNumber(Math.abs(facts.translation))}円移動`,
            put_distribution_shifted_lower_relative_to_window:
                `PUT分布が掲載窓比で下方へ${formatNumber(Math.abs(facts.shift), 1)}円移動`,
            put_distribution_shifted_higher_relative_to_window:
                `PUT分布が掲載窓比で上方へ${formatNumber(facts.shift, 1)}円移動`,
            call_distribution_shifted_lower_relative_to_window:
                `CALL分布が掲載窓比で下方へ${formatNumber(Math.abs(facts.shift), 1)}円移動`,
            call_distribution_shifted_higher_relative_to_window:
                `CALL分布が掲載窓比で上方へ${formatNumber(facts.shift, 1)}円移動`,
            support_candidate_moved_up: "支持候補strikeが上へ移動",
            support_candidate_moved_down: "支持候補strikeが下へ移動",
            resistance_candidate_moved_up: "抵抗候補strikeが上へ移動",
            resistance_candidate_moved_down: "抵抗候補strikeが下へ移動",
            support_candidate_relative_position_unchanged: "支持候補の相対位置を維持",
            resistance_candidate_relative_position_unchanged: "抵抗候補の相対位置を維持"
        };
        if (mappings[label?.code]) return mappings[label.code];
        if (label?.code === "published_participant_breadth_increased" ||
            label?.code === "published_participant_breadth_decreased") {
            return `${String(facts.optionType || "").toUpperCase()} ${facts.side || ""}の` +
                `公表参加者breadthが${facts.delta > 0 ? "増加" : "減少"}` +
                `（${signed(facts.delta)}）`;
        }
        if (label?.code === "participant_concentration_increased" ||
            label?.code === "participant_concentration_decreased") {
            return `${String(facts.optionType || "").toUpperCase()} ${facts.side || ""}の` +
                `participant集中が${facts.delta > 0 ? "増加" : "低下"}`;
        }
        return label?.code || "不明なラベル";
    }

    function partialReason(changes) {
        if (changes?.status !== "partial") return null;
        const common = changes.comparisonCoverage?.exactCommonStrikeCount;
        if (common === 0 && changes.comparisonCoverage?.translatedWindowComparable) {
            return "共通strike 0本のため、exact strike比較不可。" +
                "掲載窓内の相対比較のみ。";
        }
        if (common === 0) return "共通strike 0本のため、exact strike比較不可。";
        if (!changes.supportChanges?.available || !changes.resistanceChanges?.available) {
            return "日付対応価格がないため、支持・抵抗候補の比較は未実施です。";
        }
        return "一部の比較条件が不足しているため、利用可能な項目だけを表示します。";
    }

    function waitingView(shadowChanges, shadowSignal) {
        const signal = shadowSignal?.signal;
        const invalid = shadowChanges?.status === "invalid";
        return {
            state: invalid ? "invalid" : "waiting",
            status: invalid ? "unavailable" : "waiting_previous",
            statusText: statusText(invalid ? "unavailable" : "waiting_previous"),
            message: invalid
                ? "週次オプション変化データを検証できません。"
                : "週次オプション変化データはまだありません。前週データ待ちです。",
            metadata: [
                { label: "現在週", value: signal?.sourceDate ||
                    shadowChanges?.currentSourceMetadata?.sourceDate || "—" },
                { label: "限月", value: signal?.expiry || "—" },
                { label: "単週shadow", value: shadowSignal?.status || "未取得" }
            ],
            summaries: [],
            breadthRows: [],
            participantConcentrationRows: [],
            strikeConcentrationRows: [],
            candidates: [],
            labels: [],
            warnings: ["方向予測には使用していません。"]
        };
    }

    function createWeeklyOptionsChangesView(shadowChanges, shadowSignal = null) {
        const changes = shadowChanges?.changes;
        if (!changes) return waitingView(shadowChanges, shadowSignal);
        const step = changes.strikeWindow?.current?.step;
        const common = changes.comparisonCoverage?.exactCommonStrikeCount;
        const translation = changes.strikeWindow?.translation;
        return {
            state: "ready",
            status: changes.status,
            statusText: statusText(changes.status),
            message: changes.status === "roll_transition"
                ? "限月切替のため、前週との数量比較は行いません。" : null,
            partialReason: partialReason(changes),
            metadata: [
                { label: "対象週", value:
                    `${changes.previousSourceDate || "—"} → ${changes.currentSourceDate || "—"}` },
                { label: "限月", value: changes.expiry ||
                    `${changes.previousExpiry || "—"} → ${changes.currentExpiry || "—"}` },
                { label: "比較状態", value: statusText(changes.status) },
                { label: "共通strike", value: Number.isFinite(common)
                    ? `${common}本` : "—" },
                { label: "exact比較率", value:
                    Number.isFinite(changes.comparisonCoverage?.exactCommonStrikeRatio)
                        ? `${formatNumber(changes.comparisonCoverage.exactCommonStrikeRatio * 100, 0)}%`
                        : "—" },
                { label: "strike window移動", value:
                    Number.isFinite(translation) ? signed(translation, 0, "円") : "比較不可" }
            ],
            summaries: changes.distributionShift ? [
                { label: "PUT分布", value: distributionSummary(
                    changes.distributionShift.put?.sell, step
                ) },
                { label: "CALL分布", value: distributionSummary(
                    changes.distributionShift.call?.sell, step
                ) },
                { label: "公表参加者breadth", value:
                    breadthSummary(changes.breadthChanges) }
            ] : [],
            breadthRows: breadthRows(changes.breadthChanges),
            participantConcentrationRows: concentrationRows(
                changes.concentrationChanges?.participantHhi
            ),
            strikeConcentrationRows: concentrationRows(
                changes.concentrationChanges?.strikeHhi
            ),
            candidates: [
                candidateSummary(changes.supportChanges, "支持候補strike"),
                candidateSummary(changes.resistanceChanges, "抵抗候補strike")
            ],
            labels: (changes.labels || []).map(labelText),
            warnings: [...new Set((changes.warnings || []).map(warning =>
                WARNING_TEXT[warning] || warning
            ))]
        };
    }

    return Object.freeze({
        createWeeklyOptionsChangesView,
        statusText,
        WARNING_TEXT
    });
});
