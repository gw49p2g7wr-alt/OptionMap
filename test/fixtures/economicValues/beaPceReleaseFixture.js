"use strict";

const MONTHS = Object.freeze({ "01": "January", "02": "February", "03": "March", "04": "April",
  "05": "May", "06": "June", "07": "July", "08": "August", "09": "September",
  "10": "October", "11": "November", "12": "December" });
const WEEKDAYS = Object.freeze({ "2026-08-26": "Wednesday", "2026-09-30": "Wednesday",
  "2026-10-29": "Thursday" });
const RELEASE_NUMBERS = Object.freeze({ "2026-08-26": "26–39", "2026-09-30": "26–43",
  "2026-10-29": "26–46" });
function previousMonth(referencePeriod) {
  const [year, month] = referencePeriod.split("-").map(Number), value = new Date(Date.UTC(year, month - 2, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}
function html({ referencePeriod = "2026-09", releaseDate = "2026-10-29",
    releaseNumber = RELEASE_NUMBERS[releaseDate] || "26–99", headlineMom = "0.5", headlineYoy = "3.6",
    coreMom = "0.3", coreYoy = "3.1", priorHeadlineMom = "0.3", priorCoreMom = "0.3",
    duplicateNarrative = false, omitArchive = false, coreAlso = false, tableCurrentHeadline = headlineMom,
    tableCurrentCore = coreMom } = {}) {
  const [referenceYear, referenceMonth] = referencePeriod.split("-"), prior = previousMonth(referencePeriod),
    [releaseYear, releaseMonth, releaseDay] = releaseDate.split("-"), currentName = MONTHS[referenceMonth],
    priorName = MONTHS[prior.slice(5)], code = `${referenceMonth}${referenceYear.slice(-2)}`,
    narrative = `<p>From the preceding month, the PCE price index for ${currentName} increased ${headlineMom} percent. ` +
      `Excluding food and energy, the PCE price index ${coreAlso ? "also " : ""}increased ${coreMom} percent.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>BEA release</title></head><body>
    <div>EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, ${WEEKDAYS[releaseDate] || "Thursday"},
      ${MONTHS[releaseMonth]} ${Number(releaseDay)}, ${releaseYear}</div>
    <div>BEA ${releaseNumber}</div>
    <h1>Personal Income and Outlays, ${currentName} ${referenceYear}</h1>
    ${narrative}${duplicateNarrative ? narrative : ""}
    <p>From the same month one year ago, the PCE price index for ${currentName} increased ${headlineYoy} percent.
      Excluding food and energy, the PCE price index increased ${coreYoy} percent from one year ago.</p>
    <table><thead><tr><th colspan="3">Personal Income and Related Measures<br>
      <small>Percent change from preceding month</small></th></tr></thead><tbody>
      <tr><td></td><td>${priorName}</td><td>${currentName}</td></tr>
      <tr><td>PCE price index</td><td>${priorHeadlineMom}</td><td>${tableCurrentHeadline}</td></tr>
      <tr><td>PCE price index excluding food and energy</td><td>${priorCoreMom}</td><td>${tableCurrentCore}</td></tr>
    </tbody></table>
    <p><a href="https://apps.bea.gov/iTable/">Table 2.8.7. Percent Change From Preceding Period in Prices for PCE by Major Type of Product</a></p>
    <p><a href="https://apps.bea.gov/iTable/">Table 2.8.11. Real PCE by Major Type of Product: Percent Change From Month One Year Ago</a></p>
    <a href="/sites/default/files/${releaseYear}-${releaseMonth}/pi${code}.pdf">Full Release</a>
    <a href="/sites/default/files/${releaseYear}-${releaseMonth}/pi${code}-hist.xlsx">Historical Comparisons</a>
    ${omitArchive ? "" : `<a href="https://apps.bea.gov/histdatacore/histChildLevels.html?HMI=7&amp;oldDiv=National%20Accounts">BEA's Data Archive</a>`}
  </body></html>`;
}

module.exports = Object.freeze({ html });
