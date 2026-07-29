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