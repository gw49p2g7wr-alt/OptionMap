(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) root.OptionMapWeeklyFutures = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SCHEMA_VERSION = 2;
    const PARSER_VERSION = 2;
    const BROKER_SET_VERSION = 1;
    const SCORING_VERSION = 2;
    const PRODUCT_NAMES = Object.freeze([
        "日経225先物",
        "日経225mini",
        "TOPIX先物"
    ]);
    const CORE_BROKERS = Object.freeze({
        JPM: "ＪＰモルガン証券",
        GS: "ゴールドマン証券",
        NOMURA: "野村証券",
        BNP: "ＢＮＰパリバ証券",
        ABN: "ＡＢＮクリアリン証券"
    });

    function normalizeText(value) {
        return String(value ?? "")
            .replace(/\r?\n/g, "")
            .replace(/\u3000/g, "")
            .replace(/\s+/g, "")
            .trim();
    }

    function normalizeProductName(value) {
        const name = normalizeText(value).replace(/[＜＞<>]/g, "");
        if (name.includes("日経225mini") || name.includes("日経225ミニ")) {
            return "日経225mini";
        }
        if (name.includes("日経225先物")) return "日経225先物";
        if (name.includes("TOPIX")) return "TOPIX先物";
        return null;
    }

    function normalizeExpiry(value) {
        const match = normalizeText(value).match(
            /^(20\d{2})年(\d{1,2})月限月$/
        );
        return match
            ? `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`
            : null;
    }

    function positiveSafeInteger(value) {
        const cleaned = String(value ?? "").replace(/,/g, "").trim();
        if (!/^\d+$/.test(cleaned)) return null;
        const number = Number(cleaned);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function participantCode(value) {
        const normalized = String(value ?? "").trim();
        return /^\d+$/.test(normalized) ? normalized : null;
    }

    function createPublishedRecord({
        product,
        participantCode: code,
        broker,
        expiry,
        side,
        value
    }) {
        if (
            !PRODUCT_NAMES.includes(product) ||
            !/^\d+$/.test(code || "") ||
            !broker ||
            !/^20\d{2}-\d{2}$/.test(expiry || "") ||
            !["sell", "buy"].includes(side) ||
            !Number.isSafeInteger(value) || value <= 0
        ) {
            return null;
        }
        return {
            product,
            participantCode: code,
            broker,
            expiry,
            side,
            published: true,
            value
        };
    }

    function buildCompatibility(records, productExpiries) {
        const products = {};
        const brokerTotals = {};

        for (const productName of Object.keys(productExpiries)) {
            products[productName] = {
                expiryKeys: [...productExpiries[productName]].sort(),
                brokers: {},
                sellTotal: 0,
                buyTotal: 0
            };
        }

        for (const record of records) {
            const product = products[record.product];
            const broker = product.brokers[record.broker] || {
                participantCode: record.participantCode,
                sell: 0,
                buy: 0,
                net: 0,
                expiries: {}
            };
            if (broker.participantCode !== record.participantCode) {
                throw new Error(`participantCode不一致: ${record.broker}`);
            }
            const position = broker.expiries[record.expiry] || {
                sell: null,
                buy: null,
                net: null,
                observations: {
                    sell: { published: false, value: null },
                    buy: { published: false, value: null }
                }
            };
            if (position.observations[record.side].published) {
                throw new Error(
                    `週次先物の重複行: ${record.product}/${record.expiry}/` +
                    `${record.broker}/${record.side}`
                );
            }
            position.observations[record.side] = {
                published: true,
                value: record.value
            };
            position[record.side] = record.value;
            position.net = record.side === "buy"
                ? record.value
                : -record.value;
            broker.expiries[record.expiry] = position;
            broker[record.side] += record.value;
            broker.net = broker.buy - broker.sell;
            product[`${record.side}Total`] += record.value;
            product.brokers[record.broker] = broker;

            const total = brokerTotals[record.broker] || {
                participantCode: record.participantCode,
                sell: 0,
                buy: 0,
                net: 0
            };
            total[record.side] += record.value;
            total.net = total.buy - total.sell;
            brokerTotals[record.broker] = total;
        }
        return { products, brokerTotals };
    }

    function parseWeeklyFuturesRows(rows) {
        const records = [];
        const productExpiries = {};
        let currentProduct = null;

        for (const row of Array.isArray(rows) ? rows : []) {
            if (!Array.isArray(row)) continue;
            const detectedProduct = normalizeProductName(row[0]);
            if (detectedProduct) {
                currentProduct = detectedProduct;
                productExpiries[currentProduct] ||= new Set();
                continue;
            }
            if (/[＜<][^＞>]+[＞>]/.test(String(row[0] ?? ""))) {
                currentProduct = null;
                continue;
            }
            if (!currentProduct) continue;

            row.forEach((cell, expiryIndex) => {
                const expiry = normalizeExpiry(cell);
                if (!expiry) return;
                productExpiries[currentProduct].add(expiry);

                const sides = [
                    {
                        side: "sell",
                        participantCode: participantCode(row[expiryIndex + 1]),
                        broker: normalizeText(row[expiryIndex + 2]),
                        value: positiveSafeInteger(row[expiryIndex + 3])
                    },
                    {
                        side: "buy",
                        participantCode: participantCode(row[expiryIndex + 4]),
                        broker: normalizeText(row[expiryIndex + 5]),
                        value: positiveSafeInteger(row[expiryIndex + 6])
                    }
                ];

                for (const side of sides) {
                    const entirelyBlank = !side.participantCode &&
                        !side.broker && side.value === null;
                    if (entirelyBlank) continue;
                    const record = createPublishedRecord({
                        product: currentProduct,
                        expiry,
                        ...side
                    });
                    if (!record) {
                        throw new Error(
                            `週次先物の列データが不正です: ` +
                            `${currentProduct}/${expiry}/${side.side}`
                        );
                    }
                    records.push(record);
                }
            });
        }

        if (records.length === 0) {
            return {
                schemaVersion: SCHEMA_VERSION,
                parserVersion: PARSER_VERSION,
                records: [],
                products: {},
                brokerTotals: {}
            };
        }

        const compatibility = buildCompatibility(records, productExpiries);
        return {
            schemaVersion: SCHEMA_VERSION,
            parserVersion: PARSER_VERSION,
            records,
            ...compatibility
        };
    }

    function validateWeeklyFuturesData(data) {
        if (
            !data || data.schemaVersion !== SCHEMA_VERSION ||
            data.parserVersion !== PARSER_VERSION ||
            !Array.isArray(data.records) || data.records.length === 0
        ) return false;
        try {
            const seen = new Set();
            for (const raw of data.records) {
                const record = createPublishedRecord(raw);
                if (!record || JSON.stringify(record) !== JSON.stringify(raw)) {
                    return false;
                }
                const key = [record.product, record.expiry, record.broker,
                    record.side].join("|");
                if (seen.has(key)) return false;
                seen.add(key);
            }
            const expiryMap = {};
            for (const [product, value] of Object.entries(data.products || {})) {
                if (!Array.isArray(value?.expiryKeys) || value.expiryKeys.length === 0) {
                    return false;
                }
                expiryMap[product] = new Set(value.expiryKeys);
            }
            const rebuilt = buildCompatibility(data.records, expiryMap);
            return JSON.stringify(rebuilt.products) === JSON.stringify(data.products) &&
                JSON.stringify(rebuilt.brokerTotals) === JSON.stringify(data.brokerTotals);
        } catch (_error) {
            return false;
        }
    }

    function normalizeForSignature(data) {
        if (!validateWeeklyFuturesData(data)) return null;
        return [...data.records]
            .map(record => [
                record.product,
                record.participantCode,
                record.broker,
                record.expiry,
                record.side,
                record.published,
                record.value
            ])
            .sort((left, right) => JSON.stringify(left).localeCompare(
                JSON.stringify(right), "ja"
            ));
    }

    function toCanonicalData(data) {
        if (!validateWeeklyFuturesData(data)) return null;
        return {
            schemaVersion: SCHEMA_VERSION,
            parserVersion: PARSER_VERSION,
            productExpiries: Object.fromEntries(
                Object.entries(data.products).map(([product, value]) => [
                    product,
                    [...value.expiryKeys]
                ])
            ),
            records: data.records.map(record => ({ ...record }))
        };
    }

    function hydrateCanonicalData(canonical) {
        if (
            !canonical || canonical.schemaVersion !== SCHEMA_VERSION ||
            canonical.parserVersion !== PARSER_VERSION ||
            !canonical.productExpiries ||
            typeof canonical.productExpiries !== "object" ||
            !Array.isArray(canonical.records) || canonical.records.length === 0
        ) return null;
        try {
            const expiryMap = {};
            for (const [product, expiries] of Object.entries(
                canonical.productExpiries
            )) {
                if (
                    !PRODUCT_NAMES.includes(product) ||
                    !Array.isArray(expiries) || expiries.length === 0 ||
                    expiries.some(expiry => !/^20\d{2}-\d{2}$/.test(expiry))
                ) return null;
                expiryMap[product] = new Set(expiries);
            }
            const records = canonical.records.map(record => ({ ...record }));
            const compatibility = buildCompatibility(records, expiryMap);
            const hydrated = {
                schemaVersion: SCHEMA_VERSION,
                parserVersion: PARSER_VERSION,
                records,
                ...compatibility
            };
            return validateWeeklyFuturesData(hydrated) ? hydrated : null;
        } catch (_error) {
            return null;
        }
    }

    async function sha256(value) {
        const serialized = typeof value === "string"
            ? value : JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(serialized)
            );
            return Array.from(new Uint8Array(digest))
                .map(byte => byte.toString(16).padStart(2, "0"))
                .join("");
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
            !cache || cache.version !== 2 ||
            cache.parserVersion !== PARSER_VERSION ||
            cache.schemaVersion !== SCHEMA_VERSION ||
            cache.brokerSetVersion !== BROKER_SET_VERSION ||
            cache.scoringVersion !== SCORING_VERSION ||
            !/^20\d{2}-\d{2}-\d{2}$/.test(cache.sourceDate || "") ||
            !/^[0-9a-f]{64}$/.test(cache.signature || "") ||
            !validateWeeklyFuturesData(cache.data)
        ) return false;
        const signature = await createSignature(cache.data);
        return signature === cache.signature &&
            cache.versionKey ===
                `weekly-futures-v2|${cache.sourceDate}|sha256:${signature}`;
    }

    function getBrokerObservation(data, productName, brokerName) {
        const product = data?.products?.[productName];
        const expiryKeys = Array.isArray(product?.expiryKeys)
            ? product.expiryKeys : [];
        const records = Array.isArray(data?.records)
            ? data.records.filter(record =>
                record.product === productName && record.broker === brokerName
            ) : [];
        const byExpiry = Object.fromEntries(expiryKeys.map(expiry => [expiry, {
            expiry,
            published: false,
            side: null,
            value: null
        }]));
        for (const record of records) {
            const current = byExpiry[record.expiry];
            if (!current || current.published) {
                return { complete: false, reason: "ambiguous_observation", byExpiry };
            }
            byExpiry[record.expiry] = {
                expiry: record.expiry,
                participantCode: record.participantCode,
                broker: record.broker,
                published: true,
                side: record.side,
                value: record.value
            };
        }
        return {
            complete: expiryKeys.length > 0 &&
                Object.values(byExpiry).every(item => item.published),
            reason: expiryKeys.length === 0
                ? "no_expiries"
                : Object.values(byExpiry).some(item => !item.published)
                    ? "unpublished_expiry"
                    : null,
            byExpiry
        };
    }

    function totalsFromObservation(observation) {
        const totals = { sell: 0, buy: 0, net: 0 };
        for (const item of Object.values(observation.byExpiry || {})) {
            if (!item.published) return null;
            totals[item.side] += item.value;
        }
        totals.net = totals.buy - totals.sell;
        return totals;
    }

    function calculateWeeklyBrokerJudgment(
        previousWeekly,
        currentWeekly,
        brokerMap = CORE_BROKERS
    ) {
        const brokerDiffs = {};
        let buyScore = 0;
        let sellScore = 0;
        let eligibleBrokerCount = 0;
        const previousData = previousWeekly?.futureOpenInterest || previousWeekly;
        const currentData = currentWeekly?.futureOpenInterest || currentWeekly;

        for (const [key, brokerName] of Object.entries(brokerMap)) {
            const previousObservation = getBrokerObservation(
                previousData, "日経225先物", brokerName
            );
            const currentObservation = getBrokerObservation(
                currentData, "日経225先物", brokerName
            );
            const sameExpiries = JSON.stringify(
                Object.keys(previousObservation.byExpiry || {}).sort()
            ) === JSON.stringify(
                Object.keys(currentObservation.byExpiry || {}).sort()
            );
            const previous = previousObservation.complete
                ? totalsFromObservation(previousObservation) : null;
            const current = currentObservation.complete
                ? totalsFromObservation(currentObservation) : null;

            if (!previous || !current || !sameExpiries) {
                brokerDiffs[key] = {
                    brokerName,
                    previous,
                    current,
                    delta: null,
                    status: "unconfirmed",
                    comparisonAvailable: false,
                    reason: !sameExpiries
                        ? "expiry_set_changed"
                        : previousObservation.reason ||
                            currentObservation.reason || "unpublished"
                };
                continue;
            }

            eligibleBrokerCount += 1;
            const delta = {
                sell: current.sell - previous.sell,
                buy: current.buy - previous.buy,
                net: current.net - previous.net
            };
            let status = "unconfirmed";
            if (delta.buy > 0 && delta.sell <= 0) status = "estimatedBuy";
            else if (delta.sell > 0 && delta.buy <= 0) status = "estimatedSell";
            else if (delta.buy < 0 && delta.sell === 0) status = "reducedBuy";
            else if (delta.sell < 0 && delta.buy === 0) status = "reducedSell";

            const previousTotal = Math.abs(previous.buy) + Math.abs(previous.sell);
            if (previousTotal > 0 && status === "estimatedBuy") {
                buyScore += Math.abs(delta.buy) / previousTotal;
            }
            if (previousTotal > 0 && status === "estimatedSell") {
                sellScore += Math.abs(delta.sell) / previousTotal;
            }
            brokerDiffs[key] = {
                brokerName,
                previous,
                current,
                delta,
                status,
                comparisonAvailable: true,
                reason: null
            };
        }

        const requiredBrokerCount = Object.keys(brokerMap).length;
        const available = requiredBrokerCount > 0 &&
            eligibleBrokerCount === requiredBrokerCount;
        const scoreDiff = available ? buyScore - sellScore : null;
        let direction = null;
        if (available) {
            direction = "方向感薄い";
            if (scoreDiff >= 0.10) direction = "強い買い優勢";
            else if (scoreDiff >= 0.02) direction = "買い優勢";
            else if (scoreDiff <= -0.10) direction = "強い売り優勢";
            else if (scoreDiff <= -0.02) direction = "売り優勢";
        }
        return {
            available,
            reason: available ? null : "insufficient_published_observations",
            eligibleBrokerCount,
            requiredBrokerCount,
            brokerSetVersion: BROKER_SET_VERSION,
            scoringVersion: SCORING_VERSION,
            brokerDiffs,
            buyScore: available ? buyScore : null,
            sellScore: available ? sellScore : null,
            scoreDiff,
            direction
        };
    }

    return Object.freeze({
        SCHEMA_VERSION,
        PARSER_VERSION,
        BROKER_SET_VERSION,
        SCORING_VERSION,
        CORE_BROKERS,
        normalizeExpiry,
        parseWeeklyFuturesRows,
        validateWeeklyFuturesData,
        normalizeForSignature,
        toCanonicalData,
        hydrateCanonicalData,
        createSignature,
        validateVersionedCacheData,
        getBrokerObservation,
        calculateWeeklyBrokerJudgment
    });
});
