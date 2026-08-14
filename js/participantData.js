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
                fileStatuses[key] = "failed";
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
        normalizeSourceDate,
        extractExcelSourceDate,
        parseParticipantExcel,
        buildParticipantResult
    });
});
