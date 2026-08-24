const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/currentPriceSavedView.js");
const Ui = require("../js/currentPriceSavedUiState.js");

function documentFixture() {
    const ids = ["currentPriceSavedState", "currentPriceSavedTitle",
        "currentPriceSavedPrice", "currentPriceSavedContract", "currentPriceSavedMetadata",
        "currentPriceSavedMessage", "currentPriceSavedNote"];
    const elements = Object.fromEntries(ids.map(id => [id, { id, hidden: false, textContent: "",
        classes: new Set(), classList: { add(name) { elements[id].classes.add(name); },
            remove(name) { elements[id].classes.delete(name); } } }]));
    return { elements, getElementById(id) { return elements[id] || null; } };
}
function view(overrides = {}) {
    return { visible: true, state: "saved_pending", title: "保存済み価格",
        priceText: "65,660円", contractText: "2026年9月限",
        metadataLines: ["価格時刻：8/24 17:47", "最終取得：8/24 18:04"],
        message: "最新価格を確認中…", note: "参考表示・現在値には未反映",
        severity: "neutral", ...overrides };
}

test("dedicated renderer writes every pure view field", () => {
    const doc = documentFixture(); const result = View.renderCurrentPriceSavedUiState(view(), doc);
    assert.deepEqual([result.rendered, result.visible, doc.elements.currentPriceSavedState.hidden,
        doc.elements.currentPriceSavedTitle.textContent,
        doc.elements.currentPriceSavedPrice.textContent],
    [true, true, false, "保存済み価格", "65,660円"]);
    assert.equal(doc.elements.currentPriceSavedContract.textContent, "2026年9月限");
    assert.equal(doc.elements.currentPriceSavedMetadata.textContent,
        "価格時刻：8/24 17:47 / 最終取得：8/24 18:04");
    assert.equal(doc.elements.currentPriceSavedMessage.textContent, "最新価格を確認中…");
    assert.equal(doc.elements.currentPriceSavedNote.textContent, "参考表示・現在値には未反映");
});
test("hidden pure state hides and clears the dedicated region", () => {
    const doc = documentFixture(); View.renderCurrentPriceSavedUiState(view(), doc);
    View.renderCurrentPriceSavedUiState({ visible: false, state: "hidden" }, doc);
    assert.equal(doc.elements.currentPriceSavedState.hidden, true);
    assert.equal(doc.elements.currentPriceSavedPrice.textContent, "");
});
test("neutral and caution severity classes come only from pure state", () => {
    const doc = documentFixture(); const element = doc.elements.currentPriceSavedState;
    View.renderCurrentPriceSavedUiState(view(), doc);
    assert.equal(element.classes.has("current-price-saved-neutral"), true);
    View.renderCurrentPriceSavedUiState(view({ state: "saved_fallback",
        severity: "caution" }), doc);
    assert.equal(element.classes.has("current-price-saved-neutral"), false);
    assert.equal(element.classes.has("current-price-saved-caution"), true);
});
test("missing DOM is isolated", () => {
    assert.deepEqual(View.renderCurrentPriceSavedUiState(view(),
        { getElementById() { return null; } }),
    { rendered: false, reason: "container_missing" });
});
test("Phase 5.1 fixture displays pending then hides on live success", () => {
    const boot = { status: "candidate", reason: null, displayEligible: true,
        freshness: { status: "stale", reason: "saved_last_valid" },
        candidate: { origin: "cache", value: 65660, source: "qri-nikkei225-futures",
            mode: "automatic", contract: "2026-09", quoteDate: "2026-08-24",
            quotedAtRaw: "08/24 17:47", quotedAtNormalized: "2026-08-24T17:47:00+09:00",
            fetchedAt: "2026-08-24T09:04:05.391Z" },
        diagnostics: { integrityVerified: true, restoreStatus: "verified" } };
    const doc = documentFixture();
    const pending = Ui.buildCurrentPriceSavedUiState({ bootShadowState: boot,
        liveFetchState: "pending", currentPriceMode: "automatic" });
    View.renderCurrentPriceSavedUiState(pending, doc);
    assert.equal(doc.elements.currentPriceSavedState.hidden, false);
    const success = Ui.buildCurrentPriceSavedUiState({ bootShadowState:
        { ...boot, status: "superseded", reason: "replaced_by_live" },
        liveFetchState: "success", currentPriceMode: "automatic" });
    View.renderCurrentPriceSavedUiState(success, doc);
    assert.equal(doc.elements.currentPriceSavedState.hidden, true);
});
test("renderer does not mutate formal current price facts", () => {
    const price = { value: 65750, source: "qri-nikkei225-futures", mode: "automatic",
        contract: "26年09月限", quotedAt: "08/24 18:52", fetchedAt: "fetch" };
    const before = JSON.stringify(price);
    View.renderCurrentPriceSavedUiState(view(), documentFixture());
    assert.equal(JSON.stringify(price), before);
});
test("renderer module has no storage, fetch, calculation, Mobile, Overall, timer or polling", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/currentPriceSavedView.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|setItem|removeItem|setTimeout|setInterval/.test(source), false);
    assert.equal(/applyCurrentPrice|nearestStrike|PriceSnapshot|Observation|MobileSummary|OverallV2/.test(source), false);
});
test("HTML loads dependencies in order and places saved region before market info", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const scripts = ["js/currentPriceBootRestoreShadow.js", "js/currentPriceSavedUiState.js",
        "js/currentPriceSavedView.js", "js/script.js"];
    const positions = scripts.map(source => html.indexOf(`<script src="${source}"></script>`));
    assert.equal(positions.every(position => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.equal(html.indexOf('id="currentPriceSavedState"') <
        html.indexOf('class="market-info"'), true);
});
test("runtime wiring uses existing QRI state and pure builder without direct storage", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /getCurrentPriceBootRestoreShadowState[\s\S]+?dataFetchState\?\.qri[\s\S]+?buildCurrentPriceSavedUiState[\s\S]+?renderCurrentPriceSavedUiState/);
    const functionSource = html.slice(html.indexOf("function refreshCurrentPriceSavedUi"),
        html.indexOf("window.refreshCurrentPriceSavedUi"));
    assert.equal(/localStorage|setItem|removeItem|indexedDB|\bfetch\s*\(/.test(functionSource), false);
});
test("existing event paths refresh UI without a timer", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(html, /initializeCurrentPriceBootRestoreShadow[\s\S]+?then\(\(\) => refreshCurrentPriceSavedUi\(\)\)/);
    assert.match(html, /markCurrentPriceBootRestoreShadowSuperseded[\s\S]+?refreshCurrentPriceSavedUi\(\)/);
    assert.match(script, /if \(source === "qri"\)[\s\S]+?refreshCurrentPriceSavedUi/);
    assert.equal(/setTimeout|setInterval/.test(html.slice(
        html.indexOf("function refreshCurrentPriceSavedUi"),
        html.indexOf("let lastValidParticipantCache"))), false);
});
