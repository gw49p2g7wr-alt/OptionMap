"use strict";
const head = '<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />' +
    ' '.repeat(1400) + '<meta charset="utf-8" /></head><body>';
const row = values => `<tr>${values.map(value => `<td>${value}</td>`).join("")}</tr>`;
const html = `${head}<table id="calendar"><tr><th>Release</th></tr>${[
    row(["Advance Monthly Sales for Retail and Food Services", "September 16, 2026", "8:30 AM", "August 2026", "A202609160830", "A202608"]),
    row(["Advance Monthly Sales for Retail and Food Services", "October 15, 2026", "8:30 AM", "September 2026", "A202610150830", "A202609"]),
    row(["Advance Economic Indicators Report (International Trade, Retail, & Wholesale)", "September 29, 2026", "8:30 AM", "August 2026"]),
    row(["Quarterly Financial Report--Retail Trade", "September 8, 2026", "10:00 AM", "Second Quarter 2026"])
].join("")}</table></body></html>`;
module.exports = Object.freeze({ html, bytes: new TextEncoder().encode(html) });
