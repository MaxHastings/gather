import type { Group, Message, Session } from "./types";
import { historyScope } from "./history";
import { notificationCandidate } from "../server/notification-policy.mjs";

export type NotificationPreferences = {
  enabled: boolean;
  preview: boolean;
  muted: string[];
};
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
    };
  } catch {
    return { enabled: Boolean(window.desktop), preview: true, muted: [] };
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
