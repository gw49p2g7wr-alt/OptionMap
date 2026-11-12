"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");

const W1 = require("../../js/weeklyAcquisitionAuthorityContract.js");
const W2 = require("../../js/weeklyRawTransportShadow.js");
const W3 = require("../../js/weeklyEvidenceVaultShadow.js");
const SetStore = require("../../js/storage/weeklyEvidenceSetStore.js");
const BindingStore = require("../../js/storage/weeklySemanticEvidenceBindingStore.js");
const Promotion = require("../../js/weeklySemanticEvidencePromotionShadow.js");
const Vault = require("../../js/sourceEvidence/sourceEvidenceVault.js");
const WeeklyFutures = require("../../js/weeklyFutures.js");
const WeeklyOptions = require("../../js/weeklyOptions.js");
const OptionsHistory = require("../../js/weeklyOptionsHistory.js");

const MIME = W2.OBSERVED_JPX_MIME;
const NOW = new Date("2026-11-12T06:00:00.000Z");

function authority() {
  return W1.createMainAuthority({ keyId: "weekly-w4-authority",
    secret: Buffer.alloc(32, 0x74) });
}

function publishedDate(sourceDate) {
  const date = new Date(`${sourceDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 3);
  return date.toISOString().slice(0, 10);
}

function japaneseDate(sourceDate, current = false) {
  const [year, month, day] = sourceDate.split("-").map(Number);
  return current ? `（ ${year}年${month}月${day}日現在 ）` : `${year}年${month}月${day}日`;
}

function futuresRows(sourceDate, value = 100) {
  const rows = Array.from({ length: 8 }, () => []);
  rows[1][0] = japaneseDate(sourceDate, true);
  rows[2][0] = japaneseDate(publishedDate(sourceDate));
  rows[4] = ["＜日経225先物＞"];
  rows[5] = ["1", "2026年12月限月", "12724", "ＨＳＢＣ証券", value,
    "12400", "野村証券", value + 1];
  return rows;
}

function optionsRows(sourceDate, value = 100) {
  const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
  rows[0][0] = WeeklyOptions.SOURCE_TITLE;
  rows[1][0] = japaneseDate(sourceDate, true);
  rows[2][0] = japaneseDate(publishedDate(sourceDate));
  rows[6][1] = "プット（2026年11月限月）";
  rows[6][11] = "コール（2026年11月限月）";
  [10, 25, 40, 55, 70].forEach((start, block) => {
    const strike = 65375 + block * 125;
    rows[start - 1][1] = strike;
    rows[start - 1][11] = strike;
    for (let index = 0; index < 15; index += 1) {
      rows[start - 1 + index][0] = index + 1;
      rows[start - 1 + index][10] = index + 1;
    }
  });
  rows[9][2] = "12479";
  rows[9][3] = "ＡＢＮクリアリン証券";
  rows[9][4] = value;
  rows[9][15] = "11746";
  rows[9][16] = "ＵＢＳ証券";
  rows[9][17] = value + 1;
  return rows;
}

function xlsx(rows, tag = "") {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Comments: tag };
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

function listing(sourceDate, tag = "") {
  const compact = sourceDate.replaceAll("-", ""), year = sourceDate.slice(0, 4);
  return new TextEncoder().encode(JSON.stringify({ UpdateDate: "2026/11/09 15:31", tag,
    TableDatas: [{ TradeDate: compact,
      IndexFutures: `/automation/markets/derivatives/open-interest/files/${year}/` +
        `${compact}_indexfut_oi_by_tp.xlsx`,
      IndexOptions: `/automation/markets/derivatives/open-interest/files/${year}/` +
        `${compact}_nk225op_oi_by_tp.xlsx` }] }));
}

function response(bytes) {
  return new Response(bytes, { status: 200, headers: { "content-type": MIME,
    "content-length": String(bytes.byteLength) } });
}

async function futuresCandidate(sourceDate, value = 100) {
  const data = WeeklyFutures.parseWeeklyFuturesRows(futuresRows(sourceDate, value)),
    signature = await WeeklyFutures.createSignature(data),
    sourceUrl = W1.canonicalWorkbookUrl("weekly_futures_workbook", sourceDate);
  return { sourceDate, sourceUrl, fetchedAt: NOW.toISOString(), signature,
    versionKey: `weekly-futures-v2|${sourceDate}|sha256:${signature}`, data,
    officialMetadata: { origin: "jpx_open_interest_year_listing",
      listingUrl: W1.canonicalListingUrl(Number(sourceDate.slice(0, 4))),
      listingUpdatedAt: "2026-11-09T15:31:00+09:00", tradeDate: sourceDate,
      indexFuturesUrl: sourceUrl, publishedDate: publishedDate(sourceDate),
      currentOfficialRefetch: true, dateEvidence: { listingTradeDate: sourceDate,
        excelSourceDate: sourceDate, urlDate: sourceDate, consistent: true } } };
}

async function optionsCandidate(sourceDate, value = 100) {
  const data = WeeklyOptions.parseWeeklyOptionsRows(optionsRows(sourceDate, value)),
    signature = await WeeklyOptions.createSignature(data),
    sourceUrl = W1.canonicalWorkbookUrl("weekly_options_workbook", sourceDate), cache = {
      version: WeeklyOptions.CACHE_VERSION, parserVersion: WeeklyOptions.PARSER_VERSION,
      schemaVersion: WeeklyOptions.SCHEMA_VERSION,
      source: "jpx-weekly-nikkei225-options-open-interest", sourceDate,
      sourceDateKind: "jpx_open_interest_as_of", publishedDate: publishedDate(sourceDate),
      publishedAt: null, listingUpdatedAt: "2026-11-09T15:31:00+09:00",
      listingUpdatedAtKind: "jpx_listing_updated_at",
      listingUrl: W1.canonicalListingUrl(Number(sourceDate.slice(0, 4))),
      fetchedAt: NOW.toISOString(), sourceUrl, signatureAlgorithm: "sha256", signature,
      versionKey: `weekly-options-v2|${sourceDate}|sha256:${signature}`,
      dateEvidence: { excelAsOf: sourceDate, listingTradeDate: sourceDate,
        urlDate: sourceDate, consistent: true }, versionAssessment: "confirmed",
      currentOfficialRefetch: true, data };
  const result = await OptionsHistory.createWeeklyOptionsHistoryCandidate(cache);
  if (!result.ok) throw new Error(`weekly_options_candidate_failed:${result.reason}`);
  return result.candidate;
}

function createHarness(t) {
  const main = authority(), root = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), "optionmap-weekly-w4-"))),
    vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null }),
    evidenceSetStore = SetStore.createIsolatedWeeklyEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }), bindingStore =
      BindingStore.createIsolatedWeeklySemanticEvidenceBindingStore({ root,
        targetEnvironment: "isolated_test" });
  const promotion = Promotion.createWeeklySemanticEvidencePromotionShadow({ vault,
    evidenceSetStore, bindingStore, authority: main });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  async function capture({ sourceDate = "2026-11-06", futuresValue = 100,
      optionsValue = 100, listingTag = "", futuresTag = "", optionsTag = "",
      requestId = "weekly-w4-request-1" } = {}) {
    const listingBytes = listing(sourceDate, listingTag), futuresBytes =
      xlsx(futuresRows(sourceDate, futuresValue), futuresTag), optionsBytes =
      xlsx(optionsRows(sourceDate, optionsValue), optionsTag), urls = {
        listing: W1.canonicalListingUrl(Number(sourceDate.slice(0, 4))),
        futures: W1.canonicalWorkbookUrl("weekly_futures_workbook", sourceDate),
        options: W1.canonicalWorkbookUrl("weekly_options_workbook", sourceDate)
      }, transport = W2.createWeeklyRawTransportShadow({ authority: main, now: () => NOW,
        fetchImpl: async url => url === urls.listing ? response(listingBytes) :
          url === urls.futures ? response(futuresBytes) :
            url === urls.options ? response(optionsBytes) : new Response(null, { status: 404 }) }),
      shadow = W3.createWeeklyEvidenceVaultShadow({ transportShadow: transport, vault,
        setStore: evidenceSetStore, authority: main, testHooks: null }),
      intent = W1.createAcquisitionIntent({ requestKind: "explicit_source_date",
        targetDate: sourceDate }), result = await shadow.capture({ intent, requestId });
    if (!result.runs?.[0]) throw new Error(`weekly_w3_capture_failed:${result.reason}`);
    return { result, run: result.runs[0], listingBytes, futuresBytes, optionsBytes,
      futuresCandidate: await futuresCandidate(sourceDate, futuresValue),
      optionsCandidate: await optionsCandidate(sourceDate, optionsValue) };
  }

  return { main, root, vault, evidenceSetStore, bindingStore, promotion, capture };
}

module.exports = Object.freeze({ createHarness, futuresRows, optionsRows, xlsx, listing,
  futuresCandidate, optionsCandidate });
