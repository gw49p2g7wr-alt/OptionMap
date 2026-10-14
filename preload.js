"use strict";

const { contextBridge, ipcRenderer } = require("electron");
// Private preload state: not exposed through the immutable narrow API.
let pendingStartupReceipt=null;
const startupTicket=typeof window!=="undefined"&&typeof window.addEventListener==="function"
  ? ipcRenderer.invoke("optionmap:mof-startup:claim").catch(()=>null) : Promise.resolve(null);
if(typeof window!=="undefined"&&typeof window.addEventListener==="function"){
  window.addEventListener("optionmap:calendar-persisted",()=>{
    const receipt=pendingStartupReceipt;pendingStartupReceipt=null;
    if(receipt)ipcRenderer.invoke("optionmap:mof-startup:persisted",receipt).catch(()=>{});
  });
}

const INVALID_ARGUMENT_RESPONSE = Object.freeze({
  success: false,
  error: "リクエスト引数が不正です",
  errorCode: "invalid_argument"
});
const validCalendarDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

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

function invokeMorningV5Read(args) {
  const request = args[0];
  const current = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).length === 1 && request.scope === "current";
  const day = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).sort().join("|") === "calendarDate|scope" &&
    request.scope === "calendar_day" && validCalendarDay(request.calendarDate);
  if (!current && !day) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("read-formal-morning-v5", current ?
    Object.freeze({ scope: "current" }) : Object.freeze({
      scope: "calendar_day", calendarDate: request.calendarDate }));
}

function invokeMorningV5Evaluation(args) {
  if (args.length !== 0) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("evaluate-formal-morning-v5");
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

async function invokeCalendarCheck(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some(key => !["sourceIds", "trigger", "runtimeStates", "sessionStates"].includes(key)) ||
      (request.trigger !== undefined && !["manual", "startup"].includes(request.trigger)) ||
      [request.runtimeStates, request.sessionStates].some(value => value !== undefined &&
        (!value || typeof value !== "object" || Array.isArray(value))) ||
      (request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) ||
        request.sourceIds.length === 0 || request.sourceIds.length > 13 ||
        request.sourceIds.some(sourceId => typeof sourceId !== "string" ||
          !/^[a-z][a-z0-9-]{2,80}$/.test(sourceId))))) {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  const ticket=request.trigger==="startup"?await startupTicket:null;
  const response=await ipcRenderer.invoke("check-market-calendar-sources", Object.freeze({
    ...(request.sourceIds ? { sourceIds: Object.freeze([...new Set(request.sourceIds)]) } : {}),
    ...(request.trigger ? { trigger: request.trigger } : {}),
    ...(request.runtimeStates ? { runtimeStates: request.runtimeStates } : {}),
    ...(request.sessionStates ? { sessionStates: request.sessionStates } : {}),
    ...(ticket?{__mofStartupTicket:ticket}:{})
  }));
  if(ticket&&response&&Object.hasOwn(response,"__mofStartupResult")){
    pendingStartupReceipt=response.__mofStartupReceipt;return response.__mofStartupResult;
  }
  return response;
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
  evaluateMorningV5Formal: (...args) => invokeMorningV5Evaluation(args),
  readMorningV5Formal: (...args) => invokeMorningV5Read(args),
  saveFullExportJson: (...args) => invokeFullExportSave(args)
}));
