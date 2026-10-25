import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatherServer } from "../server/app.mjs";
import { captureSnapshot, restoreSnapshot } from "../server/snapshot.mjs";
import { restoreDatabase } from "../server/restore.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { encryptSnapshot, decryptSnapshot } from "../scripts/backup-crypto.mjs";

test("operator snapshot restores identities, authorization, retries and sequence without transient callers", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-snapshot-"));
  const restoredDir = await mkdtemp(join(tmpdir(), "gather-restore-"));
  const admin = randomBytes(32).toString("base64url");
  const server = createGatherServer({
    dataDir,
    env: { GATHER_ADMIN_TOKEN: admin },
  });
  let recovered;
  t.after(async () => {
    await server.close();
    if (recovered) await recovered.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(restoredDir, { recursive: true, force: true });
  });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, body, token) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const alice = (await api("/api/sessions", { name: "Alice" })).data;
  const group = (await api("/api/bootstrap", null, alice.token)).data.groups[0];
  const bob = (
    await api("/api/sessions", { name: "Bob", inviteCode: group.inviteCode })
  ).data;
  const eve = (await api("/api/sessions", { name: "Eve" })).data;
  const clientId = randomUUID();
  const message = (
    await api(
      `/api/groups/${group.id}/messages`,
      { clientId, body: "Keep this after a disaster." },
      alice.token,
    )
  ).data;
  const ticket = (await api("/api/realtime-ticket", {}, alice.token)).data
    .ticket;
  const socketId = randomUUID();
  server.domain.realtimeOpen(socketId, server.domain.claimTicket(ticket));
  server.domain.realtimeMessage(socketId, "voice:join", {
    groupId: group.id,
    muted: true,
  });
  for (const token of [undefined, alice.token, "wrong", admin + "x"])
    assert.equal((await api("/api/admin/snapshot", null, token)).status, 404);
  const result = await api("/api/admin/snapshot", null, admin);
  assert.equal(result.status, 200);
  assert.ok(
    !result.data.tables.some((table) =>
      ["tickets", "voices", "connections"].includes(table.name),
    ),
  );
  // Preserve the AUTOINCREMENT ceiling even when the highest row was removed.
  server.db
    .prepare(
      "INSERT INTO messages(sequence,id,clientId,groupId,userId,body,createdAt) VALUES (1000,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      randomUUID(),
      group.id,
      alice.user.id,
      "removed",
      Date.now(),
    );
  server.db.prepare("DELETE FROM messages WHERE sequence=1000").run();
  server.db.exec(
    "CREATE TABLE __hosting_metadata (value TEXT); INSERT INTO __hosting_metadata VALUES ('not application data');",
  );
  const snapshot = captureSnapshot(sqliteAdapter(server.db));
  assert.ok(!snapshot.tables.some((table) => table.name.startsWith("_")));
  const key = randomBytes(32).toString("hex");
  const encrypted = encryptSnapshot(snapshot, key);
  assert.ok(!encrypted.includes(Buffer.from("Keep this after a disaster.")));
  assert.throws(() =>
    decryptSnapshot(encrypted, randomBytes(32).toString("hex")),
  );
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decryptSnapshot(corrupt, key));
  const db = restoreDatabase(
    decryptSnapshot(encrypted, key),
    join(restoredDir, "gather.sqlite"),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM connections").get().count,
    0,
  );
  assert.throws(
    () => restoreSnapshot(sqliteAdapter(db), snapshot),
    /empty destination/,
  );
  db.close();
  assert.throws(
    () => restoreDatabase(snapshot, join(restoredDir, "gather.sqlite")),
    /EEXIST/,
  );
  recovered = createGatherServer({ dataDir: restoredDir, env: {} });
  assert.equal(recovered.domain.authorize(alice.token).id, alice.user.id);
  const history = await recovered.domain.handle(
    "GET",
    `/api/groups/${group.id}/messages`,
    {},
    bob.token,
  );
  assert.equal(history.messages[0].id, message.id);
  await assert.rejects(
    recovered.domain.handle(
      "GET",
      `/api/groups/${group.id}/messages`,
      {},
      eve.token,
    ),
    { status: 403 },
  );
  assert.equal(
    (
      await recovered.domain.handle(
        "POST",
        `/api/groups/${group.id}/messages`,
        { clientId, body: message.body },
        alice.token,
      )
    ).id,
    message.id,
  );
  const next = await recovered.domain.handle(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "After restore" },
    bob.token,
  );
  assert.equal(next.sequence, 1001);
  assert.equal(
    (await recovered.domain.handle("GET", "/api/bootstrap", {}, alice.token))
      .voice[group.id].length,
    0,
  );
});

test("snapshot restore rejects unsupported schemas and broken references atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-snapshot-invalid-"));
  const server = createGatherServer({ dataDir: directory, env: {} });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await server.domain.handle("POST", "/api/sessions", { name: "Owner" });
  const snapshot = captureSnapshot(sqliteAdapter(server.db));
  const malicious = structuredClone(snapshot);
  malicious.tables[0].name = "users; DROP TABLE users";
  assert.throws(() => restoreDatabase(malicious), /schema/);
  const broken = structuredClone(snapshot);
  broken.tables.find((table) => table.name === "memberships").rows[0].userId =
    randomUUID();
  assert.throws(() => restoreDatabase(broken), /references/);
  const db = restoreDatabase(snapshot);
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    1,
  );
});
test("a backup taken before the delivery table existed still restores", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-oldbackup-"));
  const server = createGatherServer({ dataDir });
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const snapshot = captureSnapshot(sqliteAdapter(server.db));
  snapshot.tables = snapshot.tables.filter(
    (table) => table.name !== "media_fetches",
  );
  const restored = restoreDatabase(snapshot);
  t.after(() => restored.close());
  assert.equal(
    restored.prepare("SELECT COUNT(*) AS n FROM media_fetches").get().n,
    0,
  );
});
