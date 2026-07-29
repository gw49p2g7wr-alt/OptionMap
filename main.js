const { app, BrowserWindow } = require("electron");
require("dotenv").config();

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