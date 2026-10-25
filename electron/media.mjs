import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  validateLocalMedia,
  mediaSettings,
  planMediaChange,
  LOCAL_MEDIA_ENTRIES,
  createMediaClock,
} from "../server/media-contract.mjs";

export function createMediaCache(filename, options = {}) {
  const db = new DatabaseSync(filename),
    version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 3) {
    db.close();
    throw new Error("These saved files need a newer Gather version.");
  }
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS media(scope TEXT NOT NULL,id TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,pinned INTEGER NOT NULL,touched INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,id));",
    );
    if (version < 2)
      db.exec(`
      ALTER TABLE media RENAME COLUMN pinned TO flags;
      ALTER TABLE media ADD COLUMN name TEXT NOT NULL DEFAULT 'File';
      ALTER TABLE media ADD COLUMN type TEXT NOT NULL DEFAULT 'application/octet-stream';
      ALTER TABLE media ADD COLUMN messageKey TEXT NOT NULL DEFAULT '';
      ALTER TABLE media ADD COLUMN cloudUntil INTEGER NOT NULL DEFAULT 0;
    `);
    if (version < 3)
      db.exec(
        "ALTER TABLE media ADD COLUMN proofTag TEXT NOT NULL DEFAULT '';",
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS media_config(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS media_revocations(scope TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,kind,value)); PRAGMA user_version=3;",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const clock = options.clock ?? createMediaClock();
  const now = () => clock.read().wall;
  const entryLimit = Math.min(
    LOCAL_MEDIA_ENTRIES,
    options.entryLimit ?? LOCAL_MEDIA_ENTRIES,
  );
  const freeBytes =
    options.freeBytes ??
    (() => {
      try {
        const fs = statfsSync(dirname(filename));
        return fs.bavail * fs.bsize;
      } catch {
        return undefined;
      }
    });
  const revoked = (scope, kind, value) =>
    Boolean(
      value &&
      db
        .prepare(
          "SELECT 1 FROM media_revocations WHERE scope=? AND kind=? AND value=?",
        )
        .get(scope, kind, value),
    );
  function execute(input) {
    const c = validateLocalMedia(input);
    if (c.operation === "get") {
      const row = db
        .prepare("SELECT data,messageKey FROM media WHERE scope=? AND id=?")
        .get(c.scope, c.id);
      if (
        !row ||
        revoked(c.scope, "file", c.id) ||
        revoked(c.scope, "message", row.messageKey)
      )
        return null;
      db.prepare("UPDATE media SET touched=? WHERE scope=? AND id=?").run(
        now(),
        c.scope,
        c.id,
      );
      return row.data;
    }
    if (c.operation === "put") {
      if (createHash("sha256").update(c.data).digest("hex") !== c.sha256)
        throw new Error("Attachment checksum does not match.");
      const available = freeBytes();
      if (
        Number.isFinite(available) &&
        available < 50_000_000 + c.data.byteLength * 2
      )
        throw new Error(
          "This device is low on disk space. Free some space before saving more files.",
        );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = c.id
        ? db
            .prepare("SELECT messageKey FROM media WHERE scope=? AND id=?")
            .get(c.scope, c.id)
        : null;
      if (
        c.operation === "put" &&
        (revoked(c.scope, "file", c.id) ||
          revoked(c.scope, "message", c.messageKey || existing?.messageKey))
      )
        throw new Error(
          "This message was deleted. Its file cannot be saved again.",
        );
      if (
        c.operation === "observe" &&
        !c.deleted &&
        revoked(c.scope, "message", c.messageKey)
      ) {
        db.exec("COMMIT");
        return { ok: true };
      }
      const rows = db
        .prepare(
          "SELECT scope,id,sha256,bytes,flags,touched,name,type,messageKey,cloudUntil,proofTag FROM media",
        )
        .all();
      const stored = db
        .prepare("SELECT payload FROM media_config WHERE id=1")
        .get();
      const settings = mediaSettings(
        stored ? JSON.parse(stored.payload) : undefined,
        true,
      );
      const plan = planMediaChange(rows, settings, c, clock.read(), entryLimit);
      for (const key of plan.removed)
        db.prepare("DELETE FROM media WHERE scope=? AND id=?").run(
          ...JSON.parse(key),
        );
      for (const r of plan.upserts) {
        if (c.operation === "put" && r.scope === c.scope && r.id === c.id)
          db.prepare(
            "INSERT INTO media(scope,id,sha256,bytes,flags,touched,name,type,messageKey,cloudUntil,proofTag,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET flags=excluded.flags,touched=excluded.touched,name=excluded.name,type=excluded.type,messageKey=excluded.messageKey,cloudUntil=excluded.cloudUntil,proofTag=excluded.proofTag,data=excluded.data",
          ).run(
            r.scope,
            r.id,
            r.sha256,
            r.bytes,
            r.flags,
            r.touched,
            r.name,
            r.type,
            r.messageKey,
            r.cloudUntil,
            r.proofTag,
            c.data,
          );
        else
          db.prepare(
            "UPDATE media SET flags=?,touched=?,name=?,type=?,messageKey=?,cloudUntil=?,proofTag=? WHERE scope=? AND id=?",
          ).run(
            r.flags,
            r.touched,
            r.name,
            r.type,
            r.messageKey,
            r.cloudUntil,
            r.proofTag,
            r.scope,
            r.id,
          );
      }
      if (c.operation === "configure")
        db.prepare(
          "INSERT INTO media_config VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        ).run(JSON.stringify(plan.settings));
      if (c.operation === "observe" && c.deleted) {
        const insert = db.prepare(
          "INSERT OR IGNORE INTO media_revocations VALUES (?,?,?)",
        );
        insert.run(c.scope, "message", c.messageKey);
        for (const id of new Set([
          ...c.attachments.map((a) => a.id),
          ...(c.attachmentIds ?? []),
          ...plan.removed.map((key) => JSON.parse(key)[1]),
        ]))
          insert.run(c.scope, "file", id);
      }
      db.exec("COMMIT");
      if (c.operation === "status") {
        let allocatedBytes = 0;
        for (const path of [filename, filename + "-wal"]) {
          try {
            allocatedBytes += statSync(path).size;
          } catch {}
        }
        return { ...plan.response, freeBytes: freeBytes(), allocatedBytes };
      }
      return plan.response;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { execute, close: () => db.close() };
}
