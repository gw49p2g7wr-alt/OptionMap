"use strict";

const MONTHS = Object.freeze(["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);

function html({ baseYear = "2025", referencePeriod = "2026-09", releaseDate = "2026-10-23",
    geography = "全国", allItemsIndex = "102.2", allItemsYoy = "2.1", allItemsDirection = "上昇",
    coreIndex = "102.3", coreYoy = "2.1", coreDirection = "上昇",
    coreCoreIndex = "102.8", coreCoreYoy = "2.4", coreCoreDirection = "上昇",
    corrected = false, correctionTime = "10時00分", duplicate = false, omitBase = false } = {}) {
  const [referenceYear, referenceMonth] = referencePeriod.split("-"),
    [releaseYear, releaseMonth, releaseDay] = releaseDate.split("-"),
    eraYear = Number(referenceYear) - 2018,
    heading = `${omitBase ? "" : `${baseYear}年基準 `}消費者物価指数 ${geography} ` +
      `${referenceYear}年(令和${eraYear}年)${MONTHS[Number(referenceMonth)]}月分` +
      `(${releaseYear}年${Number(releaseMonth)}月${Number(releaseDay)}日公表)` +
      `${corrected ? " 【訂正版】" : ""}`,
    first = `(1) 総合指数は${baseYear}年を100として${allItemsIndex} 前年同月比は${allItemsYoy}%の${allItemsDirection}`,
    rows = [first, `(2) 生鮮食品を除く総合指数は${coreIndex} 前年同月比は${coreYoy}%の${coreDirection}`,
      `(3) 生鮮食品及びエネルギーを除く総合指数は${coreCoreIndex} ` +
        `前年同月比は${coreCoreYoy}%の${coreCoreDirection}`];
  if (duplicate) rows.push(first.replace("(1)", "(4)"));
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>消費者物価指数(CPI)結果</title></head>
    <body><main><h1>消費者物価指数(CPI)結果</h1><h2>${heading}</h2>
    ${corrected ? `<p>訂正公表: ${releaseYear}年${Number(releaseMonth)}月${Number(releaseDay)}日 ${correctionTime}</p>` : ""}
    ${rows.map(value => `<p>${value}</p>`).join("\n")}</main></body></html>`;
}

module.exports = Object.freeze({ html });
