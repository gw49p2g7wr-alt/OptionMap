const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
const style = fs.readFileSync(path.join(root, "style.css"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("CALL and PUT chart presentation uses red and blue option-side constants", () => {
  assert.match(script, /OPTION_SIDE_CHART_COLORS[\s\S]*call:[\s\S]*rgba\(255, 99, 132,[\s\S]*put:[\s\S]*rgba\(74, 144, 226,/);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.call\.soft/g) || []).length, 2);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.call\.strong/g) || []).length, 3);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.call\.border/g) || []).length, 2);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.put\.soft/g) || []).length, 2);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.put\.strong/g) || []).length, 3);
  assert.equal((script.match(/OPTION_SIDE_CHART_COLORS\.put\.border/g) || []).length, 2);
});

test("QRI OI TOP3 markers reuse CALL red and PUT blue option-side colors", () => {
  const plugin = script.match(/const combinedWallRankPlugin = \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(plugin, /datasetIndex === 0\s*\? OPTION_SIDE_CHART_COLORS\.call\.strong\s*: OPTION_SIDE_CHART_COLORS\.put\.strong/);
});

test("QRI OI TOP3 marker ranking, position and displayed rank stay unchanged", () => {
  const plugin = script.match(/const combinedWallRankPlugin = \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(plugin, /candidates\.sort\(\(a, b\) => b\.value - a\.value\);\s*const topThree = candidates\.slice\(0, 3\)/);
  assert.match(plugin, /const x = bar\.x;[\s\S]*?chart\.chartArea\.top \+ 13,[\s\S]*?bar\.y - 14/);
  assert.match(plugin, /chart\.chartArea\.bottom - 13,[\s\S]*?bar\.y \+ 14 \+ rankIndex \* 25/);
  assert.match(plugin, /ctx\.fillText\(\s*String\(rankIndex \+ 1\),\s*x,\s*y\s*\)/);
});

test("saved option reference headings follow CALL red and PUT blue CSS variables", () => {
  assert.match(style, /--option-call-color:\s*#9b4058/);
  assert.match(style, /--option-put-color:\s*#285f9e/);
  assert.match(style, /\.is-call strong\s*{\s*color:\s*var\(--option-call-color\)/);
  assert.match(style, /\.is-put strong\s*{\s*color:\s*var\(--option-put-color\)/);
});

test("separate presentation semantics and release identity remain protected", () => {
  assert.match(script, /estimatedBuy:[\s\S]*rgba\(255, 99, 132, 0\.85\)/);
  assert.match(script, /estimatedSell:[\s\S]*rgba\(54, 162, 235, 0\.85\)/);
  assert.match(script, /unconfirmed:[\s\S]*rgba\(140, 140, 140, 0\.60\)/);
  assert.match(style, /\.call-wall\s*{[\s\S]*#1769c2/);
  assert.match(style, /\.put-wall\s*{[\s\S]*#d81b45/);
  assert.match(html, /濃色：日中　淡色：夜間/);
  assert.equal(packageJson.version, "1.1.0-beta.2");
  assert.equal(packageJson.build.appId, "com.natsu.optionmap");
  assert.equal(packageJson.build.productName, "OptionMap");
});
