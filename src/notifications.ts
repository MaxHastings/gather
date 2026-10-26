import type { Group, Message, Session } from "./types";
import { historyScope } from "./history";
import { notificationCandidate } from "../server/notification-policy.mjs";
import { mentionsUser } from "../server/mentions.mjs";

export type NotificationPreferences = {
  enabled: boolean;
  preview: boolean;
  /** Chats muted until the person unmutes them. */
  muted: string[];
  /** Chats muted for a while: chat id to the time (ms) the mute ends. */
  mutedUntil: Record<string, number>;
  /** Do Not Disturb ends at this time (ms); 0 when off. */
  dndUntil: number;
};
/** Used for "until I turn it off". */
export const FOREVER = 8_000_000_000_000_000;
export const isChatMuted = (
  preferences: NotificationPreferences,
  groupId: string,
  now = Date.now(),
) =>
  preferences.muted.includes(groupId) ||
  (preferences.mutedUntil[groupId] ?? 0) > now;
export const isDoNotDisturb = (
  preferences: NotificationPreferences,
  now = Date.now(),
) => preferences.dndUntil > now;
export const activeMutes = (
  preferences: NotificationPreferences,
  now = Date.now(),
) => [
  ...new Set([
    ...preferences.muted,
    ...Object.entries(preferences.mutedUntil)
      .filter(([, until]) => until > now)
      .map(([id]) => id),
  ]),
];
export function describeUntil(until: number, now = Date.now()) {
  if (until <= now) return "";
  if (until >= FOREVER) return "until you turn it off";
  const date = new Date(until);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return date.toDateString() === new Date(now).toDateString()
    ? `until ${time}`
    : `until ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
/** The end time for a "mute for…" choice, or 0 to clear it. */
export function muteEnd(choice: string, now = Date.now()) {
  if (choice === "1h") return now + 3_600_000;
  if (choice === "8h") return now + 8 * 3_600_000;
  if (choice === "tomorrow") {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(8, 0, 0, 0);
    return next.getTime();
  }
  if (choice === "forever") return FOREVER;
  return 0;
}
const preferenceKey = (scope: string) => `gather.notifications.${scope}`;
const browserNotifications = new Map<string, Notification>();
type SeenNotifications = { ids: string[]; last: Record<string, number> };
let opening: Promise<IDBDatabase> | undefined;
function database() {
  if (!opening)
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("gather-notifications", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("seen");
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Notification storage is busy."));
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          opening = undefined;
        };
        resolve(request.result);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
  return opening;
}
async function claimNotification(
  scope: string,
  decide: (
    record: SeenNotifications,
  ) => ReturnType<typeof notificationCandidate>,
) {
  const db = await database();
  return new Promise<ReturnType<typeof notificationCandidate>>(
    (resolve, reject) => {
      const tx = db.transaction("seen", "readwrite");
      const store = tx.objectStore("seen");
      const request = store.get(scope);
      let candidate: ReturnType<typeof notificationCandidate> = null;
      request.onsuccess = () => {
        const record = request.result ?? { ids: [], last: {} };
        candidate = decide(record);
        store.put(record, scope);
      };
      tx.oncomplete = () => resolve(candidate);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => {};
    },
  );
}
export function readNotificationPreferences(
  session: Session,
): NotificationPreferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(preferenceKey(historyScope(session))) || "null",
    );
    return {
      enabled:
        typeof value?.enabled === "boolean"
          ? value.enabled
          : Boolean(window.desktop),
      preview: value?.preview !== false,
      muted: Array.isArray(value?.muted)
        ? value.muted
            .filter((s: unknown) => typeof s === "string")
            .slice(0, 1000)
        : [],
      mutedUntil:
        value?.mutedUntil && typeof value.mutedUntil === "object"
          ? Object.fromEntries(
              (
                Object.entries(value.mutedUntil) as [string, unknown][]
              )
                .filter(
                  ([, until]) =>
                    typeof until === "number" && until > Date.now(),
                )
                .slice(0, 1000),
            ) as Record<string, number>
          : {},
      dndUntil:
        typeof value?.dndUntil === "number" && value.dndUntil > Date.now()
          ? value.dndUntil
          : 0,
    };
  } catch {
    return {
      enabled: Boolean(window.desktop),
      preview: true,
      muted: [],
      mutedUntil: {},
      dndUntil: 0,
    };
  }
}
export function clearMessageNotifications(session: Session) {
  const scope = historyScope(session);
  void window.desktop?.clearNotifications(scope).catch(() => {});
  for (const [key, note] of browserNotifications)
    if (key.startsWith(`${scope}:`)) {
      browserNotifications.delete(key);
      note.close();
    }
}
export function saveNotificationPreferences(
  session: Session,
  value: NotificationPreferences,
) {
  localStorage.setItem(
    preferenceKey(historyScope(session)),
    JSON.stringify(value),
  );
  clearMessageNotifications(session);
  window.dispatchEvent(new Event("gather:notification-preferences"));
}
export function createMessageNotifier(
  session: Session,
  context: () => { selected: string; groups: Group[] },
) {
  const scope = historyScope(session);
  let live = true;
  const preferencesChanged = (event: StorageEvent) => {
    if (event.key === preferenceKey(scope) || event.key === null)
      clearMessageNotifications(session);
  };
  window.addEventListener("storage", preferencesChanged);
  async function receive(message: Message, changeKind?: string) {
    if (!live || changeKind !== "create") return;
    const run = async () => {
      if (!live) return;
      // A read/write IndexedDB transaction is the cross-tab admission authority.
      // localStorage caches can lag across renderers even while holding a Web Lock.
      const candidate = await claimNotification(scope, (memory) => {
        if (!live || memory.ids.includes(message.id)) return null;
        const now = Date.now();
        memory.ids = [...memory.ids, message.id].slice(-200);
        const current = context();
        const candidate = notificationCandidate({
          message,
          changeKind,
          userId: session.user.id,
          group: current.groups.find((g) => g.id === message.groupId),
          selected: current.selected,
          focused:
            document.visibilityState === "visible" && document.hasFocus(),
          preferences: readNotificationPreferences(session),
          now,
          mentioned: mentionsUser(message.body, session.user.name),
        });
        const throttled = now - (memory.last[message.groupId] || 0) < 3000;
        if (candidate && !throttled) memory.last[message.groupId] = now;
        memory.last = Object.fromEntries(
          Object.entries(memory.last).filter(([, at]) => now - at < 120_000),
        );
        return throttled ? null : candidate;
      });
      if (!live || !candidate) return;
      if (window.desktop) {
        await window.desktop.showNotification({ ...candidate, scope });
      } else if (
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        const key = `${scope}:${message.groupId}`;
        browserNotifications.get(key)?.close();
        const note = new Notification(candidate.title, {
          body: candidate.body,
          tag: key,
        });
        browserNotifications.set(key, note);
        note.onclose = () => {
          if (browserNotifications.get(key) === note)
            browserNotifications.delete(key);
        };
        note.onclick = () => {
          if (live && browserNotifications.get(key) === note) {
            window.focus();
            window.dispatchEvent(
              new CustomEvent("gather:open-notification", {
                detail: { scope, groupId: message.groupId },
              }),
            );
          }
          note.close();
        };
      }
    };
    try {
      await run();
    } catch {
      /* Permission/OS failure never blocks history or the call. */
    }
  }
  return {
    receive,
    dispose: () => {
      live = false;
      window.removeEventListener("storage", preferencesChanged);
      clearMessageNotifications(session);
    },
  };
}
