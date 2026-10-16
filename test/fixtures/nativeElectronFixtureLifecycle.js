"use strict";

// Acceptance workers must let Chromium finish its own shutdown. Immediate
// app.exit() can leave Windows utility processes holding disposable userData.
async function shutdown(app, session, code = 0) {
  if (process.platform === "win32") {
    if (session?.defaultSession) {
      await session.defaultSession.closeAllConnections();
      session.defaultSession.flushStorageData();
    }
    process.exitCode = code;
    app.quit();
    return;
  }
  app.exit(code);
}

module.exports = Object.freeze({ shutdown });
