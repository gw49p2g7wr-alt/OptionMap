"use strict";

// Structural fixtures derived from MOF's six-column monthly calendar; no live body.
const headers = ["入札予定日", "入札対象国債等", "発行予定額等", "入札発行<br>について",
  "価格競争<br>入札等", "第II非価格<br>競争入札"];
function row(date, product, linked = false) {
  return `<tr><td>${date}</td><td>${product}</td><td>${linked ? '<a href="yotei/auct20260929.htm">詳細</a>' : "詳細"}</td>` +
    "<td>詳細</td><td>入札結果</td><td>入札結果</td></tr>";
}
function month(code, rows = [], extra = "") {
  const year = 2000 + Number(code.slice(0, 2)), m = Number(code.slice(2));
  return '<!doctype html><meta charset="UTF-8">' +
    `<h1>入札カレンダー：令和${year - 2018}年${m}月</h1><h3>（１）国債及び国庫短期証券</h3>` +
    `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table><h3>（２）買入消却</h3>${extra}`;
}
function index(codes = ["2610", "2611", "2612"]) {
  return '<meta charset="UTF-8"><h1>入札カレンダー</h1>' + codes.map(c =>
    `<a href="${c}.htm">${Number(c.slice(2))}月</a>`).join("|");
}
const current = month("2610", [row("10月6日（火）", "10年利付国債（第384回）", true),
  row("10月8日（木）", "30年利付国債"), row("10月14日（水）", "5年利付国債"),
  row("10月20日（火）", "20年利付国債"), row("10月29日（木）", "2年利付国債"),
  row("10月22日（木）", "流動性供給入札（残存期間5年超11年以下）"), row("10月9日（金）", "国庫短期証券（3ヶ月）")]);
const future = month("2611", [row("11月2日（月）", "5年クライメート・トランジション利付国債"),
  row("11月5日（木）", "10年利付国債"), row("11月10日（火）", "30年利付国債"),
  row("11月12日（木）", "5年利付国債"), row("11月16日（月）", "10年物価連動国債"),
  row("11月18日（水）", "20年利付国債"), row("11月25日（水）", "40年利付国債"), row("11月30日（月）", "2年利付国債")]);
module.exports = Object.freeze({ headers, row, month, index, current, future });
