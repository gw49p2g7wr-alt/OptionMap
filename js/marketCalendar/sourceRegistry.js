(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventSourceRegistry = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    // Versioned execution contracts are independent of metadata registration.
    // Keep this order/set immutable: historical authority/receipt hashes use v1.
    const HISTORICAL_SOURCE_ORDER = Object.freeze([
        "jp-boj-calendar", "jp-stat-cpi", "jp-stat-labor",
        "jp-esri-machinery-orders-calendar", "jp-esri-sna-calendar",
        "us-fed-fomc-calendar", "us-bls-calendar", "us-bea-calendar",
        "us-census-calendar", "jp-jpx-derivatives-calendar",
        "jp-jpx-market-holidays", "us-nyse-market-holidays"
    ]);
    const HISTORICAL_SOURCE_IDS = Object.freeze([...HISTORICAL_SOURCE_ORDER].sort());
    const SOURCE_SETS = Object.freeze({
        1: Object.freeze({ version: 1, candidateOnly: false, sourceIds: HISTORICAL_SOURCE_IDS }),
        // Pure candidate set only. Neither registration nor activation follows from it.
        2: Object.freeze({ version: 2, candidateOnly: true, sourceIds: Object.freeze([
            ...HISTORICAL_SOURCE_IDS, "jp-mof-jgb-auction-calendar"].sort()) })
    });
    const ACQUISITION_ENABLED_SOURCE_IDS = HISTORICAL_SOURCE_ORDER;
    const getSourceSet = version => Object.hasOwn(SOURCE_SETS, version) &&
        Number.isSafeInteger(version) ? SOURCE_SETS[version] : null;
    const getHistoricalSourceSet = (authorityVersion, permissionVersion) =>
        [2, 3].includes(authorityVersion) && permissionVersion === 1 ? SOURCE_SETS[1] : null;
    // Pure main-side/test selector; no setter, persistent input or renderer override.
    function selectRegisteredEnabledSourceIds(registeredIds, enabledIds) {
        const valid = ids => Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length) &&
            new Set(ids).size === ids.length;
        if (!valid(registeredIds) || !valid(enabledIds) || enabledIds.some(id => !registeredIds.includes(id)))
            throw new TypeError("acquisition_source_set_invalid");
        return Object.freeze(registeredIds.filter(id => enabledIds.includes(id)));
    }
    const sources = [
        ["jp-boj-calendar", "BOJ", "JP", "https://www.boj.or.jp/about/calendar/", "www.boj.or.jp", "Asia/Tokyo"],
        ["jp-stat-cpi", "JP_STATISTICS_BUREAU", "JP", "https://www.stat.go.jp/data/cpi/", "www.stat.go.jp", "Asia/Tokyo"],
        ["jp-stat-labor", "JP_STATISTICS_BUREAU", "JP", "https://www.stat.go.jp/data/roudou/", "www.stat.go.jp", "Asia/Tokyo"],
        ["jp-esri-machinery-orders-calendar", "JP_ESRI", "JP", "https://www.esri.cao.go.jp/jp/stat/stat-schedule.html", "www.esri.cao.go.jp", "Asia/Tokyo"],
        ["jp-esri-sna-calendar", "JP_ESRI", "JP", "https://www.esri.cao.go.jp/jp/sna/kouhyou/kouhyou_top.html", "www.esri.cao.go.jp", "Asia/Tokyo"],
        ["us-fed-fomc-calendar", "US_FED", "US", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "www.federalreserve.gov", "America/New_York"],
        ["us-bls-calendar", "US_BLS", "US", "https://www.bls.gov/schedule/", "www.bls.gov", "America/New_York"],
        ["us-bea-calendar", "US_BEA", "US", "https://apps.bea.gov/API/signup/release_dates.json", "apps.bea.gov", "America/New_York"],
        ["us-census-calendar", "US_CENSUS", "US", "https://www.census.gov/economic-indicators/calendar-listview.html", "www.census.gov", "America/New_York"],
        ["jp-jpx-derivatives-calendar", "JPX", "JP", "https://www.jpx.co.jp/derivatives/rules/last-trading-day/", "www.jpx.co.jp", "Asia/Tokyo"],
        ["jp-jpx-market-holidays", "JPX", "JP", "https://www.jpx.co.jp/corporate/about-jpx/calendar/", "www.jpx.co.jp", "Asia/Tokyo"],
        ["us-nyse-market-holidays", "NYSE", "US", "https://www.nyse.com/trade/hours-calendars", "www.nyse.com", "America/New_York"]
    ].map(([sourceId, authority, jurisdiction, canonicalUrl, allowedHost, sourceTimeZone]) => Object.freeze({
        sourceId, authority, jurisdiction, authorityLevel: "primary", sourceKind: "official_calendar",
        canonicalUrl, allowedHosts: Object.freeze([allowedHost]), sourceTimeZone,
        parserId: `${sourceId}-parser`, parserVersion: 1, formalEligible: true }));
    const sourceEntries = Object.fromEntries(sources.map(source => [source.sourceId, source]));
    const bea = sourceEntries["us-bea-calendar"];
    sourceEntries["us-bea-calendar"] = Object.freeze({ ...bea,
        allowedHosts: Object.freeze(["apps.bea.gov", "www.bea.gov"]),
        endpointRoles: Object.freeze({ scheduleAuthority: bea.canonicalUrl,
            releaseSemantics: "https://www.bea.gov/news/schedule" }) });
    const nyse = sourceEntries["us-nyse-market-holidays"];
    sourceEntries["us-nyse-market-holidays"] = Object.freeze({ ...nyse,
        endpointHistory: Object.freeze([{ url: "https://www.nyse.com/markets/hours-calendars",
            status: "replaced", replacement: nyse.canonicalUrl,
            reason: "official_same_host_redirect_to_trade_hours_calendars" }]) });
    const SOURCES = Object.freeze(sourceEntries);
    const BLOCKED_SOURCES = Object.freeze({ "jp-meti-calendar": Object.freeze({ sourceId: "jp-meti-calendar",
        authority: "JP_METI", jurisdiction: "JP", authorityLevel: "primary",
        sourceKind: "official_calendar", canonicalUrl: null,
        allowedHosts: Object.freeze(["www.meti.go.jp"]), sourceTimeZone: "Asia/Tokyo",
        parserId: "jp-meti-calendar-parser", parserVersion: 1, formalEligible: false,
        formalStatus: "blocked_authority_endpoint", diagnostic: "authority_endpoint_unresolved",
        resumeCondition: "verified_official_primary_schedule_endpoint" }),
        "us-ism-calendar": Object.freeze({ sourceId: "us-ism-calendar", authority: "US_ISM",
            jurisdiction: "US", authorityLevel: "primary", sourceKind: "official_calendar",
            canonicalUrl: null, allowedHosts: Object.freeze(["www.ismworld.org"]),
            sourceTimeZone: "America/New_York", parserId: "us-ism-calendar-parser", parserVersion: 1,
            formalEligible: false, formalStatus: "blocked_authority_endpoint",
            diagnostic: "public_endpoint_client_profile_dependent_sso_redirect",
            lastKnownUrl: "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/",
            resumeCondition: "stable_public_official_schedule_endpoint_without_login_session_or_cookie" }) });
    const getSource = sourceId => SOURCES[sourceId] || null;
    const getKnownSource = sourceId => SOURCES[sourceId] || BLOCKED_SOURCES[sourceId] || null;
    function getAcquisitionEnabledSourceIds() {
        return selectRegisteredEnabledSourceIds(Object.keys(SOURCES), ACQUISITION_ENABLED_SOURCE_IDS);
    }
    const isAcquisitionEnabled = sourceId => ACQUISITION_ENABLED_SOURCE_IDS.includes(sourceId) &&
        getSource(sourceId)?.formalEligible === true;
    function validateSourceUrl(sourceId, value) {
        const source = getSource(sourceId); if (!source) return { valid: false, reason: "source_unregistered" };
        try { const url = new URL(value); return url.protocol === "https:" &&
            source.allowedHosts.includes(url.hostname) && !url.username && !url.password
            ? { valid: true, reason: null, url: url.href }
            : { valid: false, reason: "source_url_not_allowed" }; }
        catch (_error) { return { valid: false, reason: "source_url_invalid" }; }
    }
    const REPLACED_SOURCES = Object.freeze({ "jp-esri-calendar": Object.freeze({ status: "replaced",
        reason: "official_endpoint_removed_http_404", replacements: Object.freeze([
            "jp-esri-machinery-orders-calendar", "jp-esri-sna-calendar"]) }) });
    return Object.freeze({ SOURCES, BLOCKED_SOURCES, REPLACED_SOURCES, getSource, getKnownSource,
        validateSourceUrl, HISTORICAL_SOURCE_ORDER, HISTORICAL_SOURCE_IDS, SOURCE_SETS,
        getSourceSet, getHistoricalSourceSet, ACQUISITION_ENABLED_SOURCE_IDS,
        selectRegisteredEnabledSourceIds, getAcquisitionEnabledSourceIds, isAcquisitionEnabled });
});
