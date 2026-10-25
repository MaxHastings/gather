import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHistoryStore } from "../electron/history.mjs";
import { historyContract } from "./history-contract.mjs";

test("failed deletion-journal writes roll back message state and synchronization cursors", async (t) => {
  const directory = await mkdtemp(
      join(tmpdir(), "gather-cleanup-transaction-"),
    ),
    filename = join(directory, "history.sqlite"),
    store = createHistoryStore(filename);
  const fault = new DatabaseSync(filename);
  t.after(async () => {
    fault.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = "cleanup-fault",
    groupId = randomUUID(),
    userId = randomUUID(),
    attachmentId = randomUUID();
  const message = {
    id: randomUUID(),
    clientId: randomUUID(),
    groupId,
    userId,
    name: "Friend",
    sequence: 1,
    revision: 1,
    createdAt: Date.now(),
    body: "original",
    attachments: [
      {
        id: attachmentId,
        name: "original.txt",
        type: "application/octet-stream",
        bytes: 1,
        sha256: "a".repeat(64),
      },
    ],
  };
  store.execute({
    operation: "apply",
    scope,
    groupId,
    messages: [message],
    cursor: 1,
    changeCursor: 1,
  });
  fault.exec(
    "CREATE TRIGGER interrupt_cleanup BEFORE INSERT ON local_media_cleanup BEGIN SELECT RAISE(ABORT,'Injected cleanup failure'); END;",
  );
  const deleted = {
    ...message,
    body: "",
    attachments: undefined,
    deletedAt: Date.now(),
    revision: 2,
  };
  assert.throws(
    () =>
      store.execute({
        operation: "apply",
        scope,
        groupId,
        messages: [deleted],
        changeCursor: 2,
      }),
    /Injected cleanup/,
  );
  assert.equal(
    store.execute({ operation: "page", scope, groupId }).messages[0].body,
    "original",
  );
  assert.equal(
    store.execute({ operation: "state", scope }).changeCursors[groupId],
    1,
  );
  assert.deepEqual(store.execute({ operation: "mediaCleanup", scope }), []);
  fault.exec("DROP TRIGGER interrupt_cleanup");
  store.execute({
    operation: "apply",
    scope,
    groupId,
    messages: [deleted],
    changeCursor: 2,
  });
  assert.deepEqual(
    store.execute({ operation: "mediaCleanup", scope })[0].attachmentIds,
    [attachmentId],
  );
});
test("desktop history survives reopen and applies message/outbox/cursor changes atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-history-"));
  const filename = join(directory, "history.sqlite");
  let store = createHistoryStore(filename);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await historyContract(
    async (command) => store.execute(command),
    async () => {
      store.close();
      store = createHistoryStore(filename);
    },
  );
});

test("version one desktop history migrates without losing groups or the outbox", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-history-upgrade-"));
  const filename = join(directory, "history.sqlite");
  let store = createHistoryStore(filename);
  store.close();
  const old = new DatabaseSync(filename);
  old.exec(
    "DROP TABLE local_archives; DROP TABLE local_media_cleanup; ALTER TABLE local_cursors DROP COLUMN changeSequence; PRAGMA user_version=1;",
  );
  const groupId = randomUUID(),
    userId = randomUUID(),
    clientId = randomUUID();
  old.prepare("INSERT INTO local_groups VALUES (?,?,?,?)").run(
    "fixture-scope",
    groupId,
    1234,
    JSON.stringify({
      id: groupId,
      name: "Original chat",
      createdAt: 1234,
      members: [{ id: userId, name: "Alice" }],
      inviteCode: "original-invite-fixture",
      lastMessage: null,
    }),
  );
  old.prepare("INSERT INTO local_outbox VALUES (?,?,?,?,?)").run(
    "fixture-scope",
    clientId,
    userId,
    groupId,
    JSON.stringify({
      id: randomUUID(),
      clientId,
      groupId,
      userId,
      name: "Alice",
      sequence: 0,
      createdAt: 1234,
      status: "sending",
      body: "Original unsent draft",
    }),
  );
  old.close();
  store = createHistoryStore(filename);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const state = store.execute({ operation: "state", scope: "fixture-scope" });
  assert.equal(state.groups[0].name, "Original chat");
  assert.equal(state.outbox[0].body, "Original unsent draft");
  assert.deepEqual(
    store.execute({ operation: "archives", scope: "fixture-scope" }),
    [],
  );
  const fault = new DatabaseSync(filename);
  fault.exec(`CREATE TRIGGER interrupt_archive BEFORE INSERT ON local_messages
    WHEN instr(NEW.scope,'"archive"')>0 AND (SELECT COUNT(*) FROM local_messages WHERE scope=NEW.scope)>=3
    BEGIN SELECT RAISE(ABORT,'Injected archive write interruption'); END;`);
  const archive = {
    format: "gather-export-v1",
    exportedAt: new Date().toISOString(),
    user: { id: userId, name: "Alice" },
    groups: [
      {
        ...state.groups[0],
        messages: Array.from({ length: 10 }, (_, index) => ({
          id: randomUUID(),
          clientId: randomUUID(),
          groupId,
          userId,
          name: "Alice",
          sequence: index + 1,
          createdAt: 1234,
          body: `Saved message ${index}`,
        })),
      },
    ],
  };
  const command = {
    operation: "importArchive",
    scope: "fixture-scope",
    name: "Original history",
    archive,
  };
  try {
    assert.throws(() => store.execute(command), /Injected/);
    assert.equal(
      fault.prepare("SELECT COUNT(*) AS count FROM local_messages").get().count,
      0,
    );
    assert.equal(
      fault.prepare("SELECT COUNT(*) AS count FROM local_groups").get().count,
      1,
    );
    assert.equal(
      fault.prepare("SELECT COUNT(*) AS count FROM local_archives").get().count,
      0,
    );
    fault.exec("DROP TRIGGER interrupt_archive");
    assert.equal(store.execute(command).messages, 10);
    assert.equal(
      store.execute({ operation: "state", scope: "fixture-scope" }).outbox[0]
        .body,
      "Original unsent draft",
    );
  } finally {
    fault.close();
  }
});
