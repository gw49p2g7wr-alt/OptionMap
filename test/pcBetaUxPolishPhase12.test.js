const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("V1 is closed by default and labeled as legacy reference", () => {
    const html = read("index.html");
    const start = html.indexOf('id="optionMapOverallSummary"');
    const opening = html.slice(html.lastIndexOf("<details", start), html.indexOf(">", start) + 1);
    assert.match(opening, /^<details/);
    assert.doesNotMatch(opening, /\sopen(?:\s|>|=)/);
    assert.match(html.slice(start, html.indexOf("</details>", start)), /旧判定 v1（参考）/);
});

test("opening V1 details retains all existing result fields", () => {
    const html = read("index.html");
    const start = html.indexOf('id="optionMapOverallSummary"');
    const section = html.slice(start, html.indexOf("</details>", start));
    for (const id of ["optionMapOverallJudgment", "optionMapWeeklyComponent",
        "optionMapOptionComponent", "optionMapOverallScore"]) assert.match(section, new RegExp(id));
});

test("V1 calculation module and runtime wiring remain unchanged", () => {
    const script = read("js/script.js");
    const render = script.slice(script.indexOf("function renderOptionMapOverallJudgment()"),
        script.indexOf("const OPTION_MAP_V2_ENABLED"));
    assert.match(script, /function calculateOptionMapOverallJudgment\(/);
    assert.match(render, /optionMapOverallJudgment|optionMapOverallScore/);
    assert.doesNotMatch(render, /localStorage|indexedDB|fetch\s*\(|setTimeout|setInterval/);
});

test("V2 remains a normal non-details main display", () => {
    const html = read("index.html");
    const start = html.indexOf('id="optionMapOverallSummaryV2"');
    assert.equal(html.slice(html.lastIndexOf("<", start), start).startsWith("<div"), true);
    assert.match(html.slice(start, start + 500), /OptionMap総合判断 v2/);
});

test("Morning header uses compact 良好 presentation while status remains internal", () => {
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(preview, /morningQualityLabel = value => \(\{ complete: "良好"/);
    assert.match(preview, /morningQualityLabel\(active\.dataQuality\.status\)/);
    assert.match(read("js/morningBaseline.js"), /\["complete", "partial"\]/);
});

test("OverallV2 formal history wording is mapped only at presentation", () => {
    const script = read("js/script.js");
    assert.match(script, /週次データ：検証済みの正式履歴を使用/);
    assert.match(script, /formatOptionMapV2Warning\(warning\)/);
    assert.match(script, /notes\.push\("週次データは検証済み正式historyを使用中"\)/);
});

test("smartphone preview naming and protected semantics stay unchanged", () => {
    const html = read("index.html");
    assert.match(html, /スマホ版 summary preview/);
    assert.match(html, /検証表示/);
    const changed = [read("js/mobileSummaryPreview.js"), read("js/script.js")].join("\n");
    assert.doesNotMatch(changed, /MobileSummaryPreview\?\.update\(\{.*formatOptionMapV2Warning/s);
});
