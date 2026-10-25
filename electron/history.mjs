import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { archiveScope } from "../server/archive-format.mjs";
import {
  validateHistoryCommand,
  normalizeSearch,
  assertHistoryIdentity,
  assertQueuedIdentity,
  mediaCleanupTask,
  mirrorGroups,
} from "../server/history-contract.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";

export function createHistoryStore(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  const version = sqlite.prepare("PRAGMA user_version").get().user_version;
  if (version > 4) {
    sqlite.close();
    throw new Error("This history needs a newer Gather version.");
  }
  const db = sqliteAdapter(sqlite);
  if (version === 0)
    db.transaction(() => {
      sqlite.exec(`
      CREATE TABLE local_groups(scope TEXT NOT NULL,id TEXT NOT NULL,createdAt INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE local_messages(scope TEXT NOT NULL,id TEXT NOT NULL,groupId TEXT NOT NULL,userId TEXT NOT NULL,clientId TEXT NOT NULL,sequence INTEGER NOT NULL,searchBody TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id),UNIQUE(scope,userId,clientId));
      CREATE INDEX local_messages_group ON local_messages(scope,groupId,sequence);
      CREATE INDEX local_messages_scope ON local_messages(scope,sequence);
      CREATE TABLE local_outbox(scope TEXT NOT NULL,clientId TEXT NOT NULL,userId TEXT NOT NULL,groupId TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,clientId));
      CREATE TABLE local_cursors(scope TEXT NOT NULL,groupId TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(scope,groupId));
      PRAGMA user_version=1;
    `);
    });
  if (version < 2)
    db.transaction(() => {
      sqlite.exec(
        "CREATE TABLE local_archives(scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id)); PRAGMA user_version=2;",
      );
    });
  if (version < 3)
    db.transaction(() =>
      sqlite.exec(
        "ALTER TABLE local_cursors ADD COLUMN changeSequence INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;",
      ),
    );
  if (version < 4)
    db.transaction(() => {
      sqlite.exec(
        "CREATE TABLE local_media_cleanup(scope TEXT NOT NULL,messageKey TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,messageKey));",
      );
      const insert = sqlite.prepare(
        "INSERT OR IGNORE INTO local_media_cleanup VALUES (?,?,?)",
      );
      for (const row of sqlite
        .prepare(
          "SELECT scope,payload FROM local_messages WHERE json_extract(payload,'$.deletedAt') IS NOT NULL",
        )
        .all()) {
        const task = mediaCleanupTask(JSON.parse(row.payload));
        insert.run(row.scope, task.messageKey, JSON.stringify(task));
      }
      sqlite.exec("PRAGMA user_version=4;");
    });
  const parseRows = (rows) => rows.map((row) => JSON.parse(row.payload));
  function execute(input) {
    const command = validateHistoryCommand(input);
    const { scope, operation } = command;
    if (operation === "mediaCleanup")
      return parseRows(
        sqlite
          .prepare(
            "SELECT payload FROM local_media_cleanup WHERE scope=? ORDER BY messageKey LIMIT 100",
          )
          .all(scope),
      );
    if (operation === "archives")
      return parseRows(
        sqlite
          .prepare(
            "SELECT payload FROM local_archives WHERE scope=? ORDER BY id",
          )
          .all(scope),
      );
    if (operation === "lookup") {
      const row = sqlite
        .prepare(
          "SELECT payload FROM local_messages WHERE scope=? AND groupId=? AND id=?",
        )
        .get(scope, command.groupId, command.id);
      return row ? JSON.parse(row.payload) : null;
    }
    if (operation === "unread")
      return Object.fromEntries(
        Object.entries(command.after).map(([groupId, after]) => {
          const rows = sqlite
            .prepare(
              "SELECT id FROM local_messages WHERE scope=? AND groupId=? AND sequence>? AND userId<>? AND json_extract(payload,'$.deletedAt') IS NULL ORDER BY sequence",
            )
            .all(scope, groupId, after, command.userId);
          return [groupId, { count: rows.length, firstId: rows[0]?.id }];
        }),
      );
    if (operation === "state")
      return {
        groups: parseRows(
          sqlite
            .prepare(
              "SELECT payload FROM local_groups WHERE scope=? ORDER BY createdAt,id",
            )
            .all(scope),
        ),
        outbox: parseRows(
          sqlite
            .prepare("SELECT payload FROM local_outbox WHERE scope=?")
            .all(scope),
        ),
        cursors: Object.fromEntries(
          sqlite
            .prepare("SELECT groupId,sequence FROM local_cursors WHERE scope=?")
            .all(scope)
            .map((row) => [row.groupId, row.sequence]),
        ),
        changeCursors: Object.fromEntries(
          sqlite
            .prepare(
              "SELECT groupId,changeSequence FROM local_cursors WHERE changeSequence>0 AND scope=?",
            )
            .all(scope)
            .map((row) => [row.groupId, row.changeSequence]),
        ),
      };
    if (operation === "page") {
      const limit = command.limit ?? 50;
      const forward = command.after !== undefined;
      const rows = sqlite
        .prepare(
          forward
            ? "SELECT payload FROM local_messages WHERE scope=? AND groupId=? AND sequence>? ORDER BY sequence ASC LIMIT ?"
            : "SELECT payload FROM local_messages WHERE scope=? AND groupId=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
        )
        .all(
          scope,
          command.groupId,
          command.after ?? command.before ?? Number.MAX_SAFE_INTEGER,
          limit + 1,
        );
      return {
        messages: forward
          ? parseRows(rows.slice(0, limit))
          : parseRows(rows.slice(0, limit)).reverse(),
        hasMore: rows.length > limit,
      };
    }
    if (operation === "search") {
      const query = normalizeSearch(command.query.trim());
      return parseRows(
        command.groupId
          ? sqlite
              .prepare(
                "SELECT payload FROM local_messages WHERE scope=? AND groupId=? AND instr(searchBody,?)>0 ORDER BY sequence DESC LIMIT 50",
              )
              .all(scope, command.groupId, query)
          : sqlite
              .prepare(
                "SELECT payload FROM local_messages WHERE scope=? AND instr(searchBody,?)>0 ORDER BY sequence DESC LIMIT 50",
              )
              .all(scope, query),
      );
    }
    return db.transaction(() => {
      if (operation === "mediaCleanupDone")
        for (const key of command.messageKeys)
          sqlite
            .prepare(
              "DELETE FROM local_media_cleanup WHERE scope=? AND messageKey=?",
            )
            .run(scope, key);
      if (operation === "importArchive") {
        const archive = command.archive;
        const id = createHash("sha256")
          .update(JSON.stringify(archive))
          .digest("hex");
        const existing = sqlite
          .prepare("SELECT payload FROM local_archives WHERE scope=? AND id=?")
          .get(scope, id);
        if (existing)
          return { ...JSON.parse(existing.payload), alreadyImported: true };
        const target = archiveScope(scope, id);
        if (target.length > 512)
          throw new Error(
            "This server address is too long for an imported archive.",
          );
        if (
          sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM local_archives WHERE scope=?",
            )
            .get(scope).count >= 100
        )
          throw new Error("Remove an imported archive before adding more.");
        let count = 0;
        const insertGroup = sqlite.prepare(
          "INSERT INTO local_groups VALUES (?,?,?,?)",
        );
        const insertMessage = sqlite.prepare(
          "INSERT INTO local_messages VALUES (?,?,?,?,?,?,?,?)",
        );
        for (const { messages, ...group } of archive.groups) {
          insertGroup.run(
            target,
            group.id,
            group.createdAt,
            JSON.stringify(group),
          );
          for (const message of messages) {
            insertMessage.run(
              target,
              message.id,
              message.groupId,
              message.userId,
              message.clientId,
              message.sequence,
              normalizeSearch(message.body),
              JSON.stringify(message),
            );
            count++;
          }
        }
        const entry = {
          id,
          name: command.name,
          scope: target,
          importedAt: Date.now(),
          exportedAt: archive.exportedAt,
          person: archive.user.name,
          groups: archive.groups.length,
          messages: count,
        };
        sqlite
          .prepare("INSERT INTO local_archives VALUES (?,?,?)")
          .run(scope, id, JSON.stringify(entry));
        return entry;
      }
      if (operation === "deleteArchive") {
        const target = archiveScope(scope, command.id);
        for (const name of [
          "local_groups",
          "local_messages",
          "local_outbox",
          "local_cursors",
          "local_media_cleanup",
        ])
          sqlite.prepare(`DELETE FROM ${name} WHERE scope=?`).run(target);
        sqlite
          .prepare("DELETE FROM local_archives WHERE scope=? AND id=?")
          .run(scope, command.id);
      }
      if (operation === "bootstrap") {
        const insert = sqlite.prepare(
          "INSERT INTO local_groups VALUES (?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET createdAt=excluded.createdAt,payload=excluded.payload",
        );
        for (let group of command.groups) {
          const row = sqlite
            .prepare("SELECT payload FROM local_groups WHERE scope=? AND id=?")
            .get(scope, group.id);
          const previous = row ? JSON.parse(row.payload) : undefined;
          if (
            previous?.lastMessage &&
            previous.lastMessage.sequence > (group.lastMessage?.sequence ?? 0)
          )
            group = { ...group, lastMessage: previous.lastMessage };
          insert.run(scope, group.id, group.createdAt, JSON.stringify(group));
        }
      }
      if (operation === "queue") {
        const message = command.message;
        if (command.replaceClientId) {
          const row = sqlite
              .prepare(
                "SELECT payload FROM local_outbox WHERE scope=? AND clientId=?",
              )
              .get(scope, command.replaceClientId),
            previous = row ? JSON.parse(row.payload) : null;
          if (
            !previous ||
            !previous.cancelled ||
            !previous.paused ||
            previous.userId !== message.userId ||
            previous.groupId !== message.groupId
          )
            throw new Error(
              "This unsent draft changed. Reopen it before sending.",
            );
          sqlite
            .prepare("DELETE FROM local_outbox WHERE scope=? AND clientId=?")
            .run(scope, command.replaceClientId);
        }

        const accepted = sqlite
          .prepare(
            "SELECT payload FROM local_messages WHERE scope=? AND userId=? AND clientId=?",
          )
          .get(scope, message.userId, message.clientId);
        if (accepted) {
          assertQueuedIdentity(JSON.parse(accepted.payload), message);
          return { accepted: JSON.parse(accepted.payload) };
        }
        const queued = sqlite
          .prepare(
            "SELECT payload FROM local_outbox WHERE scope=? AND clientId=?",
          )
          .get(scope, message.clientId);
        if (queued) {
          assertQueuedIdentity(JSON.parse(queued.payload), message);
          return { queued: true };
        }
        if (
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM local_outbox WHERE scope=?")
            .get(scope).count >= 1000
        )
          throw new Error(
            "Your unsent queue is full. Reconnect before sending more.",
          );
        sqlite
          .prepare("INSERT INTO local_outbox VALUES (?,?,?,?,?)")
          .run(
            scope,
            message.clientId,
            message.userId,
            message.groupId,
            JSON.stringify(message),
          );
      }
      if (operation === "apply") {
        const insert = sqlite.prepare(
          "INSERT INTO local_messages VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET searchBody=excluded.searchBody,payload=excluded.payload",
        );
        let latest;
        for (const message of command.messages) {
          const existing = sqlite
            .prepare(
              "SELECT payload FROM local_messages WHERE scope=? AND id=?",
            )
            .get(scope, message.id);
          assertHistoryIdentity(
            existing ? JSON.parse(existing.payload) : undefined,
            message,
          );
          if (
            existing &&
            ((JSON.parse(existing.payload).revision ?? 0) >
              (message.revision ?? 0) ||
              (JSON.parse(existing.payload).deletedAt && !message.deletedAt))
          )
            continue;
          if (message.deletedAt) {
            const messageKey = `${message.userId}:${message.clientId}`;
            const priorTask = sqlite
              .prepare(
                "SELECT payload FROM local_media_cleanup WHERE scope=? AND messageKey=?",
              )
              .get(scope, messageKey);
            const pending = sqlite
              .prepare(
                "SELECT payload FROM local_outbox WHERE scope=? AND userId=? AND clientId=?",
              )
              .get(scope, message.userId, message.clientId);
            const task = mediaCleanupTask(
              message,
              existing ? JSON.parse(existing.payload) : undefined,
              pending ? JSON.parse(pending.payload) : undefined,
              priorTask ? JSON.parse(priorTask.payload) : undefined,
            );
            sqlite
              .prepare(
                "INSERT INTO local_media_cleanup VALUES (?,?,?) ON CONFLICT(scope,messageKey) DO UPDATE SET payload=excluded.payload",
              )
              .run(scope, messageKey, JSON.stringify(task));
          }
          insert.run(
            scope,
            message.id,
            message.groupId,
            message.userId,
            message.clientId,
            message.sequence,
            normalizeSearch(message.body),
            JSON.stringify(message),
          );
          sqlite
            .prepare(
              "DELETE FROM local_outbox WHERE scope=? AND userId=? AND clientId=?",
            )
            .run(scope, message.userId, message.clientId);
          if (!latest || latest.sequence < message.sequence) latest = message;
        }
        if (command.cursor !== undefined || command.changeCursor !== undefined)
          sqlite
            .prepare(
              "INSERT INTO local_cursors(scope,groupId,sequence,changeSequence) VALUES (?,?,?,?) ON CONFLICT(scope,groupId) DO UPDATE SET sequence=MAX(sequence,excluded.sequence),changeSequence=MAX(changeSequence,excluded.changeSequence)",
            )
            .run(
              scope,
              command.groupId,
              command.cursor ?? 0,
              command.changeCursor ?? 0,
            );
        if (latest) {
          const row = sqlite
            .prepare("SELECT payload FROM local_groups WHERE scope=? AND id=?")
            .get(scope, command.groupId);
          if (row) {
            const group = JSON.parse(row.payload);
            if (
              !group.lastMessage ||
              group.lastMessage.sequence < latest.sequence ||
              (group.lastMessage.sequence === latest.sequence &&
                (group.lastMessage.revision ?? 0) <= (latest.revision ?? 0))
            )
              sqlite
                .prepare(
                  "UPDATE local_groups SET payload=? WHERE scope=? AND id=?",
                )
                .run(
                  JSON.stringify({ ...group, lastMessage: latest }),
                  scope,
                  group.id,
                );
          }
        }
      }
      if (operation === "archiveMirror") {
        const existing = sqlite
          .prepare("SELECT payload FROM local_archives WHERE scope=? AND id=?")
          .get(scope, command.id);
        if (existing) return JSON.parse(existing.payload);
        const target = archiveScope(scope, command.id),
          count = sqlite
            .prepare("SELECT COUNT(*) n FROM local_messages WHERE scope=?")
            .get(scope).n;
        if (count > 100000)
          throw new Error(
            "Export your saved history before reconciling this server restore.",
          );
        const recoveredGroups = mirrorGroups(
          parseRows(
            sqlite
              .prepare("SELECT payload FROM local_groups WHERE scope=?")
              .all(scope),
          ),
          parseRows(
            sqlite
              .prepare("SELECT payload FROM local_messages WHERE scope=?")
              .all(scope),
          ),
        );
        for (const group of recoveredGroups)
          sqlite
            .prepare("INSERT INTO local_groups VALUES (?,?,?,?)")
            .run(target, group.id, group.createdAt, JSON.stringify(group));
        sqlite
          .prepare(
            "INSERT INTO local_messages SELECT ?,id,groupId,userId,clientId,sequence,searchBody,payload FROM local_messages WHERE scope=?",
          )
          .run(target, scope);
        sqlite.prepare("DELETE FROM local_groups WHERE scope=?").run(scope);
        sqlite.prepare("DELETE FROM local_messages WHERE scope=?").run(scope);
        sqlite.prepare("DELETE FROM local_cursors WHERE scope=?").run(scope);
        for (const row of sqlite
          .prepare("SELECT clientId,payload FROM local_outbox WHERE scope=?")
          .all(scope))
          sqlite
            .prepare(
              "UPDATE local_outbox SET payload=? WHERE scope=? AND clientId=?",
            )
            .run(
              JSON.stringify({
                ...JSON.parse(row.payload),
                paused: true,
                status: "failed",
              }),
              scope,
              row.clientId,
            );
        const entry = {
          id: command.id,
          name: command.name,
          scope: target,
          importedAt: Date.now(),
          exportedAt: new Date().toISOString(),
          person: command.person,
          groups: recoveredGroups.length,
          messages: count,
          mediaSourceScope: scope,
        };
        sqlite
          .prepare("INSERT INTO local_archives VALUES (?,?,?)")
          .run(scope, command.id, JSON.stringify(entry));
        return entry;
      }
      if (operation === "resetSync")
        sqlite.prepare("DELETE FROM local_cursors WHERE scope=?").run(scope);
      if (operation === "outboxControl") {
        const row = sqlite
          .prepare(
            "SELECT payload FROM local_outbox WHERE scope=? AND clientId=?",
          )
          .get(scope, command.clientId);
        if (row) {
          if (command.discard)
            sqlite
              .prepare("DELETE FROM local_outbox WHERE scope=? AND clientId=?")
              .run(scope, command.clientId);
          else
            sqlite
              .prepare(
                "UPDATE local_outbox SET payload=? WHERE scope=? AND clientId=?",
              )
              .run(
                JSON.stringify({
                  ...JSON.parse(row.payload),
                  paused: command.paused,
                  ...(command.cancelled ? { cancelled: true } : {}),
                  status: "failed",
                }),
                scope,
                command.clientId,
              );
        }
      }
      if (operation === "fail") {
        const row = sqlite
          .prepare(
            "SELECT payload FROM local_outbox WHERE scope=? AND clientId=?",
          )
          .get(scope, command.clientId);
        if (row)
          sqlite
            .prepare(
              "UPDATE local_outbox SET payload=? WHERE scope=? AND clientId=?",
            )
            .run(
              JSON.stringify({ ...JSON.parse(row.payload), status: "failed" }),
              scope,
              command.clientId,
            );
      }
      return { ok: true };
    });
  }
  return { execute, close: () => sqlite.close() };
}
