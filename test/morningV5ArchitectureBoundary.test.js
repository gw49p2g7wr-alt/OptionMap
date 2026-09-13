"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V4 = require("../js/morningBaselineV4.js");
const V4Storage = require("../js/morningBaselineV4Storage.js");

const source = name => fs.readFileSync(path.join(__dirname, "../js", name), "utf8");

test("Morning v4 authority and storage identities remain fixed", () => {
    assert.deepEqual([V4.BASELINE_VERSION, V4.SCHEMA_VERSION], [4, 1]);
    assert.deepEqual([V4Storage.STORAGE_KEY, V4Storage.BASELINE_VERSION,
        V4Storage.STORAGE_VERSION], ["optionMapMorningBaselinesV4", 4, 1]);
});

test("Morning v4 remains strict same-contract throughout its authority path", () => {
    assert.match(source("morningBaselineV4.js"),
        /price\.value\.contract !== qri\.value\.contract/);
    assert.match(source("morningV4FormalSessionScope.js"),
        /qri\.contract === price\.contract/);
    assert.match(source("morningComparisonV4.js"),
        /baseline\.currentPrice\.contract === current\.currentPrice\.contract/);
});

test("Morning v5 stays disconnected from v4 storage UI and Full Export", () => {
    for (const name of ["morningBaselineV4.js", "morningBaselineV4Storage.js",
        "morningComparisonV4.js", "fullExportCollector.js"]) {
        assert.doesNotMatch(source(name), /MorningV5|morningV5|morning-v5/);
    }
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.doesNotMatch(html, /id="[^"]*morningV5/i);
});
