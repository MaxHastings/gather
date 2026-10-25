import { useEffect, useState } from "react";
import type { Group, Session } from "./types";
import {
  readNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from "./notifications";

export function NotificationSettings({
  session,
  groups,
}: {
  session: Session;
  groups: Group[];
}) {
  const [preferences, setPreferences] = useState(() =>
    readNotificationPreferences(session),
  );
  const [permission, setPermission] = useState("checking");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (window.desktop)
      void window.desktop
        .notificationsSupported()
        .then((supported) => {
          if (live) setPermission(supported ? "granted" : "unsupported");
        })
        .catch(() => {
          if (live) setPermission("unsupported");
        });
    else
      setPermission(
        "Notification" in window ? Notification.permission : "unsupported",
      );
    return () => {
      live = false;
    };
  }, []);
  function save(next: NotificationPreferences) {
    try {
      saveNotificationPreferences(session, next);
      setPreferences(next);
      setError("");
    } catch {
      setError(
        "Could not save notification settings. Check available storage and try again.",
      );
    }
  }
  async function toggle(enabled: boolean) {
    if (
      enabled &&
      !window.desktop &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      try {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result !== "granted") return;
      } catch {
        setError(
          "Notifications could not be enabled. Check your browser's site permissions.",
        );
        return;
      }
    }
    save({ ...preferences, enabled });
  }
  const blocked = permission === "denied" || permission === "unsupported";
  return (
    <div className="notification-settings">
      <p className="field-hint">
        Message alerts while Gather is running. Your system’s notification
        settings also apply.
      </p>
      <label className="preference-toggle">
        <input
          type="checkbox"
          checked={preferences.enabled && !blocked}
          disabled={blocked || permission === "checking"}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>Message notifications</span>
      </label>
      {permission === "denied" && (
        <p className="field-hint">
          Notifications are blocked. Allow them in your browser’s site settings
          to enable alerts.
        </p>
      )}
      {permission === "unsupported" && (
        <p className="field-hint">
          System notifications are unavailable on this device.
        </p>
      )}
      <label className="preference-toggle">
        <input
          type="checkbox"
          checked={preferences.preview}
          onChange={(event) =>
            save({ ...preferences, preview: event.target.checked })
          }
        />
        <span>Show names and message previews</span>
      </label>
      <h3>Muted chats</h3>
      <div className="notification-chat-list">
        {groups.map((group) => (
          <label className="preference-toggle" key={group.id}>
            <input
              type="checkbox"
              checked={preferences.muted.includes(group.id)}
              onChange={(event) =>
                save({
                  ...preferences,
                  muted: event.target.checked
                    ? [...preferences.muted, group.id]
                    : preferences.muted.filter((id) => id !== group.id),
                })
              }
            />
            <span>{group.name}</span>
          </label>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
