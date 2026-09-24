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

function invokeFullExportSave(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" ||
      typeof request.fileName !== "string" || typeof request.json !== "string") {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("save-full-export-json", request);
}

function invokeCalendarSource(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" ||
      Array.isArray(request) || Object.keys(request).sort().join("|") !==
        "operation|sourceId" ||
      typeof request.sourceId !== "string" ||
      !/^[a-z][a-z0-9-]{2,80}$/.test(request.sourceId) ||
      request.operation !== "source-document-set") {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("request-market-calendar-source", Object.freeze({
    sourceId: request.sourceId,
    operation: request.operation
  }));
}

function invokeCalendarCheck(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some(key => key !== "sourceIds") ||
      (request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) ||
        request.sourceIds.length === 0 || request.sourceIds.length > 12 ||
        request.sourceIds.some(sourceId => typeof sourceId !== "string" ||
          !/^[a-z][a-z0-9-]{2,80}$/.test(sourceId))))) {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("check-market-calendar-sources", Object.freeze({
    ...(request.sourceIds ? { sourceIds: Object.freeze([...new Set(request.sourceIds)]) } : {})
  }));
}

contextBridge.exposeInMainWorld("optionMapBridge", Object.freeze({
  fetchQriOptionPage: (...args) => invokeUrlChannel("fetch-option-page", args),
  fetchJpxPage: (...args) => invokeUrlChannel("fetch-daytrading-page", args),
  fetchOpenInterestListing: (...args) =>
    invokeUrlChannel("fetch-jpx-open-interest-json", args),
  fetchParticipantListing: (...args) =>
    invokeUrlChannel("fetch-jpx-participant-json", args),
  downloadJpxExcel: (...args) =>
    invokeUrlChannel("download-daytrading-excel", args),
  checkCalendarSources: (...args) => invokeCalendarCheck(args),
  requestCalendarSource: (...args) => invokeCalendarSource(args),
  saveFullExportJson: (...args) => invokeFullExportSave(args)
}));
