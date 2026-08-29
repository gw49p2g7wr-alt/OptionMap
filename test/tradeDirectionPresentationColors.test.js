const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
const style = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("weekly futures open-interest datasets use buy red and sell blue", () => {
  assert.match(script, /TRADE_DIRECTION_CHART_COLORS[\s\S]*buy:[\s\S]*rgba\(255, 99, 132, 0\.75\)[\s\S]*sell:[\s\S]*rgba\(54, 162, 235, 0\.75\)/);
  assert.match(script, /label:\s*"売り建玉"[\s\S]*backgroundColor:\s*TRADE_DIRECTION_CHART_COLORS\.sell\.fill[\s\S]*borderColor:\s*TRADE_DIRECTION_CHART_COLORS\.sell\.border/);
  assert.match(script, /label:\s*"買い建玉"[\s\S]*backgroundColor:\s*TRADE_DIRECTION_CHART_COLORS\.buy\.fill[\s\S]*borderColor:\s*TRADE_DIRECTION_CHART_COLORS\.buy\.border/);
});

test("Major5 buy and sell statuses use Japanese trade-direction markers", () => {
  assert.match(script, /TRADE_DIRECTION_MARKERS[\s\S]*buy:\s*"🔴"[\s\S]*sell:\s*"🔵"[\s\S]*neutral:\s*"○"/);
  for (const status of ["estimatedBuy", "reducedBuy"]) {
    assert.match(script, new RegExp(`${status}:.*TRADE_DIRECTION_MARKERS\\.buy`));
  }
  for (const status of ["estimatedSell", "reducedSell"]) {
    assert.match(script, new RegExp(`${status}:.*TRADE_DIRECTION_MARKERS\\.sell`));
  }
  assert.match(script, /unconfirmed:.*TRADE_DIRECTION_MARKERS\.neutral/);
  assert.equal((script.match(/TRADE_DIRECTION_MARKERS\.buy} (?:強い)?買い優勢/g) || []).length, 2);
  assert.equal((script.match(/TRADE_DIRECTION_MARKERS\.sell} (?:強い)?売り優勢/g) || []).length, 2);
  assert.match(script, /TRADE_DIRECTION_MARKERS\.neutral} 方向感薄い/);
});

test("option-side, participant and upper/lower wall semantics remain independent", () => {
  assert.match(script, /OPTION_SIDE_CHART_COLORS[\s\S]*call:[\s\S]*rgba\(255, 99, 132,[\s\S]*put:[\s\S]*rgba\(74, 144, 226,/);
  assert.match(script, /PARTICIPANT_CUMULATIVE_COLORS[\s\S]*estimatedBuy:[\s\S]*rgba\(255, 99, 132, 0\.85\)[\s\S]*estimatedSell:[\s\S]*rgba\(54, 162, 235, 0\.85\)/);
  assert.match(style, /\.call-wall\s*{[\s\S]*border-left:\s*7px solid #1769c2/);
  assert.match(style, /\.put-wall\s*{[\s\S]*border-left:\s*7px solid #d81b45/);
});
