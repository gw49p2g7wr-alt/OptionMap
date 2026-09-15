"use strict";
const json = JSON.stringify({
    "Gross Domestic Product": { release_dates: [
        "2026-09-30T12:30:00+00:00", "2026-10-29T12:30:00+00:00",
        "2026-11-25T13:30:00+00:00", "2026-12-23T13:30:00+00:00"] },
    "Personal Income and Outlays": { release_dates: [
        "2026-09-30T12:30:00+00:00", "2026-10-29T12:30:00+00:00",
        "2026-11-25T13:30:00+00:00", "2026-12-23T13:30:00+00:00"] },
    file_last_updated: "2026-07-14T00:00:00"
});
const row = (date, time, title) => `<tr class="scheduled-releases-type-press"><td class="scheduled-date"><div class="release-date">${date}</div><small class="text-muted">${time}</small></td><td class="release-title views-field">${title}</td></tr>`;
const html = `<table id="release-schedule-table"><thead><tr><th>Year 2026</th></tr></thead><tbody>${[
    row("September 30", "8:30 AM", "GDP (Third Estimate), Industries, Corporate Profits, State GDP, and State Personal Income, 2nd Quarter 2026; State PCE, 2025"),
    row("September 30", "8:30 AM", "Personal Income and Outlays, August 2026"),
    row("October 29", "8:30 AM", "GDP (Advance Estimate), 3rd Quarter 2026"),
    row("October 29", "8:30 AM", "Personal Income and Outlays, September 2026"),
    row("November 25", "8:30 AM", "GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026"),
    row("November 25", "8:30 AM", "Personal Income and Outlays, October 2026"),
    row("December 23", "8:30 AM", "GDP (Third Estimate), Industries and Corporate Profits, 3rd Quarter 2026"),
    row("December 23", "8:30 AM", "Personal Income and Outlays, November 2026"),
    row("December 10", "8:30 AM", "Real Personal Consumption Expenditures by State and Real Personal Income by State, 2025"),
    row("September 25", "8:30 AM", "Gross Domestic Product, 2nd Quarter 2025 (Third Estimate), GDP by Industry, Corporate Profits (Revised), and Annual Update"),
    row("January 22", "10:00 AM", "Personal Income and Outlays, October and November 2025")
].join("")}</tbody></table>`;
module.exports = Object.freeze({ json, html });
