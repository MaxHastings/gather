import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
import { validateMediaBytes } from "../server/media.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("private media reserves before upload, verifies bytes, commits once and authorizes every range", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-media-"));
  const server = createGatherServer({
    dataDir,
    storageOptions: { limitBytes: png.length * 2 },
  });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function api(path, token, body, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const alice = (await api("/api/sessions", null, { name: "Alice" })).body;
  const bob = (await api("/api/sessions", null, { name: "Bob" })).body;
  const stranger = (await api("/api/sessions", null, { name: "Stranger" }))
    .body;
  const group = (await api("/api/bootstrap", alice.token)).body.groups[0];
  await api("/api/groups/join", bob.token, { code: group.inviteCode });
  const file = {
    id: randomUUID(),
    name: "picture.png",
    type: "image/png",
    bytes: png.length,
    sha256: sha256(png),
  };
  const prepare = () =>
    api(`/api/groups/${group.id}/uploads`, alice.token, file);
  assert.equal((await prepare()).status, 200);
  assert.equal((await prepare()).status, 200);
  assert.equal(
    server.db.prepare("SELECT SUM(bytes) AS n FROM storage_objects").get().n,
    png.length,
  );
  const second = { ...file, id: randomUUID() };
  assert.equal(
    (await api(`/api/groups/${group.id}/uploads`, alice.token, second)).status,
    200,
  );
  assert.equal(
    (
      await api(`/api/groups/${group.id}/uploads`, alice.token, {
        ...file,
        id: randomUUID(),
      })
    ).status,
    507,
  );
  assert.equal(
    (await api(`/api/uploads/${second.id}/cancel`, alice.token, {})).status,
    200,
  );
  const upload = async (token, bytes) =>
    fetch(`${base}/api/uploads/${file.id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
  assert.equal((await upload(bob.token, png)).status, 404);
  assert.equal(
    (await upload(alice.token, Buffer.alloc(png.length))).status,
    400,
  );
  assert.equal((await upload(alice.token, png)).status, 200);
  const content = `/api/attachments/${file.id}/content`;
  assert.equal(
    (
      await fetch(base + content, {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).status,
    404,
  );
  const message = {
    clientId: randomUUID(),
    body: "A picture",
    attachmentIds: [file.id],
  };
  const sent = await api(
    `/api/groups/${group.id}/messages`,
    alice.token,
    message,
  );
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.attachments, [file]);
  const again = await api(
    `/api/groups/${group.id}/messages`,
    alice.token,
    message,
  );
  assert.equal(again.body.id, sent.body.id);
  assert.equal(
    (
      await api(`/api/groups/${group.id}/messages`, alice.token, {
        ...message,
        attachmentIds: [],
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/api/uploads/${file.id}/cancel`, alice.token, {})).status,
    409,
  );
  assert.equal((await upload(alice.token, png)).status, 200);
  for (const headers of [
    {},
    { Authorization: `Bearer ${stranger.token}`, Range: "bytes=0-9" },
  ])
    assert.ok(
      [401, 403].includes((await fetch(base + content, { headers })).status),
    );
  const response = await fetch(base + content, {
    headers: { Authorization: `Bearer ${bob.token}`, Range: "bytes=0-9" },
  });
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("Content-Range"),
    `bytes 0-9/${png.length}`,
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    png.subarray(0, 10),
  );
  const full = await fetch(base + content, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  assert.equal(full.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), png);
  assert.equal(
    (await api(`/api/groups/${group.id}/messages`, bob.token)).body.messages[0]
      .attachments[0].sha256,
    file.sha256,
  );
  server.db
    .prepare("DELETE FROM memberships WHERE groupId=? AND userId=?")
    .run(group.id, bob.user.id);
  assert.equal(
    (
      await fetch(base + content, {
        headers: { Authorization: `Bearer ${bob.token}`, Range: "bytes=0-1" },
      })
    ).status,
    403,
  );
});
test("media headers reject executable or oversized image payloads", () => {
  assert.doesNotThrow(() => validateMediaBytes(png, "image/png"));
  assert.throws(
    () => validateMediaBytes(Buffer.from("<svg onload=alert(1)>"), "image/png"),
    { status: 415 },
  );
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20000, 16);
  assert.throws(() => validateMediaBytes(huge, "image/png"), { status: 413 });
});
test("one chat or identity cannot take more than its fair share of file space", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-quota-"));
  const server = createGatherServer({
    dataDir,
    storageOptions: {
      limitBytes: png.length * 10,
      groupLimitBytes: png.length * 2,
      userLimitBytes: png.length * 3,
    },
  });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const bootstrap = async (token) =>
    (
      await fetch(base + "/api/bootstrap", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
  const alice = (await api("/api/sessions", null, { name: "Alice" })).body;
  const [first] = (await bootstrap(alice.token)).groups;
  const second = (await api("/api/groups", alice.token, { name: "Two" })).body;
  const third = (await api("/api/groups", alice.token, { name: "Three" })).body;
  const prepare = (group) =>
    api(`/api/groups/${group.id}/uploads`, alice.token, {
      id: randomUUID(),
      name: "p.png",
      type: "image/png",
      bytes: png.length,
      sha256: sha256(png),
    });
  assert.equal((await prepare(first)).status, 200);
  assert.equal((await prepare(first)).status, 200);
  const full = await prepare(first);
  assert.equal(full.status, 507);
  assert.match(full.body.error, /shared file space/);
  // Another chat still has room, until this identity's own allowance is spent.
  assert.equal((await prepare(second)).status, 200);
  const spent = await prepare(third);
  assert.equal(spent.status, 507);
  assert.match(spent.body.error, /allowance/);
});
test("old sent files roll off at the chat limit and expire by age while messages stay", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-retention-"));
  const server = createGatherServer({
    dataDir,
    storageOptions: {
      limitBytes: png.length * 10,
      groupLimitBytes: png.length * 2,
      userLimitBytes: png.length * 10,
    },
  });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const alice = await (
    await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    })
  ).json();
  const group = (await api("/api/bootstrap", alice.token)).body.groups[0];
  const share = async () => {
    const id = randomUUID();
    const prepared = await api(`/api/groups/${group.id}/uploads`, alice.token, {
      id,
      name: "p.png",
      type: "image/png",
      bytes: png.length,
      sha256: sha256(png),
    });
    if (prepared.status !== 200) return { prepared };
    await fetch(`${base}/api/uploads/${id}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${alice.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: png,
    });
    const sent = await api(`/api/groups/${group.id}/messages`, alice.token, {
      clientId: randomUUID(),
      body: "pic",
      attachmentIds: [id],
    });
    return { id, prepared, sent };
  };
  const fetchFile = (id) =>
    fetch(`${base}/api/attachments/${id}/content`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
  const a = await share();
  const b = await share();
  assert.equal(a.sent.status, 200);
  assert.equal(b.sent.status, 200);
  // Chat is at its limit: the third upload evicts the oldest instead of failing.
  const c = await share();
  assert.equal(c.prepared.status, 200);
  assert.equal(c.sent.status, 200);
  assert.equal((await fetchFile(a.id)).status, 410);
  assert.equal((await fetchFile(b.id)).status, 200);
  assert.equal((await fetchFile(c.id)).status, 200);
  // Age expiry: nothing is removed early, then files past 30 days go.
  assert.equal((await server.domain.expireFiles()).expired, 0);
  const later = Date.now() + 31 * 86_400_000;
  const swept = await server.domain.expireFiles(later);
  assert.equal(swept.expired, 2, JSON.stringify(swept));
  const res = await fetchFile(b.id);
  assert.equal(res.status, 410);
  assert.match((await res.json()).error, /expired/);
  // The messages themselves are untouched.
  const history = (await api(`/api/groups/${group.id}/messages`, alice.token))
    .body;
  assert.ok(JSON.stringify(history).includes("pic"));
});
test("a file is removed from the server once every other member has fetched it", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-delivered-"));
  const server = createGatherServer({ dataDir });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const person = async (name) =>
    (await api("/api/sessions", null, { name })).body;
  const alice = await person("Alice");
  const bob = await person("Bob");
  const cara = await person("Cara");
  const group = (await api("/api/bootstrap", alice.token)).body.groups[0];
  await api("/api/groups/join", bob.token, { code: group.inviteCode });
  await api("/api/groups/join", cara.token, { code: group.inviteCode });
  const id = randomUUID();
  await api(`/api/groups/${group.id}/uploads`, alice.token, {
    id,
    name: "p.png",
    type: "image/png",
    bytes: png.length,
    sha256: sha256(png),
  });
  await fetch(`${base}/api/uploads/${id}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${alice.token}`,
      "Content-Type": "application/octet-stream",
    },
    body: png,
  });
  await api(`/api/groups/${group.id}/messages`, alice.token, {
    clientId: randomUUID(),
    body: "pic",
    attachmentIds: [id],
  });
  const get = (token) =>
    fetch(`${base}/api/attachments/${id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const week = Date.now() + 2 * 86_400_000;
  assert.equal((await get(bob.token)).status, 200);
  // Cara has not fetched it yet, so it stays.
  assert.equal((await server.domain.expireFiles(week)).expired, 0);
  assert.equal((await get(cara.token)).status, 200);
  // Everyone has it, but the grace period has not passed.
  assert.equal((await server.domain.expireFiles()).expired, 0);
  assert.equal((await server.domain.expireFiles(week)).expired, 1);
  assert.equal((await get(bob.token)).status, 410);
});
