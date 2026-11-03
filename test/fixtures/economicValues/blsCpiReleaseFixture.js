"use strict";

const MONTHS = Object.freeze({ "01": "JANUARY", "02": "FEBRUARY", "03": "MARCH", "04": "APRIL",
  "05": "MAY", "06": "JUNE", "07": "JULY", "08": "AUGUST", "09": "SEPTEMBER",
  "10": "OCTOBER", "11": "NOVEMBER", "12": "DECEMBER" });
const RELEASE_MONTHS = Object.freeze({ "01": "January", "02": "February", "03": "March", "04": "April",
  "05": "May", "06": "June", "07": "July", "08": "August", "09": "September",
  "10": "October", "11": "November", "12": "December" });
function html({ referencePeriod = "2026-09", releaseDate = "2026-10-14",
    headlineMom = "0.6", headlineYoy = "3.7", coreMom = "0.3", coreYoy = "2.6",
    includeCore = true, heading = true } = {}) {
  const [referenceYear, referenceMonth] = referencePeriod.split("-"),
    [releaseYear, releaseMonth, releaseDay] = releaseDate.split("-");
  return `<!doctype html><html><body>
    ${heading ? "<h1>Consumer Price Index News Release</h1>" : "<h1>Changed release</h1>"}
    <p>Transmission of material in this release is embargoed until 8:30 a.m. (ET) Wednesday,
      ${RELEASE_MONTHS[releaseMonth]} ${Number(releaseDay)}, ${releaseYear}</p>
    <h2>CONSUMER PRICE INDEX - ${MONTHS[referenceMonth]} ${referenceYear}</h2>
    <p>The Consumer Price Index for All Urban Consumers was published by the Bureau.</p>
    <table id="cpi-table-a">
      <caption>Table A. Percent changes in CPI for All Urban Consumers (CPI-U): U.S. city average</caption>
      <thead><tr><th>Item</th><th>Aug. 2026</th><th>Sep. 2026</th><th>Unadjusted 12-mos. ended</th></tr></thead>
      <tbody>
        <tr><th>All items</th><td>0.4</td><td>${headlineMom}</td><td>${headlineYoy}</td></tr>
        ${includeCore ? `<tr><th>All items less food and energy</th><td>0.3</td><td>${coreMom}</td><td>${coreYoy}</td></tr>` : ""}
      </tbody>
    </table>
  </body></html>`;
}
module.exports = Object.freeze({ html });
