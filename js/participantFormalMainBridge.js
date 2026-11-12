"use strict";

const crypto = require("node:crypto");

const COMMAND_CHANNEL = "optionmap:participants-formal:commit";
const RESULT_CHANNEL = "optionmap:participants-formal:result";
const DEFAULT_TIMEOUT_MS = 15_000;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));

function createParticipantFormalMainBridge(options = {}) {
  if (!exact(options, ["ipcMain", "getWebContents", "timeoutMs"]) ||
      typeof options.ipcMain?.on !== "function" ||
      typeof options.ipcMain?.removeListener !== "function" ||
      typeof options.getWebContents !== "function" || !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 || options.timeoutMs > DEFAULT_TIMEOUT_MS)
    throw new TypeError("participants_formal_bridge_options_invalid");
  const pending = new Map();

  function onResult(event, message) {
    if (!exact(message, ["commandId", "result"]) ||
        typeof message.commandId !== "string") return;
    const item = pending.get(message.commandId), target = options.getWebContents();
    if (!item || event.sender !== target) return;
    pending.delete(message.commandId); clearTimeout(item.timer); item.resolve(message.result);
  }
  options.ipcMain.on(RESULT_CHANNEL, onResult);

  function commit(payload) {
    const target = options.getWebContents();
    if (!target || target.isDestroyed?.()) return Promise.reject(
      new Error("participants_formal_renderer_unavailable"));
    const commandId = `participants-formal-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(commandId); reject(new Error("participants_formal_commit_timeout"));
      }, options.timeoutMs);
      pending.set(commandId, { resolve, reject, timer });
      try { target.send(COMMAND_CHANNEL, { commandId, payload }); }
      catch (error) { clearTimeout(timer); pending.delete(commandId); reject(error); }
    });
  }

  function close() {
    options.ipcMain.removeListener(RESULT_CHANNEL, onResult);
    for (const item of pending.values()) {
      clearTimeout(item.timer); item.reject(new Error("participants_formal_bridge_closed"));
    }
    pending.clear();
  }
  return Object.freeze({ commit, close });
}

module.exports = Object.freeze({ COMMAND_CHANNEL, RESULT_CHANNEL, DEFAULT_TIMEOUT_MS,
  createParticipantFormalMainBridge });
