(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const api = factory();
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsHistoryComparisonView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const typeText = value => value === "put" ? "PUT" : "CALL";
    const sideText = value => value === "sell" ? "sell" : "buy";
    const number = value => Number.isFinite(value) ? value.toLocaleString("ja-JP") : "非掲載";
    const signed = value => Number.isFinite(value)
        ? `${value > 0 ? "+" : ""}${value.toLocaleString("ja-JP")}` : "差分なし";
    function participantLine(item) {
        const broker = item.brokerLabels.current || item.brokerLabels.previous || "名称不明";
        const value = item.status === "newly_published"
            ? item.current.value : item.previous.value;
        return `${typeText(item.optionType)} ${sideText(item.side)}｜` +
            `${item.participantCode} ${broker}｜公表値 ${number(value)}`;
    }
    function createHistoryComparisonView(result) {
        const base = {
            sourceNotice: "正式weekly options history（active revision）使用中",
            predictionNotice: "方向予測には未使用",
            metadata: [], coverageRows: [], strikeRows: [],
            strikeMessage: null, newlyPublished: [], disappeared: [], warnings: []
        };
        if (!result || result.status === "invalid") return { ...base,
            state: "invalid", message: "正式historyを検証できないため比較を行いません。" };
        if (result.status === "unavailable") return { ...base,
            state: "empty", message: "正式weekly options historyはまだありません。" };
        if (result.status === "waiting_previous") return { ...base,
            state: "waiting", message: "正式historyが1週のみのため、前週データ待ちです。",
            metadata: [{ label: "最新週", value: result.currentSourceDate || "—" },
                { label: "対象限月", value: result.currentExpiry || "—" }] };
        const changes = result.changes;
        const metadata = [
            { label: "比較", value: `${result.previousSourceDate} → ${result.currentSourceDate}` },
            { label: "対象限月", value: result.status === "roll_transition"
                ? `${result.previousExpiry} → ${result.currentExpiry}` : result.currentExpiry },
            { label: "比較状態", value: result.status }
        ];
        if (result.status === "roll_transition") return { ...base,
            state: "roll_transition", metadata,
            message: "限月切替のため単純比較対象外です。数量差は計算していません。",
            warnings: ["PUT/CALLの限月切替を検出しました。異なる限月は比較していません。"] };
        const top = (changes.strikeChanges || []).filter(item =>
            item.status === "continued" && Number.isFinite(item.delta)
        ).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
        return { ...base, state: "ready", metadata,
            coverageRows: [
                { label: "両週掲載・比較可能", value: result.counts.comparable },
                { label: "前週のみ掲載", value: result.counts.previousOnly },
                { label: "最新週のみ掲載", value: result.counts.currentOnly },
                { label: "両週観測不能", value: result.counts.unobserved },
                { label: "比較不能／非掲載", value: result.counts.unavailable }
            ],
            strikeRows: top.map(item => ({
                label: `${typeText(item.optionType)} ${sideText(item.side)}｜${number(item.strike)}円`,
                previous: number(item.previous.value), current: number(item.current.value),
                change: signed(item.delta)
            })),
            strikeMessage: top.length === 0
                ? "共通strikeがないため、同一strikeの数量差は表示しません。" : null,
            newlyPublished: (changes.newlyPublished || []).slice(0, 12).map(participantLine),
            disappeared: (changes.disappeared || []).slice(0, 12).map(participantLine),
            warnings: ["非掲載は0として補完していません。",
                "CALL/PUT、sell/buy、participantCodeを分離して比較しています。",
                ...(result.counts.comparable === 0
                    ? ["前週と最新週で掲載strike窓が重ならないため、相対位置を同一strike差として扱っていません。"] : []),
                "公表順位内で観測できた変化であり、市場全体の建玉変化ではありません。"]
        };
    }
    return Object.freeze({ createHistoryComparisonView });
});
