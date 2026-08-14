(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.OptionMapParticipantData = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const PRODUCT_CODES = Object.freeze({
        NK225F: Object.freeze({ bucket: "large", label: "日経225先物" }),
        NK225MF: Object.freeze({ bucket: "mini", label: "日経225mini" }),
        TOPIXF: Object.freeze({ bucket: "topix", label: "TOPIX先物" }),
        NK225E: Object.freeze({ bucket: "option", label: "日経225オプション" })
    });

    const FILE_KEYS = Object.freeze([
        "dayAuction",
        "dayJnet",
        "nightAuction",
        "nightJnet"
    ]);

    const CACHE_VERSION = 1;
    const PARSER_VERSION = 1;
    const CACHE_SOURCE = "jpx-daily-participant-volume";
    const SIGNATURE_ALGORITHM = "sha256";
    const FILE_VERSION_PREFIXES = Object.freeze({
        dayAuction: "participant-day-auction",
        dayJnet: "participant-day-jnet",
        nightAuction: "participant-night-auction",
        nightJnet: "participant-night-jnet"
    });
    const PRODUCT_BUCKETS = Object.freeze({
        large: "NK225F",
        mini: "NK225MF",
        topix: "TOPIXF",
        option: "NK225E"
    });
    const DANGEROUS_KEYS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);

    function emptyProductData() {
        return { records: [], top10: [] };
    }

    function normalizeSourceDate(value) {
        const digits = String(value ?? "").replace(/\D/g, "");

        if (digits.length !== 8) return null;

        const year = digits.slice(0, 4);
        const month = digits.slice(4, 6);
        const day = digits.slice(6, 8);
        const date = new Date(`${year}-${month}-${day}T00:00:00Z`);

        if (
            Number.isNaN(date.getTime()) ||
            date.getUTCFullYear() !== Number(year) ||
            date.getUTCMonth() + 1 !== Number(month) ||
            date.getUTCDate() !== Number(day)
        ) {
            return null;
        }

        return `${year}-${month}-${day}`;
    }

    function extractExcelSourceDate(rows) {
        for (const row of rows) {
            if (!Array.isArray(row)) continue;

            const label = row.map(value => String(value ?? "")).join(" ");
            if (!/取引日|Trading Date/i.test(label)) continue;

            for (const value of row) {
                const sourceDate = normalizeSourceDate(value);
                if (sourceDate) return sourceDate;
            }
        }

        return null;
    }

    function getTop10(records) {
        return [...records]
            .sort((left, right) => left.rank - right.rank)
            .slice(0, 10);
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function containsDangerousKey(value, seen = new Set()) {
        if (value === null || typeof value !== "object") return false;
        if (seen.has(value)) return false;
        seen.add(value);

        for (const key of Object.keys(value)) {
            if (DANGEROUS_KEYS.has(key)) return true;
            if (containsDangerousKey(value[key], seen)) return true;
        }

        return false;
    }

    function isIsoDate(value) {
        return normalizeSourceDate(value) === value;
    }

    function isIsoDateTime(value) {
        return typeof value === "string" &&
            !Number.isNaN(new Date(value).getTime()) &&
            /^20\d{2}-\d{2}-\d{2}T/.test(value);
    }

    function normalizeRecord(record) {
        return {
            product: record.product.trim(),
            contractCode: record.contractCode,
            contractName: record.contractName.trim(),
            rank: record.rank,
            participantCode: record.participantCode,
            company: record.company.trim(),
            companyEnglish: record.companyEnglish.trim(),
            volume: record.volume
        };
    }

    function compareNormalizedRecords(left, right) {
        return left.product.localeCompare(right.product) ||
            left.contractCode.localeCompare(right.contractCode) ||
            left.rank - right.rank ||
            left.participantCode.localeCompare(right.participantCode) ||
            left.company.localeCompare(right.company);
    }

    function normalizeFileForSignature(data) {
        return Object.keys(PRODUCT_BUCKETS)
            .flatMap(bucket => data[bucket].records.map(normalizeRecord))
            .sort(compareNormalizedRecords);
    }

    async function sha256(value) {
        const serialized = typeof value === "string"
            ? value
            : JSON.stringify(value);

        if (globalThis.crypto?.subtle) {
            const bytes = new TextEncoder().encode(serialized);
            const digest = await globalThis.crypto.subtle.digest(
                "SHA-256",
                bytes
            );
            return Array.from(new Uint8Array(digest))
                .map(byte => byte.toString(16).padStart(2, "0"))
                .join("");
        }

        const { createHash } = require("node:crypto");
        return createHash("sha256").update(serialized).digest("hex");
    }

    async function createFileSignature(data) {
        return sha256(normalizeFileForSignature(data));
    }

    function createFileVersionKey(fileKey, sourceDate, signature) {
        const prefix = FILE_VERSION_PREFIXES[fileKey];
        if (!prefix || !isIsoDate(sourceDate) || !/^[0-9a-f]{64}$/.test(signature || "")) {
            return null;
        }
        return `${prefix}|${sourceDate}|sha256:${signature}`;
    }

    async function createSetSignature(fileSignatures) {
        const normalized = FILE_KEYS.map(key => [key, fileSignatures[key]]);
        return sha256(normalized);
    }

    function createSetVersionKey(sourceDate, signature) {
        if (!isIsoDate(sourceDate) || !/^[0-9a-f]{64}$/.test(signature || "")) {
            return null;
        }
        return `participant-set|${sourceDate}|sha256:${signature}`;
    }

    function getExpectedFileName(fileKey, sourceDate) {
        const compactDate = sourceDate.replaceAll("-", "");
        const suffixes = {
            dayAuction: "volume_by_participant_whole_day.xlsx",
            dayJnet: "volume_by_participant_whole_day_J-NET.xlsx",
            nightAuction: "volume_by_participant_night.xlsx",
            nightJnet: "volume_by_participant_night_J-NET.xlsx"
        };
        return `${compactDate}_${suffixes[fileKey]}`;
    }

    function selectLatestParticipantListing(hrefs) {
        const byDate = new Map();

        for (const value of Array.isArray(hrefs) ? hrefs : []) {
            let url;
            try {
                url = new URL(value, "https://www.jpx.co.jp");
            } catch (error) {
                continue;
            }
            if (url.protocol !== "https:" || url.hostname !== "www.jpx.co.jp") {
                continue;
            }

            const match = url.pathname.match(/\/(20\d{6})_volume_by_participant_[^/]+\.xlsx$/);
            if (!match) continue;
            const sourceDate = normalizeSourceDate(match[1]);
            if (!sourceDate) continue;
            const files = byDate.get(sourceDate) || {};

            for (const fileKey of FILE_KEYS) {
                if (url.pathname.endsWith(`/${getExpectedFileName(fileKey, sourceDate)}`)) {
                    files[fileKey] = url.href;
                }
            }
            byDate.set(sourceDate, files);
        }

        const sourceDate = [...byDate.keys()].sort().at(-1);
        if (!sourceDate) return null;
        const urls = byDate.get(sourceDate);
        return {
            sourceDate,
            urls,
            complete: FILE_KEYS.every(key => typeof urls[key] === "string")
        };
    }

    function isValidSourceUrl(value, fileKey, sourceDate) {
        try {
            const url = new URL(value);
            return url.protocol === "https:" &&
                url.hostname === "www.jpx.co.jp" &&
                url.pathname.endsWith(`/${getExpectedFileName(fileKey, sourceDate)}`);
        } catch (error) {
            return false;
        }
    }

    function validateRecord(record, expectedProduct) {
        return isPlainObject(record) &&
            record.product === expectedProduct &&
            typeof record.contractCode === "string" &&
            record.contractCode !== "" &&
            typeof record.contractName === "string" &&
            record.contractName.trim() !== "" &&
            Number.isSafeInteger(record.rank) &&
            record.rank > 0 &&
            typeof record.participantCode === "string" &&
            record.participantCode !== "" &&
            typeof record.company === "string" &&
            record.company.trim() !== "" &&
            typeof record.companyEnglish === "string" &&
            Number.isSafeInteger(record.volume) &&
            record.volume >= 0;
    }

    function validateParsedFile(data, sourceDate) {
        if (
            !isPlainObject(data) ||
            data.sourceDate !== sourceDate ||
            !["excel", "url_target"].includes(data.sourceDateKind) ||
            !isPlainObject(data.micro) ||
            !Array.isArray(data.micro.records) ||
            !Array.isArray(data.micro.top10) ||
            data.micro.records.length !== 0 ||
            data.micro.top10.length !== 0 ||
            containsDangerousKey(data)
        ) {
            return false;
        }

        let recordCount = 0;
        for (const [bucket, product] of Object.entries(PRODUCT_BUCKETS)) {
            const group = data[bucket];
            if (!isPlainObject(group) || !Array.isArray(group.records) || !Array.isArray(group.top10)) {
                return false;
            }

            const identities = new Set();
            for (const record of group.records) {
                if (!validateRecord(record, product)) return false;
                const identity = `${record.product}|${record.contractCode}|${record.participantCode}`;
                if (identities.has(identity)) return false;
                identities.add(identity);
                recordCount += 1;
            }

            const expectedTop10 = getTop10(group.records);
            if (
                group.top10.length !== expectedTop10.length ||
                group.top10.some((record, index) =>
                    !validateRecord(record, product) ||
                    JSON.stringify(normalizeRecord(record)) !==
                        JSON.stringify(normalizeRecord(expectedTop10[index]))
                )
            ) {
                return false;
            }
        }

        return recordCount > 0;
    }

    async function createCompleteCache({ data, sourceUrls, sourceDate, fetchedAt }) {
        if (!isIsoDate(sourceDate) || !isIsoDateTime(fetchedAt)) return null;

        const files = {};
        const fileSignatures = {};

        for (const fileKey of FILE_KEYS) {
            const fileData = data?.[fileKey];
            const sourceUrl = sourceUrls?.[fileKey];
            if (
                !validateParsedFile(fileData, sourceDate) ||
                !isValidSourceUrl(sourceUrl, fileKey, sourceDate)
            ) {
                return null;
            }

            const signature = await createFileSignature(fileData);
            fileSignatures[fileKey] = signature;
            files[fileKey] = {
                status: "success",
                sourceDate,
                sourceDateKind: fileData.sourceDateKind,
                sourceUrl,
                signatureAlgorithm: SIGNATURE_ALGORITHM,
                signature,
                versionKey: createFileVersionKey(fileKey, sourceDate, signature),
                data: fileData
            };
        }

        const signature = await createSetSignature(fileSignatures);
        return {
            version: CACHE_VERSION,
            parserVersion: PARSER_VERSION,
            source: CACHE_SOURCE,
            sourceDate,
            fetchedAt,
            status: "complete",
            files,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            signature,
            versionKey: createSetVersionKey(sourceDate, signature)
        };
    }

    async function validateParticipantCache(cache) {
        if (
            !isPlainObject(cache) ||
            containsDangerousKey(cache) ||
            cache.version !== CACHE_VERSION ||
            cache.parserVersion !== PARSER_VERSION ||
            cache.source !== CACHE_SOURCE ||
            !isIsoDate(cache.sourceDate) ||
            !isIsoDateTime(cache.fetchedAt) ||
            cache.status !== "complete" ||
            !isPlainObject(cache.files) ||
            Object.keys(cache.files).length !== FILE_KEYS.length ||
            cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^[0-9a-f]{64}$/.test(cache.signature || "")
        ) {
            return false;
        }

        const fileSignatures = {};
        for (const fileKey of FILE_KEYS) {
            const file = cache.files[fileKey];
            if (
                !isPlainObject(file) ||
                file.status !== "success" ||
                file.sourceDate !== cache.sourceDate ||
                !["excel", "url_target"].includes(file.sourceDateKind) ||
                !isValidSourceUrl(file.sourceUrl, fileKey, cache.sourceDate) ||
                file.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
                !/^[0-9a-f]{64}$/.test(file.signature || "") ||
                !validateParsedFile(file.data, cache.sourceDate)
            ) {
                return false;
            }

            const signature = await createFileSignature(file.data);
            if (
                signature !== file.signature ||
                file.versionKey !== createFileVersionKey(fileKey, cache.sourceDate, signature)
            ) {
                return false;
            }
            fileSignatures[fileKey] = signature;
        }

        const signature = await createSetSignature(fileSignatures);
        return signature === cache.signature &&
            cache.versionKey === createSetVersionKey(cache.sourceDate, signature);
    }

    async function parseParticipantCache(serialized) {
        if (typeof serialized !== "string" || serialized.trim() === "") {
            return null;
        }
        try {
            const cache = JSON.parse(serialized);
            return await validateParticipantCache(cache) ? cache : null;
        } catch (error) {
            return null;
        }
    }

    function cacheToParsedDayData(cache) {
        return Object.fromEntries(
            FILE_KEYS.map(key => [key, cache.files[key].data])
        );
    }

    function compareVersions(activeCache, liveCache, officialCurrent = false) {
        if (!liveCache) return { assessment: "indeterminate", reason: "invalid_live_cache" };
        if (!activeCache) return { assessment: "new_version", reason: "no_active_cache" };
        if (liveCache.sourceDate > activeCache.sourceDate) {
            return { assessment: "new_version", reason: "newer_source_date" };
        }
        if (liveCache.sourceDate < activeCache.sourceDate) {
            return { assessment: "older_or_inconsistent", reason: "older_source_date" };
        }
        if (liveCache.signature === activeCache.signature) {
            return { assessment: "same_version", reason: "same_date_and_signature" };
        }
        return officialCurrent
            ? { assessment: "revised_same_date", reason: "current_official_links_changed" }
            : { assessment: "indeterminate", reason: "revision_order_unknown" };
    }

    function parseParticipantExcel(json, expectedSourceDate = null) {
        const inputRows = Array.isArray(json) ? json : [];
        const excelSourceDate = extractExcelSourceDate(inputRows);
        const sourceDate = excelSourceDate || expectedSourceDate || null;
        const sourceDateKind = excelSourceDate
            ? "excel"
            : expectedSourceDate
                ? "url_target"
                : null;
        const buckets = {
            large: [],
            mini: [],
            topix: [],
            micro: [],
            option: []
        };

        for (const row of inputRows) {
            if (!Array.isArray(row) || row.length < 8) continue;

            const product = String(row[0] ?? "").trim();
            const productDefinition = PRODUCT_CODES[product];
            if (!productDefinition) continue;

            const rank = Number(row[3]);
            const volume = Number(row[7]);
            const company = String(row[5] ?? "").trim();

            if (!Number.isFinite(rank) || !Number.isFinite(volume) || !company) {
                continue;
            }

            buckets[productDefinition.bucket].push({
                product,
                contractCode: String(row[1] ?? ""),
                contractName: String(row[2] ?? ""),
                rank,
                participantCode: String(row[4] ?? ""),
                company,
                companyEnglish: String(row[6] ?? "").trim(),
                volume
            });
        }

        return {
            sourceDate,
            sourceDateKind,
            large: { records: buckets.large, top10: getTop10(buckets.large) },
            mini: { records: buckets.mini, top10: getTop10(buckets.mini) },
            topix: { records: buckets.topix, top10: getTop10(buckets.topix) },
            micro: emptyProductData(),
            option: { records: buckets.option, top10: getTop10(buckets.option) }
        };
    }

    function buildParticipantResult(settledResults, targetDate) {
        const data = {};
        const fileStatuses = {};
        const errors = {};
        let successCount = 0;

        FILE_KEYS.forEach((key, index) => {
            const result = settledResults[index];

            if (result?.status !== "fulfilled") {
                data[key] = null;
                fileStatuses[key] = result?.reason?.participantStatus === "unavailable"
                    ? "unavailable"
                    : "failed";
                errors[key] = result?.reason?.message || String(result?.reason || "取得失敗");
                return;
            }

            const fileData = result.value;
            if (!fileData || fileData.sourceDate !== targetDate) {
                data[key] = null;
                fileStatuses[key] = "failed";
                errors[key] = fileData?.sourceDate
                    ? `取引日不一致: ${fileData.sourceDate}（期待値 ${targetDate}）`
                    : "取引日を確認できません";
                return;
            }

            data[key] = fileData;
            fileStatuses[key] = "success";
            successCount += 1;
        });

        return {
            data,
            metadata: {
                sourceDate: targetDate,
                successCount,
                fileCount: FILE_KEYS.length,
                status: successCount === FILE_KEYS.length
                    ? "success"
                    : successCount > 0
                        ? "partial"
                        : "failed",
                fileStatuses,
                errors
            }
        };
    }

    return Object.freeze({
        PRODUCT_CODES,
        FILE_KEYS,
        CACHE_VERSION,
        PARSER_VERSION,
        CACHE_SOURCE,
        normalizeSourceDate,
        extractExcelSourceDate,
        parseParticipantExcel,
        buildParticipantResult,
        normalizeFileForSignature,
        createFileSignature,
        createFileVersionKey,
        createSetSignature,
        createSetVersionKey,
        selectLatestParticipantListing,
        createCompleteCache,
        validateParticipantCache,
        parseParticipantCache,
        cacheToParsedDayData,
        compareVersions
    });
});
