const {
  app,
  BrowserWindow,
  ipcMain,
} = require("electron");
require("dotenv").config();


ipcMain.handle("fetch-option-page", async (event, pageUrl) => {
    let fetchWindow = null;
  
    try {
        console.log("オプションページ取得開始:", pageUrl);
  
        // 念のため、取得先をQRIだけに限定
        const parsedUrl = new URL(pageUrl);
  
        if (parsedUrl.hostname !== "svc.qri.jp") {
            throw new Error("許可されていない取得先です");
        }
  
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
  
        // ① まずJPXトップページを開く
  await fetchWindow.loadURL(
    "https://www.jpx.co.jp/",
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
  
  await fetchWindow.loadURL(
      jpxQuotesUrl,
      {
          userAgent
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 2000)
  );
  
  // ③ JPXの案内ページを参照元としてQRIを開く
  await fetchWindow.loadURL(
      pageUrl,
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
            html: pageInfo.html
        };
    } catch (error) {
        console.error(
            "オプションページ取得エラー:",
            error
        );
  
        return {
            success: false,
            error: error.message
        };
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
        console.log("日中データページ取得開始:", pageUrl);
  
        // 念のため、取得先をQRIだけに限定
        const parsedUrl = new URL(pageUrl);
  
        if (parsedUrl.hostname !== "www.jpx.co.jp") {
            throw new Error("許可されていない取得先です");
        }
  
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
  
        console.log("📅 daytrading pageUrl =", pageUrl);
  
        // ① まずJPXトップページを開く
  await fetchWindow.loadURL(
    "https://www.jpx.co.jp/",
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
  
  await fetchWindow.loadURL(
    jpxParticipantVolumeUrl,
      {
          userAgent
      }
  );
  
  await new Promise(resolve =>
      setTimeout(resolve, 2000)
  );
  
  // ③ JPXの案内ページを参照元としてQRIを開く
  await fetchWindow.loadURL(
      pageUrl,
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
  
        return {
            success: false,
            error: error.message
        };
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
        console.log("日中Excelダウンロード開始:", excelUrl);

        const response = await fetch(excelUrl);

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

        return {
            success: false,
            error: error.message
        };
    }
});


console.log(
  "OpenAI APIキーを読み込めた？",
  Boolean(process.env.OPENAI_API_KEY)
);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "OptionMap",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});