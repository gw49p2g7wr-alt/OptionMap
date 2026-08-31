const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const assetPath = path.join(root, "js/vendor/chart.umd.js");
const licensePath = path.join(root, "js/vendor/Chart.js.LICENSE.md");
const chartSource = fs.readFileSync(assetPath, "utf8");

test("Chart.js 4.5.1をpackageとlockへexact pinする", () => {
    assert.equal(packageJson.dependencies["chart.js"], "4.5.1");
    assert.equal(packageLock.packages[""].dependencies["chart.js"], "4.5.1");
    assert.equal(packageLock.packages["node_modules/chart.js"].version, "4.5.1");
    assert.match(packageLock.packages["node_modules/chart.js"].resolved,
        /chart\.js-4\.5\.1\.tgz$/);
    assert.match(packageLock.packages["node_modules/chart.js"].integrity, /^sha512-/);
});

test("local UMD assetとMIT licenseを明示package対象へ含める", () => {
    assert.equal(fs.statSync(assetPath).isFile(), true);
    assert.equal(fs.statSync(licensePath).isFile(), true);
    assert.match(fs.readFileSync(licensePath, "utf8"), /The MIT License \(MIT\)/);
    assert.match(fs.readFileSync(licensePath, "utf8"), /Chart\.js Contributors/);
    assert.ok(packageJson.build.files.includes("js/**/*"));
});

test("rendererはremote executable scriptを持たずlocal Chartを先にloadする", () => {
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
        .map(match => match[1]);
    assert.ok(sources.includes("js/vendor/chart.umd.js"));
    assert.equal(sources.some(source => /^https?:\/\//i.test(source)), false);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/chart\.js/i);
    assert.ok(html.indexOf('src="js/vendor/chart.umd.js"') <
        html.indexOf('src="js/ai.js"'));
    for (const source of sources) {
        assert.equal(fs.existsSync(path.join(root, source)), true,
            `offline script is missing: ${source}`);
    }
});

test("local browser bundleは既存Chart global APIと互換", () => {
    const browser = {};
    browser.window = browser;
    browser.self = browser;
    browser.globalThis = browser;
    vm.runInNewContext(chartSource, browser, { filename: "chart.umd.js" });
    assert.equal(typeof browser.Chart, "function");
    assert.equal(browser.Chart.version, "4.5.1");
    assert.equal(typeof browser.Chart.getChart, "function");
    assert.equal(typeof browser.Chart.prototype.destroy, "function");
    assert.equal(typeof browser.Chart.register, "function");
});

test("Chart local化でrenderer requireと既存Chart source contractを変更しない", () => {
    const rendererSources = ["index.html", ...fs.readdirSync(path.join(root, "js"))
        .filter(name => name.endsWith(".js")).map(name => `js/${name}`)]
        .map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    assert.doesNotMatch(rendererSources, /require\(["']chart\.js["']\)/);
    assert.match(rendererSources, /Chart\.getChart\(/);
    assert.match(rendererSources, /new Chart\(/);
    assert.match(rendererSources, /responsive:\s*true/);
    assert.match(rendererSources, /maintainAspectRatio:\s*false/);
    assert.match(rendererSources, /afterDatasetsDraw\s*\(/);
});
