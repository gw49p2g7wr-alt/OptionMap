"use strict";
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;",
  ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
function page(sourceId, rows) {
  const name = sourceId === "jp-stat-cpi" ? "消費者物価指数" : "労働力調査";
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body><main><section>
    <h3>政府統計名に関連する公表予定一覧</h3><dl><dt>組織</dt><dd>総務省</dd>
    <dt>政府統計名</dt><dd>${name}</dd></dl><table><tbody>${rows.map((row, i) =>
    `<tr><td>${i + 1}</td><td><div class="detail_list_table">${row.group === undefined ? "" :
      `<div class="detail_list_header">${escape(row.group)}</div>`}<div class="detail_list_title">${escape(row.title)}</div>
    <div class="detail_list_flex"><ul><li>公表日</li><li>${escape(row.date)} &nbsp;${escape(row.time ?? "08:30")}</li></ul>
    <ul><li>掲載年月日</li><li>-</li></ul></div></div></td></tr>`).join("")}</tbody></table></section></main></body></html>`;
}
function monthly(sourceId, lane, month, date) {
  const period = `${month.slice(0, 4)}年${Number(month.slice(5))}月分`;
  return { group: sourceId === "jp-stat-cpi" ? lane === "national" ? "全国" : "東京都区部（中旬速報値）" : period,
    title: sourceId === "jp-stat-cpi" ? period : `基本集計（${period}）`, date };
}
module.exports = { page, monthly };
