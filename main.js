const auditCoordinator = require("./js/marketCalendarHistory/readOnlyAuditCoordinator.js");
const auditArguments = auditCoordinator.classifyArguments(process.argv);
auditCoordinator.configureDevelopmentProfile();
if (auditArguments === "invalid_audit_flag") {
  console.error("Invalid read-only audit invocation");
  require("electron").app.exit(2);
} else if (auditArguments === "audit") {
  auditCoordinator.runAudit().then(result => {
    console.log(`OPTIONMAP_AUDIT_RESULT ${JSON.stringify(result)}`);
    require("electron").app.exit(result.ok ? 0 : 2);
  }, error => {
    console.error(`OPTIONMAP_AUDIT_FATAL ${error?.stack || error}`);
    require("electron").app.exit(1);
  });
} else {
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const networkUrlPolicy = require("./js/security/networkUrlPolicy.js");
const calendarAcquisition = require(
  "./js/marketCalendarRuntime/calendarAcquisitionService.js"
);
const automaticShadowRuntime = require("./js/marketCalendarRuntime/automaticFormalShadowRuntime.js");
let calendarShadowRuntime = null;
const { createSaveService } = require("./js/fullExportFileSave.js");
const { createWeeklyListingAcquisitionDiagnostics } = require(
  "./js/security/weeklyListingAcquisitionDiagnostics.js"
);
require("dotenv").config();

const weeklyListingDiagnostics = createWeeklyListingAcquisitionDiagnostics();
const fullExportSaveService = createSaveService({ dialog, fs, path, randomUUID });
const calendarAcquisitionService = calendarAcquisition.createCalendarAcquisitionService({
  fetchImpl: (url, options) => net.fetch(url, options)
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  invalid_url: "取得先URLが不正です",
  invalid_protocol: "取得先URLが不正です",
  invalid_credentials: "取得先URLが不正です",
  invalid_host: "許可されていない取得先です",
  invalid_port: "取得先URLが不正です",
  invalid_query: "取得先URLが不正です",
  invalid_hash: "取得先URLが不正です",
  invalid_path: "許可されていない取得先です",
  invalid_date: "取得先URLの日付が不正です",
  invalid_redirect: "取得先の移動を許可できませんでした"
});

function securityError(errorCode) {
  const error = new Error(SAFE_ERROR_MESSAGES[errorCode] || "取得先を確認できませんでした");
  error.errorCode = errorCode || "invalid_url";
  return error;
}

function requireAllowedUrl(validator, value) {
  const validation = validator(value);
  if (!validation.ok) throw securityError(validation.errorCode);
  return validation.url;
}

function safeIpcFailure(error, fallbackMessage) {
  const errorCode = SAFE_ERROR_MESSAGES[error?.errorCode] ? error.errorCode : null;
  return {
    success: false,
    error: errorCode ? SAFE_ERROR_MESSAGES[errorCode] : fallbackMessage,
    ...(errorCode ? { errorCode } : {})
  };
}

function installHiddenWindowPolicy(fetchWindow) {
  let activeValidator = () => ({ ok: false });
  let redirectBlocked = false;
  const validateNavigation = (event, url) => {
    if (!activeValidator(url).ok) {
      redirectBlocked = true;
      event.preventDefault();
    }
  };
  fetchWindow.webContents.on("will-navigate", validateNavigation);
  fetchWindow.webContents.on("will-redirect", validateNavigation);
  fetchWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return {
    async load(url, validator, options) {
      activeValidator = validator;
      redirectBlocked = false;
      const requestedUrl = requireAllowedUrl(validator, url);
      try {
        await fetchWindow.loadURL(requestedUrl, options);
      } catch (error) {
        if (redirectBlocked) throw securityError("invalid_redirect");
        throw error;
      }
      const finalUrl = fetchWindow.webContents.getURL();
      const finalValidation = networkUrlPolicy.validateFinalUrl(
        validator, requestedUrl, finalUrl
      );
      if (redirectBlocked || !finalValidation.ok) {
        throw securityError("invalid_redirect");
      }
      return finalValidation.url;
    }
  };
}

let mainWindow = null;
const gotTheSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotTheSingleInstanceLock) {
  console.log("Second instance blocked; focusing existing window");
  app.quit();
} else {
console.log("OptionMap single-instance lock acquired");

app.on("second-instance", (_event, argv) => {
  if (auditCoordinator.classifyArguments(argv) !== "normal") {
    console.error("Read-only audit invocation rejected: existing process");
    return;
  }
  console.log("Second instance blocked; focusing existing window");
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

ipcMain.handle("fetch-jpx-open-interest-json", async (event, jsonUrl) => {
  weeklyListingDiagnostics.begin(jsonUrl);
  try {
    const requestedValidation = networkUrlPolicy.validateOpenInterestJsonUrl(jsonUrl);
    weeklyListingDiagnostics.requestedValidated(requestedValidation);
    if (!requestedValidation.ok) throw securityError(requestedValidation.errorCode);
    const requestedUrl = requestedValidation.url;
    weeklyListingDiagnostics.networkStarted();
    let response;
    try {
      response = await net.fetch(requestedUrl, {
        cache: "no-store",
        redirect: "error"
      });
    } catch (_error) {
      weeklyListingDiagnostics.fail(
        "network_started",
        "network_or_redirect_rejected",
        "fetch_rejected",
        { redirectPolicy: "error" }
      );
      throw new Error("weekly_listing_network_failed");
    }
    weeklyListingDiagnostics.responseReceived(response.status);
    weeklyListingDiagnostics.redirectProtected(requestedUrl);

    weeklyListingDiagnostics.httpChecked(response.status);
    if (!response.ok) {
      weeklyListingDiagnostics.fail("http_status_checked", "http_error", null,
        { httpStatus: response.status });
      throw new Error("weekly_listing_http_error");
    }

    let body;
    try {
      body = await response.text();
      weeklyListingDiagnostics.bodyRead();
    } catch (_error) {
      weeklyListingDiagnostics.fail("body_read", "body_read_failed");
      throw new Error("weekly_listing_body_read_failed");
    }
    let data;
    try {
      data = JSON.parse(body);
      weeklyListingDiagnostics.jsonParsed();
    } catch (_error) {
      weeklyListingDiagnostics.fail("json_parsed", "json_parse_failed");
      throw new Error("weekly_listing_json_parse_failed");
    }
    weeklyListingDiagnostics.accepted();
    return {
      success: true,
      data
    };
  } catch (error) {
    return safeIpcFailure(error, "JPX週次JSONを取得できませんでした");
  }
});

ipcMain.handle("get-weekly-listing-acquisition-diagnostics", () =>
  weeklyListingDiagnostics.getState()
);

ipcMain.handle("request-market-calendar-source", async (event, request) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) {
    return { success: false, reason: "invalid_sender", retryable: false,
      documents: [], diagnostics: [] };
  }
  if (["jp-stat-labor", "jp-stat-cpi", "us-bls-calendar"].includes(request?.sourceId))
    return { success: false, reason: "controlled_activation_required", retryable: false, documents: [], diagnostics: [] };
  try {
    const result = await calendarAcquisitionService.acquire(request);
    return calendarAcquisition.sanitizeForIpc(result);
  } catch (_error) {
    return { success: false, reason: "acquisition_failed", retryable: false,
      documents: [], diagnostics: [] };
  }
});

ipcMain.handle("check-market-calendar-sources", async (event, request) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) return { state: "unavailable", mode: "writer_disabled",
    reasonClass: "invalid_sender", sources: [], failedSourceIds: [] };
  try {
    if (!calendarShadowRuntime) calendarShadowRuntime = automaticShadowRuntime.createRuntime({
      webContents: event.sender, fetchImpl: (url, options) => net.fetch(url, options),
      acquire: request => calendarAcquisitionService.acquire(request)
    });
    return await calendarShadowRuntime.check(request);
  }
  catch (_error) { return { state: "failed", mode: "writer_disabled",
    reasonClass: "manual_check_failed", sources: [], failedSourceIds: [] }; }
});

ipcMain.handle("save-full-export-json", (event, request) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) {
    return { success: false, cancelled: false, reason: "invalid_export_window" };
  }
  return fullExportSaveService.save(owner, request);
});

ipcMain.handle("fetch-jpx-participant-json", async (event, jsonUrl) => {
  try {
    const requestedUrl = requireAllowedUrl(
      networkUrlPolicy.validateParticipantJsonUrl, jsonUrl
    );
    const response = await net.fetch(requestedUrl, { cache: "no-store" });
    const finalUrl = networkUrlPolicy.validateFinalUrl(
      networkUrlPolicy.validateParticipantJsonUrl, requestedUrl, response.url
    );
    if (!finalUrl.ok) throw securityError("invalid_redirect");
    if (!response.ok) {
      throw new Error(
        `JPX参加者別JSONの取得に失敗しました（HTTP ${response.status}）`
      );
    }
    return { success: true, data: await response.json() };
  } catch (error) {
    return safeIpcFailure(error, "JPX参加者別JSONを取得できませんでした");
  }
});


ipcMain.handle("fetch-option-page", async (event, pageUrl) => {
    let fetchWindow = null;
  
    try {
        console.log("オプションページ取得開始");
        const requestedUrl = requireAllowedUrl(
            networkUrlPolicy.validateQriUrl, pageUrl
        );
  
        fetchWindow = new BrowserWindow({
            show: false,
  
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
  
                // Cookieやセッションを次回も保持
                partition: "persist:qri-option-session"
            }
        });
  
        const userAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
            "Version/18.0 Safari/605.1.15";
  
        fetchWindow.webContents.setUserAgent(userAgent);
        const navigation = installHiddenWindowPolicy(fetchWindow);
  
        // ① まずJPXトップページを開く
  await navigation.load(
    "https://www.jpx.co.jp/",
    networkUrlPolicy.validateJpxInternalUrl,
    {
        userAgent
    }
  );
  
  // 少し待つ
  await new Promise(resolve =>
    setTimeout(resolve, 2000)
  );
  
  
  
  // ② JPXの案内ページを開く
  const jpxQuotesUrl =
      "https://www.jpx.co.jp/markets/derivatives/quotes/index.html";
  
  await navigation.load(
      jpxQuotesUrl,
      networkUrlPolicy.validateJpxInternalUrl,
      {
          userAgent
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 2000)
  );
  
  // ③ JPXの案内ページを参照元としてQRIを開く
  await navigation.load(
      requestedUrl,
      networkUrlPolicy.validateQriUrl,
      {
          userAgent,
          httpReferrer: jpxQuotesUrl
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 4000)
  );
  
  console.log(
      "現在のURL:",
      fetchWindow.webContents.getURL()
  );
  // 表示待ち
  await new Promise(resolve =>
    setTimeout(resolve, 3000)
  );
  
        // ページ内のJavaScriptや表の描画を少し待つ
        await new Promise(resolve => {
            setTimeout(resolve, 3000);
        });
  
        const finalValidation = networkUrlPolicy.validateFinalUrl(
            networkUrlPolicy.validateQriUrl,
            requestedUrl,
            fetchWindow.webContents.getURL()
        );
        if (!finalValidation.ok) throw securityError("invalid_redirect");

        const pageInfo =
            await fetchWindow.webContents.executeJavaScript(`
                (() => {
                    return {
                        title: document.title,
                        text: document.body?.innerText || "",
                        html: document.documentElement.outerHTML
                    };
                })()
            `);
  
        const blocked =
            pageInfo.text.includes("403 ERROR") ||
            pageInfo.text.includes("Request blocked") ||
            pageInfo.text.includes(
                "The request could not be satisfied"
            );
  
        if (blocked) {
            throw new Error(
                "QRI側のCloudFrontにアクセスを拒否されました"
            );
        }
  
        console.log(
          "取得ページ本文の先頭:",
          pageInfo.text.slice(0, 500)
      );
  
        console.log(
            "オプションページ取得成功:",
            pageInfo.html.length,
            "文字"
        );
  
        return {
            success: true,
            html: pageInfo.html,
            sourceUrl: finalValidation.url
        };
    } catch (error) {
        console.error(
            "オプションページ取得エラー:",
            error
        );
  
        return safeIpcFailure(error, "オプションページを取得できませんでした");
    } finally {
        if (
            fetchWindow &&
            !fetchWindow.isDestroyed()
        ) {
            fetchWindow.destroy();
        }
    }
  });
  ipcMain.handle("fetch-daytrading-page", async (event, pageUrl) => {
    let fetchWindow = null;
  
    try {
        console.log("日中データページ取得開始");
        const requestedUrl = requireAllowedUrl(
            networkUrlPolicy.validateJpxPageUrl, pageUrl
        );
  
        fetchWindow = new BrowserWindow({
            show: false,
  
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
  
                // Cookieやセッションを次回も保持
                partition: "persist:qri-option-session"
            }
        });
  
        const userAgent =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
            "Version/18.0 Safari/605.1.15";
  
        fetchWindow.webContents.setUserAgent(userAgent);
        const navigation = installHiddenWindowPolicy(fetchWindow);
  
        // ① まずJPXトップページを開く
  await navigation.load(
    "https://www.jpx.co.jp/",
    networkUrlPolicy.validateJpxInternalUrl,
    {
        userAgent
    }
  );
  
  // 少し待つ
  await new Promise(resolve =>
    setTimeout(resolve, 2000)
  );
  
  
  
  // ② JPXの案内ページを開く
  const jpxParticipantVolumeUrl =
  "https://www.jpx.co.jp/markets/derivatives/participant-volume/index.html";
  
  await navigation.load(
    jpxParticipantVolumeUrl,
    networkUrlPolicy.validateJpxInternalUrl,
      {
          userAgent
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 2000)
  );
  
  // ③ JPXの案内ページを参照元としてQRIを開く
  await navigation.load(
      requestedUrl,
      networkUrlPolicy.validateJpxPageUrl,
      {
          userAgent,
          httpReferrer: jpxParticipantVolumeUrl
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 4000)
  );
  
  console.log(
      "現在のURL:",
      fetchWindow.webContents.getURL()
  );
  // 表示待ち
  await new Promise(resolve =>
    setTimeout(resolve, 3000)
  );
  
        // ページ内のJavaScriptや表の描画を少し待つ
        await new Promise(resolve => {
            setTimeout(resolve, 3000);
        });
  
        const finalValidation = networkUrlPolicy.validateFinalUrl(
            networkUrlPolicy.validateJpxPageUrl,
            requestedUrl,
            fetchWindow.webContents.getURL()
        );
        if (!finalValidation.ok) throw securityError("invalid_redirect");

        const pageInfo =
            await fetchWindow.webContents.executeJavaScript(`
                (() => {
                    return {
                        title: document.title,
                        text: document.body?.innerText || "",
                        html: document.documentElement.outerHTML
                    };
                })()
            `);
  
        const blocked =
            pageInfo.text.includes("403 ERROR") ||
            pageInfo.text.includes("Request blocked") ||
            pageInfo.text.includes(
                "The request could not be satisfied"
            );
  
        if (blocked) {
            throw new Error(
                "QRI側のCloudFrontにアクセスを拒否されました"
            );
        }
  
        console.log(
          "取得ページ本文の先頭:",
          pageInfo.text.slice(0, 500)
      );
  
        console.log(
            "日中データページ取得成功:",
            pageInfo.html.length,
            "文字"
        );
  
        return {
            success: true,
            html: pageInfo.html
        };
    } catch (error) {
        console.error(
            "日中データページ取得エラー:",
            error
        );
  
        return safeIpcFailure(error, "日中データページを取得できませんでした");
    } finally {
        if (
            fetchWindow &&
            !fetchWindow.isDestroyed()
        ) {
            fetchWindow.destroy();
        }
    }
  });
    
  ipcMain.handle("download-daytrading-excel", async (event, excelUrl) => {
    try {
        console.log("日中Excelダウンロード開始");
        const requestedUrl = requireAllowedUrl(
            networkUrlPolicy.validateExcelUrl, excelUrl
        );
        const response = await fetch(requestedUrl);
        const finalUrl = networkUrlPolicy.validateFinalUrl(
            networkUrlPolicy.validateExcelUrl,
            requestedUrl,
            response.url
        );
        if (!finalUrl.ok) throw securityError("invalid_redirect");

        if (!response.ok) {
            throw new Error(
                `Excel取得失敗: ${response.status} ${response.statusText}`
            );
        }

        const arrayBuffer = await response.arrayBuffer();

        return {
            success: true,
            data: Array.from(new Uint8Array(arrayBuffer))
        };
    } catch (error) {
        console.error("日中Excelダウンロードエラー:", error);

        return safeIpcFailure(error, "Excelを取得できませんでした");
    }
});


console.log(
  "OpenAI APIキーを読み込めた？",
  Boolean(process.env.OPENAI_API_KEY)
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "OptionMap",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    calendarShadowRuntime = null;
  });
  const mainDocumentUrl = pathToFileURL(
    path.join(__dirname, "index.html")
  ).href;
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== mainDocumentUrl) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
}
}
