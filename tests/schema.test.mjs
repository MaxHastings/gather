import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initializeSchema, LATEST_SCHEMA_VERSION } from "../server/schema.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { restoreDatabase } from "../server/restore.mjs";
import { createDomain, hash } from "../server/domain.mjs";

test("existing deleted attachments are reannounced with cleanup references after schema six", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const domain = createDomain(db),
    profile = await domain.handle("POST", "/api/sessions", {
      name: "Upgrade friend",
    });
  const group = (
    await domain.handle("GET", "/api/bootstrap", {}, profile.token)
  ).groups[0];
  const message = await domain.handle(
      "POST",
      `/api/groups/${group.id}/messages`,
      { clientId: randomUUID(), body: "old file" },
      profile.token,
    ),
    uploadId = randomUUID();
  db.prepare("INSERT INTO media_uploads VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    uploadId,
    group.id,
    profile.user.id,
    `media/${uploadId}`,
    "old.txt",
    "application/octet-stream",
    1,
    "a".repeat(64),
    "committed",
    Date.now(),
  );
  db.prepare("INSERT INTO message_attachments VALUES (?,?,?)").run(
    message.id,
    uploadId,
    0,
  );
  const deleted = await domain.handle(
    "POST",
    `/api/messages/${message.id}/delete`,
    {},
    profile.token,
  );
  // Retire the newer, empty avatar tables to reproduce the schema-six fixture.
  sqlite.exec(
    "DROP TABLE message_replies; DROP TABLE cancelled_messages; DROP TABLE server_state; DROP TABLE group_departures; DROP TABLE group_controls; DROP TABLE avatar_slots; DROP TABLE avatar_images; DELETE FROM schema_versions WHERE version>6;",
  );
  initializeSchema(db);
  const replay = await domain.handle(
    "GET",
    `/api/groups/${group.id}/changes`,
    {},
    profile.token,
    new URLSearchParams({ after: String(deleted.revision) }),
  );
  assert.equal(replay.changes.length, 1);
  assert.deepEqual(replay.changes[0].message.deletedAttachmentIds, [uploadId]);
  assert.equal(replay.changes[0].message.body, "");
  assert.equal(replay.changes[0].message.attachments, undefined);
  initializeSchema(db);
  assert.equal(
    (
      await domain.handle(
        "GET",
        `/api/groups/${group.id}/changes`,
        {},
        profile.token,
        new URLSearchParams({ after: String(deleted.revision) }),
      )
    ).changes.length,
    1,
  );
});
test("version one archives restore and migrate without changing identities, grants or messages", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db = sqliteAdapter(sqlite);
  initializeSchema(db, 1);
  const userId = randomUUID(),
    groupId = randomUUID(),
    token = "schema-fixture-only";
  db.prepare("INSERT INTO users VALUES (?,?,?)").run(
    userId,
    "Original person",
    1234,
  );
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
    hash(token),
    userId,
    1234,
  );
  db.prepare("INSERT INTO groups VALUES (?,?,?,?)").run(
    groupId,
    "Original group",
    "old-invite-code-123456",
    1234,
  );
  db.prepare("INSERT INTO memberships VALUES (?,?)").run(groupId, userId);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run(
    70,
    randomUUID(),
    randomUUID(),
    groupId,
    userId,
    "Original history",
    1234,
  );
  const oldSnapshot = captureSnapshot(db);
  const restored = restoreDatabase(oldSnapshot);
  t.after(() => restored.close());
  const domain = createDomain(sqliteAdapter(restored));
  assert.equal(domain.authorize(token).id, userId);
  assert.equal(
    (await domain.handle("GET", `/api/groups/${groupId}/messages`, {}, token))
      .messages[0].body,
    "Original history",
  );
  assert.equal(
    restored.prepare("SELECT name FROM devices").get().name,
    "Existing device",
  );
  initializeSchema(sqliteAdapter(restored));
  assert.deepEqual(
    restored
      .prepare("SELECT version FROM schema_versions ORDER BY version")
      .all()
      .map((row) => row.version),
    Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
  );
  assert.equal(
    (
      await domain.handle(
        "POST",
        `/api/groups/${groupId}/messages`,
        { clientId: randomUUID(), body: "New after upgrade" },
        token,
      )
    ).sequence,
    71,
  );
});
test("failed migrations roll back completely and newer schemas refuse older servers", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db, 1);
  const failing = {
    ...db,
    prepare: (sql) => {
      if (sql.includes("CREATE TABLE recovery_codes"))
        throw new Error("Injected migration interruption");
      return db.prepare(sql);
    },
  };
  assert.throws(() => initializeSchema(failing), /Injected/);
  assert.equal(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name='devices'").get(),
    undefined,
  );
  assert.equal(
    sqlite.prepare("SELECT MAX(version) AS version FROM schema_versions").get()
      .version,
    1,
  );
  initializeSchema(db);
  db.prepare("INSERT INTO schema_versions VALUES (?)").run(
    LATEST_SCHEMA_VERSION + 1,
  );
  assert.throws(() => initializeSchema(db), /newer Gather/);
  assert.equal(
    sqlite.prepare("SELECT MAX(version) AS version FROM schema_versions").get()
      .version,
    LATEST_SCHEMA_VERSION + 1,
  );
});
