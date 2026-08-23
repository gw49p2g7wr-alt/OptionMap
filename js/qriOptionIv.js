(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionIv = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const PARSER_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SOURCE = "qri-nikkei225-option-iv";
    const VALUE_UNIT = "percent_points";
    const VERSION_PREFIX = "qri-option-iv-v1";
    const QRI_ORIGIN = "https://svc.qri.jp";

    function text(value) {
        return String(value ?? "").replace(/<br\s*\/?>/gi, " ")
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
        const match = String(html).match(new RegExp(
            `${escaped}[\\s\\S]{0,200}?<dd[^>]*>\\s*(20\\d{2}\\/\\d{2}\\/\\d{2})\\s*<\\/dd>`, "i"
        ));
        return dateFromSlash(match?.[1]);
    }

    function normalizeSourceUrl(value) {
        try {
            const url = new URL(value);
            if (url.origin !== QRI_ORIGIN || !/^\/jpx\/nkopm(?:\/\d+)?\/?$/.test(url.pathname)) {
                return null;
            }
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

    function parsePercent(value) {
        const normalized = text(value);
        if (normalized === "") {
            return { status: "missing", value: null, sourceFormat: "blank" };
        }
        if (/^[－—–-]$/.test(normalized)) {
            return { status: "missing", value: null, sourceFormat: "dash" };
        }
        const match = normalized.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(%)?$/);
        if (!match) {
            return { status: "invalid", value: null, sourceFormat: "malformed" };
        }
        const number = Number(match[1]);
        if (!Number.isFinite(number) || number < 0) {
            return { status: "invalid", value: null, sourceFormat: "malformed" };
        }
        return { status: "available", value: number,
            sourceFormat: match[2] ? "percent_sign" : "plain_number" };
    }

    function parseStrike(value) {
        const normalized = text(value).replace(/リスク指標/g, "")
            .replace(/\bA\s*T\s*M\b/gi, "").replace(/,/g, "").trim();
        if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
        const strike = Number(normalized);
        return Number.isFinite(strike) && strike > 0 ? strike : null;
    }

    function parseRecords(html) {
        const records = [];
        for (const row of String(html).matchAll(/<tr\b[^>]*class=["'][^"']*\brow-num\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
                .map(item => item[1]);
            if (cells.length !== 17) throw new Error("invalid_iv_row_cell_count");
            const strike = parseStrike(cells[8]);
            if (strike === null) throw new Error("invalid_iv_strike");
            records.push({ optionType: "call", strike, iv: parsePercent(cells[5]) });
            records.push({ optionType: "put", strike, iv: parsePercent(cells[11]) });
        }
        if (records.length === 0) throw new Error("iv_rows_missing");
        return records;
    }

    function parseQriOptionIvPage(html, sourceUrl) {
        if (typeof html !== "string") throw new Error("invalid_qri_iv_page");
        const normalizedUrl = normalizeSourceUrl(sourceUrl);
        const decodedHtml = html.replace(/&amp;/gi, "&");
        const gengetsu = decodedHtml.match(/[?&]gengetsu=(20\d{4})(?:&|["'])/i)?.[1] || null;
        const canonical = {
            parserVersion: PARSER_VERSION,
            schemaVersion: SCHEMA_VERSION,
            source: SOURCE,
            sourceUrl: normalizedUrl,
            valueUnit: VALUE_UNIT,
            contract: contractFromGengetsu(gengetsu),
            tradingDate: metadataDate(html, "取引日"),
            pageUpdatedAt: pageUpdatedAt(html),
            lastTradingDate: metadataDate(html, "取引最終日"),
            records: parseRecords(html)
        };
        if (!validateCanonical(canonical)) throw new Error("qri_iv_canonical_invalid");
        return canonical;
    }

    function validateIv(iv) {
        if (!iv || typeof iv !== "object") return false;
        if (iv.status === "available") {
            return Number.isFinite(iv.value) && iv.value >= 0 &&
                ["percent_sign", "plain_number"].includes(iv.sourceFormat);
        }
        if (iv.status === "missing") {
            return iv.value === null && ["dash", "blank"].includes(iv.sourceFormat);
        }
        if (iv.status === "invalid") {
            return iv.value === null && iv.sourceFormat === "malformed";
        }
        return false;
    }

    function validateCanonical(data) {
        if (!data || data.parserVersion !== PARSER_VERSION ||
            data.schemaVersion !== SCHEMA_VERSION || data.source !== SOURCE ||
            data.valueUnit !== VALUE_UNIT || !normalizeSourceUrl(data.sourceUrl) ||
            !/^20\d{2}-(0[1-9]|1[0-2])$/.test(data.contract || "") ||
            !validDate(data.tradingDate) || !validDate(data.lastTradingDate) ||
            typeof data.pageUpdatedAt !== "string" ||
            Number.isNaN(new Date(data.pageUpdatedAt).getTime()) ||
            !Array.isArray(data.records) || data.records.length === 0) return false;
        const keys = new Set();
        const strikes = { call: new Set(), put: new Set() };
        for (const record of data.records) {
            if (!record || !["call", "put"].includes(record.optionType) ||
                !Number.isFinite(record.strike) || record.strike <= 0 ||
                !validateIv(record.iv)) return false;
            const key = `${record.optionType}|${record.strike}`;
            if (keys.has(key)) return false;
            keys.add(key); strikes[record.optionType].add(record.strike);
        }
        return strikes.call.size > 0 && strikes.call.size === strikes.put.size &&
            [...strikes.call].every(strike => strikes.put.has(strike));
    }

    function normalizeForSignature(data) {
        if (!validateCanonical(data)) return null;
        return {
            source: data.source,
            sourceUrl: normalizeSourceUrl(data.sourceUrl),
            valueUnit: data.valueUnit,
            contract: data.contract,
            tradingDate: data.tradingDate,
            pageUpdatedAt: data.pageUpdatedAt,
            lastTradingDate: data.lastTradingDate,
            records: data.records.map(record => [record.optionType, record.strike,
                record.iv.status, record.iv.value, record.iv.sourceFormat])
                .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1])
        };
    }

    async function sha256(value) {
        const serialized = JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest(
                "SHA-256", new TextEncoder().encode(serialized)
            );
            return [...new Uint8Array(digest)]
                .map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
    }

    async function createSignature(data) {
        const normalized = normalizeForSignature(data);
        return normalized ? sha256(normalized) : null;
    }

    async function createVersionKey(data) {
        const signature = await createSignature(data);
        return signature ? `${VERSION_PREFIX}|${data.contract}|${data.pageUpdatedAt}|sha256:${signature}` : null;
    }

    return Object.freeze({ PARSER_VERSION, SCHEMA_VERSION, SOURCE, VALUE_UNIT,
        VERSION_PREFIX, normalizeSourceUrl, contractFromGengetsu, parsePercent,
        parseQriOptionIvPage, validateCanonical, normalizeForSignature,
        createSignature, createVersionKey });
});
