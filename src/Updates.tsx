import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { UpdateState } from "./types";
function useUpdates() {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    if (!window.desktop) return;
    let live = true,
      received = false;
    const remove = window.desktop.onUpdateState((value) => {
      received = true;
      if (live) setState(value);
    });
    void window.desktop
      .updateStatus()
      .then((value) => {
        if (live && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      remove();
    };
  }, []);
  return state;
}
export function UpdateBanner({ busy }: { busy: boolean }) {
  const state = useUpdates();
  const [dismissed, setDismissed] = useState("");
  const [error, setError] = useState("");
  if (state?.phase !== "ready" || dismissed === state.version) return null;
  return (
    <div className="update-banner" role="status">
      <Download size={16} />
      <span>
        Gather {state.version} is ready.
        {busy ? " Restart after your call or transfer." : ""}
      </span>
      <button
        className="text-button"
        disabled={busy}
        onClick={() =>
          void window.desktop
            ?.restartToUpdate()
            .then((result) => {
              if (!result.ok)
                setError(result.reason || "Could not restart. Try again.");
            })
            .catch(() => setError("Could not restart. Try again."))
        }
      >
        Restart
      </button>
      <button
        className="text-button"
        onClick={() => setDismissed(state.version)}
      >
        Later
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
export function UpdateSettings({ busy }: { busy: boolean }) {
  const state = useUpdates();
  const [error, setError] = useState("");
  if (!window.desktop || !state || state.phase === "unsupported") return null;
  const working = ["checking", "downloading", "installing"].includes(
    state.phase,
  );
  return (
    <div className="settings-block update-settings">
      <label>App updates</label>
      <p className="field-hint">
        {state.phase === "ready"
          ? `Version ${state.version} is ready.${busy ? " Finish your call or transfer before restarting." : ""}`
          : state.phase === "downloading"
            ? `Downloading ${state.percent}%`
            : state.phase === "checking"
              ? "Checking for updates…"
              : state.phase === "current"
                ? "You’re up to date."
                : state.phase === "installing"
                  ? "Restarting to update…"
                  : state.phase === "error"
                    ? state.error
                    : state.phase === "waiting"
                      ? "Updates will download after your call or transfer."
                      : "Updates download automatically."}
      </p>
      <button
        className="button secondary"
        disabled={working || (state.phase === "ready" && busy)}
        onClick={async () => {
          setError("");
          try {
            if (state.phase === "ready") {
              const result = await window.desktop!.restartToUpdate();
              if (!result.ok)
                setError(result.reason || "Could not restart. Try again.");
            } else await window.desktop!.checkForUpdates();
          } catch {
            setError("Could not update. Try again later.");
          }
        }}
      >
        <RefreshCw size={15} />
        {state.phase === "ready" ? "Restart to update" : "Check for updates"}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
