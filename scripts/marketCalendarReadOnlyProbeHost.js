"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const isolatedProfile = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-readonly-probe-"));
app.setPath("userData", isolatedProfile);
let complete = false;
app.whenReady().then(() => {
    const launchProbe = () => {
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false,
        contextIsolation: true, sandbox: true, session: require("electron").session.defaultSession } });
    if (window.webContents.session !== require("electron").session.defaultSession)
        throw new Error("isolated_session_mismatch");
    const fail = reason => { if (complete) return; complete = true; console.error(`PROBE_FAILED ${reason}`);
        app.exit(1); };
    const timeout = setTimeout(() => fail("timeout"), 15000);
    window.webContents.on("render-process-gone", (_event, details) => fail(
        `renderer_gone:${details.reason}`));
    window.webContents.on("destroyed", () => fail("renderer_destroyed"));
    if (process.argv.includes("--simulate-disconnect")) window.webContents.once("did-start-loading",
        () => window.destroy());
    window.webContents.on("console-message", (_event, _level, message) => {
        if (message.startsWith("OPTIONMAP_PROBE_STAGE ")) console.log(message);
        if (message.startsWith("OPTIONMAP_PROBE_FATAL ")) fail(message);
        if (!message.startsWith("OPTIONMAP_PROBE_RESULT ")) return;
        complete = true; clearTimeout(timeout); console.log(message);
        try { const result = JSON.parse(message.slice("OPTIONMAP_PROBE_RESULT ".length));
            app.exit(result.ok ? 0 : 2); }
        catch (_error) { app.exit(1); }
    });
    window.loadFile(path.join(__dirname, "marketCalendarReadOnlyProbe.html"), { query: {
        isolated: "1", sourceId: "us-bea-calendar", session: `isolated:${isolatedProfile}` } });
    };
    if (!process.argv.includes("--fixture")) { launchProbe(); return; }
    const fixture = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false,
        contextIsolation: true, sandbox: true } });
    const timeout = setTimeout(() => { console.error("FIXTURE_FAILED timeout"); app.exit(1); }, 15000);
    fixture.webContents.on("render-process-gone", (_event, details) => {
        console.error(`FIXTURE_FAILED renderer_gone:${details.reason}`); app.exit(1); });
    fixture.webContents.on("console-message", (_event, _level, message) => {
        if (message.startsWith("OPTIONMAP_FIXTURE_ERROR")) { console.error(message); app.exit(1); }
        if (message !== "OPTIONMAP_FIXTURE_READY") return;
        clearTimeout(timeout); fixture.close(); launchProbe();
    });
    fixture.loadFile(path.join(__dirname, "marketCalendarReadOnlyProbeFixture.html"));
});
