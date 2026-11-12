"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const participantFormalBridge = require("./js/participantFormalBridgeContract.js");
const participantFormalWriterApi = require("./js/participantFormalProductionWriter.js");
const participantFormalSchema = require("./js/formalArchive/participantFormalArchiveSchema.js");
// Private preload state: not exposed through the immutable narrow API.
let pendingStartupReceipt=null;
let participantFormalWriter=null;
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

function participantWriter() {
  if (!participantFormalWriter) participantFormalWriter =
    participantFormalWriterApi.createParticipantFormalProductionWriter({ indexedDB: window.indexedDB,
      IDBKeyRange: window.IDBKeyRange, databaseName: participantFormalSchema.DATABASE_NAME });
  return participantFormalWriter;
}

ipcRenderer.on(participantFormalBridge.COMMAND_CHANNEL, async (_event, command) => {
  if (!command || typeof command !== "object" || Array.isArray(command) ||
      Object.keys(command).sort().join("|") !== "commandId|payload" ||
      typeof command.commandId !== "string") return;
  let result;
  try { result = await participantWriter().commit(command.payload); }
  catch (_error) { result = { status: "rejected", reason: "archive_write_failed",
    classification: null, revisionWriteCount: 0, transactionCount: 0, revision: null }; }
  ipcRenderer.send(participantFormalBridge.RESULT_CHANNEL, { commandId: command.commandId, result });
});

function invokeParticipantAcquisition(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" || Array.isArray(request))
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  const keys = Object.keys(request).sort().join("|");
  const latest = keys === "requestKind" && request.requestKind === "latest_available";
  const explicit = keys === "requestKind|targetDate" &&
    request.requestKind === "explicit_source_date" && validCalendarDay(request.targetDate);
  const range = keys === "endDate|requestKind|startDate" &&
    request.requestKind === "historical_backfill_range" &&
    validCalendarDay(request.startDate) && validCalendarDay(request.endDate) &&
    request.startDate <= request.endDate &&
    (Date.parse(`${request.endDate}T00:00:00.000Z`) -
      Date.parse(`${request.startDate}T00:00:00.000Z`)) / 86_400_000 <= 366;
  if (!latest && !explicit && !range) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("acquire-participants", Object.freeze({ ...request }));
}

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

function invokeQriAcquisition(args) {
  const request = args[0];
  const active = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).length === 1 &&
    request.requestKind === "active";
  const reference = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).sort().join("|") ===
      "listedContractId|parentAcquisitionId|requestKind|role" &&
    request.requestKind === "listed_reference" && ["next", "major_sq"].includes(request.role) &&
    /^qri-acquisition-v1\|sha256:[0-9a-f]{64}$/.test(request.parentAcquisitionId || "") &&
    /^qri-listed-contract-v1\|sha256:[0-9a-f]{64}$/.test(request.listedContractId || "");
  if (!active && !reference) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("acquire-qri-page", Object.freeze({ ...request }));
}

function invokeQriFinalization(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join("|") !== "acquisitionId|cache|canonical|ivCanonical" ||
      !/^qri-acquisition-v1\|sha256:[0-9a-f]{64}$/.test(request.acquisitionId || "") ||
      !request.canonical || typeof request.canonical !== "object" ||
      Array.isArray(request.canonical) ||
      (request.cache !== null && (!request.cache || typeof request.cache !== "object" ||
        Array.isArray(request.cache))) ||
      (request.ivCanonical !== null && (!request.ivCanonical ||
        typeof request.ivCanonical !== "object" || Array.isArray(request.ivCanonical)))) {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("finalize-qri-page", request);
}

function invokeFullExportSave(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" ||
      typeof request.fileName !== "string" || typeof request.json !== "string") {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("save-full-export-json", request);
}

function invokeCalendarExportSave(args) {
  const request = args[0];
  if (args.length !== 1 || !request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join("|") !== "fileName|json" ||
      typeof request.fileName !== "string" || typeof request.json !== "string") {
    return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  }
  return ipcRenderer.invoke("save-calendar-export-json", request);
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

function invokeOverallTraceRead(args) {
  const request = args[0];
  const current = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).length === 1 && request.scope === "current";
  const day = args.length === 1 && request && typeof request === "object" &&
    !Array.isArray(request) && Object.keys(request).sort().join("|") === "calendarDate|scope" &&
    request.scope === "calendar_day" && validCalendarDay(request.calendarDate);
  if (!current && !day) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("read-formal-overall-trace", current ?
    Object.freeze({ scope: "current" }) : Object.freeze({
      scope: "calendar_day", calendarDate: request.calendarDate }));
}

function invokeMorningV5Evaluation(args) {
  if (args.length !== 0) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("evaluate-formal-morning-v5");
}

function invokeOverallTraceEvaluation(args) {
  if (args.length !== 0) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("evaluate-formal-overall-trace");
}

function invokeRuntimeMetadata(args) {
  if (args.length !== 0) return Promise.resolve(INVALID_ARGUMENT_RESPONSE);
  return ipcRenderer.invoke("get-runtime-metadata");
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
  acquireQriPage: (...args) => invokeQriAcquisition(args),
  acquireParticipants: (...args) => invokeParticipantAcquisition(args),
  finalizeQriPage: (...args) => invokeQriFinalization(args),
  fetchJpxPage: (...args) => invokeUrlChannel("fetch-daytrading-page", args),
  fetchOpenInterestListing: (...args) =>
    invokeUrlChannel("fetch-jpx-open-interest-json", args),
  downloadJpxExcel: (...args) =>
    invokeUrlChannel("download-daytrading-excel", args),
  getRuntimeMetadata: (...args) => invokeRuntimeMetadata(args),
  checkCalendarSources: (...args) => invokeCalendarCheck(args),
  requestCalendarSource: (...args) => invokeCalendarSource(args),
  evaluateMorningV5Formal: (...args) => invokeMorningV5Evaluation(args),
  evaluateOverallV2Trace: (...args) => invokeOverallTraceEvaluation(args),
  readOverallV2Trace: (...args) => invokeOverallTraceRead(args),
  readMorningV5Formal: (...args) => invokeMorningV5Read(args),
  saveCalendarExportJson: (...args) => invokeCalendarExportSave(args),
  saveFullExportJson: (...args) => invokeFullExportSave(args)
}));
