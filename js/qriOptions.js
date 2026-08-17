(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptions = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const PARSER_VERSION = 2;
    const SCHEMA_VERSION = 2;
    const CACHE_VERSION = 2;
    const SOURCE = "qri-nikkei225-options";
    const VERSION_PREFIX = "qri-options-v2";
    const QRI_ORIGIN = "https://svc.qri.jp";

    function text(value) {
        return String(value || "").replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
            .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
    }
    function validDate(value) {
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    function dateFromSlash(value) {
        const match = String(value || "").match(/(20\d{2})\/(\d{2})\/(\d{2})/);
        const result = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
        return validDate(result) ? result : null;
    }
    function pageUpdatedAt(html) {
        const match = String(html).match(/最終更新時刻[\s\S]{0,300}?<dd[^>]*>\s*(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*<\/dd>/i);
        return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00` : null;
    }
    function metadataDate(html, label) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = String(html).match(new RegExp(`${escaped}[\\s\\S]{0,200}?<dd[^>]*>\\s*(20\\d{2}\\/\\d{2}\\/\\d{2})\\s*<\\/dd>`, "i"));
        return dateFromSlash(match?.[1]);
    }
    function normalizeSourceUrl(value) {
        try {
            const url = new URL(value);
            if (url.origin !== QRI_ORIGIN || !/^\/jpx\/nkopm(?:\/\d+)?\/?$/.test(url.pathname)) return null;
            const path = url.pathname.replace(/\/+$/, "");
            url.pathname = path === "/jpx/nkopm" ? `${path}/` : path;
            url.search = ""; url.hash = "";
            return url.href;
        } catch (_error) { return null; }
    }
    function contractFromGengetsu(value) {
        const match = String(value || "").match(/^(20\d{2})(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}-${match[2]}` : null;
    }
    function contractMatchesLabel(contract, label) {
        const month = String(label || "").match(/(1[0-2]|[1-9])月/)?.[1];
        return month != null && Number(contract?.slice(5)) === Number(month);
    }
    function navigation(html, sourceUrl) {
        const block = String(html).match(/<div[^>]+id=["']futuresContractTab["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
        if (!block) return [];
        const items = [];
        for (const match of block.matchAll(/<li\b([^>]*)>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi)) {
            const active = /\bactive\b/i.test(match[1]);
            const href = match[2].match(/href=["']([^"']+)["']/i)?.[1];
            let url = null;
            try { url = active || /^javascript:/i.test(href || "")
                ? normalizeSourceUrl(sourceUrl)
                : normalizeSourceUrl(new URL(href, QRI_ORIGIN).href); }
            catch (_error) { url = null; }
            const label = text(match[3]);
            if (url && label) items.push({ contract: null, label, url, active });
        }
        return items;
    }
    function parseCell(value) {
        const normalized = text(value);
        if (normalized === "" || /^[－—–-]$/.test(normalized)) {
            return { published: false, value: null };
        }
        const compact = normalized.replace(/,/g, "");
        if (!/^\d+$/.test(compact)) return null;
        const number = Number(compact);
        return Number.isSafeInteger(number) && number >= 0
            ? { published: true, value: number } : null;
    }
    function parseRows(html, contract) {
        const records = [];
        for (const row of String(html).matchAll(/<tr\b[^>]*class=["'][^"']*\brow-num\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(item => item[1]);
            const strikeText = text(cells[8]).replace(/リスク指標/g, "")
                .replace(/\bA\s*T\s*M\b/gi, "").replace(/,/g, "").trim();
            if (!/^\d+(?:\.\d+)?$/.test(strikeText)) throw new Error("invalid_strike");
            const strike = Number(strikeText);
            if (!Number.isFinite(strike) || strike <= 0) throw new Error("invalid_strike");
            for (const [optionType, cellIndex] of [["call", 1], ["put", 15]]) {
                const observed = parseCell(cells[cellIndex]);
                if (!observed) throw new Error("invalid_open_interest_cell");
                records.push({ contract, optionType, strike, ...observed });
            }
        }
        if (records.length === 0) throw new Error("option_rows_missing");
        return records;
    }
    function parseQriOptionsPage(html, sourceUrl) {
        const normalizedUrl = normalizeSourceUrl(sourceUrl);
        if (!normalizedUrl || typeof html !== "string") throw new Error("invalid_qri_page");
        const decodedHtml = html.replace(/&amp;/gi, "&");
        const gengetsu = decodedHtml.match(/[?&]gengetsu=(20\d{4})(?:&|["'])/i)?.[1] || null;
        const contract = contractFromGengetsu(gengetsu);
        const nav = navigation(html, normalizedUrl);
        const active = nav.find(item => item.active);
        const updatedAt = pageUpdatedAt(html);
        const tradingDate = metadataDate(html, "取引日");
        const lastTradingDate = metadataDate(html, "取引最終日");
        if (!contract || !active || !updatedAt || !tradingDate || !lastTradingDate) {
            throw new Error("qri_metadata_invalid");
        }
        active.contract = contract;
        const records = parseRows(html, contract);
        const publishedTypes = new Set(records.filter(record => record.published)
            .map(record => record.optionType));
        const openInterestStatus = publishedTypes.size === 2 ? "available"
            : publishedTypes.size === 1 ? "partial" : "unavailable";
        const result = { parserVersion: PARSER_VERSION, schemaVersion: SCHEMA_VERSION,
            source: SOURCE, sourceUrl: normalizedUrl, pageUpdatedAt: updatedAt,
            tradingDate, openInterestAsOf: null, contract, gengetsu,
            contractLabel: active.label, isActiveContract: true,
            lastTradingDate, openInterestStatus, availableContracts: nav, records };
        if (!validateCanonical(result, { allowUnresolvedContracts: true })) {
            throw new Error("qri_canonical_invalid");
        }
        return result;
    }
    function resolveAvailableContracts(defaultPage, pages) {
        const byUrl = new Map(pages.map(page => [page.sourceUrl, page]));
        return defaultPage.availableContracts.map(item => {
            const page = byUrl.get(item.url);
            if (!page) return { ...item };
            if (page.contractLabel !== item.label || !contractMatchesLabel(page.contract, item.label)) {
                throw new Error("contract_url_mismatch");
            }
            return { contract: page.contract, label: item.label, url: item.url,
                active: item.active, gengetsu: page.gengetsu,
                lastTradingDate: page.lastTradingDate };
        });
    }
    function parseQriOptionsBundle(pageInputs, defaultSourceUrl) {
        if (!Array.isArray(pageInputs) || pageInputs.length === 0) throw new Error("pages_missing");
        const pages = pageInputs.map(input => parseQriOptionsPage(input.html, input.sourceUrl));
        const defaultUrl = normalizeSourceUrl(defaultSourceUrl);
        const defaultPage = pages.find(page => page.sourceUrl === defaultUrl);
        if (!defaultPage) throw new Error("default_page_missing");
        const availableContracts = resolveAvailableContracts(defaultPage, pages);
        if (availableContracts.some(item => !item.contract)) throw new Error("contract_page_missing");
        return { defaultContract: defaultPage.contract, availableContracts, pages };
    }
    function validateCanonical(data, { allowUnresolvedContracts = false } = {}) {
        if (!data || data.parserVersion !== 2 || data.schemaVersion !== 2 || data.source !== SOURCE ||
            !normalizeSourceUrl(data.sourceUrl) || !/^20\d{2}-\d{2}-\d{2}T/.test(data.pageUpdatedAt || "") ||
            !validDate(data.tradingDate) || data.openInterestAsOf !== null || !validDate(data.lastTradingDate) ||
            !["available", "partial", "unavailable"].includes(data.openInterestStatus) ||
            data.isActiveContract !== true ||
            contractFromGengetsu(data.gengetsu) !== data.contract || !Array.isArray(data.availableContracts) ||
            !Array.isArray(data.records) || data.records.length === 0) return false;
        const activeItems = data.availableContracts.filter(item => item.active);
        const selected = activeItems.find(item => item.url === data.sourceUrl);
        if (activeItems.length !== 1 || !selected || selected.contract !== data.contract ||
            !contractMatchesLabel(data.contract, data.contractLabel) ||
            selected.label !== data.contractLabel) return false;
        if (!allowUnresolvedContracts && data.availableContracts.some(item => !item.contract)) return false;
        const urls = new Set();
        for (const item of data.availableContracts) {
            const contractValid = item.contract === null && allowUnresolvedContracts ||
                /^20\d{2}-(0[1-9]|1[0-2])$/.test(item.contract || "");
            if (!normalizeSourceUrl(item.url) || urls.has(item.url) || typeof item.label !== "string" ||
                typeof item.active !== "boolean" || !contractValid) return false;
            urls.add(item.url);
        }
        const keys = new Set(); const strikesByType = { call: new Set(), put: new Set() };
        for (const record of data.records) {
            if (record.contract !== data.contract || !["call", "put"].includes(record.optionType) ||
                !Number.isFinite(record.strike) || record.strike <= 0 || typeof record.published !== "boolean" ||
                (record.published ? !Number.isSafeInteger(record.value) || record.value < 0 : record.value !== null)) return false;
            const key = `${record.optionType}|${record.strike}`;
            if (keys.has(key)) return false;
            keys.add(key); strikesByType[record.optionType].add(record.strike);
        }
        const publishedTypes = new Set(data.records.filter(record => record.published)
            .map(record => record.optionType));
        const expectedStatus = publishedTypes.size === 2 ? "available"
            : publishedTypes.size === 1 ? "partial" : "unavailable";
        return data.openInterestStatus === expectedStatus && strikesByType.call.size > 0 &&
            strikesByType.call.size === strikesByType.put.size &&
            [...strikesByType.call].every(strike => strikesByType.put.has(strike));
    }
    function normalizeForSignature(data) {
        if (!validateCanonical(data, { allowUnresolvedContracts: true })) return null;
        return { contract: data.contract, pageUpdatedAt: data.pageUpdatedAt,
            tradingDate: data.tradingDate, lastTradingDate: data.lastTradingDate,
            records: data.records.map(record => [record.contract, record.optionType,
                record.strike, record.published, record.value]).sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }
    async function sha256(value) {
        const serialized = JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
            return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
    }
    async function createSignature(data) {
        const normalized = normalizeForSignature(data);
        return normalized ? sha256(normalized) : null;
    }
    async function createCacheV2(data, fetchedAt) {
        if (!validateCanonical(data, { allowUnresolvedContracts: true }) ||
            Number.isNaN(new Date(fetchedAt).getTime())) return null;
        const signature = await createSignature(data);
        return { cacheVersion: CACHE_VERSION, parserVersion: PARSER_VERSION,
            schemaVersion: SCHEMA_VERSION, source: SOURCE, sourceUrl: data.sourceUrl,
            contract: data.contract, pageUpdatedAt: data.pageUpdatedAt, fetchedAt,
            signatureAlgorithm: "sha256", signature,
            versionKey: `${VERSION_PREFIX}|${data.contract}|${data.pageUpdatedAt}|sha256:${signature}`,
            canonical: JSON.parse(JSON.stringify(data)) };
    }
    async function validateCacheV2(cache) {
        if (!cache || cache.cacheVersion !== 2 || cache.parserVersion !== 2 || cache.schemaVersion !== 2 ||
            cache.source !== SOURCE || cache.contract !== cache.canonical?.contract ||
            cache.sourceUrl !== cache.canonical?.sourceUrl || cache.pageUpdatedAt !== cache.canonical?.pageUpdatedAt ||
            cache.signatureAlgorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(cache.signature || "") ||
            Number.isNaN(new Date(cache.fetchedAt).getTime()) ||
            !validateCanonical(cache.canonical, { allowUnresolvedContracts: true })) return false;
        const signature = await createSignature(cache.canonical);
        return signature === cache.signature && cache.versionKey ===
            `${VERSION_PREFIX}|${cache.contract}|${cache.pageUpdatedAt}|sha256:${signature}`;
    }
    async function restoreCacheV2(serialized) {
        try {
            const parsed = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
            return await validateCacheV2(parsed) ? JSON.parse(JSON.stringify(parsed)) : null;
        } catch (_error) { return null; }
    }
    function createLegacyDisplayView(data) {
        if (!validateCanonical(data, { allowUnresolvedContracts: true })) return null;
        const strikes = [...new Set(data.records.map(record => record.strike))].sort((a, b) => a - b);
        const record = (type, strike) => data.records.find(item => item.optionType === type && item.strike === strike);
        return { legacyDisplayOnly: true, contract: data.contract,
            labels: strikes.map(strike => strike.toLocaleString("ja-JP")),
            callOpenInterest: strikes.map(strike => record("call", strike).published ? record("call", strike).value : 0),
            putOpenInterest: strikes.map(strike => record("put", strike).published ? record("put", strike).value : 0),
            openInterestAvailable: data.records.some(item => item.optionType === "call" && item.published) &&
                data.records.some(item => item.optionType === "put" && item.published) };
    }
    function selectContractUrl(bundle, contract) {
        if (!bundle || !Array.isArray(bundle.availableContracts)) return null;
        return bundle.availableContracts.find(item => item.contract === contract)?.url || null;
    }
    return Object.freeze({ PARSER_VERSION, SCHEMA_VERSION, CACHE_VERSION, SOURCE,
        contractFromGengetsu, normalizeSourceUrl, parseQriOptionsPage,
        parseQriOptionsBundle, validateCanonical, normalizeForSignature,
        createSignature, createCacheV2, validateCacheV2, restoreCacheV2, createLegacyDisplayView,
        selectContractUrl });
});
