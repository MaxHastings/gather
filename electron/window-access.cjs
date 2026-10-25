// Electron can ask for permissions after a native window has been destroyed.
// Deny those requests before touching native getters; optional chaining alone
// only handles null/undefined JavaScript references.
function createWindowAccess(getWindow, trusted) {
  function liveWindow() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return null;
    const contents = window.webContents;
    if (!contents || contents.isDestroyed()) return null;
    return { window, contents };
  }
  function withWindow(action) {
    const current = liveWindow();
    if (!current) return false;
    action(current.window, current.contents);
    return true;
  }
  function validSender(event) {
    const current = liveWindow();
    if (
      !current ||
      !event.sender ||
      event.sender.isDestroyed() ||
      event.sender !== current.contents
    )
      return false;
    try {
      return trusted(event.senderFrame?.url ?? "");
    } catch {
      return false;
    } // The sending frame may already be disposed.
  }
  function permissionCheck(contents, permission, origin, details = {}) {
    const current = liveWindow();
    if (
      !current ||
      !contents ||
      contents.isDestroyed() ||
      contents !== current.contents
    )
      return false;
    const requestingUrl = details.requestingUrl || origin || contents.getURL();
    if (!trusted(requestingUrl) || details.isMainFrame === false) return false;
    return (
      permission === "clipboard-sanitized-write" ||
      (permission === "media" && details.mediaType !== "video")
    );
  }
  function permissionRequest(contents, permission, callback, details = {}) {
    const current = liveWindow();
    if (
      !current ||
      !contents ||
      contents.isDestroyed() ||
      contents !== current.contents
    ) {
      callback(false);
      return;
    }
    const allowed =
      trusted(details.requestingUrl || contents.getURL()) &&
      details.isMainFrame !== false &&
      (permission === "clipboard-sanitized-write" ||
        (permission === "media" &&
          Array.isArray(details.mediaTypes) &&
          details.mediaTypes.length > 0 &&
          details.mediaTypes.every((type) => type === "audio")));
    callback(Boolean(allowed));
  }
  return { withWindow, validSender, permissionCheck, permissionRequest };
}
module.exports = { createWindowAccess };
