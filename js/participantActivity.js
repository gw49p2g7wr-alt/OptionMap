(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OptionMapParticipantActivity = api;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const HISTORY_SOURCE = "jpx-daily-participant-volume-history";
    const PRODUCT_BUCKETS = Object.freeze(["large", "mini", "topix"]);
    const FILE_DIMENSIONS = Object.freeze({
        dayAuction: Object.freeze({ session: "day", marketType: "auction" }),
        dayJnet: Object.freeze({ session: "day", marketType: "jnet" }),
        nightAuction: Object.freeze({ session: "night", marketType: "auction" }),
        nightJnet: Object.freeze({ session: "night", marketType: "jnet" })
    });

    function isPlainObject(value) {
        if (value === null || typeof value !== "object") return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isIsoDate(value) {
        if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === value;
    }

    function safePercentChange(current, previous) {
        return Number.isFinite(current) && Number.isFinite(previous) && previous > 0
            ? ((current - previous) / previous) * 100
            : null;
    }

    function safeRatio(numerator, denominator, available = true) {
        return available && Number.isFinite(numerator) &&
            Number.isFinite(denominator) && denominator > 0
            ? numerator / denominator
            : null;
    }

    function createCanonicalRow(
        record,
        sourceDate,
        fileKey,
        productBucket
    ) {
        const dimensions = FILE_DIMENSIONS[fileKey];
        if (
            !dimensions ||
            !isPlainObject(record) ||
            typeof record.product !== "string" ||
            typeof record.contractCode !== "string" ||
            typeof record.contractName !== "string" ||
            typeof record.participantCode !== "string" ||
            typeof record.company !== "string" ||
            typeof record.companyEnglish !== "string" ||
            !Number.isSafeInteger(record.rank) || record.rank <= 0 ||
            !Number.isSafeInteger(record.volume) || record.volume < 0
        ) {
            return null;
        }

        return {
            sourceDate,
            fileKey,
            session: dimensions.session,
            marketType: dimensions.marketType,
            productBucket,
            productCode: record.product,
            contractCode: record.contractCode,
            contractName: record.contractName,
            participantCode: record.participantCode,
            company: record.company,
            companyEnglish: record.companyEnglish,
            rank: record.rank,
            volume: record.volume
        };
    }

    function buildCanonicalHistory(history) {
        if (
            !isPlainObject(history) ||
            history.version !== 1 ||
            history.parserVersion !== 1 ||
            history.source !== HISTORY_SOURCE ||
            !Array.isArray(history.entries)
        ) {
            return { status: "invalid", days: [], warnings: ["invalid_history"] };
        }

        const sourceDates = new Set();
        const days = [];

        for (const entry of history.entries) {
            if (
                !isPlainObject(entry) ||
                !isIsoDate(entry.sourceDate) ||
                sourceDates.has(entry.sourceDate) ||
                typeof entry.activeVersionKey !== "string" ||
                !Array.isArray(entry.revisions)
            ) {
                return { status: "invalid", days: [], warnings: ["invalid_entry"] };
            }
            sourceDates.add(entry.sourceDate);

            const activeRevision = entry.revisions.find(revision =>
                revision?.versionKey === entry.activeVersionKey
            );
            const completeSet = activeRevision?.completeSet;
            if (
                !activeRevision ||
                !isPlainObject(completeSet) ||
                completeSet.sourceDate !== entry.sourceDate ||
                completeSet.versionKey !== entry.activeVersionKey ||
                !isPlainObject(completeSet.files)
            ) {
                return { status: "invalid", days: [], warnings: ["invalid_active_revision"] };
            }

            const rows = [];
            for (const [fileKey] of Object.entries(FILE_DIMENSIONS)) {
                const file = completeSet.files[fileKey];
                if (!isPlainObject(file) || !isPlainObject(file.data)) {
                    return { status: "invalid", days: [], warnings: ["missing_complete_file"] };
                }

                for (const productBucket of PRODUCT_BUCKETS) {
                    const records = file.data[productBucket]?.records;
                    if (!Array.isArray(records)) {
                        return { status: "invalid", days: [], warnings: ["invalid_product_rows"] };
                    }
                    for (const record of records) {
                        const row = createCanonicalRow(
                            record,
                            entry.sourceDate,
                            fileKey,
                            productBucket
                        );
                        if (!row) {
                            return { status: "invalid", days: [], warnings: ["invalid_record"] };
                        }
                        rows.push(row);
                    }
                }
            }

            days.push({
                sourceDate: entry.sourceDate,
                parserVersion: completeSet.parserVersion,
                versionKey: activeRevision.versionKey,
                signature: activeRevision.signature,
                availableFileKeys: Object.keys(FILE_DIMENSIONS),
                rows
            });
        }

        days.sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
        return {
            status: days.length === 0 ? "empty" : "ready",
            days,
            warnings: []
        };
    }

    function rowsForProduct(day, productBucket) {
        if (!PRODUCT_BUCKETS.includes(productBucket)) return [];
        return Array.isArray(day?.rows)
            ? day.rows.filter(row => row.productBucket === productBucket)
            : [];
    }

    function createProductDailySummary(day, productBucket) {
        const rows = rowsForProduct(day, productBucket);
        const availableFiles = new Set(day?.availableFileKeys || []);
        const sum = predicate => rows.reduce(
            (total, row) => predicate(row) ? total + row.volume : total,
            0
        );
        const disclosedVolumeTotal = sum(() => true);
        const dayVolume = sum(row => row.session === "day");
        const nightVolume = sum(row => row.session === "night");
        const auctionVolume = sum(row => row.marketType === "auction");
        const jnetVolume = sum(row => row.marketType === "jnet");
        const dayAvailable = ["dayAuction", "dayJnet"]
            .every(key => availableFiles.has(key));
        const nightAvailable = ["nightAuction", "nightJnet"]
            .every(key => availableFiles.has(key));
        const auctionAvailable = ["dayAuction", "nightAuction"]
            .every(key => availableFiles.has(key));
        const jnetAvailable = ["dayJnet", "nightJnet"]
            .every(key => availableFiles.has(key));
        const contractCodes = [...new Set(rows.map(row => row.contractCode))]
            .sort();

        return {
            sourceDate: day?.sourceDate || null,
            productBucket,
            disclosedVolumeTotal,
            dayVolume: dayAvailable ? dayVolume : null,
            nightVolume: nightAvailable ? nightVolume : null,
            auctionVolume: auctionAvailable ? auctionVolume : null,
            jnetVolume: jnetAvailable ? jnetVolume : null,
            nightDayRatio: safeRatio(
                nightVolume,
                dayVolume,
                dayAvailable && nightAvailable
            ),
            disclosedJnetRatio: safeRatio(
                jnetVolume,
                auctionVolume + jnetVolume,
                auctionAvailable && jnetAvailable
            ),
            participantCount: new Set(rows.map(row => row.participantCode)).size,
            contractCount: contractCodes.length,
            contractCodes
        };
    }

    function sumContracts(day, productBucket, contractCodes) {
        const allowed = new Set(contractCodes);
        return rowsForProduct(day, productBucket).reduce(
            (total, row) => allowed.has(row.contractCode)
                ? total + row.volume
                : total,
            0
        );
    }

    function compareProductObservations(previousDay, currentDay, productBucket) {
        if (!currentDay) return { available: false, reason: "no_current" };
        if (!previousDay) {
            return {
                available: false,
                reason: "no_previous_saved_entry",
                currentSourceDate: currentDay.sourceDate,
                previousSourceDate: null,
                comparisonKind: "previous_saved_entry",
                warnings: []
            };
        }

        const current = createProductDailySummary(currentDay, productBucket);
        const previous = createProductDailySummary(previousDay, productBucket);
        const currentContracts = new Set(current.contractCodes);
        const previousContracts = new Set(previous.contractCodes);
        const commonContracts = [...currentContracts]
            .filter(code => previousContracts.has(code))
            .sort();
        const contractCompositionChanged =
            current.contractCodes.length !== previous.contractCodes.length ||
            current.contractCodes.some(code => !previousContracts.has(code));
        const sameContractCurrent = sumContracts(
            currentDay,
            productBucket,
            commonContracts
        );
        const sameContractPrevious = sumContracts(
            previousDay,
            productBucket,
            commonContracts
        );
        const dayGap = Math.round(
            (new Date(`${currentDay.sourceDate}T00:00:00.000Z`) -
                new Date(`${previousDay.sourceDate}T00:00:00.000Z`)) /
            86400000
        );
        const sameParserVersion =
            currentDay.parserVersion === previousDay.parserVersion;
        const warnings = [];
        if (!sameParserVersion) warnings.push("parser_version_changed");
        if (contractCompositionChanged) {
            warnings.push("contract_composition_changed");
        }

        return {
            available: true,
            currentSourceDate: currentDay.sourceDate,
            previousSourceDate: previousDay.sourceDate,
            dayGap,
            comparisonKind: "previous_saved_entry",
            sameParserVersion,
            current,
            previous,
            absoluteChange:
                current.disclosedVolumeTotal - previous.disclosedVolumeTotal,
            percentChange: safePercentChange(
                current.disclosedVolumeTotal,
                previous.disclosedVolumeTotal
            ),
            contractCompositionChanged,
            commonContractCodes: commonContracts,
            sameContractDisclosedVolumeCurrent: sameContractCurrent,
            sameContractDisclosedVolumePrevious: sameContractPrevious,
            sameContractAbsoluteChange:
                sameContractCurrent - sameContractPrevious,
            sameContractPercentChange: commonContracts.length > 0
                ? safePercentChange(sameContractCurrent, sameContractPrevious)
                : null,
            warnings
        };
    }

    function aggregateCompanies(day, productBucket, filters = {}) {
        const map = new Map();
        for (const row of rowsForProduct(day, productBucket)) {
            if (filters.session && row.session !== filters.session) continue;
            if (filters.marketType && row.marketType !== filters.marketType) continue;
            if (filters.contractCode && row.contractCode !== filters.contractCode) continue;
            const current = map.get(row.participantCode) || {
                participantCode: row.participantCode,
                company: row.company,
                companyEnglish: row.companyEnglish,
                disclosedVolume: 0
            };
            current.company = row.company;
            current.companyEnglish = row.companyEnglish;
            current.disclosedVolume += row.volume;
            map.set(row.participantCode, current);
        }
        return [...map.values()].sort((left, right) =>
            right.disclosedVolume - left.disclosedVolume ||
            left.participantCode.localeCompare(right.participantCode)
        );
    }

    function createCompanySeries(days, productBucket, filters = {}) {
        const companies = new Map();
        for (const day of Array.isArray(days) ? days : []) {
            for (const item of aggregateCompanies(day, productBucket, filters)) {
                const series = companies.get(item.participantCode) || {
                    participantCode: item.participantCode,
                    company: item.company,
                    companyEnglish: item.companyEnglish,
                    points: []
                };
                series.company = item.company;
                series.companyEnglish = item.companyEnglish;
                series.points.push({
                    sourceDate: day.sourceDate,
                    disclosedVolume: item.disclosedVolume
                });
                companies.set(item.participantCode, series);
            }
        }
        return [...companies.values()];
    }

    function getTopParticipants(day, productBucket, limit = 10) {
        return aggregateCompanies(day, productBucket).slice(0, limit);
    }

    function compareTopParticipants(previousDay, currentDay, productBucket, limit = 10) {
        if (!previousDay || !currentDay) return null;
        const previous = getTopParticipants(previousDay, productBucket, limit);
        const current = getTopParticipants(currentDay, productBucket, limit);
        const previousCodes = new Set(previous.map(item => item.participantCode));
        const currentCodes = new Set(current.map(item => item.participantCode));
        const retainedCount = [...currentCodes]
            .filter(code => previousCodes.has(code)).length;
        return {
            previousParticipantCodes: [...previousCodes],
            currentParticipantCodes: [...currentCodes],
            retainedCount,
            topNRetentionRate: previousCodes.size > 0
                ? retainedCount / previousCodes.size
                : null,
            topNTurnoverCount: [...currentCodes]
                .filter(code => !previousCodes.has(code)).length,
            ...(limit === 10 ? {
                top10RetentionRate: previousCodes.size > 0
                    ? retainedCount / previousCodes.size
                    : null,
                top10TurnoverCount: [...currentCodes]
                    .filter(code => !previousCodes.has(code)).length
            } : {})
        };
    }

    function getDisclosedTopNConcentration(day, productBucket, limit = 5) {
        const summary = createProductDailySummary(day, productBucket);
        if (summary.disclosedVolumeTotal <= 0) return null;
        const topVolume = getTopParticipants(day, productBucket, limit)
            .reduce((total, item) => total + item.disclosedVolume, 0);
        return topVolume / summary.disclosedVolumeTotal;
    }

    function createProductTimeSeries(days, productBucket, metric = "disclosedVolumeTotal") {
        return (Array.isArray(days) ? days : []).map(day => {
            const summary = createProductDailySummary(day, productBucket);
            return {
                sourceDate: day.sourceDate,
                value: summary[metric] ?? null
            };
        });
    }

    function createContractSeries(days, productBucket, contractCode) {
        return (Array.isArray(days) ? days : []).flatMap(day => {
            const rows = rowsForProduct(day, productBucket)
                .filter(row => row.contractCode === contractCode);
            if (rows.length === 0) return [];
            return [{
                sourceDate: day.sourceDate,
                productBucket,
                contractCode,
                disclosedVolume: rows.reduce(
                    (total, row) => total + row.volume,
                    0
                )
            }];
        });
    }

    function createActivityViewModel(history, productBucket = "mini") {
        const canonical = buildCanonicalHistory(history);
        if (canonical.status === "invalid") {
            return { status: "invalid", productBucket, days: [], warnings: canonical.warnings };
        }
        if (canonical.days.length === 0) {
            return { status: "empty", productBucket, days: [], warnings: [] };
        }

        const currentDay = canonical.days.at(-1);
        const previousDay = canonical.days.at(-2) || null;
        const current = createProductDailySummary(currentDay, productBucket);
        const comparison = compareProductObservations(
            previousDay,
            currentDay,
            productBucket
        );
        return {
            status: previousDay ? "ready" : "one_entry",
            productBucket,
            entryCount: canonical.days.length,
            current,
            comparison,
            topParticipants: getTopParticipants(currentDay, productBucket, 10),
            topParticipantComparison: compareTopParticipants(
                previousDay,
                currentDay,
                productBucket,
                10
            ),
            disclosedTop5Concentration:
                getDisclosedTopNConcentration(currentDay, productBucket, 5),
            series: createProductTimeSeries(
                canonical.days,
                productBucket,
                "disclosedVolumeTotal"
            ),
            warnings: [
                "activity_does_not_indicate_direction",
                ...(comparison.warnings || [])
            ]
        };
    }

    return Object.freeze({
        HISTORY_SOURCE,
        PRODUCT_BUCKETS,
        FILE_DIMENSIONS,
        buildCanonicalHistory,
        createProductDailySummary,
        compareProductObservations,
        createCompanySeries,
        getTopParticipants,
        compareTopParticipants,
        getDisclosedTopNConcentration,
        createProductTimeSeries,
        createContractSeries,
        createActivityViewModel
    });
});
