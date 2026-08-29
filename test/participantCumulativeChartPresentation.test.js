const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
const style = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("participant cumulative chart uses the available PC width responsively", () => {
  assert.match(style, /\.cumulative-chart-card\s*{[^}]*width:\s*100%;/s);
  assert.match(style, /\.cumulative-chart-card\s*{[^}]*max-width:\s*1100px;/s);
  assert.match(style, /\.cumulative-chart-card\s*{[^}]*box-sizing:\s*border-box;/s);
  assert.match(style, /#cumulativeChart\s*{[^}]*width:\s*100%\s*!important;/s);
  assert.match(style, /#cumulativeChart\s*{[^}]*max-width:\s*100%;/s);
  assert.match(script, /responsive:\s*true/);
  assert.match(script, /maintainAspectRatio:\s*false/);
});

test("participant cumulative chart follows Japanese buy and sell colors", () => {
  assert.match(html, /🔴 買い推定/);
  assert.match(html, /🔵 売り推定/);
  assert.match(script, /estimatedBuy:[\s\S]*day:\s*"rgba\(255, 99, 132, 0\.85\)"[\s\S]*night:\s*"rgba\(255, 99, 132, 0\.35\)"/);
  assert.match(script, /estimatedSell:[\s\S]*day:\s*"rgba\(54, 162, 235, 0\.85\)"[\s\S]*night:\s*"rgba\(54, 162, 235, 0\.35\)"/);
});

test("participant cumulative neutral colors and day/night intensity stay unchanged", () => {
  assert.match(script, /unconfirmed:[\s\S]*day:\s*"rgba\(140, 140, 140, 0\.60\)"[\s\S]*night:\s*"rgba\(180, 180, 180, 0\.30\)"/);
  assert.match(html, /⚪ 未確定/);
  assert.match(html, /濃色：日中　淡色：夜間/);
});
