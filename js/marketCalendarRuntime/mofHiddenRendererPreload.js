"use strict";

// Dedicated sandboxed preload ONLY. No public UI/main-world API, source, plan,
// token, channel or DB-operation argument. Same-origin page code cannot see this
// private isolated-world interface. Main still validates every sender and packet.
const { contextBridge, ipcRenderer } = require("electron");
const WORLD = 1754;
const invoke = (channel, packet) => ipcRenderer.invoke(channel, packet);
contextBridge.exposeInIsolatedWorld(WORLD, "__mofPrivateGrant", Object.freeze({
  challenge: packet => invoke("optionmap:mof-controlled:challenge", packet),
  consume: packet => invoke("optionmap:mof-controlled:consume", packet),
  submitReceipt: packet => invoke("optionmap:mof-controlled:receipt", packet)
}));
