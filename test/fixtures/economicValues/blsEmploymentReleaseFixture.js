"use strict";

const MONTHS = Object.freeze({ "01": "JANUARY", "02": "FEBRUARY", "03": "MARCH", "04": "APRIL",
  "05": "MAY", "06": "JUNE", "07": "JULY", "08": "AUGUST", "09": "SEPTEMBER",
  "10": "OCTOBER", "11": "NOVEMBER", "12": "DECEMBER" });
const RELEASE_MONTHS = Object.freeze({ "01": "January", "02": "February", "03": "March", "04": "April",
  "05": "May", "06": "June", "07": "July", "08": "August", "09": "September",
  "10": "October", "11": "November", "12": "December" });
const title = month => month[0] + month.slice(1).toLowerCase();
const numeric = value => Number(String(value).replace(/,/g, ""));
function revisionText(revisions) {
  if (!revisions.length) return "";
  return revisions.map((value, index) => {
    const difference = Math.abs(numeric(value.to) - numeric(value.from)).toLocaleString("en-US"),
      direction = numeric(value.to) >= numeric(value.from) ? "up" : "down",
      lead = index === 0 ? "The change in total nonfarm payroll employment for" : "the change for";
    return `${index ? "and " : ""}${lead} ${title(value.month)} was revised ${direction} by ${difference}, ` +
      `from ${value.from} to ${value.to}${index === revisions.length - 1 ? "." : ", "}`;
  }).join("");
}
function html({ referencePeriod = "2026-09", releaseDate = "2026-10-02", payroll = "+29,000",
    unemployment = "4.2", revisions = [], heading = true, corrected = false,
    correctedTime = "9:00 a.m." } = {}) {
  const [referenceYear, referenceMonth] = referencePeriod.split("-"),
    [releaseYear, releaseMonth, releaseDay] = releaseDate.split("-");
  return `<!doctype html><html><body>
    <h1>${heading ? "Employment Situation News Release" : "Changed release"}${corrected ? " - CORRECTED" : ""}</h1>
    ${corrected ? `<p>Corrected: ${RELEASE_MONTHS[releaseMonth]} ${Number(releaseDay)}, ${releaseYear} at ${correctedTime} (ET)</p>` : ""}
    <p>Transmission of material in this news release is embargoed until 8:30 a.m. (ET) Friday,
      ${RELEASE_MONTHS[releaseMonth]} ${Number(releaseDay)}, ${releaseYear}</p>
    <h2>THE EMPLOYMENT SITUATION - ${MONTHS[referenceMonth]} ${referenceYear}</h2>
    <p>Both nonfarm payroll employment (${payroll}) and the unemployment rate (${unemployment} percent)
      changed little in ${title(MONTHS[referenceMonth])}, the U.S. Bureau of Labor Statistics reported today.</p>
    <p>This news release presents statistics from two monthly surveys.</p>
    ${revisions.length ? `<p>${revisionText(revisions)}</p>` : ""}
  </body></html>`;
}

module.exports = Object.freeze({ html });
