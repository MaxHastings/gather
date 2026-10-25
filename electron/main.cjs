const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  globalShortcut,
  clipboard,
  shell,
  nativeTheme,
  safeStorage,
  Notification,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createWindowAccess } = require("./window-access.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
let win;
let backend;
let historyStore;
let mediaCache;
let sessionStore;
let notifications;
let updates;
let updateBusy = true;
let inCall = false;
let downloads = 0;
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});
const testing = Boolean(process.env.GATHER_TEST_DATA);
if (testing)
  app.setPath("userData", path.resolve(process.env.GATHER_TEST_DATA));
const devUrl = process.env.GATHER_DEV_URL;
const defaultServer = require("./config.json").serverUrl;
const trusted = (url) => {
  try {
    const target = new URL(url);
    return devUrl
      ? target.origin === new URL(devUrl).origin
      : target.protocol === "app:" && target.hostname === "gather";
  } catch {
    return false;
  }
};
const access = createWindowAccess(() => win, trusted);
const validSender = access.validSender;
const singleInstance = testing || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on("second-instance", () => {
    access.withWindow((window) => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
  });
  app
    .whenReady()
    .then(async () => {
      const { config } = await import("dotenv");
      config({ path: path.join(app.getAppPath(), ".env"), quiet: true });
      if (testing || !defaultServer) {
        const { createGatherServer } = await import(
          pathToFileURL(path.join(app.getAppPath(), "server/app.mjs")).href
        );
        const local = createGatherServer({
          dataDir: testing
            ? path.join(process.env.GATHER_TEST_DATA, "server")
            : path.join(app.getPath("userData"), "server"),
          distDir: path.join(app.getAppPath(), "dist"),
        });
        try {
          await local.listen(
            Number(process.env.GATHER_TEST_PORT || 4318),
            "127.0.0.1",
          );
          backend = local;
        } catch (error) {
          await local.close();
          if (error.code !== "EADDRINUSE") throw error;
          const health = await fetch(
            `http://127.0.0.1:${process.env.GATHER_TEST_PORT || 4318}/api/health`,
          )
            .then((r) => r.json())
            .catch(() => null);
          if (health?.service !== "gather")
            throw new Error(
              "Port 4318 is in use by another app. Close it and restart Gather.",
            );
        }
      }
      protocol.handle("app", (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "gather")
          return new Response("Not found", { status: 404 });
        const asset =
          url.pathname === "/"
            ? "index.html"
            : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const root = path.join(app.getAppPath(), "dist");
        const target = path.resolve(root, asset);
        if (!target.startsWith(root + path.sep))
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(target).href);
      });
      session.defaultSession.setPermissionRequestHandler(
        access.permissionRequest,
      );
      session.defaultSession.setPermissionCheckHandler(access.permissionCheck);
      win = new BrowserWindow({
        icon: path.join(__dirname, "icon.png"),
        width: 1220,
        height: 840,
        minWidth: 880,
        minHeight: 620,
        title: "Gather",
        backgroundColor: nativeTheme.shouldUseDarkColors
          ? "#111821"
          : "#f8fbfe",
        frame: process.platform === "darwin",
        ...(process.platform === "darwin"
          ? {
              titleBarStyle: "hiddenInset",
              trafficLightPosition: { x: 14, y: 10 },
            }
          : {}),
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          additionalArguments: [
            `--gather-server=${testing ? "" : defaultServer}`,
          ],
        },
      });
      const createdWindow = win;
      let confirmingClose = false;
      createdWindow.on("close", (event) => {
        if (quitting || testing || !(inCall || updateBusy || downloads > 0))
          return;
        event.preventDefault();
        if (confirmingClose) return;
        confirmingClose = true;
        void require("electron")
          .dialog.showMessageBox(createdWindow, {
            type: "question",
            message: "Quit Gather?",
            detail: inCall
              ? "This will end your voice call. Your saved messages and outbox will stay on this device."
              : "A transfer or unsent files may still be open. Sent messages and queued work are saved; selected files not yet sent will need to be selected again.",
            buttons: ["Keep open", "Quit"],
            defaultId: 0,
            cancelId: 0,
          })
          .then(({ response }) => {
            confirmingClose = false;
            if (response === 1 && !createdWindow.isDestroyed())
              createdWindow.destroy();
          })
          .catch(() => {
            confirmingClose = false;
          });
      });

      createdWindow.on("closed", () => {
        if (win === createdWindow) win = null;
        globalShortcut.unregisterAll();
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (!trusted(url)) event.preventDefault();
      });
      win.once(
        "ready-to-show",
        () => !testing && access.withWindow((window) => window.show()),
      );
      const { createHistoryStore } = await import(
        pathToFileURL(path.join(__dirname, "history.mjs")).href
      );
      historyStore = createHistoryStore(
        path.join(app.getPath("userData"), "history.sqlite"),
      );
      ipcMain.handle("history:execute", (event, command) => {
        if (!validSender(event)) throw new Error("History access denied.");
        return historyStore.execute(command);
      });
      const { createMediaCache } = await import(
        pathToFileURL(path.join(__dirname, "media.mjs")).href
      );
      mediaCache = createMediaCache(
        path.join(app.getPath("userData"), "media.sqlite"),
      );
      // Main-process-only fixture access; never exposed through the preload.
      if (testing) globalThis.__gatherTestMediaStore = mediaCache;
      ipcMain.handle("media:execute", (event, command) => {
        if (
          !validSender(event) ||
          event.senderFrame !== win.webContents.mainFrame
        )
          throw new Error("Media access denied.");
        return mediaCache.execute(command);
      });
      const { createSessionStore } = await import(
        pathToFileURL(path.join(__dirname, "session.mjs")).href
      );
      sessionStore = createSessionStore(
        path.join(app.getPath("userData"), "session.sqlite"),
        safeStorage,
      );
      const sessionSender = (event) =>
        validSender(event) && event.senderFrame === win.webContents.mainFrame;
      const { createNotifications } = require("./notifications.cjs");
      // Integration fixtures exercise IPC and clicks without showing real OS toasts.
      let NativeNotification = Notification;
      if (testing) {
        const { EventEmitter } = require("node:events");
        globalThis.__gatherTestNotifications = [];
        NativeNotification = class extends EventEmitter {
          static isSupported() {
            return true;
          }
          constructor(options) {
            super();
            this.options = options;
          }
          show() {
            globalThis.__gatherTestNotifications.push(this);
          }
          close() {
            this.closed = true;
            this.emit("close");
          }
        };
      }
      if (process.platform === "win32")
        app.setAppUserModelId("com.gather.desktop");
      notifications = createNotifications(
        NativeNotification,
        access,
        path.join(__dirname, "icon.png"),
      );
      ipcMain.handle("notifications:supported", (event) => {
        if (!sessionSender(event))
          throw new Error("Notification access denied.");
        return notifications.supported();
      });
      ipcMain.handle("notifications:show", (event, value) => {
        if (!sessionSender(event))
          throw new Error("Notification access denied.");
        return notifications.show(value);
      });
      ipcMain.handle("notifications:clear", (event, scope) => {
        if (!sessionSender(event))
          throw new Error("Notification access denied.");
        notifications.clear(scope);
      });
      const supportedUpdates =
        app.isPackaged &&
        !testing &&
        process.platform === "win32" &&
        process.arch === "x64" &&
        !process.env.PORTABLE_EXECUTABLE_DIR;
      if (supportedUpdates) {
        const { NsisUpdater } = require("electron-updater");
        const { createUpdateManager } = require("./updates.cjs");
        const updater = new NsisUpdater({
          provider: "generic",
          url: new URL("/updates/", defaultServer).href,
          useMultipleRangeRequest: false,
        });
        updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
        updates = createUpdateManager({
          updater,
          version: app.getVersion(),
          trust: require("./update-trust.json"),
          canRestart: () => !updateBusy && !inCall && downloads === 0,
          publish: (state) =>
            access.withWindow((_window, contents) =>
              contents.send("updates:state", state),
            ),
        });
      }
      ipcMain.handle("updates:status", (event) => {
        if (!sessionSender(event)) throw new Error("Update access denied.");
        return (
          updates?.status() ?? {
            phase: "unsupported",
            version: app.getVersion(),
            percent: 0,
            error: "",
          }
        );
      });
      ipcMain.handle("updates:busy", (event, value) => {
        if (!sessionSender(event) || typeof value !== "boolean")
          throw new Error("Invalid update state.");
        updateBusy = value;
        updates?.activityChanged(value || inCall || downloads > 0);
      });
      ipcMain.handle("updates:check", (event) => {
        if (!sessionSender(event)) throw new Error("Update access denied.");
        return updates?.check();
      });
      ipcMain.handle("updates:restart", (event) => {
        if (!sessionSender(event)) throw new Error("Update access denied.");
        return (
          updates?.restart() ?? {
            ok: false,
            reason: "Install Gather to enable automatic updates.",
          }
        );
      });
      session.defaultSession.on("will-download", (_event, item) => {
        downloads++;
        updates?.activityChanged(true);
        item.once("done", () => {
          downloads = Math.max(0, downloads - 1);
          updates?.activityChanged(updateBusy || inCall || downloads > 0);
        });
      });
      ipcMain.handle("session:read", async (event) => {
        if (!sessionSender(event)) throw new Error("Profile access denied.");
        try {
          return { ok: true, value: await sessionStore.read() };
        } catch (error) {
          return {
            ok: false,
            error:
              /^(Your saved|The saved|This profile|Protected profile)/.test(
                error.message,
              )
                ? error.message
                : "Your saved profile could not be opened. Check available storage and try again.",
          };
        }
      });
      ipcMain.handle("session:write", async (event, value, expectedToken) => {
        if (!sessionSender(event)) throw new Error("Profile access denied.");
        try {
          return {
            ok: true,
            value: await sessionStore.write(value, expectedToken),
          };
        } catch (error) {
          return {
            ok: false,
            error:
              /^(Your profile|The saved|This profile|Protected profile)/.test(
                error.message,
              )
                ? error.message
                : "Your profile could not be saved. Check available storage and try again.",
          };
        }
      });
      ipcMain.handle("recovery:copy", (event, code) => {
        if (
          !validSender(event) ||
          typeof code !== "string" ||
          !/^gather_[A-Za-z0-9_-]{43}$/.test(code)
        )
          throw new Error("Invalid recovery code.");
        clipboard.writeText(code);
      });
      await win.loadURL(devUrl || "app://gather/index.html");
      if (testing)
        access.withWindow((_window, contents) => contents.setAudioMuted(true));
      ipcMain.on("window:minimize", (event) => {
        if (validSender(event)) win.minimize();
      });
      ipcMain.on("window:maximize", (event) => {
        if (validSender(event))
          win.isMaximized() ? win.unmaximize() : win.maximize();
      });
      ipcMain.on("window:close", (event) => {
        if (validSender(event)) win.close();
      });
      ipcMain.handle("call:active", (event, active) => {
        if (!validSender(event)) return false;
        inCall = active === true;
        updates?.activityChanged(updateBusy || inCall || downloads > 0);
        globalShortcut.unregister("CommandOrControl+Shift+M");
        return active === true
          ? globalShortcut.register("CommandOrControl+Shift+M", () =>
              access.withWindow((_window, contents) =>
                contents.send("call:toggle-mute"),
              ),
            )
          : true;
      });
      ipcMain.handle("text:copy", (event, value) => {
        if (
          !validSender(event) ||
          typeof value !== "string" ||
          value.length > 16000
        )
          throw new Error("Clipboard access denied.");
        clipboard.writeText(value);
      });
      ipcMain.handle("external:open", async (event, value) => {
        if (!validSender(event)) throw new Error("Link access denied.");
        const { externalUrl } = require("../server/external-url.cjs");
        await shell.openExternal(externalUrl(value));
      });
      ipcMain.handle("invite:copy", async (event, value) => {
        if (
          !validSender(event) ||
          typeof value !== "string" ||
          value.length > 2048
        )
          throw new Error("Invalid invite.");
        const url = new URL(value);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          !/^\/join\/[A-Za-z0-9_-]{16,64}$/.test(url.pathname) ||
          url.username ||
          url.password
        )
          throw new Error("Invalid invite.");
        await clipboard.writeText(url.href);
      });
    })
    .catch((error) => {
      if (quitting) return;
      require("electron").dialog.showErrorBox(
        "Gather couldn’t start",
        error.message,
      );
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  notifications?.dispose();
  notifications = null;
  updates?.dispose();
  updates = null;
  historyStore?.close();
  historyStore = null;
  mediaCache?.close();
  mediaCache = null;
  sessionStore?.close();
  sessionStore = null;
  const local = backend;
  backend = null;
  local?.close();
});
