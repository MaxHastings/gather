import { api } from "./api";
import { history, historyScope } from "./history";
import type { MediaCleanupTask } from "../server/history-contract.mjs";
import type { Attachment, Session } from "./types";
import {
  validateLocalMedia,
  mediaSettings,
  planMediaChange,
  mediaKey,
  createMediaClock,
  type MediaCommand,
  type MediaRow,
} from "../server/media-contract.mjs";
export const mediaTypes = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
];
export const digest = async (data: Uint8Array) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

let opening: Promise<IDBDatabase> | undefined;
const clock = createMediaClock();
function database() {
  if (!opening)
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("gather-media", 2);
      let blocked = false;
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (event.oldVersion < 1) {
          db.createObjectStore("metadata", { keyPath: "key" });
          db.createObjectStore("bytes", { keyPath: "key" });
        }
        if (event.oldVersion < 2) {
          db.createObjectStore("settings");
          db.createObjectStore("revocations", { keyPath: "key" });
          const cursor = open.transaction!.objectStore("metadata").openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            const row = item.value,
              [scope, id] = JSON.parse(row.key);
            item.update({
              ...row,
              scope,
              id,
              flags: row.pinned ? 1 : 0,
              name: "File",
              type: "application/octet-stream",
              messageKey: "",
              cloudUntil: 0,
            });
            item.continue();
          };
        }
      };
      open.onblocked = () => {
        blocked = true;
        reject(
          new Error("Close older Gather tabs so saved files can be updated."),
        );
      };
      open.onerror = () =>
        reject(
          new Error(
            "Files could not be opened on this device. Check free storage.",
          ),
        );
      open.onsuccess = () => {
        const db = open.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
  return opening;
}
const result = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function browserCache(input: MediaCommand) {
  const c = validateLocalMedia(input);
  if (c.operation === "put") {
    c.data = c.data!.slice();
    if ((await digest(c.data)) !== c.sha256)
      throw new Error("Attachment checksum does not match.");
    const estimate = await navigator.storage
      ?.estimate?.()
      .catch(() => undefined);
    if (
      estimate?.quota &&
      typeof estimate.usage === "number" &&
      estimate.quota - estimate.usage < 10_000_000 + c.data.byteLength * 2
    )
      throw new Error(
        "Browser storage is low. Free some space or save the original to a folder.",
      );
  }
  const db = await database();
  const tx = db.transaction(
    ["metadata", "bytes", "settings", "revocations"],
    ["status", "entry", "list"].includes(c.operation)
      ? "readonly"
      : "readwrite",
    { durability: "strict" },
  );
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error || new Error("Files could not be saved. Check free storage."),
      );
    tx.onerror = () => {};
  });
  void done.catch(() => {});
  const meta = tx.objectStore("metadata"),
    bytes = tx.objectStore("bytes"),
    prefs = tx.objectStore("settings"),
    revocations = tx.objectStore("revocations"),
    key = mediaKey(c.scope, c.id);
  const revoked = async (kind: string, value?: string) =>
    Boolean(
      value &&
      (await result(revocations.get(mediaKey(c.scope, `${kind}:${value}`)))),
    );
  try {
    const old = c.id ? await result(meta.get(key)) : null;
    if (c.operation === "get") {
      const saved =
        old &&
        !(await revoked("file", c.id)) &&
        !(await revoked("message", old.messageKey))
          ? await result(bytes.get(key))
          : null;
      if (saved) meta.put({ ...old, touched: Date.now() });
      await done;
      return saved?.data ?? null;
    }
    if (
      c.operation === "put" &&
      ((await revoked("file", c.id)) ||
        (await revoked("message", c.messageKey || old?.messageKey)))
    )
      throw new Error(
        "This message was deleted. Its file cannot be saved again.",
      );
    if (
      c.operation === "observe" &&
      !c.deleted &&
      (await revoked("message", c.messageKey))
    ) {
      await done;
      return { ok: true };
    }
    const rows: MediaRow[] = await result(meta.getAll());
    const settings = mediaSettings(await result(prefs.get("device")), false);
    const plan = planMediaChange(rows, settings, c, clock.read());
    for (const key of plan.removed) {
      meta.delete(key);
      bytes.delete(key);
    }
    for (const row of plan.upserts) {
      const key = mediaKey(row.scope, row.id);
      meta.put({ ...row, key });
      if (c.operation === "put" && row.scope === c.scope && row.id === c.id)
        bytes.put({ key, data: c.data });
    }
    if (c.operation === "configure") prefs.put(plan.settings, "device");
    if (c.operation === "observe" && c.deleted) {
      revocations.put({ key: mediaKey(c.scope, `message:${c.messageKey}`) });
      for (const id of new Set([
        ...c.attachments!.map((a) => a.id),
        ...(c.attachmentIds ?? []),
        ...plan.removed.map((key) => JSON.parse(key)[1]),
      ]))
        revocations.put({ key: mediaKey(c.scope, `file:${id}`) });
    }
    await done;
    return plan.response;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw error;
  }
}
let channel: BroadcastChannel | undefined;
const changed = (scope?: string) =>
  window.dispatchEvent(
    new CustomEvent("gather:media-changed", { detail: { scope } }),
  );
export async function cacheMedia<T>(input: MediaCommand): Promise<T> {
  const c = validateLocalMedia(input);
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("gather-media");
    channel.onmessage = () => changed();
  }
  const value = await (window.desktop?.media
    ? window.desktop.media(c)
    : browserCache(c));
  if (!["get", "status", "entry", "list"].includes(c.operation)) {
    changed(c.scope);
    channel?.postMessage({ changed: true });
  }
  return value as T;
}
const cache = cacheMedia;
const cleanupRunning = new Map<
  string,
  { dirty: boolean; promise: Promise<void> }
>();
export function flushMediaCleanup(scope: string): Promise<void> {
  const existing = cleanupRunning.get(scope);
  if (existing) {
    existing.dirty = true;
    return existing.promise;
  }
  const state = { dirty: false, promise: Promise.resolve() };
  state.promise = (async () => {
    do {
      state.dirty = false;
      for (;;) {
        const tasks = await history<MediaCleanupTask[]>({
          operation: "mediaCleanup",
          scope,
        });
        if (!tasks.length) break;
        const completed: string[] = [];
        for (const task of tasks) {
          await cacheMedia({
            operation: "observe",
            scope,
            messageKey: task.messageKey,
            deleted: true,
            attachments: [],
            attachmentIds: task.attachmentIds,
          });
          completed.push(task.messageKey);
        }
        await history({
          operation: "mediaCleanupDone",
          scope,
          messageKeys: completed,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } while (state.dirty);
  })().finally(() => cleanupRunning.delete(scope));
  cleanupRunning.set(scope, state);
  return state.promise;
}

export class AttachmentInputError extends Error {}
export async function stageFile(
  session: Session,
  file: File,
  messageKey?: string,
): Promise<Attachment> {
  if (!file.size || file.size > 10_000_000)
    throw new AttachmentInputError(
      "Choose files under 10 MB for cloud sharing.",
    );
  const data = new Uint8Array(await file.arrayBuffer()),
    sha256 = await digest(data);
  const attachment = {
    id: crypto.randomUUID(),
    name:
      file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180) ||
      "attachment",
    type: mediaTypes.includes(file.type)
      ? file.type
      : file.type === "audio/x-wav"
        ? "audio/wav"
        : "application/octet-stream",
    bytes: data.length,
    sha256,
  };
  await cache({
    operation: "put",
    scope: historyScope(session),
    ...attachment,
    data,
    pinned: true,
    messageKey,
  });
  return attachment;
}
export async function unpinMedia(session: Session, id: string) {
  await cache({ operation: "unpin", scope: historyScope(session), id });
}
export async function uploadMedia(
  session: Session,
  groupId: string,
  attachment: Attachment,
  signal?: AbortSignal,
) {
  const data = await cache<Uint8Array | null>({
    operation: "get",
    scope: historyScope(session),
    id: attachment.id,
  });
  if (!data) throw new Error("The original file is missing from this device.");
  if ((await digest(data)) !== attachment.sha256)
    throw new Error("The saved file could not be verified.");
  const prepared = await api<Attachment & { state: string }>(
    session,
    `/api/groups/${groupId}/uploads`,
    { method: "POST", body: JSON.stringify(attachment), signal },
  );
  if (["ready", "committed"].includes(prepared.state)) return;
  await api(session, `/api/uploads/${attachment.id}/content`, {
    method: "PUT",
    body: data as Uint8Array<ArrayBuffer>,
    headers: { "Content-Type": "application/octet-stream" },
    signal: signal ?? AbortSignal.timeout(120_000),
  });
}
export async function loadMedia(
  session: Session,
  attachment: Attachment,
  signal?: AbortSignal,
  scope = historyScope(session),
  remote = true,
  messageKey?: string,
  fallbackScope?: string,
) {
  let data = await cache<Uint8Array | null>({
    operation: "get",
    scope,
    id: attachment.id,
  }).catch(() => null);
  let fromFallback = false;
  if (!data && fallbackScope) {
    data = await cache<Uint8Array | null>({
      operation: "get",
      scope: fallbackScope,
      id: attachment.id,
    }).catch(() => null);
    fromFallback = Boolean(data);
  }
  if (
    data &&
    (data.length !== attachment.bytes ||
      (await digest(data)) !== attachment.sha256)
  )
    data = null;
  if (data && fromFallback)
    await cache({
      operation: "put",
      scope,
      ...attachment,
      data,
      pinned: false,
      messageKey,
    }).catch(() => {});
  if (!data) {
    if (!remote)
      throw new Error(
        "This original file is not saved on this device and cannot be fetched from this history.",
      );
    const response = await fetch(
      `${session.server}/api/attachments/${attachment.id}/content`,
      {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.error || "This file could not be downloaded. Please retry.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The file is empty.");
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > attachment.bytes) {
          await reader.cancel();
          throw new Error("The downloaded file is larger than expected.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    data = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      data.set(part, offset);
      offset += part.length;
    }
  }
  if (
    data.length !== attachment.bytes ||
    (await digest(data)) !== attachment.sha256
  )
    throw new Error("The file could not be verified. Please retry.");
  // Viewing still works when optional cache persistence is unavailable.
  await cache({
    operation: "put",
    scope,
    ...attachment,
    data,
    pinned: false,
    messageKey,
  }).catch(() => {});
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: attachment.type });
}
