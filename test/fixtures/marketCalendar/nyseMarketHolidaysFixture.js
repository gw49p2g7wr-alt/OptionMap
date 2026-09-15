"use strict";
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h4>All NYSE markets observe U.S. holidays as listed below for 2026, 2027, and 2028.</h4>
<table><thead><tr><th>Holiday</th><th>2026</th><th>2027</th><th>2028</th></tr></thead><tbody>
<tr><th>New Year’s Day</th><td>Thursday, January 1</td><td>Friday, January 1</td><td>—*</td></tr>
<tr><th>Independence Day</th><td>Friday, July 3 (Independence Day observed)</td><td>Monday, July 5 (Independence Day observed)</td><td>Tuesday, July 4**</td></tr>
<tr><th>Thanksgiving Day</th><td>Thursday, November 26***</td><td>Thursday, November 25***</td><td>Thursday, November 23***</td></tr>
</tbody></table>
<p data-type="disclaimer">* Because the holiday falls on Saturday, January 1, 2028, no New Year’s Day holiday is observed.</p>
<p data-type="disclaimer">** Each market will close early at 1:00 p.m. (1:15 p.m. for eligible options) on Monday, July 3, 2028. NYSE American Equities, NYSE Arca Equities, NYSE National, and NYSE Texas late trading sessions will close at 5:00 p.m. All times are Eastern Time.</p>
<p data-type="disclaimer">*** Each market will close early at 1:00 p.m. (1:15 p.m. for eligible options) on Friday, November 27, 2026, Friday, November 26, 2027, and Friday, November 24, 2028 (the day after Thanksgiving). NYSE American Equities, NYSE Arca Equities, NYSE National, and NYSE Texas late trading sessions will close at 5:00 p.m. All times are Eastern Time.</p>
</body></html>`;
module.exports = Object.freeze({ html, bytes: new TextEncoder().encode(html) });
