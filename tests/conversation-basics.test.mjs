import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { restoreDatabase } from "../server/restore.mjs";
import { inlineText, messageText } from "../server/message-text.mjs";
const { externalUrl } = createRequire(import.meta.url)(
  "../server/external-url.cjs",
);
async function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [];
  const domain = createDomain(db, {}, { group: (...a) => events.push(a) });
  const call = (method, path, body = {}, token) =>
    domain.handle(method, path, body, token);
  const a = await call("POST", "/api/sessions", { name: "Max" }),
    b = await call("POST", "/api/sessions", { name: "Jamie" });
  const g = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  await call("POST", "/api/groups/join", { code: g.inviteCode }, b.token);
  return { sqlite, db, domain, call, a, b, g, events };
}

test("reply references are private, idempotent and resolve current edited/deleted source through the change stream", async (t) => {
  const { db, call, a, b, g, events } = await setup(t);
  const send = (body, replyTo, clientId = randomUUID()) =>
    call(
      "POST",
      `/api/groups/${g.id}/messages`,
      { body, replyTo, clientId },
      a.token,
    );
  const original = await send("Original detail"),
    reply = await send("I mean this one", original.id);
  assert.equal(reply.replyTo, original.id);
  assert.equal(reply.reply.body, original.body);
  assert.equal(
    (await send(reply.body, original.id, reply.clientId)).id,
    reply.id,
  );
  await assert.rejects(send(reply.body, undefined, reply.clientId), {
    status: 409,
  });
  const other = (await call("GET", "/api/bootstrap", {}, b.token)).groups.find(
    (group) => group.id !== g.id,
  );
  const secret = await call(
    "POST",
    `/api/groups/${other.id}/messages`,
    { body: "private", clientId: randomUUID() },
    b.token,
  );
  await assert.rejects(send("Cross-chat", secret.id), { status: 400 });
  const edited = await call(
    "POST",
    `/api/messages/${original.id}/edit`,
    { body: "Corrected detail", baseRevision: original.contentRevision },
    a.token,
  );
  const listed = await call("GET", `/api/groups/${g.id}/messages`, {}, a.token);
  assert.equal(
    listed.messages.find((m) => m.id === reply.id).reply.body,
    "Corrected detail",
  );
  assert.ok(
    events.some(
      ([, name, message]) =>
        name === "message" &&
        message.id === reply.id &&
        message.reply?.body === "Corrected detail",
    ),
  );
  await call("POST", `/api/messages/${original.id}/delete`, {}, a.token);
  const lookup = await call(
    "GET",
    `/api/groups/${g.id}/message/${reply.id}`,
    {},
    b.token,
  );
  assert.equal(lookup.reply.deleted, true);
  assert.equal(lookup.reply.body, "");
  const changes = await call(
    "GET",
    `/api/groups/${g.id}/changes`,
    {},
    a.token,
    new URLSearchParams({ after: String(edited.revision) }),
  );
  assert.ok(
    changes.changes.some(
      (change) =>
        change.message.id === reply.id && change.message.reply.deleted,
    ),
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_replies").get().n, 1);
  const restored = restoreDatabase(captureSnapshot(db));
  t.after(() => restored.close());
  assert.equal(
    (
      await createDomain(sqliteAdapter(restored)).handle(
        "GET",
        `/api/groups/${g.id}/message/${reply.id}`,
        {},
        a.token,
      )
    ).reply.deleted,
    true,
  );
});

test("durable cancellation wins against late sends; a lost acceptance is reconciled rather than deleted", async (t) => {
  const { call, a, b, g } = await setup(t);
  const clientId = randomUUID(),
    path = `/api/groups/${g.id}/outbox/${clientId}`;
  assert.deepEqual(await call("GET", path, {}, a.token), { message: null });
  assert.equal(
    (await call("POST", path, { action: "cancel" }, a.token)).cancelled,
    true,
  );
  assert.equal(
    (await call("POST", path, { action: "cancel" }, a.token)).cancelled,
    true,
  );
  await assert.rejects(
    call(
      "POST",
      `/api/groups/${g.id}/messages`,
      { clientId, body: "Late retry" },
      a.token,
    ),
    { status: 409 },
  );
  const accepted = await call(
    "POST",
    `/api/groups/${g.id}/messages`,
    { clientId: randomUUID(), body: "Already accepted" },
    a.token,
  );
  const result = await call(
    "POST",
    `/api/groups/${g.id}/outbox/${accepted.clientId}`,
    { action: "cancel" },
    a.token,
  );
  assert.equal(result.message.id, accepted.id);
  assert.equal(result.message.body, "Already accepted");
  assert.equal(
    (
      await call(
        "GET",
        `/api/groups/${g.id}/outbox/${accepted.clientId}`,
        {},
        b.token,
      )
    ).message,
    null,
  );
  const outsider = await call("POST", "/api/sessions", { name: "Outside" });
  await assert.rejects(call("GET", path, {}, outsider.token), { status: 403 });
});

test("server generation stays stable across ordinary reopening but rotates after restore without losing identities", async (t) => {
  const { db, call, a, g } = await setup(t),
    before = await call("GET", "/api/bootstrap", {}, a.token);
  assert.equal(
    (await createDomain(db).handle("GET", "/api/bootstrap", {}, a.token))
      .generation,
    before.generation,
  );
  const restored = restoreDatabase(captureSnapshot(db));
  t.after(() => restored.close());
  const after = await createDomain(sqliteAdapter(restored)).handle(
    "GET",
    "/api/bootstrap",
    {},
    a.token,
  );
  assert.notEqual(after.generation, before.generation);
  assert.equal(after.user.id, a.user.id);
  assert.ok(after.groups.some((group) => group.id === g.id));
});

test("the text grammar preserves source meaning and accepts only ordinary external links", () => {
  assert.equal(
    externalUrl("https://example.com/path?q=a#b"),
    "https://example.com/path?q=a#b",
  );
  for (const value of [
    "javascript:alert(1)",
    "file:///C:/private",
    "data:text/html,test",
    "https://name:password@example.com",
    "https://example.com/\nunsafe",
  ])
    assert.throws(() => externalUrl(value));
  const tokens = inlineText(
    "**bold** *italic* ~~old~~ `**literal**` https://example.com/a(b). <script>bad</script>",
  );
  assert.deepEqual(
    tokens.filter((t) => !["text", "link"].includes(t.type)).map((t) => t.type),
    ["bold", "italic", "strike", "code"],
  );
  assert.equal(
    tokens.find((t) => t.type === "link").value,
    "https://example.com/a(b)",
  );
  assert.ok(
    tokens.some((t) => t.type === "text" && t.value.includes("<script>")),
  );
  assert.equal(
    messageText("```js\n<script>unchanged</script>\n```")[0].value,
    "<script>unchanged</script>\n",
  );
  assert.equal(
    inlineText("ordinary * unmatched")[0].value,
    "ordinary * unmatched",
  );
});
