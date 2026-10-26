import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initializeSchema, createDomain, hash } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { restoreDatabase } from "../server/restore.mjs";

async function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [];
  const domain = createDomain(
    db,
    {},
    {
      connection: (...args) => events.push(args),
      group: (...args) => events.push(args),
    },
  );
  const call = (method, path, body = {}, token) =>
    domain.handle(method, path, body, token);
  const a = await call("POST", "/api/sessions", { name: "Owner" });
  const initial = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  const b = await call("POST", "/api/sessions", {
    name: "Friend",
    inviteCode: initial.inviteCode,
  });
  const c = await call("POST", "/api/sessions", {
    name: "Third",
    inviteCode: initial.inviteCode,
  });
  const group = async () =>
    (await call("GET", "/api/bootstrap", {}, a.token)).groups.find(
      (g) => g.id === initial.id,
    );
  const act = async (session, action, userId, revision) =>
    call(
      "POST",
      `/api/groups/${initial.id}/membership`,
      { action, userId, revision: revision ?? (await group()).controlRevision },
      session.token,
    );
  return { db, domain, call, a, b, c, group, act, events, initial };
}

test("owner-only member removal rotates invites, ejects every voice device and revokes group access without signing out", async (t) => {
  const { db, domain, call, a, b, c, group, act, events, initial } =
    await setup(t);
  assert.equal((await group()).ownerId, a.user.id);
  for (const action of ["remove", "transfer", "rotate"])
    await assert.rejects(act(b, action, c.user.id), { status: 403 });
  await assert.rejects(act(a, "remove", a.user.id), { status: 400 });
  await assert.rejects(act(a, "leave"), { status: 409 });
  const message = await call(
    "POST",
    `/api/groups/${initial.id}/messages`,
    { clientId: randomUUID(), body: "saved history" },
    b.token,
  );
  const sockets = [randomUUID(), randomUUID(), randomUUID()];
  domain.realtimeOpen(sockets[0], { ...b.user, tokenHash: hash(b.token) });
  domain.realtimeOpen(sockets[1], { ...b.user, tokenHash: hash(b.token) });
  domain.realtimeOpen(sockets[2], { ...a.user, tokenHash: hash(a.token) });
  domain.realtimeMessage(sockets[0], "voice:join", { groupId: initial.id });
  domain.realtimeMessage(sockets[2], "voice:join", { groupId: initial.id });
  const before = await group();
  const after = await act(a, "remove", b.user.id);
  assert.notEqual(after.inviteCode, before.inviteCode);
  assert.equal(
    after.members.some((p) => p.id === b.user.id),
    false,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM voices WHERE connectionId=?")
      .get(sockets[0]).n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM voices WHERE connectionId=?")
      .get(sockets[2]).n,
    1,
  );
  assert.equal(
    events.filter(
      ([id, event]) =>
        sockets.slice(0, 2).includes(id) && event === "group-access",
    ).length,
    2,
  );
  assert.equal(domain.authorize(b.token).id, b.user.id);
  for (const [method, path, body] of [
    ["GET", `/api/groups/${initial.id}/messages`, {}],
    ["GET", `/api/groups/${initial.id}/changes`, {}],
    [
      "POST",
      `/api/groups/${initial.id}/messages`,
      { clientId: randomUUID(), body: "no" },
    ],
    ["POST", `/api/groups/${initial.id}/ice`, {}],
    ["POST", `/api/groups/${initial.id}/profile`, { name: "no" }],
    [
      "POST",
      `/api/messages/${message.id}/edit`,
      { body: "no", baseRevision: message.contentRevision },
    ],
    ["POST", `/api/messages/${message.id}/delete`, {}],
    [
      "POST",
      `/api/messages/${message.id}/reactions`,
      { emoji: "👍", active: true },
    ],
    [
      "POST",
      `/api/groups/${initial.id}/membership`,
      { action: "leave", revision: after.controlRevision },
    ],
  ])
    await assert.rejects(call(method, path, body, b.token), { status: 403 });
  assert.throws(
    () =>
      domain.realtimeMessage(sockets[0], "voice:join", { groupId: initial.id }),
    { status: 403 },
  );
  assert.throws(
    () =>
      domain.realtimeMessage(sockets[0], "typing", {
        groupId: initial.id,
        active: true,
      }),
    { status: 403 },
  );
  assert.throws(
    () =>
      domain.realtimeMessage(sockets[0], "signal", {
        to: sockets[2],
        candidate: { candidate: "x" },
      }),
    { status: 403 },
  );
  await assert.rejects(
    call("POST", "/api/groups/join", { code: before.inviteCode }, b.token),
    { status: 404 },
  );
  await assert.rejects(
    call("POST", "/api/sessions", {
      name: "Fresh identity",
      inviteCode: before.inviteCode,
    }),
    { status: 404 },
  );
  await assert.rejects(act(a, "remove", b.user.id, before.controlRevision), {
    status: 409,
  });
  assert.equal((await group()).inviteCode, after.inviteCode);
  const bootstrap = await call("GET", "/api/bootstrap", {}, b.token);
  assert.equal(
    bootstrap.groups.some((g) => g.id === initial.id),
    false,
  );
  assert.deepEqual(
    bootstrap.departures.map((d) => ({ ...d })),
    [
      {
        groupId: initial.id,
        access: "removed",
        controlRevision: after.controlRevision,
      },
    ],
  );
  // Membership in another chat remains functional.
  const other = await call(
    "POST",
    "/api/groups",
    { name: "Other chat" },
    b.token,
  );
  await call(
    "POST",
    `/api/groups/${other.id}/messages`,
    { clientId: randomUUID(), body: "still works" },
    b.token,
  );
  // A current member can explicitly share the new invite to readmit them.
  const rejoined = await call(
    "POST",
    "/api/groups/join",
    { code: after.inviteCode },
    b.token,
  );
  assert.ok(rejoined.controlRevision > after.controlRevision);
  assert.deepEqual(
    (await call("GET", "/api/bootstrap", {}, b.token)).departures,
    [],
  );
});

test("ownership handoff, voluntary departure, closed empty chats and snapshot restore preserve controls", async (t) => {
  const { db, call, a, b, c, group, act, initial } = await setup(t);
  const rotated = await act(a, "rotate");
  assert.notEqual(rotated.inviteCode, initial.inviteCode);
  const oldRevision = rotated.controlRevision;
  const transferred = await act(a, "transfer", b.user.id);
  assert.equal(transferred.ownerId, b.user.id);
  await assert.rejects(act(a, "rotate", undefined, oldRevision), {
    status: 409,
  });
  await assert.rejects(act(a, "rotate"), { status: 403 });
  await act(a, "leave");
  let current = (await call("GET", "/api/bootstrap", {}, b.token)).groups.find(
    (g) => g.id === initial.id,
  );
  await call(
    "POST",
    `/api/groups/${initial.id}/membership`,
    { action: "remove", userId: c.user.id, revision: current.controlRevision },
    b.token,
  );
  current = (await call("GET", "/api/bootstrap", {}, b.token)).groups.find(
    (g) => g.id === initial.id,
  );
  const closed = await call(
    "POST",
    `/api/groups/${initial.id}/membership`,
    { action: "leave", revision: current.controlRevision },
    b.token,
  );
  assert.equal(closed.access, "left");
  assert.equal(
    db
      .prepare("SELECT ownerId FROM group_controls WHERE groupId=?")
      .get(initial.id).ownerId,
    null,
  );
  const lastCode = db
    .prepare("SELECT inviteCode FROM groups WHERE id=?")
    .get(initial.id).inviteCode;
  for (const code of [current.inviteCode, lastCode])
    await assert.rejects(call("POST", "/api/groups/join", { code }, c.token), {
      status: 404,
    });
  const restored = restoreDatabase(captureSnapshot(db));
  t.after(() => restored.close());
  const recovered = createDomain(sqliteAdapter(restored));
  const data = await recovered.handle("GET", "/api/bootstrap", {}, b.token);
  assert.equal(
    data.departures.find((d) => d.groupId === initial.id).access,
    "left",
  );
  assert.equal(restored.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("legacy chats assign their earliest member as owner even when later members have older identities", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db, 8);
  const first = randomUUID(),
    older = randomUUID(),
    id = randomUUID();
  db.prepare("INSERT INTO users (id,name,createdAt) VALUES (?,?,?)").run(older, "Old identity", 1);
  db.prepare("INSERT INTO users (id,name,createdAt) VALUES (?,?,?)").run(first, "Creator", 2);
  db.prepare("INSERT INTO groups VALUES (?,?,?,?)").run(
    id,
    "Legacy",
    "old-link",
    3,
  );
  db.prepare("INSERT INTO memberships VALUES (?,?)").run(id, first);
  db.prepare("INSERT INTO memberships VALUES (?,?)").run(id, older);
  const restored = restoreDatabase(captureSnapshot(db));
  t.after(() => restored.close());
  initializeSchema(db);
  assert.equal(
    db.prepare("SELECT ownerId FROM group_controls").get().ownerId,
    first,
  );
  assert.equal(
    restored.prepare("SELECT ownerId FROM group_controls").get().ownerId,
    first,
  );
  assert.equal(
    db.prepare("SELECT inviteCode FROM groups").get().inviteCode,
    "old-link",
  );
  initializeSchema(db);
});

test("removal revokes private file reads and in-flight uploads before their response completes", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const objects = new Map();
  let afterRead, afterWrite;
  const storage = {
    reserve: async () => {},
    writeReserved: async (key, bytes) => {
      objects.set(key, bytes);
      await afterWrite?.();
    },
    get: async (key) => ({
      arrayBuffer: async () => {
        await afterRead?.();
        return objects.get(key);
      },
    }),
  };
  const domain = createDomain(db, {}, {}, { objectStorage: storage });
  const call = (method, path, body = {}, token) =>
    domain.handle(method, path, body, token);
  const a = await call("POST", "/api/sessions", { name: "Owner" });
  const group = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  const b = await call("POST", "/api/sessions", {
    name: "Friend",
    inviteCode: group.inviteCode,
  });
  const bytes = Buffer.from("A private text file");
  const { createHash } = await import("node:crypto");
  const prepare = async () => {
    const file = {
      id: randomUUID(),
      name: "notes.txt",
      type: "application/octet-stream",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await call("POST", `/api/groups/${group.id}/uploads`, file, b.token);
    return file;
  };
  const request = (file, method = "PUT") =>
    domain.mediaRequest(
      new Request(
        `https://gather.test/api/${method === "PUT" ? "uploads" : "attachments"}/${file.id}/content`,
        {
          method,
          headers: { Authorization: `Bearer ${b.token}` },
          ...(method === "PUT" ? { body: bytes } : {}),
        },
      ),
    );
  const remove = async () => {
    const current = (await call("GET", "/api/bootstrap", {}, a.token))
      .groups[0];
    return call(
      "POST",
      `/api/groups/${group.id}/membership`,
      {
        action: "remove",
        userId: b.user.id,
        revision: current.controlRevision,
      },
      a.token,
    );
  };
  const file = await prepare();
  await request(file);
  await call(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "file", attachmentIds: [file.id] },
    b.token,
  );
  assert.equal(await (await request(file, "GET")).text(), bytes.toString());
  afterRead = async () => {
    afterRead = undefined;
    await remove();
  };
  await assert.rejects(request(file, "GET"), { status: 403 });
  await assert.rejects(request(file, "GET"), { status: 403 });
  let current = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  await call("POST", "/api/groups/join", { code: current.inviteCode }, b.token);
  const pending = await prepare();
  afterWrite = async () => {
    afterWrite = undefined;
    await remove();
  };
  await assert.rejects(request(pending), { status: 403 });
  await assert.rejects(
    call(
      "POST",
      `/api/groups/${group.id}/messages`,
      { clientId: randomUUID(), body: "no", attachmentIds: [pending.id] },
      b.token,
    ),
    { status: 403 },
  );
  assert.equal(
    db.prepare("SELECT state FROM media_uploads WHERE id=?").get(pending.id)
      .state,
    "pending",
  );
});

test("invite preview names the chat without a sign-in and exposes nothing else", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const domain = createDomain(db, {}, { connection() {}, group() {} });
  const owner = await domain.handle("POST", "/api/sessions", { name: "Owner" });
  const group = (await domain.handle("GET", "/api/bootstrap", {}, owner.token))
    .groups[0];
  const preview = await domain.handle(
    "GET",
    `/api/invites/${group.inviteCode}`,
    {},
  );
  assert.deepEqual(preview, { name: group.name, memberCount: 1 });
  await assert.rejects(
    domain.handle("GET", "/api/invites/not-a-real-code", {}),
    { status: 404 },
  );
});
