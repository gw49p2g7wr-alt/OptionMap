"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");

test("button hover excludes disabled controls", () => {
    assert.match(css, /button:hover:not\(:disabled\)\s*\{/);
    assert.doesNotMatch(css, /(?:^|\n)button:hover\s*\{/);
});

test("disabled button select and input share muted non-pointer feedback", () => {
    assert.match(css, /button:disabled,\s*select:disabled,\s*input:disabled\s*\{[^}]*cursor:\s*not-allowed[^}]*opacity:[^}]*filter:\s*saturate/s);
    assert.match(css, /select:disabled,\s*input:disabled\s*\{[^}]*background:[^}]*color:/s);
    assert.match(css, /\.iv-contract-button:disabled,\s*\.iv-range-button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
});

test("button select input and textarea use one visible keyboard focus contract", () => {
    assert.match(css, /button:focus-visible,\s*select:focus-visible,\s*input:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*3px[^}]*outline-offset:\s*2px/s);
});

test("chart mode initial active state and runtime aria-pressed stay synchronized", () => {
    assert.match(html, /id="showOpenInterestButton"[^>]*class="chart-mode-button active"[^>]*aria-pressed="true"/s);
    assert.match(html, /id="showVolumeButton"[^>]*class="chart-mode-button"[^>]*aria-pressed="false"/s);
    assert.match(script, /showOpenInterestButton\.classList\.toggle\([\s\S]*?selected[\s\S]*?showOpenInterestButton\.setAttribute\("aria-pressed", String\(selected\)\)/);
    assert.match(script, /showVolumeButton\.classList\.toggle\([\s\S]*?selected[\s\S]*?showVolumeButton\.setAttribute\("aria-pressed", String\(selected\)\)/);
});

test("IV contract and range active states synchronize aria-pressed", () => {
    assert.match(html, /data-range-mode="plus_minus_3000"[^>]*class="iv-range-button active"[^>]*aria-pressed="true"/);
    assert.equal((html.match(/class="iv-range-button" aria-pressed="false"/g) || []).length, 2);
    assert.match(html, /button\.classList\.toggle\("active", item\.role === qriIvContractSelection\);\s*button\.setAttribute\("aria-pressed", String\(item\.role === qriIvContractSelection\)\)/);
    assert.match(html, /button\.classList\.toggle\("active", selected\);\s*button\.setAttribute\("aria-pressed", String\(selected\)\)/);
});

test("changing IV range does not mutate the contract selection", () => {
    const handler = html.match(/qriIvRangeButtons\.forEach\(button => button\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\}\)\);/)?.[1] || "";
    assert.match(handler, /qriIvRangeMode = mode/);
    assert.doesNotMatch(handler, /qriIvContractSelection\s*=/);
});

test("selected meaning colors and Phase 1 disclosure contract remain intact", () => {
    assert.match(css, /\.iv-contract-button\.active,\s*\.iv-range-button\.active\s*\{[^}]*background:\s*#315f9d/s);
    assert.match(css, /\.chart-mode-button\.active\s*\{[^}]*background:\s*#244a82/s);
    assert.match(css, /\.container details > summary::before\s*\{[^}]*content:\s*"▶"/s);
    assert.match(css, /\.container details\[open\] > summary::before\s*\{[^}]*content:\s*"▼"/s);
});

test("mode and IV controls wrap safely without changing document structure", () => {
    assert.match(css, /\.chart-mode-switch\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(css, /\.iv-contract-switch,\s*\.iv-range-switch\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(css, /\.iv-contract-button,\s*\.iv-range-button\s*\{[^}]*min-height:\s*40px[^}]*margin:\s*0/s);
});

test("IV controls use compact labelled rows without changing selection semantics", () => {
    assert.match(html, /id="qriIvContractSwitchLabel"[^>]*>限月<\/span>/);
    assert.match(html, /id="qriIvContractSwitch"[^>]*role="group"[^>]*aria-labelledby="qriIvContractSwitchLabel"/s);
    assert.match(html, /id="qriIvRangeSwitchLabel"[^>]*>表示範囲<\/span>/);
    assert.match(html, /class="iv-range-switch"[^>]*role="group"[^>]*aria-labelledby="qriIvRangeSwitchLabel"/s);
    assert.match(css, /\.qri-iv-control-row\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*max-width:\s*100%[^}]*margin-bottom:\s*8px/s);
    assert.match(css, /\.iv-contract-switch,\s*\.iv-range-switch\s*\{[^}]*flex:\s*0 1 auto[^}]*gap:\s*6px[^}]*margin:\s*0/s);
    assert.match(css, /\.iv-contract-button,\s*\.iv-range-button\s*\{[^}]*min-height:\s*40px[^}]*padding:\s*6px 11px/s);
});

test("IV labelled control rows wrap below their labels on mobile", () => {
    assert.match(css, /@media \(max-width:\s*550px\)[\s\S]*?\.qri-iv-control-label\s*\{[^}]*flex-basis:\s*100%/s);
    assert.match(css, /@media \(max-width:\s*550px\)[\s\S]*?\.iv-contract-switch,\s*\.iv-range-switch\s*\{[^}]*width:\s*100%/s);
});
