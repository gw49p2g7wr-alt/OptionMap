(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestSourceContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const SOURCE_ID = "jp-jpx-derivatives-open-interest-daily";
    const SCHEMA_VERSION = "jpx-derivatives-open-interest-canonical-v1";
    const PARSER_VERSION = "1";
    const LISTING_URL = "https://www.jpx.co.jp/markets/derivatives/trading-volume/index.html";
    const SHEET_NAME = "デリバティブ建玉残高状況";
    const FUTURES_ANCHOR = "＜OSE 指数先物取引＞";
    const OPTIONS_ANCHOR = "＜OSE 指数オプション取引＞";
    const SIGNED_NUMBER_FORMAT = '\\+#,##0__;\\-#,##0__;"±"0__';
    const INTEGER_NUMBER_FORMATS = Object.freeze(["#,##0__", "#,##0_ "]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const normalizeText = value => typeof value === "string" ? value.normalize("NFKC")
        .replace(/\r/g, "").replace(/[ \t]+/g, " ").trim() : "";
    const isDate = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ?
        Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    async function sha256(value) {
        const text = typeof value === "string" ? value : JSON.stringify(stable(value));
        const bytes = new TextEncoder().encode(text);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
            return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        return require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    }
    return Object.freeze({ SOURCE_ID, SCHEMA_VERSION, PARSER_VERSION, LISTING_URL, SHEET_NAME,
        FUTURES_ANCHOR, OPTIONS_ANCHOR, SIGNED_NUMBER_FORMAT, INTEGER_NUMBER_FORMATS,
        clone, normalizeText, isDate, stable, sha256 });
});
