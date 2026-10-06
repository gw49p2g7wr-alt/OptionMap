"use strict";
const G1 = require("./mofJgbFixture.js"), Existing = require("./automaticShadowFixture.js");
const Mof = require("../../../js/marketCalendarIsolated/mofJgbVariableAdapter.js");
const S = require("../../../js/marketCalendarIsolated/mofJgbSource.js");
const AT = "2026-10-07T00:00:00.000Z";
function response(url, body, status = 200, headers = {}) {
  const r = new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8", ...headers } });
  Object.defineProperty(r, "url", { value: url }); return r;
}
function transport(patch = {}) {
  const documents = { [S.INDEX_URL]: G1.index(["2610", "2611"]),
    "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm": G1.current,
    "https://www.mof.go.jp/jgbs/auction/calendar/2611.htm": G1.future, ...patch };
  let count = 0;
  const fetchImpl = async (url, options) => {
    count++; if (!(url in documents)) throw Error("unexpected_url");
    const value = documents[url]; return typeof value === "function" ? value(url, options) : response(url, value);
  };
  return { fetchImpl, requests: () => count };
}
async function mof(patch) {
  const t = transport(patch), source = await Mof.create({ enablement: Mof.ENABLEMENT, fetchImpl: t.fetchImpl })
    .acquire({ sourceId: S.SOURCE_ID, assessmentDateJst: "2026-10-07" });
  return { source, requests: t.requests() };
}
async function fixture(options) { const f = await Existing.fixture(options); f.sources.push((await mof()).source); return f; }
module.exports = { AT, G1, S, Mof, response, transport, mof, fixture, Existing };
