import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export async function historyContract(execute, reopen) {
  await queueContract(execute, reopen);
  const scope = JSON.stringify(["https://gather.example", randomUUID()]);
  const otherScope = JSON.stringify(["https://another.example", randomUUID()]);
  const userId = randomUUID(),
    groupId = randomUUID();
  const group = {
    id: groupId,
    name: "The crew",
    createdAt: Date.now(),
    inviteCode: "test-invite-code",
    members: [{ id: userId, name: "Alice" }],
    lastMessage: null,
  };
  const call = (operation, extra = {}, target = scope) =>
    execute({ operation, scope: target, ...extra });
  assert.deepEqual(await call("state"), {
    groups: [],
    outbox: [],
    cursors: {},
    changeCursors: {},
  });
  await call("bootstrap", { groups: [group] });
  const queued = {
    id: randomUUID(),
    clientId: randomUUID(),
    sequence: 0,
    groupId,
    userId,
    name: "Alice",
    body: "First queued message",
    createdAt: Date.now(),
    status: "sending",
  };
  await call("queue", { message: queued });
  await assert.rejects(
    call("queue", { message: { ...queued, groupId: randomUUID() } }),
    /already used/,
  );
  await call("fail", { clientId: queued.clientId });
  await reopen();
  assert.equal((await call("state")).outbox[0].status, "failed");
  const first = { ...queued, id: randomUUID(), sequence: 1 };
  delete first.status;
  await call("apply", { groupId, messages: [first], cursor: 1 });
  await call("apply", { groupId, messages: [first], cursor: 1 });
  let state = await call("state");
  assert.equal(state.outbox.length, 0);
  assert.equal(state.cursors[groupId], 1);
  await call("apply", {
    groupId,
    messages: [
      {
        ...first,
        revision: 3,
        reactions: [{ emoji: "👍", userIds: [userId] }],
      },
    ],
    changeCursor: 99,
  });
  await call("apply", { groupId, messages: [first], changeCursor: 1 });
  assert.equal((await call("page", { groupId })).messages[0].revision, 3);
  assert.equal((await call("state")).changeCursors[groupId], 99);
  assert.equal(
    (await call("queue", { message: queued })).accepted.id,
    first.id,
  );
  const newMessage = (sequence) => ({
    id: randomUUID(),
    clientId: randomUUID(),
    sequence,
    groupId,
    userId,
    name: "Alice",
    body:
      sequence % 15 === 0 ? `ＮＥＥＤＬＥ ${sequence}` : `Message ${sequence}`,
    createdAt: Date.now(),
  });
  await assert.rejects(
    call("apply", {
      groupId,
      messages: [newMessage(2), { ...first, sequence: 3 }],
      cursor: 3,
    }),
    /cannot be changed/,
  );
  assert.equal((await call("state")).cursors[groupId], 1);
  assert.equal((await call("page", { groupId })).messages.length, 1);
  const remaining = Array.from({ length: 120 }, (_, index) =>
    newMessage(index + 2),
  );
  await call("apply", { groupId, messages: remaining, cursor: 121 });
  await call("bootstrap", { groups: [group] });
  await reopen();
  state = await call("state");
  assert.equal(state.cursors[groupId], 121);
  assert.equal(state.groups[0].lastMessage.sequence, 121);
  const page = await call("page", { groupId });
  assert.equal(page.messages.length, 50);
  assert.equal(page.messages[0].sequence, 72);
  assert.equal(page.hasMore, true);
  const older = await call("page", { groupId, before: 72 });
  const later = await call("page", { groupId, after: 1 });
  assert.equal(later.messages[0].sequence, 2);
  assert.equal(later.messages.at(-1).sequence, 51);
  assert.equal(later.hasMore, true);
  const latest = await call("page", { groupId, after: 72 });
  assert.equal(latest.messages.length, 49);
  assert.equal(latest.hasMore, false);
  await assert.rejects(
    call("page", { groupId, before: 10, after: 1 }),
    /Invalid/,
  );
  assert.equal(older.messages[0].sequence, 22);
  const oldest = await call("page", { groupId, before: 22 });
  assert.equal(oldest.messages.length, 21);
  assert.equal(oldest.hasMore, false);
  assert.equal((await call("search", { query: "needle" })).length, 8);
  assert.equal((await call("search", { query: "%" })).length, 0);
  assert.deepEqual(await call("state", {}, otherScope), {
    groups: [],
    outbox: [],
    cursors: {},
    changeCursors: {},
  });
  assert.equal(
    (await call("page", { groupId }, otherScope)).messages.length,
    0,
  );
  await assert.rejects(
    call("apply", { groupId, messages: [newMessage(125)], cursor: 124 }),
    /cursor/,
  );
  await assert.rejects(
    call("execute_sql", { sql: "DROP TABLE local_messages" }),
    /Unsupported/,
  );
  assert.equal((await call("page", { groupId })).messages.length, 50);
  const archive = {
    format: "gather-export-v1",
    exportedAt: new Date().toISOString(),
    user: { id: userId, name: "Alice" },
    groups: [
      {
        ...group,
        inviteCode: "private-invite-must-not-transfer",
        messages: [first, ...remaining],
      },
    ],
  };
  const imported = await call("importArchive", {
    name: "Old chat archive",
    archive,
  });
  assert.equal(imported.messages, 121);
  assert.equal((await call("archives")).length, 1);
  assert.equal(
    (await call("state", {}, imported.scope)).groups[0].inviteCode,
    "",
  );
  assert.equal((await call("state", {}, imported.scope)).outbox.length, 0);
  assert.deepEqual((await call("state", {}, imported.scope)).cursors, {});
  assert.equal(
    (await call("page", { groupId }, imported.scope)).messages.length,
    50,
  );
  await reopen();
  assert.equal((await call("archives"))[0].id, imported.id);
  assert.equal(
    (await call("importArchive", { name: "Same file again", archive }))
      .alreadyImported,
    true,
  );
  assert.equal((await call("archives")).length, 1);
  await call("deleteArchive", { id: imported.id }, otherScope);
  assert.equal((await call("archives")).length, 1);
  const invalid = structuredClone(archive);
  invalid.groups[0].messages.push(first);
  await assert.rejects(
    call("importArchive", { name: "Invalid", archive: invalid }),
    /duplicate/,
  );
  assert.equal((await call("archives")).length, 1);
  await call("deleteArchive", { id: imported.id });
  assert.equal((await call("archives")).length, 0);
  assert.equal(
    (await call("page", { groupId }, imported.scope)).messages.length,
    0,
  );
  assert.equal((await call("page", { groupId })).messages.length, 50);
  const finalMessage = (await call("page", { groupId })).messages.at(-1);
  const deleted = {
    ...finalMessage,
    body: "",
    deletedAt: Date.now(),
    revision: 9000,
    contentRevision: 9000,
  };
  await call("apply", { groupId, messages: [deleted], changeCursor: 9000 });
  await call("apply", {
    groupId,
    messages: [{ ...finalMessage, revision: 10000 }],
  });
  await reopen();
  assert.equal(
    (await call("page", { groupId })).messages.at(-1).deletedAt,
    deleted.deletedAt,
  );
  assert.equal(
    (await call("state")).groups.find((g) => g.id === groupId).lastMessage.body,
    "",
  );
  assert.equal(
    (await call("search", { query: finalMessage.body })).some(
      (m) => m.id === finalMessage.id,
    ),
    false,
  );
  const attachment = {
    id: randomUUID(),
    name: "kept.txt",
    type: "application/octet-stream",
    bytes: 12,
    sha256: "a".repeat(64),
  };
  const withFile = {
    ...finalMessage,
    id: randomUUID(),
    clientId: randomUUID(),
    sequence: finalMessage.sequence + 1,
    revision: 10001,
    attachments: [attachment],
  };
  await call("apply", { groupId, messages: [withFile] });
  const removed = {
    ...withFile,
    body: "",
    attachments: undefined,
    deletedAt: Date.now(),
    revision: 10002,
    contentRevision: 10002,
  };
  await call("apply", { groupId, messages: [removed], changeCursor: 10002 });
  await reopen();
  const key = `${removed.userId}:${removed.clientId}`;
  assert.deepEqual(
    (await call("mediaCleanup")).find((task) => task.messageKey === key)
      .attachmentIds,
    [attachment.id],
  );
  await call("mediaCleanupDone", { messageKeys: [key] }, otherScope);
  assert.ok(
    (await call("mediaCleanup")).some((task) => task.messageKey === key),
  );
  await call("mediaCleanupDone", { messageKeys: [key] });
  assert.equal(
    (await call("mediaCleanup")).some((task) => task.messageKey === key),
    false,
  );
  // A device can first learn of a deleted attachment from the server's tombstone.
  const unseen = {
    ...removed,
    id: randomUUID(),
    clientId: randomUUID(),
    sequence: withFile.sequence + 1,
    revision: 10003,
    deletedAttachmentIds: [randomUUID()],
  };
  await call("apply", { groupId, messages: [unseen], changeCursor: 10003 });
  assert.deepEqual(
    (await call("mediaCleanup")).find(
      (task) => task.messageKey === `${unseen.userId}:${unseen.clientId}`,
    ).attachmentIds,
    unseen.deletedAttachmentIds,
  );
}

export async function queueContract(execute, reopen) {
  const scope = JSON.stringify(["https://queue.example", randomUUID()]),
    userId = randomUUID(),
    groupId = randomUUID();
  const call = (operation, extra = {}) =>
    execute({ scope, operation, ...extra });
  const original = {
    id: randomUUID(),
    clientId: randomUUID(),
    userId,
    groupId,
    name: "Max",
    body: "Draft with original bytes",
    createdAt: 1,
    sequence: 0,
    status: "failed",
  };
  await call("queue", { message: original });
  await call("outboxControl", {
    clientId: original.clientId,
    paused: true,
    cancelled: true,
  });
  await reopen();
  let state = await call("state");
  assert.equal(state.outbox[0].paused, true);
  assert.equal(state.outbox[0].cancelled, true);
  const next = {
    ...original,
    id: randomUUID(),
    clientId: randomUUID(),
    body: "Corrected draft",
  };
  await call("queue", { message: next, replaceClientId: original.clientId });
  state = await call("state");
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].clientId, next.clientId);
  await assert.rejects(
    call("queue", {
      message: { ...next, id: randomUUID(), clientId: randomUUID() },
      replaceClientId: original.clientId,
    }),
    /changed/,
  );
  assert.equal((await call("state")).outbox.length, 1);
  const incoming = {
    ...next,
    id: randomUUID(),
    clientId: randomUUID(),
    userId: randomUUID(),
    sequence: 1,
  };
  delete incoming.status;
  const own = { ...next, sequence: 2 };
  delete own.status;
  await call("apply", {
    groupId,
    messages: [incoming, own],
    cursor: 2,
    changeCursor: 2,
  });
  const summary = await call("unread", { userId, after: { [groupId]: 0 } });
  assert.equal(summary[groupId].count, 1);
  assert.equal(summary[groupId].firstId, incoming.id);
  assert.equal(
    (await call("lookup", { groupId, id: incoming.id })).body,
    incoming.body,
  );
  assert.equal(
    await call("lookup", { groupId: randomUUID(), id: incoming.id }),
    null,
  );
  await call("resetSync");
  state = await call("state");
  assert.deepEqual(state.cursors, {});
  assert.deepEqual(state.changeCursors, {});
  assert.equal((await call("page", { groupId })).messages.length, 2);
  const pending = {
    ...original,
    id: randomUUID(),
    clientId: randomUUID(),
    body: "Still unsent",
  };
  await call("queue", { message: pending });
  const archive = await call("archiveMirror", {
    id: "a".repeat(64),
    name: "Before restore",
    person: "Max",
  });
  await reopen();
  state = await call("state");
  assert.equal(state.groups.length, 0);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].paused, true);
  assert.equal((await call("page", { groupId })).messages.length, 0);
  const oldState = await execute({ scope: archive.scope, operation: "state" });
  assert.equal(oldState.groups.length, 1);
  assert.equal(oldState.groups[0].inviteCode, "");
  assert.equal(oldState.groups[0].access, "left");
  assert.equal(
    (await execute({ scope: archive.scope, operation: "page", groupId }))
      .messages.length,
    2,
  );
  const replacement = {
    ...incoming,
    id: randomUUID(),
    clientId: randomUUID(),
    body: "After restore",
    sequence: 1,
  };
  await call("apply", { groupId, messages: [replacement], cursor: 1 });
  await call("archiveMirror", {
    id: "a".repeat(64),
    name: "Before restore",
    person: "Max",
  });
  assert.equal(
    (await call("page", { groupId })).messages[0].body,
    "After restore",
  );
  assert.equal((await call("archives")).length, 1);
}
