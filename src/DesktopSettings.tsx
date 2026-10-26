import { useEffect, useState } from "react";

type Prefs = {
  closeToTray: boolean;
  startOnLogin: boolean;
  supportsTray: boolean;
  supportsStartOnLogin: boolean;
};
/** Desktop-only choices: stay running when closed, start when you sign in. */
export function DesktopSettings() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void window.desktop
      ?.getDesktopPrefs?.()
      .then((value) => live && setPrefs(value))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!prefs || (!prefs.supportsTray && !prefs.supportsStartOnLogin))
    return null;
  const change = (patch: Partial<Pick<Prefs, "closeToTray" | "startOnLogin">>) =>
    window.desktop
      ?.setDesktopPrefs?.(patch)
      .then((value) => {
        setPrefs(value);
        setError("");
      })
      .catch(() => setError("That setting could not be saved."));
  return (
    <div className="settings-block desktop-settings">
      <label>This computer</label>
      {prefs.supportsTray && (
        <label className="preference-toggle">
          <input
            type="checkbox"
            checked={prefs.closeToTray}
            onChange={(event) =>
              void change({ closeToTray: event.target.checked })
            }
          />
          <span>Keep Gather running when I close the window</span>
        </label>
      )}
      {prefs.supportsStartOnLogin && (
        <label className="preference-toggle">
          <input
            type="checkbox"
            checked={prefs.startOnLogin}
            onChange={(event) =>
              void change({ startOnLogin: event.target.checked })
            }
          />
          <span>Start Gather when I sign in</span>
        </label>
      )}
      <p className="field-hint">
        Friends see you online and can ring you while Gather runs in the
        background. Quit from the tray icon or the Dock menu.
      </p>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
