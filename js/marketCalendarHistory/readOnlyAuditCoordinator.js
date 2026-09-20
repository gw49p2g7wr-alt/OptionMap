"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, session, ipcMain } = require("electron");

const AUDIT_FLAG = "--optionmap-calendar-readonly-audit";
const REPORT_CHANNEL = "optionmap:calendar-readonly-audit-report";
let active = false;

function classifyArguments(argv) {
    const auditLike = argv.filter(value => typeof value === "string" &&
        value.startsWith(AUDIT_FLAG));
    if (!auditLike.length) return "normal";
    return auditLike.length === 1 && auditLike[0] === AUDIT_FLAG ? "audit" : "invalid_audit_flag";
}
function configureDevelopmentProfile(env = process.env) {
    const profile = env.OPTIONMAP_AUDIT_TEST_PROFILE;
    if (!profile) return null;
    const resolved = fs.realpathSync(profile), temporaryRoot = fs.realpathSync(os.tmpdir());
    if (app.isPackaged || path.dirname(resolved) !== temporaryRoot ||
        !path.basename(resolved).startsWith("optionmap-audit-dev-"))
        throw new Error("isolated_profile_invalid");
    app.setPath("userData", resolved);
    return resolved;
}
function createReportGate(expectedSenderId, expectedNonce) {
    let consumed = false;
    return Object.freeze({ receive(senderId, message) {
        if (consumed) return { accepted: false, reason: "duplicate_report" };
        if (senderId !== expectedSenderId) return { accepted: false, reason: "sender_mismatch" };
        if (!message || message.nonce !== expectedNonce) return { accepted: false,
            reason: "nonce_mismatch" };
        consumed = true;
        return { accepted: true, result: message.result };
    }, get consumed() { return consumed; } });
}
async function runAudit({ env = process.env, timeoutMs = 15000 } = {}) {
    if (active) return { ok: false, outcome: "duplicate_probe_invocation" };
    if (!app.requestSingleInstanceLock()) return { ok: false, outcome: "existing_process_rejected" };
    active = true;
    try { await app.whenReady();
        if (!app.isPackaged && env.OPTIONMAP_AUDIT_TEST_PROFILE &&
            env.OPTIONMAP_AUDIT_TEST_HOLD_MS) await new Promise(resolve => setTimeout(resolve,
                Math.min(5000, Math.max(0, Number(env.OPTIONMAP_AUDIT_TEST_HOLD_MS) || 0))));
        const mode = env.OPTIONMAP_AUDIT_CATALOG_ONLY === "1" ? "catalog" : "preflight",
            nonce = randomUUID(), file = path.join(app.getAppPath(), "scripts",
                "marketCalendarReadOnlyProbe.html"), expectedUrl = pathToFileURL(file).href;
        return await new Promise(resolve => {
            let window = null, finished = false, timer = null, gate = null;
            const complete = (outcome, result = null) => {
                if (finished) return; finished = true;
                if (timer) clearTimeout(timer);
                ipcMain.removeListener(REPORT_CHANNEL, onReport);
                if (window && !window.isDestroyed()) window.destroy();
                resolve({ ok: outcome === "read_only_audit_complete", outcome,
                    result });
            };
            const onReport = (event, message) => {
                if (!gate) return complete("report_before_window_ready");
                const checked = gate.receive(event.sender.id, message);
                if (!checked.accepted) {
                    if (checked.reason !== "sender_mismatch") complete(checked.reason);
                    return;
                }
                if (event.sender.session !== session.defaultSession ||
                    event.sender.getURL().split("?")[0] !== expectedUrl)
                    return complete("report_origin_session_mismatch");
                const value = checked.result, resources = value?.resources;
                if (!value || resources?.openConnections !== 0 ||
                    resources?.activeTransactions !== 0 ||
                    resources?.catalogSeen !== true ||
                    (mode === "catalog" && resources?.openAttempts !== 0))
                    return complete("probe_resource_gate_failed", value);
                if (value.stages?.at(-1)?.stage !== "probe_finished" ||
                    !value.stages?.some(stage => stage.stage === "origin_session_confirmed" &&
                        stage.origin === "file://" && stage.session === "default") ||
                    (mode === "catalog" && value.outcome !== "catalog_only_complete"))
                    return complete("probe_report_gate_failed", value);
                if (value.ok !== true) return complete("probe_rejected", value);
                complete("read_only_audit_complete", value);
            };
            try {
                window = new BrowserWindow({ show: false, skipTaskbar: true, focusable: false,
                    webPreferences: { session: session.defaultSession, nodeIntegration: false,
                        contextIsolation: true, sandbox: true, webSecurity: true,
                        webviewTag: false, preload: path.join(app.getAppPath(), "scripts",
                            "marketCalendarReadOnlyAuditReportPreload.js") } });
                if (window.webContents.session !== session.defaultSession)
                    return complete("default_session_mismatch");
                const contents = window.webContents;
                gate = createReportGate(contents.id, nonce);
                contents.on("will-navigate", event => { event.preventDefault();
                    complete("navigation_rejected"); });
                contents.on("will-redirect", event => { event.preventDefault();
                    complete("redirect_rejected"); });
                contents.on("will-attach-webview", event => { event.preventDefault();
                    complete("webview_rejected"); });
                contents.setWindowOpenHandler(() => ({ action: "deny" }));
                contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
                    if (isMainFrame) complete(`load_failed:${code}:${description}`); });
                contents.on("render-process-gone", (_event, details) => complete(
                    `renderer_gone:${details.reason}`));
                contents.on("destroyed", () => complete("renderer_disconnected"));
                contents.on("unresponsive", () => complete("renderer_unresponsive"));
                ipcMain.on(REPORT_CHANNEL, onReport);
                timer = setTimeout(() => complete("audit_timeout"), timeoutMs);
                window.loadFile(file, { query: { audit: "1", mode, nonce, sourceId:
                    "us-bea-calendar", session: "default", testTransactionFailure:
                    !app.isPackaged && env.OPTIONMAP_AUDIT_TEST_PROFILE &&
                    env.OPTIONMAP_AUDIT_TEST_TRANSACTION_FAILURE === "1" ? "1" : "0",
                    testOpenFailure: !app.isPackaged && env.OPTIONMAP_AUDIT_TEST_PROFILE &&
                    env.OPTIONMAP_AUDIT_TEST_OPEN_FAILURE === "1" ? "1" : "0" } }).then(() => {
                    if (!finished && contents.getURL().split("?")[0] !== expectedUrl)
                        complete("file_origin_mismatch");
                    if (!finished && !app.isPackaged && env.OPTIONMAP_AUDIT_TEST_CRASH === "1")
                        contents.forcefullyCrashRenderer();
                    if (!finished && !app.isPackaged && env.OPTIONMAP_AUDIT_TEST_PROFILE &&
                        env.OPTIONMAP_AUDIT_TEST_DISCONNECT === "1") contents.destroy();
                }, error => complete(`load_failed:${error?.message || error}`));
            } catch (error) { complete(`audit_setup_failed:${error?.message || error}`); }
        });
    } finally { active = false; }
}
module.exports = Object.freeze({ AUDIT_FLAG, REPORT_CHANNEL, classifyArguments,
    configureDevelopmentProfile, createReportGate, runAudit });
