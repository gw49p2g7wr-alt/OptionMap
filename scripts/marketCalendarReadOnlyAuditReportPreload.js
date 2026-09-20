"use strict";
const { contextBridge, ipcRenderer } = require("electron");
let sent = false;
contextBridge.exposeInMainWorld("optionMapReadOnlyAuditReport", Object.freeze({
    send(nonce, result) { if (sent) return false; sent = true;
        ipcRenderer.send("optionmap:calendar-readonly-audit-report", { nonce, result });
        return true; }
}));
