"use strict";
const Route = require("../../../js/marketCalendarIsolated/blsFixedRoute.js");
const rows = Object.freeze({
  cpi: [["August 2026", "Sep. 11, 2026", "08:30 AM"], ["September 2026", "Oct. 14, 2026", "08:30 AM"], ["October 2026", "Nov. 10, 2026", "08:30 AM"]],
  ppi: [["August 2026", "Sep. 10, 2026", "08:30 AM"], ["September 2026", "Oct. 15, 2026", "08:30 AM"], ["October 2026", "Nov. 13, 2026", "08:30 AM"]],
  employment_situation: [["August 2026", "Sep. 04, 2026", "08:30 AM"], ["September 2026", "Oct. 02, 2026", "08:30 AM"], ["October 2026", "Nov. 06, 2026", "08:30 AM"]],
  jolts: [["July 2026", "Sep. 01, 2026", "10:00 AM"], ["August 2026", "Sep. 29, 2026", "10:00 AM"], ["September 2026", "Nov. 03, 2026", "10:00 AM"], ["October 2026", "Dec. 01, 2026", "10:00 AM"]]
});
function html(role, values = rows[role]) {
  return `<meta charset="utf-8"><title>Schedule of Releases for the ${Route.ROLES.find(r => r.role === role).title}</title>` +
    `<table class="layout"><tr><td><nav>ignore</nav><table class="release-list"><thead><tr>` +
    ["Reference Month", "Release Date", "Release Time"].map(x => `<th>${x}</th>`).join("") +
    `</tr></thead><tbody>${values.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></td></tr></table>`;
}
function document(role, body = html(role)) {
  const bytes = new TextEncoder().encode(body);
  return { role, requestedUrl: Route.ROLES.find(r => r.role === role).url, fetchOutcome: "success",
    httpStatus: 200, mime: "text/html", contentType: "text/html", redirects: [],
    byteCount: bytes.length, contentSha256: Route.hash(bytes), parserInput: bytes };
}
function acquisition() { return { sourceId: Route.SOURCE_ID, fetchedAt: "2026-09-26T00:00:00.000Z",
  documents: Route.ROLES.map(r => document(r.role)) }; }
module.exports = { rows, html, document, acquisition };
