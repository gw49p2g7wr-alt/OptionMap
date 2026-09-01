"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const INVALID_ARGUMENT_RESPONSE = Object.freeze({
  success: false,
  error: "リクエスト引数が不正です",
  errorCode: "invalid_argument"
});

function invokeUrlChannel(channel, args) {
  const url = args[0];
  if (
    args.length !== 1 ||
    typeof url !== "string" ||
    url.trim() === "" ||
    url.length > 4096
  ) {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke(channel, url);
}

contextBridge.exposeInMainWorld("optionMapBridge", Object.freeze({
  fetchQriOptionPage: (...args) => invokeUrlChannel("fetch-option-page", args),
  fetchJpxPage: (...args) => invokeUrlChannel("fetch-daytrading-page", args),
  fetchOpenInterestListing: (...args) =>
    invokeUrlChannel("fetch-jpx-open-interest-json", args),
  fetchParticipantListing: (...args) =>
    invokeUrlChannel("fetch-jpx-participant-json", args),
  downloadJpxExcel: (...args) =>
    invokeUrlChannel("download-daytrading-excel", args)
}));
