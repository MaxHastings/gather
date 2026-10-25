import type { Message, Group, Session } from "./types";
import { archiveScope } from "../server/archive-format.mjs";
import {
  validateHistoryCommand,
  historyKey,
  normalizeSearch,
  assertHistoryIdentity,
  assertQueuedIdentity,
  type HistoryCommand,
  mediaCleanupTask,
  mirrorGroups,
} from "../server/history-contract.mjs";
export type HistoryState = {
  groups: Group[];
  outbox: Message[];
  cursors: Record<string, number>;
  changeCursors?: Record<string, number>;
};
type StoredMessage = {
  key: string;
  scope: string;
  groupId: string;
  userId: string;
  clientId: string;
  sequence: number;
  searchBody: string;
  value: Message;
};
let browserDatabase: Promise<IDBDatabase> | undefined;
function database() {
  if (!browserDatabase) {
    browserDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("gather-history", 3);
      let blocked = false;
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (event.oldVersion < 1) {
          const groups = db.createObjectStore("groups", { keyPath: "key" });
          groups.createIndex("scope", "scope");
          const messages = db.createObjectStore("messages", { keyPath: "key" });
          messages.createIndex("group", ["scope", "groupId", "sequence"]);
          messages.createIndex("scopeSequence", ["scope", "sequence"]);
          messages.createIndex("client", ["scope", "userId", "clientId"], {
            unique: true,
          });
          const outbox = db.createObjectStore("outbox", { keyPath: "key" });
          outbox.createIndex("scope", "scope");
          const cursors = db.createObjectStore("cursors", { keyPath: "key" });
          cursors.createIndex("scope", "scope");
        }
        if (event.oldVersion < 2) {
          const archives = db.createObjectStore("archives", { keyPath: "key" });
          archives.createIndex("scope", "scope");
        }
        if (event.oldVersion < 3) {
          const cleanup = db.createObjectStore("mediaCleanup", {
            keyPath: "key",
          });
          cleanup.createIndex("scope", "scope");
          const cursor = open.transaction!.objectStore("messages").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (row.value.value.deletedAt) {
              const task = mediaCleanupTask(row.value.value);
              cleanup.put({
                key: historyKey(row.value.scope, task.messageKey),
                scope: row.value.scope,
                value: task,
              });
            }
            row.continue();
          };
        }
      };
      open.onerror = () =>
        reject(
          new Error(
            "Your local history could not be opened. Check available storage.",
          ),
        );
      open.onblocked = () => {
        blocked = true;
        reject(
          new Error("Close older Gather tabs so local history can be updated."),
        );
      };
      open.onsuccess = () => {
        const db = open.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          browserDatabase = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      browserDatabase = undefined;
      throw error;
    });
  }
  return browserDatabase;
}
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Local history operation failed."));
  });
async function browserExecute(command: HistoryCommand): Promise<unknown> {
  const { scope, operation } = command;
  const archiveId =
    operation === "importArchive"
      ? [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(command.archive)),
            ),
          ),
        ]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
      : undefined;
  const db = await database();
  const readOnly = [
    "state",
    "page",
    "search",
    "archives",
    "mediaCleanup",
  ].includes(operation);
  const tx = db.transaction(
    ["groups", "messages", "outbox", "cursors", "archives", "mediaCleanup"],
    readOnly ? "readonly" : "readwrite",
    { durability: "strict" },
  );
  const complete = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ||
          new Error("Local history was not saved. Check available storage."),
      );
    tx.onerror = () => {};
  });
  // Prevent an early transaction failure from becoming an unhandled rejection
  // while the operation is still awaiting an IndexedDB request.
  void complete.catch(() => {});
  const groups = tx.objectStore("groups"),
    messages = tx.objectStore("messages"),
    outbox = tx.objectStore("outbox"),
    cursors = tx.objectStore("cursors"),
    archives = tx.objectStore("archives"),
    cleanup = tx.objectStore("mediaCleanup");
  let response: unknown = { ok: true };
  try {
    if (operation === "lookup") {
      const row = await result(messages.get(historyKey(scope, command.id)));
      response = row?.groupId === command.groupId ? row.value : null;
    }
    if (operation === "unread") {
      const summary: Record<string, { count: number; firstId?: string }> = {};
      for (const [groupId, after] of Object.entries(command.after)) {
        const rows = await result(
          messages
            .index("group")
            .getAll(
              IDBKeyRange.bound(
                [scope, groupId, after + 1],
                [scope, groupId, Number.MAX_SAFE_INTEGER],
              ),
            ),
        );
        const incoming = rows.filter(
          (row) => row.value.userId !== command.userId && !row.value.deletedAt,
        );
        summary[groupId] = {
          count: incoming.length,
          firstId: incoming[0]?.value.id,
        };
      }
      response = summary;
    }
    if (operation === "mediaCleanup")
      response = (await result(cleanup.index("scope").getAll(scope, 100))).map(
        (row) => row.value,
      );
    if (operation === "mediaCleanupDone")
      for (const key of command.messageKeys)
        cleanup.delete(historyKey(scope, key));
    if (operation === "archives")
      response = (await result(archives.index("scope").getAll(scope))).map(
        (row) => row.value,
      );
    if (operation === "importArchive") {
      const existing = await result(
        archives.get(historyKey(scope, archiveId!)),
      );
      if (existing) response = { ...existing.value, alreadyImported: true };
      else {
        const target = archiveScope(scope, archiveId!);
        if (target.length > 512)
          throw new Error(
            "This server address is too long for an imported archive.",
          );
        if ((await result(archives.index("scope").count(scope))) >= 100)
          throw new Error("Remove an imported archive before adding more.");
        let count = 0;
        for (const { messages: records, ...group } of command.archive.groups) {
          groups.put({
            key: historyKey(target, group.id),
            scope: target,
            value: group,
          });
          for (const message of records) {
            messages.put({
              key: historyKey(target, message.id),
              scope: target,
              groupId: message.groupId,
              userId: message.userId,
              clientId: message.clientId,
              sequence: message.sequence,
              searchBody: normalizeSearch(message.body),
              value: message,
            });
            count++;
          }
        }
        const entry = {
          id: archiveId,
          name: command.name,
          scope: target,
          importedAt: Date.now(),
          exportedAt: command.archive.exportedAt,
          person: command.archive.user.name,
          groups: command.archive.groups.length,
          messages: count,
        };
        archives.put({
          key: historyKey(scope, archiveId!),
          scope,
          value: entry,
        });
        response = entry;
      }
    }
    if (operation === "deleteArchive") {
      const target = archiveScope(scope, command.id);
      for (const store of [groups, messages, outbox, cursors, cleanup])
        await new Promise<void>((resolve, reject) => {
          const index = store.indexNames.contains("scope")
            ? store.index("scope")
            : store.index("scopeSequence");
          const range =
            store.name === "messages"
              ? IDBKeyRange.bound(
                  [target, 0],
                  [target, Number.MAX_SAFE_INTEGER],
                )
              : target;
          const cursor = index.openKeyCursor(range);
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) {
              resolve();
              return;
            }
            store.delete(current.primaryKey);
            current.continue();
          };
        });
      archives.delete(historyKey(scope, command.id));
    }
    if (operation === "state") {
      const [g, o, c] = await Promise.all([
        result(groups.index("scope").getAll(scope)),
        result(outbox.index("scope").getAll(scope)),
        result(cursors.index("scope").getAll(scope)),
      ]);
      response = {
        groups: g
          .map((row) => row.value)
          .sort(
            (a: Group, b: Group) =>
              a.createdAt - b.createdAt || a.id.localeCompare(b.id),
          ),
        outbox: o.map((row) => row.value),
        cursors: Object.fromEntries(
          c.map((row) => [row.groupId, row.sequence]),
        ),
        changeCursors: Object.fromEntries(
          c
            .filter((row) => row.changeSequence > 0)
            .map((row) => [row.groupId, row.changeSequence]),
        ),
      };
    }
    if (operation === "bootstrap")
      for (let group of command.groups) {
        const previous = await result(groups.get(historyKey(scope, group.id)));
        if (
          previous?.value.lastMessage &&
          previous.value.lastMessage.sequence >
            (group.lastMessage?.sequence ?? 0)
        )
          group = { ...group, lastMessage: previous.value.lastMessage };
        groups.put({ key: historyKey(scope, group.id), scope, value: group });
      }
    if (operation === "page" || operation === "search") {
      const limit = operation === "page" ? (command.limit ?? 50) : 50;
      const forward = operation === "page" && command.after !== undefined;
      const groupId = command.groupId;
      const index = messages.index(groupId ? "group" : "scopeSequence");
      const lower = groupId
        ? [scope, groupId, forward ? command.after! : 0]
        : [scope, 0];
      const upper = groupId
        ? [
            scope,
            groupId,
            operation === "page"
              ? (command.before ?? Number.MAX_SAFE_INTEGER)
              : Number.MAX_SAFE_INTEGER,
          ]
        : [scope, Number.MAX_SAFE_INTEGER];
      const query =
        operation === "search" ? normalizeSearch(command.query.trim()) : "";
      const rows = await new Promise<Message[]>((resolve, reject) => {
        const found: Message[] = [];
        const cursor = index.openCursor(
          IDBKeyRange.bound(lower, upper, forward, operation === "page"),
          forward ? "next" : "prev",
        );
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (
            !current ||
            found.length >= limit + (operation === "page" ? 1 : 0)
          ) {
            resolve(found);
            return;
          }
          const row = current.value as StoredMessage;
          if (!query || row.searchBody.includes(query)) found.push(row.value);
          current.continue();
        };
      });
      response =
        operation === "page"
          ? {
              messages: forward
                ? rows.slice(0, limit)
                : rows.slice(0, limit).reverse(),
              hasMore: rows.length > limit,
            }
          : rows;
    }
    if (operation === "queue") {
      const message = command.message;
      if (command.replaceClientId) {
        const previous = await result(
          outbox.get(historyKey(scope, command.replaceClientId)),
        );
        if (
          !previous ||
          !previous.value.cancelled ||
          !previous.value.paused ||
          previous.value.userId !== message.userId ||
          previous.value.groupId !== message.groupId
        )
          throw new Error(
            "This unsent draft changed. Reopen it before sending.",
          );
        outbox.delete(historyKey(scope, command.replaceClientId));
      }

      const existing = await result(
        messages.index("client").get([scope, message.userId, message.clientId]),
      );
      const queued = await result(
        outbox.get(historyKey(scope, message.clientId)),
      );
      if (existing) {
        assertQueuedIdentity(existing.value, message);
        response = { accepted: existing.value };
      } else if (queued) {
        assertQueuedIdentity(queued.value, message);
        response = { queued: true };
      } else {
        if ((await result(outbox.index("scope").count(scope))) >= 1000)
          throw new Error(
            "Your unsent queue is full. Reconnect before sending more.",
          );
        outbox.put({
          key: historyKey(scope, message.clientId),
          scope,
          value: message,
        });
      }
    }
    if (operation === "apply") {
      let latest: Message | undefined;
      for (const message of command.messages) {
        const existing = await result(
          messages.get(historyKey(scope, message.id)),
        );
        assertHistoryIdentity(existing?.value, message);
        if (
          (existing?.value.revision ?? 0) > (message.revision ?? 0) ||
          (existing?.value.deletedAt && !message.deletedAt)
        )
          continue;
        const queuedForCleanup = message.deletedAt
          ? await result(outbox.get(historyKey(scope, message.clientId)))
          : undefined;
        if (message.deletedAt) {
          const messageKey = `${message.userId}:${message.clientId}`;
          const previousTask = await result(
            cleanup.get(historyKey(scope, messageKey)),
          );
          const task = mediaCleanupTask(
            message,
            existing?.value,
            queuedForCleanup?.value.userId === message.userId
              ? queuedForCleanup.value
              : undefined,
            previousTask?.value,
          );
          cleanup.put({
            key: historyKey(scope, messageKey),
            scope,
            value: task,
          });
        }
        messages.put({
          key: historyKey(scope, message.id),
          scope,
          groupId: message.groupId,
          userId: message.userId,
          clientId: message.clientId,
          sequence: message.sequence,
          searchBody: normalizeSearch(message.body),
          value: message,
        });
        const queued = await result(
          outbox.get(historyKey(scope, message.clientId)),
        );
        if (queued?.value.userId === message.userId)
          outbox.delete(historyKey(scope, message.clientId));
        if (!latest || latest.sequence < message.sequence) latest = message;
      }
      if (command.cursor !== undefined || command.changeCursor !== undefined) {
        const current = await result(
          cursors.get(historyKey(scope, command.groupId)),
        );
        cursors.put({
          key: historyKey(scope, command.groupId),
          scope,
          groupId: command.groupId,
          sequence: Math.max(current?.sequence ?? 0, command.cursor ?? 0),
          changeSequence: Math.max(
            current?.changeSequence ?? 0,
            command.changeCursor ?? 0,
          ),
        });
      }
      if (latest) {
        const row = await result(
          groups.get(historyKey(scope, command.groupId)),
        );
        if (
          row &&
          (!row.value.lastMessage ||
            row.value.lastMessage.sequence < latest.sequence ||
            (row.value.lastMessage.sequence === latest.sequence &&
              (row.value.lastMessage.revision ?? 0) <= (latest.revision ?? 0)))
        )
          groups.put({ ...row, value: { ...row.value, lastMessage: latest } });
      }
    }
    if (operation === "archiveMirror") {
      const existing = await result(
        archives.get(historyKey(scope, command.id)),
      );
      if (!existing) {
        const target = archiveScope(scope, command.id),
          oldGroups = await result(groups.index("scope").getAll(scope)),
          oldMessages = await result(
            messages
              .index("scopeSequence")
              .getAll(
                IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]),
              ),
          );
        if (oldMessages.length > 100000)
          throw new Error(
            "Export your saved history before reconciling this server restore.",
          );
        const recoveredGroups = mirrorGroups(
          oldGroups.map((row) => row.value),
          oldMessages.map((row) => row.value),
        );
        for (const group of recoveredGroups)
          groups.put({
            key: historyKey(target, group.id),
            scope: target,
            value: group,
          });
        for (const row of oldGroups) groups.delete(row.key);
        for (const row of oldMessages) {
          messages.put({
            ...row,
            key: historyKey(target, row.value.id),
            scope: target,
          });
          messages.delete(row.key);
        }
        const keys = await result(cursors.index("scope").getAllKeys(scope));
        for (const key of keys) cursors.delete(key);
        for (const row of await result(outbox.index("scope").getAll(scope)))
          outbox.put({
            ...row,
            value: { ...row.value, paused: true, status: "failed" },
          });
        const entry = {
          id: command.id,
          name: command.name,
          scope: target,
          importedAt: Date.now(),
          exportedAt: new Date().toISOString(),
          person: command.person,
          groups: recoveredGroups.length,
          messages: oldMessages.length,
          mediaSourceScope: scope,
        };
        archives.put({
          key: historyKey(scope, command.id),
          scope,
          value: entry,
        });
        response = entry;
      } else response = existing.value;
    }
    if (operation === "resetSync") {
      const keys = await result(cursors.index("scope").getAllKeys(scope));
      for (const key of keys) cursors.delete(key);
    }
    if (operation === "outboxControl") {
      const key = historyKey(scope, command.clientId),
        row = await result(outbox.get(key));
      if (row) {
        if (command.discard) outbox.delete(key);
        else
          outbox.put({
            ...row,
            value: {
              ...row.value,
              paused: command.paused,
              ...(command.cancelled ? { cancelled: true } : {}),
              status: "failed",
            },
          });
      }
    }
    if (operation === "fail") {
      const row = await result(outbox.get(historyKey(scope, command.clientId)));
      if (row)
        outbox.put({ ...row, value: { ...row.value, status: "failed" } });
    }
    await complete;
    return response;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await complete.catch(() => {});
    throw error;
  }
}
export function historyScope(session: Session) {
  return JSON.stringify([session.server, session.user.id]);
}
export async function history<T>(command: HistoryCommand): Promise<T> {
  const valid = validateHistoryCommand(command);
  const value = (
    window.desktop?.history
      ? await window.desktop.history(valid)
      : await browserExecute(valid)
  ) as T;
  if (
    ![
      "state",
      "lookup",
      "unread",
      "page",
      "search",
      "archives",
      "mediaCleanup",
      "mediaCleanupDone",
    ].includes(valid.operation)
  )
    window.dispatchEvent(
      new CustomEvent("gather:history-updated", {
        detail: { scope: valid.scope, operation: valid.operation },
      }),
    );
  return value;
}
