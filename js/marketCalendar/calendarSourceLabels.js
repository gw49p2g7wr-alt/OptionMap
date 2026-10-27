(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarSourceLabels = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const LABELS = Object.freeze({
        "jp-boj-calendar": "日本銀行",
        "jp-stat-cpi": "総務省統計局・消費者物価指数",
        "jp-stat-labor": "総務省統計局・労働力調査",
        "jp-esri-machinery-orders-calendar": "内閣府・機械受注",
        "jp-esri-sna-calendar": "内閣府・国民経済計算",
        "us-fed-fomc-calendar": "米連邦準備制度",
        "us-bls-calendar": "米労働統計局",
        "us-bea-calendar": "米経済分析局",
        "us-census-calendar": "米国勢調査局",
        "jp-jpx-derivatives-calendar": "日本取引所・デリバティブ",
        "jp-jpx-market-holidays": "日本取引所・休場日",
        "us-nyse-market-holidays": "ニューヨーク証券取引所",
        "jp-mof-jgb-auction-calendar": "財務省・国債入札"
    });
    const getLabel = sourceId => LABELS[sourceId] || null;
    return Object.freeze({ LABELS, getLabel });
});
