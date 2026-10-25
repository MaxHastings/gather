const { verifyManifest, verifyInstaller } = require("./update-signature.cjs");
function createUpdateManager({
  updater,
  version,
  trust,
  canRestart,
  publish,
  schedule = setTimeout,
  cancel = clearTimeout,
  automatic = true,
}) {
  let state = { phase: "idle", version, percent: 0, error: "" };
  let busy = false,
    disposed = false,
    staged = null,
    timer,
    downloadToken;
  let paused = false;
  const listeners = [];
  const send = (next) => {
    if (!disposed) {
      state = { ...state, ...next };
      publish(state);
    }
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  // Error strings from the provider may contain paths/URLs; UI receives fixed copy.
  function failed() {
    send({
      phase: "error",
      error: "Could not update. You can keep using Gather and try again later.",
    });
  }
  function on(event, listener) {
    updater.on(event, listener);
    listeners.push([event, listener]);
  }
  on("error", failed);
  on("download-progress", (progress) =>
    send({
      phase: "downloading",
      percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    }),
  );
  function nextCheck(delay = 6 * 60 * 60 * 1000) {
    if (!automatic || disposed) return;
    cancel(timer);
    timer = schedule(() => void check(), delay);
    timer.unref?.();
  }
  async function check() {
    if (
      disposed ||
      busy ||
      state.phase === "ready" ||
      state.phase === "installing"
    )
      return state;
    if (!canRestart()) {
      send({ phase: "waiting", error: "" });
      nextCheck(60_000);
      return state;
    }
    paused = false;
    busy = true;
    send({ phase: "checking", error: "", percent: 0 });
    try {
      const result = await updater.checkForUpdates();
      if (disposed) return state;
      if (!result || result.updateInfo.version === version) {
        send({ phase: "current", version });
        return state;
      }
      const verified = verifyManifest(result.updateInfo, trust, version);
      if (!canRestart()) {
        send({ phase: "waiting", error: "" });
        return state;
      }
      send({ phase: "downloading", version: verified.version });
      downloadToken = result.cancellationToken;
      const paths = await updater.downloadUpdate(downloadToken);
      if (disposed) return state;
      if (!Array.isArray(paths) || paths.length !== 1)
        throw new Error("Unexpected update payload.");
      await verifyInstaller(paths[0], verified.file);
      staged = { ...verified, path: paths[0] };
      send({ phase: "ready", percent: 100, version: verified.version });
    } catch {
      staged = null;
      if (paused) send({ phase: "waiting", error: "" });
      else failed();
    } finally {
      busy = false;
      downloadToken = undefined;
      nextCheck(
        state.phase === "waiting"
          ? 60_000
          : state.phase === "error"
            ? 30 * 60 * 1000
            : undefined,
      );
    }
    return state;
  }
  async function restart() {
    if (disposed || busy || !staged || state.phase !== "ready")
      return { ok: false, reason: "No verified update is ready." };
    if (!canRestart())
      return {
        ok: false,
        reason: "Finish your call or file transfer before restarting.",
      };
    busy = true;
    try {
      // Recheck cached bytes and the library's selected installer before execution.
      await verifyInstaller(staged.path, staged.file);
      if (disposed || !canRestart())
        return {
          ok: false,
          reason: "Finish your call or file transfer before restarting.",
        };
      if (updater.installerPath !== staged.path)
        throw new Error("Update selection changed.");
      send({ phase: "installing", error: "" });
      updater.quitAndInstall(true, true);
      return state.phase === "error"
        ? {
            ok: false,
            reason: "The installer could not start. Try again later.",
          }
        : { ok: true };
    } catch {
      staged = null;
      failed();
      return {
        ok: false,
        reason:
          "The saved update could not be verified. Check for updates to download it again.",
      };
    } finally {
      busy = false;
    }
  }
  nextCheck(20_000);
  return {
    check,
    restart,
    status: () => ({ ...state }),
    activityChanged(active) {
      if (active && downloadToken) {
        paused = true;
        downloadToken.cancel();
      } else if (!active && state.phase === "waiting") nextCheck(1000);
    },
    dispose() {
      disposed = true;
      cancel(timer);
      downloadToken?.cancel();
      for (const [event, listener] of listeners)
        // The async downloader can still emit an error while the app quits.
        if (event !== "error") updater.removeListener(event, listener);
    },
  };
}
module.exports = { createUpdateManager };
