const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const morningFiles = ["index.html", "js/mobileSummaryPreview.js",
    "js/morningBaselineV4CapturePolicy.js", "js/morningBaselineV4CaptureRuntime.js"];

function blockBetween(start, end) {
    const from = main.indexOf(start); const to = main.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} block missing`);
    return main.slice(from, to);
}

test("startup acquires the Electron single-instance lock after dotenv", () => {
    const dotenv = main.indexOf('require("dotenv").config()');
    const lock = main.indexOf("app.requestSingleInstanceLock()");
    const ipc = main.indexOf("ipcMain.handle(");
    const ready = main.indexOf("app.whenReady()");
    assert.ok(dotenv >= 0 && lock > dotenv && lock < ipc && lock < ready);
    assert.equal((main.match(/requestSingleInstanceLock\(\)/g) || []).length, 1);
    assert.doesNotMatch(main, /lockFile|lock-file|proper-lockfile|flock/);
});

test("lock failure logs, quits and cannot enter primary startup branch", () => {
    const failure = blockBetween("if (!gotTheSingleInstanceLock)", "} else {");
    assert.match(failure, /Second instance blocked; focusing existing window/);
    assert.match(failure, /app\.quit\(\)/);
    assert.doesNotMatch(failure, /createWindow|app\.whenReady|ipcMain\.handle|new BrowserWindow/);
    const primary = main.slice(main.indexOf("} else {") + 8);
    assert.match(primary, /app\.whenReady\(\)\.then\(createWindow\)/);
    assert.match(primary, /app\.on\("window-all-closed"/);
});

test("primary owns one module-scoped mainWindow and clears it on close", () => {
    assert.match(main, /let mainWindow = null;\s*const gotTheSingleInstanceLock/);
    const create = blockBetween("function createWindow()", "app.whenReady()");
    assert.match(create, /mainWindow = new BrowserWindow\(/);
    assert.match(create, /mainWindow\.on\("closed", \(\) => \{\s*mainWindow = null;/);
    assert.match(create, /mainWindow\.loadFile\("index\.html"\)/);
    assert.doesNotMatch(create, /BrowserWindow\.getAllWindows/);
});

test("second instance only restores, shows and focuses a live main window", () => {
    const handler = blockBetween('app.on("second-instance"', 'ipcMain.handle("fetch-jpx');
    assert.match(handler, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return;/);
    assert.match(handler, /mainWindow\.isMinimized\(\).*mainWindow\.restore\(\)/s);
    assert.match(handler, /mainWindow\.isVisible\(\).*mainWindow\.show\(\)/s);
    assert.match(handler, /mainWindow\.focus\(\)/);
    assert.doesNotMatch(handler, /createWindow|new BrowserWindow|BrowserWindow\.getAllWindows/);
});

test("second-instance data is ignored and never forwarded or interpreted", () => {
    const handler = blockBetween('app.on("second-instance"', 'ipcMain.handle("fetch-jpx');
    assert.match(handler, /app\.on\("second-instance", \(\) =>/);
    assert.doesNotMatch(handler, /argv|commandLine|workingDirectory|additionalData|ipcMain|webContents\.send/);
    assert.doesNotMatch(handler, /\beval\b|executeJavaScript|openURL|openExternal|loadURL|readFile|require\("fs"\)|\bshell\b/);
});

test("hidden QRI and JPX BrowserWindow lifecycle remains local and independent", () => {
    const option = blockBetween('ipcMain.handle("fetch-option-page"',
        'ipcMain.handle("fetch-daytrading-page"');
    const day = blockBetween('ipcMain.handle("fetch-daytrading-page"',
        'ipcMain.handle("download-daytrading-excel"');
    for (const block of [option, day]) {
        assert.match(block, /let fetchWindow = null/);
        assert.match(block, /fetchWindow = new BrowserWindow\(\{\s*show: false/s);
        assert.match(block, /fetchWindow\.destroy\(\)/);
        assert.doesNotMatch(block, /mainWindow|requestSingleInstanceLock|second-instance/);
    }
});

test("renderer package and Morning files receive no single-instance wiring", () => {
    const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
    for (const file of morningFiles) {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        assert.doesNotMatch(source, /requestSingleInstanceLock|second-instance|gotTheSingleInstanceLock/);
    }
    assert.doesNotMatch(packageJson, /requestSingleInstanceLock|single-instance|proper-lockfile/);
});
