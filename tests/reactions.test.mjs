import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
test("reactions are private, reversible, idempotent and replayed through ordered changes without moving messages", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const domain = createDomain(db);
  const a = await domain.handle("POST", "/api/sessions", { name: "A" }),
    b = await domain.handle("POST", "/api/sessions", { name: "B" });
  const group = (await domain.handle("GET", "/api/bootstrap", {}, a.token))
    .groups[0];
  const message = await domain.handle(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "One more game?" },
    a.token,
  );
  const path = `/api/messages/${message.id}/reactions`;
  await assert.rejects(
    domain.handle("POST", path, { emoji: "👍", active: true }, b.token),
    { status: 403 },
  );
  await domain.handle(
    "POST",
    "/api/groups/join",
    { code: group.inviteCode },
    b.token,
  );
  const reacted = await domain.handle(
    "POST",
    path,
    { emoji: "👍", active: true },
    b.token,
  );
  assert.equal(reacted.sequence, message.sequence);
  assert.ok(reacted.revision > message.revision);
  assert.deepEqual(reacted.reactions, [{ emoji: "👍", userIds: [b.user.id] }]);
  assert.equal(
    (await domain.handle("POST", path, { emoji: "👍", active: true }, b.token))
      .revision,
    reacted.revision,
  );
  const removed = await domain.handle(
    "POST",
    path,
    { emoji: "👍", active: false },
    b.token,
  );
  assert.ok(removed.revision > reacted.revision);
  assert.equal(removed.reactions, undefined);
  const classic = await domain.handle(
    "POST",
    path,
    { emoji: ":msn-thumbs-up:", active: true },
    b.token,
  );
  assert.equal(classic.reactions[0].emoji, ":msn-thumbs-up:");
  const changes = await domain.handle(
    "GET",
    `/api/groups/${group.id}/changes`,
    {},
    a.token,
    new URLSearchParams({ after: String(message.revision) }),
  );
  assert.equal(changes.changes.length, 3);
  assert.ok(
    changes.changes.every(
      (c) =>
        c.message.id === message.id && c.message.revision === classic.revision,
    ),
  );
  await assert.rejects(
    domain.handle("POST", path, { emoji: "not emoji", active: true }, a.token),
    { status: 400 },
  );
});
