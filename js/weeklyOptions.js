(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) root.OptionMapWeeklyOptions = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const PARSER_VERSION = 2;
    const SCHEMA_VERSION = 2;
    const CACHE_VERSION = 2;
    const PRODUCT = "日経225オプション";
    const SOURCE_TITLE = "日経平均オプション取引参加者別建玉残高";
    const BLOCK_START_ROWS = Object.freeze([10, 25, 40, 55, 70]);
    const BLOCK_SIZE = 15;
    const SIDE_LAYOUT = Object.freeze({
        put: Object.freeze({ headerColumn: 1, rankColumn: 0, strikeColumn: 1 }),
        call: Object.freeze({ headerColumn: 11, rankColumn: 10, strikeColumn: 11 })
    });

    function isPlainObject(value) {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function normalizeText(value) {
        return String(value ?? "").replace(/\r?\n/g, "").trim();
    }

    function isoDate(year, month, day) {
        const result = [year, month, day].map((value, index) =>
            String(Number(value)).padStart(index === 0 ? 4 : 2, "0")
        ).join("-");
        const date = new Date(`${result}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === result ? result : null;
    }

    function parseSourceDate(value) {
        const match = normalizeText(value).match(
            /（\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日現在\s*）/
        );
        return match ? isoDate(match[1], match[2], match[3]) : null;
    }

    function parsePublishedDate(value) {
        const match = normalizeText(value).match(
            /^(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日$/
        );
        return match ? isoDate(match[1], match[2], match[3]) : null;
    }

    function parseHeader(value, expectedType) {
        const match = normalizeText(value).match(
            /^(プット|コール)（(20\d{2})年\s*(\d{1,2})月限月）$/
        );
        const optionType = match?.[1] === "プット"
            ? "put" : match?.[1] === "コール" ? "call" : null;
        if (!match || optionType !== expectedType) return null;
        return {
            optionType,
            expiry: `${match[2]}-${String(Number(match[3])).padStart(2, "0")}`
        };
    }

    function positiveSafeInteger(value) {
        const normalized = String(value ?? "").replace(/,/g, "").trim();
        if (!/^\d+$/.test(normalized)) return null;
        const number = Number(normalized);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function participantCode(value) {
        const normalized = String(value ?? "").trim();
        return /^\d+$/.test(normalized) ? normalized : null;
    }

    function positiveStrike(value) {
        const number = Number(String(value ?? "").replace(/,/g, "").trim());
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function createRecord(raw) {
        if (
            !isPlainObject(raw) || raw.product !== PRODUCT ||
            !["put", "call"].includes(raw.optionType) ||
            !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(raw.expiry || "") ||
            !Number.isFinite(raw.strike) || raw.strike <= 0 ||
            !Number.isInteger(raw.rank) || raw.rank < 1 || raw.rank > BLOCK_SIZE ||
            !/^\d+$/.test(raw.participantCode || "") ||
            typeof raw.broker !== "string" || raw.broker.trim() === "" ||
            raw.broker !== raw.broker.trim() ||
            !["sell", "buy"].includes(raw.side) ||
            raw.published !== true ||
            !Number.isSafeInteger(raw.value) || raw.value <= 0
        ) return null;
        return {
            product: raw.product,
            optionType: raw.optionType,
            expiry: raw.expiry,
            strike: raw.strike,
            rank: raw.rank,
            participantCode: raw.participantCode,
            broker: raw.broker,
            side: raw.side,
            published: true,
            value: raw.value
        };
    }

    function parsePublishedSide({ row, baseColumn, side, context }) {
        const offset = side === "sell" ? 1 : 4;
        const rawCode = row[baseColumn + offset];
        const rawBroker = row[baseColumn + offset + 1];
        const rawValue = row[baseColumn + offset + 2];
        const blank = [rawCode, rawBroker, rawValue].every(value =>
            value === null || value === undefined || String(value).trim() === ""
        );
        if (blank) return null;

        const record = createRecord({
            ...context,
            participantCode: participantCode(rawCode),
            broker: normalizeText(rawBroker),
            side,
            published: true,
            value: positiveSafeInteger(rawValue)
        });
        if (!record) {
            throw new Error(
                `週次オプションの不完全な公表行: ${context.optionType}/` +
                `${context.strike}/rank${context.rank}/${side}`
            );
        }
        return record;
    }

    function parseWeeklyOptionsRows(rows) {
        if (!Array.isArray(rows)) throw new Error("週次オプション行が不正です");
        const sourceTitle = normalizeText(rows[0]?.[0]);
        const sourceDateText = normalizeText(rows[1]?.[0]);
        const publishedDateText = normalizeText(rows[2]?.[0]);
        const sourceHeaders = {
            put: normalizeText(rows[6]?.[SIDE_LAYOUT.put.headerColumn]),
            call: normalizeText(rows[6]?.[SIDE_LAYOUT.call.headerColumn])
        };
        const sourceDate = parseSourceDate(sourceDateText);
        const publishedDate = parsePublishedDate(publishedDateText);
        const headers = {
            put: parseHeader(sourceHeaders.put, "put"),
            call: parseHeader(sourceHeaders.call, "call")
        };
        if (
            sourceTitle !== SOURCE_TITLE || !sourceDate || !publishedDate ||
            !headers.put || !headers.call
        ) throw new Error("週次オプションExcelのタイトル・日付・限月headerが不正です");

        const records = [];
        const strikes = { put: [], call: [] };
        for (const optionType of ["put", "call"]) {
            const layout = SIDE_LAYOUT[optionType];
            for (const startRow of BLOCK_START_ROWS) {
                const first = rows[startRow - 1] || [];
                const strike = positiveStrike(first[layout.strikeColumn]);
                if (!strike) {
                    throw new Error(`${optionType}のstrike blockが不正です: row ${startRow}`);
                }
                strikes[optionType].push(strike);
                for (let index = 0; index < BLOCK_SIZE; index += 1) {
                    const row = rows[startRow - 1 + index] || [];
                    const rank = positiveSafeInteger(row[layout.rankColumn]);
                    if (rank !== index + 1) {
                        throw new Error(`${optionType}の順位が不正です: row ${startRow + index}`);
                    }
                    const context = {
                        product: PRODUCT,
                        optionType,
                        expiry: headers[optionType].expiry,
                        strike,
                        rank
                    };
                    for (const side of ["sell", "buy"]) {
                        const record = parsePublishedSide({
                            row,
                            baseColumn: layout.strikeColumn,
                            side,
                            context
                        });
                        if (record) records.push(record);
                    }
                }
            }
        }

        const data = {
            parserVersion: PARSER_VERSION,
            schemaVersion: SCHEMA_VERSION,
            product: PRODUCT,
            sourceTitle,
            sourceDateText,
            publishedDateText,
            sourceHeaders,
            sourceDate,
            publishedDate,
            optionExpiries: {
                put: headers.put.expiry,
                call: headers.call.expiry
            },
            strikes,
            records
        };
        if (!validateWeeklyOptionsData(data)) {
            throw new Error("週次オプションcanonical rawの検証に失敗しました");
        }
        return data;
    }

    function validateWeeklyOptionsData(data) {
        if (
            !isPlainObject(data) || data.parserVersion !== PARSER_VERSION ||
            data.schemaVersion !== SCHEMA_VERSION || data.product !== PRODUCT ||
            data.sourceTitle !== SOURCE_TITLE ||
            parseSourceDate(data.sourceDateText) !== data.sourceDate ||
            parsePublishedDate(data.publishedDateText) !== data.publishedDate ||
            !isPlainObject(data.sourceHeaders) ||
            !isPlainObject(data.optionExpiries) || !isPlainObject(data.strikes) ||
            !Array.isArray(data.records) || data.records.length === 0
        ) return false;
        for (const optionType of ["put", "call"]) {
            const parsedHeader = parseHeader(
                data.sourceHeaders[optionType], optionType
            );
            if (
                !parsedHeader ||
                parsedHeader.expiry !== data.optionExpiries[optionType] ||
                !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(data.optionExpiries[optionType] || "") ||
                !Array.isArray(data.strikes[optionType]) ||
                data.strikes[optionType].length !== BLOCK_START_ROWS.length ||
                new Set(data.strikes[optionType]).size !== BLOCK_START_ROWS.length ||
                data.strikes[optionType].some(strike => !Number.isFinite(strike) || strike <= 0)
            ) return false;
        }

        const duplicateKeys = new Set();
        const rankKeys = new Set();
        for (const raw of data.records) {
            const record = createRecord(raw);
            if (!record || JSON.stringify(record) !== JSON.stringify(raw)) return false;
            if (
                record.expiry !== data.optionExpiries[record.optionType] ||
                !data.strikes[record.optionType].includes(record.strike)
            ) return false;
            const duplicateKey = [record.optionType, record.expiry, record.strike,
                record.participantCode, record.side].join("|");
            if (duplicateKeys.has(duplicateKey)) return false;
            duplicateKeys.add(duplicateKey);
            const rankKey = [record.optionType, record.expiry, record.strike,
                record.rank, record.side].join("|");
            if (rankKeys.has(rankKey)) return false;
            rankKeys.add(rankKey);
        }
        return true;
    }

    function normalizeForSignature(data) {
        if (!validateWeeklyOptionsData(data)) return null;
        return data.records.map(record => [
            record.product,
            record.optionType,
            record.expiry,
            record.strike,
            record.rank,
            record.participantCode,
            record.broker,
            record.side,
            record.published,
            record.value
        ]).sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right), "ja")
        );
    }

    async function sha256(value) {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest(
                "SHA-256", new TextEncoder().encode(serialized)
            );
            return Array.from(new Uint8Array(digest))
                .map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        const { createHash } = require("node:crypto");
        return createHash("sha256").update(serialized).digest("hex");
    }

    async function createSignature(data) {
        const normalized = normalizeForSignature(data);
        return normalized ? sha256(normalized) : null;
    }

    async function validateVersionedCacheData(cache) {
        if (
            !isPlainObject(cache) || cache.version !== CACHE_VERSION ||
            cache.parserVersion !== PARSER_VERSION ||
            cache.schemaVersion !== SCHEMA_VERSION ||
            cache.sourceDate !== cache.data?.sourceDate ||
            !/^[0-9a-f]{64}$/.test(cache.signature || "") ||
            !validateWeeklyOptionsData(cache.data)
        ) return false;
        const signature = await createSignature(cache.data);
        return signature === cache.signature &&
            cache.versionKey ===
                `weekly-options-v2|${cache.sourceDate}|sha256:${signature}`;
    }

    function getObservation(data, criteria) {
        if (!validateWeeklyOptionsData(data) || !isPlainObject(criteria)) return null;
        const matches = data.records.filter(record =>
            ["product", "optionType", "expiry", "strike", "participantCode",
                "broker", "side"].every(key =>
                criteria[key] === undefined || record[key] === criteria[key]
            )
        );
        if (matches.length === 1) return { ...matches[0] };
        if (matches.length > 1) return { published: null, value: null, ambiguous: true };
        return { published: false, value: null };
    }

    return Object.freeze({
        PARSER_VERSION,
        SCHEMA_VERSION,
        CACHE_VERSION,
        PRODUCT,
        SOURCE_TITLE,
        BLOCK_START_ROWS,
        BLOCK_SIZE,
        parseWeeklyOptionsRows,
        validateWeeklyOptionsData,
        normalizeForSignature,
        createSignature,
        validateVersionedCacheData,
        getObservation
    });
});
