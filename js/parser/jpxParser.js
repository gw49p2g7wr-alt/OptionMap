export function parseJpxHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");

    const rows = doc.querySelectorAll("tr.row-num");
    const result = [];

    rows.forEach(row => {
        const strikeCell = row.querySelector("td.price");
        if (!strikeCell) return;

        const strike = toNumber(
            strikeCell.textContent
                .replace("リスク指標", "")
        );

        if (!Number.isFinite(strike) || strike <= 0) {
            return;
        }

        const cells = row.querySelectorAll("td");

        result.push({
            strike,
        
            // CALL
            callOI: toNumber(cells[1]?.textContent),
            callVolume: toNumber(cells[2]?.textContent),
        
            // PUT
            putVolume: toNumber(cells[14]?.textContent),
            putOI: toNumber(cells[15]?.textContent)
        });
    });

    return result;
}

export function parseJpxReferencePrices(htmlText) {
    const unavailableNikkei225 = () => ({
        available: false,
        price: null,
        quotedAt: null
    });

    const unavailableNikkei225Futures = () => ({
        available: false,
        price: null,
        contract: null,
        quotedAt: null
    });

    const result = {
        nikkei225: unavailableNikkei225(),
        nikkei225Futures: unavailableNikkei225Futures()
    };

    if (typeof htmlText !== "string" || htmlText.trim() === "") {
        return result;
    }

    const priceInfoStart = htmlText.search(
        /<[^>]+id=["']priceInfo["'][^>]*>/i
    );

    if (priceInfoStart < 0) {
        return result;
    }

    const priceTableEnd = htmlText.indexOf("</table>", priceInfoStart);

    if (priceTableEnd < 0) {
        return result;
    }

    const priceInfoHtml = htmlText.slice(
        priceInfoStart,
        priceTableEnd + "</table>".length
    );

    const rowMatches = priceInfoHtml.matchAll(
        /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    );

    for (const rowMatch of rowMatches) {
        const cellMatches = [
            ...rowMatch[1].matchAll(
                /<td\b([^>]*)>([\s\S]*?)<\/td>/gi
            )
        ];

        if (cellMatches.length < 2) continue;

        const label = htmlToText(cellMatches[0][2]);
        const priceCell = cellMatches.find(([, attributes]) =>
            /\bprice-now\b/i.test(attributes)
        );

        if (!priceCell) continue;

        const priceCellText = htmlToText(priceCell[2]);
        const price = parseReferencePrice(priceCellText);
        const quotedAt = parseQuotedAt(priceCellText);

        if (/^日経平均株価\s*\(日経225\)/.test(label)) {
            if (price !== null) {
                result.nikkei225 = {
                    available: true,
                    price,
                    quotedAt
                };
            }

            continue;
        }

        if (/^日経225先物(?:\s|\()/.test(label)) {
            const contractMatch = label.match(
                /\((\d{2,4}年\s*\d{1,2}月限)\)/
            );
            const contract = contractMatch
                ? contractMatch[1].replace(/\s+/g, "")
                : null;

            if (price !== null && contract) {
                result.nikkei225Futures = {
                    available: true,
                    price,
                    contract,
                    quotedAt
                };
            }
        }
    }

    return result;
}

function htmlToText(html) {
    return html
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function parseReferencePrice(text) {
    const priceMatch = text.match(
        /(?:^|\s)(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(?=\s|\(|$)/
    );

    if (!priceMatch) return null;

    const price = Number(priceMatch[1].replace(/,/g, ""));

    return Number.isFinite(price) && price > 0
        ? price
        : null;
}

function parseQuotedAt(text) {
    const quotedAtMatch = text.match(
        /\((\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})\)/
    );

    return quotedAtMatch
        ? quotedAtMatch[1].replace(/\s+/g, " ")
        : null;
}

function toNumber(text) {
    if (!text) return 0;

    const cleaned = text
        .replace(/,/g, "")
        .replace(/[－—–-]/g, "")
        .trim();

    if (cleaned === "") {
        return 0;
    }

    const number = Number(cleaned);

    return Number.isFinite(number)
        ? number
        : 0;
}
