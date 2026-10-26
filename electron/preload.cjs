const { contextBridge, ipcRenderer } = require("electron");
async function profileCall(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response?.ok)
    throw new Error(
      response?.error || "Your saved profile could not be opened. Try again.",
    );
  return response.value;
}

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  defaultServer:
    process.argv
      .find((arg) => arg.startsWith("--gather-server="))
      ?.slice("--gather-server=".length) || "",
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  openExternal: (value) => ipcRenderer.invoke("external:open", value),
  copyText: (value) => ipcRenderer.invoke("text:copy", value),
  copyInvite: (value) => ipcRenderer.invoke("invite:copy", value),
  setInCall: (active) => ipcRenderer.invoke("call:active", active === true),
  setUnreadCount: (count) => ipcRenderer.invoke("unread:set", count),
  history: (command) => ipcRenderer.invoke("history:execute", command),
  media: (command) => ipcRenderer.invoke("media:execute", command),
  notificationsSupported: () => ipcRenderer.invoke("notifications:supported"),
  updateStatus: () => ipcRenderer.invoke("updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  restartToUpdate: () => ipcRenderer.invoke("updates:restart"),
  setUpdateBusy: (value) => ipcRenderer.invoke("updates:busy", value),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updates:state", listener);
    return () => ipcRenderer.removeListener("updates:state", listener);
  },
  showNotification: (value) => ipcRenderer.invoke("notifications:show", value),
  clearNotifications: (scope) =>
    ipcRenderer.invoke("notifications:clear", scope),
  onNotificationOpen: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("notifications:open", listener);
    return () => ipcRenderer.removeListener("notifications:open", listener);
  },
  readSession: () => profileCall("session:read"),
  writeSession: (value, expectedToken) =>
    profileCall("session:write", value, expectedToken),
  copyRecoveryCode: (code) => ipcRenderer.invoke("recovery:copy", code),
  onToggleMute: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("call:toggle-mute", listener);
    return () => ipcRenderer.removeListener("call:toggle-mute", listener);
  },
});
