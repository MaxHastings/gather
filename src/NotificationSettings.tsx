import { useEffect, useState } from "react";
import type { Group, Session } from "./types";
import {
  describeUntil,
  FOREVER,
  muteEnd,
  readNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from "./notifications";

export const muteChoices = [
  ["off", "Not muted"],
  ["1h", "Mute for 1 hour"],
  ["8h", "Mute for 8 hours"],
  ["tomorrow", "Mute until tomorrow morning"],
  ["forever", "Mute until I unmute"],
] as const;
/** Returns preferences with one chat's mute set to a choice from muteChoices. */
export function withMute(
  preferences: NotificationPreferences,
  groupId: string,
  choice: string,
): NotificationPreferences {
  const mutedUntil = { ...preferences.mutedUntil };
  delete mutedUntil[groupId];
  const end = muteEnd(choice);
  if (end && end < FOREVER) mutedUntil[groupId] = end;
  return {
    ...preferences,
    muted:
      choice === "forever"
        ? [...new Set([...preferences.muted, groupId])]
        : preferences.muted.filter((id) => id !== groupId),
    mutedUntil,
  };
}
export function currentMuteChoice(
  preferences: NotificationPreferences,
  groupId: string,
) {
  if (preferences.muted.includes(groupId)) return "forever";
  return (preferences.mutedUntil[groupId] ?? 0) > Date.now() ? "timed" : "off";
}

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
      <h3>Do Not Disturb</h3>
      <p className="field-hint">
        Silences message alerts, call rings and their sounds. Incoming calls
        still show on screen.
        {preferences.dndUntil > Date.now() &&
          ` On ${describeUntil(preferences.dndUntil)}.`}
      </p>
      <select
        aria-label="Do Not Disturb"
        value={preferences.dndUntil > Date.now() ? "on" : "off"}
        onChange={(event) => {
          const choice = event.target.value;
          if (choice === "on" || choice === "off")
            return save({
              ...preferences,
              dndUntil: choice === "on" ? preferences.dndUntil : 0,
            });
          save({ ...preferences, dndUntil: muteEnd(choice) });
        }}
      >
        <option value="off">Off</option>
        {preferences.dndUntil > Date.now() && (
          <option value="on">
            On {describeUntil(preferences.dndUntil)}
          </option>
        )}
        <option value="1h">For 1 hour</option>
        <option value="8h">For 8 hours</option>
        <option value="tomorrow">Until tomorrow morning</option>
        <option value="forever">Until I turn it off</option>
      </select>
      <h3>Muted chats</h3>
      <p className="field-hint">
        Muted chats stay quiet, but a message that mentions you still gets
        through.
      </p>
      <div className="notification-chat-list">
        {groups.map((group) => {
          const choice = currentMuteChoice(preferences, group.id);
          return (
            <div className="preference-select" key={group.id}>
              <span>{group.name}</span>
              <select
                aria-label={`Mute ${group.name}`}
                value={choice}
                onChange={(event) =>
                  save(withMute(preferences, group.id, event.target.value))
                }
              >
                {choice === "timed" && (
                  <option value="timed">
                    Muted {describeUntil(preferences.mutedUntil[group.id])}
                  </option>
                )}
                {muteChoices.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
