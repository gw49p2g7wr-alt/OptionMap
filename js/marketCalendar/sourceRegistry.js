(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventSourceRegistry = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const sources = [
        ["jp-boj-calendar", "BOJ", "JP", "https://www.boj.or.jp/about/calendar/", "www.boj.or.jp", "Asia/Tokyo"],
        ["jp-stat-cpi", "JP_STATISTICS_BUREAU", "JP", "https://www.stat.go.jp/data/cpi/", "www.stat.go.jp", "Asia/Tokyo"],
        ["jp-stat-labor", "JP_STATISTICS_BUREAU", "JP", "https://www.stat.go.jp/data/roudou/", "www.stat.go.jp", "Asia/Tokyo"],
        ["jp-esri-calendar", "JP_ESRI", "JP", "https://www.esri.cao.go.jp/jp/stat/kouhyou/kouhyou.html", "www.esri.cao.go.jp", "Asia/Tokyo"],
        ["jp-meti-calendar", "JP_METI", "JP", "https://www.meti.go.jp/statistics/", "www.meti.go.jp", "Asia/Tokyo"],
        ["us-fed-fomc-calendar", "US_FED", "US", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "www.federalreserve.gov", "America/New_York"],
        ["us-bls-calendar", "US_BLS", "US", "https://www.bls.gov/schedule/", "www.bls.gov", "America/New_York"],
        ["us-bea-calendar", "US_BEA", "US", "https://www.bea.gov/news/schedule", "www.bea.gov", "America/New_York"],
        ["us-census-calendar", "US_CENSUS", "US", "https://www.census.gov/economic-indicators/calendar-listview.html", "www.census.gov", "America/New_York"],
        ["us-ism-calendar", "US_ISM", "US", "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/", "www.ismworld.org", "America/New_York"],
        ["jp-jpx-derivatives-calendar", "JPX", "JP", "https://www.jpx.co.jp/derivatives/rules/last-trading-day/", "www.jpx.co.jp", "Asia/Tokyo"],
        ["jp-jpx-market-holidays", "JPX", "JP", "https://www.jpx.co.jp/corporate/about-jpx/calendar/", "www.jpx.co.jp", "Asia/Tokyo"],
        ["us-nyse-market-holidays", "NYSE", "US", "https://www.nyse.com/markets/hours-calendars", "www.nyse.com", "America/New_York"]
    ].map(([sourceId, authority, jurisdiction, canonicalUrl, allowedHost, sourceTimeZone]) => Object.freeze({
        sourceId, authority, jurisdiction, authorityLevel: "primary", sourceKind: "official_calendar",
        canonicalUrl, allowedHosts: Object.freeze([allowedHost]), sourceTimeZone,
        parserId: `${sourceId}-parser`, parserVersion: 1, formalEligible: true }));
    const SOURCES = Object.freeze(Object.fromEntries(sources.map(source => [source.sourceId, source])));
    const getSource = sourceId => SOURCES[sourceId] || null;
    function validateSourceUrl(sourceId, value) {
        const source = getSource(sourceId); if (!source) return { valid: false, reason: "source_unregistered" };
        try { const url = new URL(value); return url.protocol === "https:" &&
            source.allowedHosts.includes(url.hostname) && !url.username && !url.password
            ? { valid: true, reason: null, url: url.href }
            : { valid: false, reason: "source_url_not_allowed" }; }
        catch (_error) { return { valid: false, reason: "source_url_invalid" }; }
    }
    return Object.freeze({ SOURCES, getSource, validateSourceUrl });
});
