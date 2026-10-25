import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { parseArchive } from "../server/archive-format.mjs";

test("own-message edits preserve order, ignore reaction-only conflicts, synchronize and never revive a deletion", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [],
    domain = createDomain(db, {}, { group: (...args) => events.push(args) });
  const call = (method, path, body, token, query) =>
    domain.handle(method, path, body, token, query);
  const a = await call("POST", "/api/sessions", { name: "Max" }),
    b = await call("POST", "/api/sessions", { name: "Jamie" });
  const group = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  await call("POST", "/api/groups/join", { code: group.inviteCode }, b.token);
  const original = await call(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "tyop" },
    a.token,
  );
  const edit = `/api/messages/${original.id}/edit`,
    remove = `/api/messages/${original.id}/delete`;
  await assert.rejects(
    call(
      "POST",
      edit,
      { body: "Nope", baseRevision: original.contentRevision },
      b.token,
    ),
    { status: 403 },
  );
  await assert.rejects(call("POST", remove, {}, b.token), { status: 403 });
  await call(
    "POST",
    `/api/messages/${original.id}/reactions`,
    { emoji: "👍", active: true },
    b.token,
  );
  const edited = await call(
    "POST",
    edit,
    { body: "typo fixed", baseRevision: original.contentRevision },
    a.token,
  );
  assert.equal(edited.sequence, original.sequence);
  assert.equal(edited.createdAt, original.createdAt);
  assert.ok(edited.editedAt);
  assert.ok(edited.contentRevision > original.contentRevision);
  assert.equal(
    (
      await call(
        "POST",
        edit,
        { body: "typo fixed", baseRevision: original.contentRevision },
        a.token,
      )
    ).revision,
    edited.revision,
  );
  await assert.rejects(
    call(
      "POST",
      edit,
      { body: "stale edit", baseRevision: original.contentRevision },
      a.token,
    ),
    { status: 409 },
  );
  const deleted = await call("POST", remove, {}, a.token);
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.body, "");
  assert.equal(deleted.attachments, undefined);
  assert.equal(deleted.reactions, undefined);
  assert.equal(
    (await call("POST", remove, {}, a.token)).revision,
    deleted.revision,
  );
  await assert.rejects(
    call(
      "POST",
      edit,
      { body: "resurrect", baseRevision: deleted.contentRevision },
      a.token,
    ),
    { status: 409 },
  );
  await assert.rejects(
    call(
      "POST",
      `/api/messages/${original.id}/reactions`,
      { emoji: "👍", active: true },
      b.token,
    ),
    { status: 409 },
  );
  assert.equal(
    (
      await call(
        "POST",
        `/api/groups/${group.id}/messages`,
        { clientId: original.clientId, body: original.body },
        a.token,
      )
    ).deletedAt,
    deleted.deletedAt,
  );
  const changes = await call(
    "GET",
    `/api/groups/${group.id}/changes`,
    {},
    b.token,
    new URLSearchParams({ after: String(original.revision) }),
  );
  assert.ok(
    changes.changes.every(
      (change) => change.message.deletedAt === deleted.deletedAt,
    ),
  );
  const archived = parseArchive(await call("GET", "/api/export", {}, b.token));
  assert.equal(
    archived.groups.find((g) => g.id === group.id).messages[0].deletedAt,
    deleted.deletedAt,
  );
  assert.deepEqual(
    events.filter((e) => e[1] === "message").map((e) => e[2].changeKind),
    ["create", "reaction", "edit", "delete"],
  );
  const renamed = await call(
    "POST",
    `/api/groups/${group.id}/profile`,
    { name: "Friday night" },
    b.token,
  );
  assert.equal(renamed.id, group.id);
  assert.equal(renamed.inviteCode, group.inviteCode);
  assert.equal(renamed.name, "Friday night");
  await assert.rejects(
    call("POST", `/api/groups/${group.id}/profile`, { name: " " }, b.token),
    { status: 400 },
  );
});
