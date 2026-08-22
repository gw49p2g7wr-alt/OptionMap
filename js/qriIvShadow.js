(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriIvShadow = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const VALUE_UNIT = "percent_points";
    const SERIES = Object.freeze(["singleIv", "askIv", "bidIv"]);

    function text(value) {
        return String(value ?? "").replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
            .replace(/\s+/g, " ").trim();
    }

    function parsePercent(value) {
        const normalized = text(value);
        if (normalized === "" || /^[－—–-]$/.test(normalized)) {
            return Object.freeze({ value: null, status: "missing", sourceFormat: null });
        }
        const match = normalized.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(%)?$/);
        if (!match) {
            return Object.freeze({ value: null, status: "invalid", sourceFormat: null });
        }
        const number = Number(match[1]);
        if (!Number.isFinite(number) || number < 0) {
            return Object.freeze({ value: null, status: "invalid", sourceFormat: null });
        }
        return Object.freeze({ value: number, status: "available",
            sourceFormat: match[2] ? "percent_sign" : "plain_number" });
    }

    function parts(value) {
        return String(value ?? "").split(/<br\s*\/?>/i).map(text);
    }

    function quoteIv(value) {
        const values = parts(value);
        return {
            // QRI header order is 売気配IV, then 買気配IV.
            askIv: parsePercent(values[0] ?? ""),
            bidIv: parsePercent(values[1] ?? "")
        };
    }

    function optionIv(single, quotes) {
        const quote = quoteIv(quotes);
        return Object.freeze({
            singleIv: parsePercent(single),
            askIv: quote.askIv,
            bidIv: quote.bidIv
        });
    }

    function parseStrike(value) {
        const normalized = text(value).replace(/リスク指標/g, "")
            .replace(/\bA\s*T\s*M\b/gi, "").replace(/,/g, "").trim();
        if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
        const strike = Number(normalized);
        return Number.isFinite(strike) && strike > 0 ? strike : null;
    }

    function metadata(html) {
        const trading = String(html).match(/取引日[\s\S]{0,200}?<dd[^>]*>\s*(20\d{2})\/(\d{2})\/(\d{2})\s*<\/dd>/i);
        const gengetsu = String(html).replace(/&amp;/gi, "&")
            .match(/[?&]gengetsu=(20\d{4})(?:&|["'])/i)?.[1] || null;
        return {
            contract: gengetsu ? `${gengetsu.slice(0, 4)}-${gengetsu.slice(4)}` : null,
            tradingDate: trading ? `${trading[1]}-${trading[2]}-${trading[3]}` : null
        };
    }

    function parseHtml(html) {
        if (typeof html !== "string") throw new TypeError("html_required");
        const rows = [];
        for (const row of html.matchAll(/<tr\b[^>]*class=["'][^"']*\brow-num\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
            const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
                .map(match => match[1]);
            if (cells.length !== 17) throw new Error("invalid_iv_row_cell_count");
            const strike = parseStrike(cells[8]);
            if (strike === null) throw new Error("invalid_iv_strike");
            rows.push(Object.freeze({
                strike,
                call: optionIv(cells[5], cells[3]),
                put: optionIv(cells[11], cells[13])
            }));
        }
        if (rows.length === 0) throw new Error("iv_rows_missing");
        const page = metadata(html);
        return Object.freeze({ shadowVersion: 1, valueUnit: VALUE_UNIT,
            contract: page.contract, tradingDate: page.tradingDate,
            rows: Object.freeze(rows) });
    }

    function isAvailable(observation) {
        return observation?.status === "available" &&
            Number.isFinite(observation.value);
    }

    function filterFiveHundred(rows) {
        return (Array.isArray(rows) ? rows : [])
            .filter(row => Number.isFinite(row?.strike) && row.strike % 500 === 0)
            .slice().sort((left, right) => left.strike - right.strike);
    }

    function density(rows, side) {
        const result = { strikeCount: rows.length, singleIv: 0, askIv: 0,
            bidIv: 0, askAndBid: 0, allMissing: 0, invalidCells: 0 };
        for (const row of rows) {
            const value = row[side];
            for (const series of SERIES) result[series] += Number(isAvailable(value?.[series]));
            result.askAndBid += Number(isAvailable(value?.askIv) && isAvailable(value?.bidIv));
            result.allMissing += Number(SERIES.every(series =>
                value?.[series]?.status === "missing"));
            result.invalidCells += SERIES.filter(series =>
                value?.[series]?.status === "invalid").length;
        }
        return result;
    }

    function continuity(rows, side, series) {
        if (!SERIES.includes(series)) throw new Error("invalid_iv_series");
        const available = rows.map(row => isAvailable(row?.[side]?.[series]));
        let longestAvailable = 0; let run = 0;
        for (const value of available) {
            run = value ? run + 1 : 0;
            longestAvailable = Math.max(longestAvailable, run);
        }
        const first = available.indexOf(true);
        const last = available.lastIndexOf(true);
        const gaps = [];
        if (first >= 0 && last > first) {
            let missing = 0;
            for (let index = first + 1; index < last; index += 1) {
                if (!available[index]) missing += 1;
                else if (missing > 0) { gaps.push(missing); missing = 0; }
            }
            if (missing > 0) gaps.push(missing);
        }
        const maximumGapPoints = gaps.length ? Math.max(...gaps) : 0;
        return { availablePoints: available.filter(Boolean).length,
            missingPoints: available.length - available.filter(Boolean).length,
            longestAvailableRun: longestAvailable, gapCount: gaps.length,
            maximumGapPoints,
            maximumGapWidth: maximumGapPoints > 0 ? (maximumGapPoints + 1) * 500 : 0 };
    }

    function analyze(parsed, currentPrice) {
        if (!parsed || !Array.isArray(parsed.rows)) throw new TypeError("parsed_rows_required");
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            throw new TypeError("valid_current_price_required");
        }
        const fiveHundred = filterFiveHundred(parsed.rows);
        const select = radius => fiveHundred.filter(row =>
            row.strike >= currentPrice - radius && row.strike <= currentPrice + radius);
        const summarize = rows => ({
            strikeCount: rows.length,
            call: density(rows, "call"),
            put: density(rows, "put"),
            continuity: Object.fromEntries(["call", "put"].map(side => [side,
                Object.fromEntries(SERIES.map(series => [series,
                    continuity(rows, side, series)]))]))
        });
        return Object.freeze({ currentPrice, full: summarize(fiveHundred),
            ranges: Object.freeze({
                2000: summarize(select(2000)),
                3000: summarize(select(3000)),
                5000: summarize(select(5000))
            }) });
    }

    return Object.freeze({ VALUE_UNIT, SERIES, parsePercent, parseHtml,
        filterFiveHundred, density, continuity, analyze });
});
