"use strict";

const XLSX = require("xlsx");
// Small synthetic fixtures modeled on explicit official table/worksheet structure;
// never a persisted official response body.
const primary = '<meta charset="utf-8"><h2 id="p02">会合</h2><p>2026年10月29日（木）、30日（金）</p>' +
  '<h2 id="p03">会見</h2><p>2026年10月30日（金）15:30～</p>' +
  '<table><caption>公表予定</caption><tr><td>2026年10月7日</td><td>10:00</td><td>【挨拶】植田総裁（全国証券大会）</td></tr></table>';
const table = (caption, headers, rows) => `<table><caption>表 ${caption}</caption><thead><tr>${headers.map(x =>
  `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const recent = [
  ["2026年10月6日", "植田総裁", '<a href="/about/press/koen_2026/ko261006a.htm">【挨拶】（全国証券大会）</a>'],
  ["2026年10月5日", "内田副総裁", '<a href="/about/press/koen_2026/ko261005a.htm">【挨拶】（ECONDAT 2026 Fall Meetingにおける開会挨拶の邦訳）</a>'],
  ["2026年9月10日", "増審議委員", '<a href="/about/press/koen_2026/ko260910a.htm">【挨拶】（福井県金融経済懇談会）</a>']
];
const upcoming = [
  ["2026年10月15日", "小枝審議委員", "熊本県金融経済懇談会における挨拶"],
  ["2026年10月16日", "植田総裁（内田副総裁代読）", "全国信用組合大会における挨拶"],
  ["2026年11月12日", "浅田審議委員", "長崎県金融経済懇談会における挨拶"],
  ["2026年11月16日", "高田審議委員", "徳島経済同友会における講演"]
];
function speeches({ latest = recent, future = upcoming } = {}) {
  return '<meta charset="utf-8">' + table("最新の講演・挨拶等", ["開催日", "講演者等", "タイトル等"], latest) +
    table("今後の講演・挨拶等の予定", ["日程", "講演者等", "講演内容等"], future);
}
function workbook(mutator = () => {}) {
  const sheet = { A1: { t: "s", v: "統計データの公表・掲載予定" }, B2: { t: "s", v: "統計名" },
    A229: { t: "s", v: "８．短観" }, B230: { t: "s", v: "短観（全国企業短期経済観測調査）／概要及び要旨" },
    B231: { t: "s", v: "短観（全国企業短期経済観測調査）／概要及び要旨" },
    D230: { t: "n", v: 530 / 1440 }, D231: { t: "s", v: "(四半期)" }, "!ref": "A1:P308" };
  [..."EFGHIJKLMNOP"].forEach((c, i) => {
    const month = (6 + i) % 12 + 1, year = i < 6 ? 2026 : 2027;
    sheet[c + "2"] = { t: "s", v: `${i === 0 || i === 6 ? year + "年" : ""}\n${month}月` };
    sheet[c + "230"] = { t: "s", v: "―" }; sheet[c + "231"] = { t: "s", v: "―" };
  });
  for (const [c, serial, period] of [["E", 46204, 6], ["H", 46296, 9], ["J", 46370, 12], ["N", 46478, 3]]) {
    sheet[c + "230"] = { t: "s", v: `(${period}月調査)` }; sheet[c + "231"] = { t: "n", v: serial };
  }
  const b = { SheetNames: ["表紙", "統計データ"], Sheets: { 表紙: XLSX.utils.aoa_to_sheet([["fixture"]]), 統計データ: sheet } };
  mutator(b);
  return new Uint8Array(XLSX.write(b, { type: "buffer", bookType: "xlsx", compression: true }));
}
function response(url) {
  if (url === "https://www.boj.or.jp/about/calendar/") return new Response(primary, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (url === "https://www.boj.or.jp/about/press/index.htm") return new Response(speeches(), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (url === "https://www.boj.or.jp/statistics/outline/tkohyos.xlsx") return new Response(workbook(), {
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  throw Error("fixture_url_unexpected");
}
module.exports = Object.freeze({ primary, recent, upcoming, speeches, workbook, response });
