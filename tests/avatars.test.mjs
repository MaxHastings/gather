import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { createGatherServer } from "../server/app.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { restoreDatabase } from "../server/restore.mjs";
import { createFileBucket } from "../server/file-bucket.mjs";
function png(color = 70, width = 256) {
  const chunk = (type, bytes) => {
    const value = Buffer.concat([Buffer.from(type), bytes]),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(value));
    return Buffer.concat([length, value, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * 256, color);
  for (let i = 0; i < 256; i++) rows[i * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("profile/group pictures are private, versioned, replaceable, idempotent and share the storage ceiling", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gather-avatar-contract-"));
  const first = png(),
    second = png(110),
    server = createGatherServer({
      dataDir: dir,
      env: {},
      storageOptions: { limitBytes: first.length + second.length },
    });
  const { port } = await server.listen(0),
    base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await server.close();
    assert.ok(dir.startsWith(join(tmpdir(), "gather-avatar-contract-")));
    await rm(dir, { recursive: true, force: true });
  });
  const call = (method, path, body, token) =>
    server.domain.handle(method, path, body, token);
  const alice = await call("POST", "/api/sessions", { name: "Alice" }),
    bob = await call("POST", "/api/sessions", { name: "Bob" }),
    stranger = await call("POST", "/api/sessions", { name: "Outsider" });
  const group = (await call("GET", "/api/bootstrap", {}, alice.token))
    .groups[0];
  await call("POST", "/api/groups/join", { code: group.inviteCode }, bob.token);
  const put = (path, token, bytes, id = randomUUID(), revision = 0) =>
    fetch(`${base}${path}/content?id=${id}&revision=${revision}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "image/png",
      },
      body: bytes,
    });
  assert.equal(
    (await put("/api/profile/avatar", alice.token, png(20, 128))).status,
    400,
  );
  const id = randomUUID(),
    uploaded = await put("/api/profile/avatar", alice.token, first, id);
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  assert.deepEqual(await uploaded.json(), { avatarId: id, avatarRevision: 1 });
  assert.equal(
    (await put("/api/profile/avatar", alice.token, first, id)).status,
    200,
  );
  assert.equal(
    server.db.prepare("SELECT SUM(bytes) AS n FROM storage_objects").get().n,
    first.length,
  );
  const content = (id) => `${base}/api/avatars/${id}/content`;
  for (const token of [alice.token, bob.token]) {
    const response = await fetch(content(id), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), first);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await fetch(content(id))).status, 401);
  assert.equal(
    (
      await fetch(content(id), {
        headers: { Authorization: `Bearer ${stranger.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await put("/api/profile/avatar", bob.token, first, id)).status,
    409,
  );
  assert.equal(
    (await put(`/api/groups/${group.id}/avatar`, stranger.token, first)).status,
    403,
  );
  const replacement = randomUUID();
  assert.equal(
    (await put("/api/profile/avatar", alice.token, second, replacement, 0))
      .status,
    409,
  );
  assert.equal(
    (await put("/api/profile/avatar", alice.token, second, replacement, 1))
      .status,
    200,
  );
  assert.equal(
    server.db.prepare("SELECT SUM(bytes) AS n FROM storage_objects").get().n,
    second.length,
  );
  assert.equal(
    (
      await fetch(content(id), {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).status,
    404,
  );
  const groupId = randomUUID();
  assert.equal(
    (await put(`/api/groups/${group.id}/avatar`, bob.token, first, groupId))
      .status,
    200,
  );
  assert.equal(
    (await put("/api/profile/avatar", alice.token, first, randomUUID(), 2))
      .status,
    507,
  );
  assert.equal(
    (await call("GET", "/api/bootstrap", {}, alice.token)).user.avatarId,
    replacement,
  );
  const savedGroup = (await call("GET", "/api/bootstrap", {}, alice.token))
    .groups[0];
  assert.equal(savedGroup.avatarId, groupId);
  assert.equal(
    savedGroup.members.find((p) => p.id === alice.user.id).avatarId,
    replacement,
  );
  const restored = restoreDatabase(captureSnapshot(sqliteAdapter(server.db)));
  assert.equal(
    restored.prepare("SELECT id FROM avatar_slots WHERE kind='group'").get().id,
    groupId,
  );
  restored.close();
  await assert.rejects(
    call(
      "POST",
      `/api/groups/${group.id}/avatar/remove`,
      { baseRevision: 0 },
      alice.token,
    ),
    /picture changed/,
  );
  assert.deepEqual(
    await call(
      "POST",
      `/api/groups/${group.id}/avatar/remove`,
      { baseRevision: 1 },
      alice.token,
    ),
    { avatarRevision: 2 },
  );
  assert.equal(
    (await put(`/api/groups/${group.id}/avatar`, bob.token, first, groupId))
      .status,
    409,
  );
  assert.equal(
    (
      await fetch(content(groupId), {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    server.db.prepare("SELECT SUM(bytes) AS n FROM storage_objects").get().n,
    second.length,
  );
});

test("membership lost during an avatar write prevents publication and reclaims confirmed bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gather-avatar-revoke-"));
  let release, started;
  const writing = new Promise((done) => {
    started = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const bucket = createFileBucket(join(dir, "objects"));
  const server = createGatherServer({
    dataDir: join(dir, "data"),
    env: {},
    bucket: {
      ...bucket,
      async put(...args) {
        const result = await bucket.put(...args);
        started();
        await gate;
        return result;
      },
    },
  });
  const { port } = await server.listen(0);
  t.after(async () => {
    release();
    await server.close();
    assert.ok(dir.startsWith(join(tmpdir(), "gather-avatar-revoke-")));
    await rm(dir, { recursive: true, force: true });
  });
  const call = (method, path, body, token) =>
    server.domain.handle(method, path, body, token);
  const alice = await call("POST", "/api/sessions", { name: "Alice" }),
    bob = await call("POST", "/api/sessions", { name: "Bob" });
  const group = (await call("GET", "/api/bootstrap", {}, alice.token))
    .groups[0];
  await call("POST", "/api/groups/join", { code: group.inviteCode }, bob.token);
  const upload = fetch(
    `http://127.0.0.1:${port}/api/groups/${group.id}/avatar/content?id=${randomUUID()}&revision=0`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bob.token}`,
        "Content-Type": "image/png",
      },
      body: png(),
    },
  );
  await writing;
  server.db
    .prepare("DELETE FROM memberships WHERE groupId=? AND userId=?")
    .run(group.id, bob.user.id);
  release();
  assert.equal((await upload).status, 403);
  assert.equal(
    server.db.prepare("SELECT COUNT(*) AS n FROM avatar_slots").get().n,
    0,
  );
  assert.equal(
    server.db.prepare("SELECT COUNT(*) AS n FROM storage_objects").get().n,
    0,
  );
});
