import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { restoreDatabase } from "../server/restore.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { createDomain } from "../server/domain.mjs";
import { encryptSnapshot, decryptSnapshot } from "../scripts/backup-crypto.mjs";
const base = process.env.GATHER_OPERATIONS_SERVER || "http://127.0.0.1:18787";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error(
    "Operations fixtures must run on an isolated loopback server.",
  );
const admin = "local-backup-test-only-000000000000000000000000000000000";
async function api(path, token, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(
    response.ok,
    true,
    `Unexpected status ${response.status} on ${path}`,
  );
  return data;
}
const health = await api("/api/health");
assert.equal(health.protocol.current, 1);
assert.equal((await fetch(base + "/api/admin/snapshot")).status, 404);
const alice = await api("/api/sessions", null, { name: "Restore drill Alice" });
const group = (await api("/api/bootstrap", alice.token)).groups[0];
const bob = await api("/api/sessions", null, {
  name: "Restore drill Bob",
  inviteCode: group.inviteCode,
});
try {
  const message = await api(`/api/groups/${group.id}/messages`, alice.token, {
    clientId: randomUUID(),
    body: "Cloudflare snapshot restore drill",
  });
  const snapshot = await api("/api/admin/snapshot", admin);
  const key = randomBytes(32).toString("hex");
  const restored = restoreDatabase(
    decryptSnapshot(encryptSnapshot(snapshot, key), key),
  );
  try {
    const domain = createDomain(sqliteAdapter(restored));
    const recovered = await domain.handle(
      "GET",
      `/api/groups/${group.id}/messages`,
      {},
      bob.token,
    );
    assert.equal(recovered.messages[0].id, message.id);
    assert.equal(domain.authorize(alice.token).id, alice.user.id);
    assert.equal(
      (await domain.handle("GET", "/api/bootstrap", {}, bob.token)).groups[0]
        .id,
      group.id,
    );
    const ticket = await domain.handle(
      "POST",
      "/api/realtime-ticket",
      {},
      bob.token,
    );
    const connection = randomUUID();
    domain.realtimeOpen(connection, domain.claimTicket(ticket.ticket));
    const voice = domain.realtimeMessage(connection, "voice:join", {
      groupId: group.id,
      muted: true,
    });
    assert.equal(voice.peers[0].muted, true);
    const next = await domain.handle(
      "POST",
      `/api/groups/${group.id}/messages`,
      { clientId: randomUUID(), body: "After restoration" },
      bob.token,
    );
    assert.ok(next.sequence > message.sequence);
  } finally {
    restored.close();
  }
  console.log(
    "PASS: real Worker snapshot, encrypted round trip, identity, membership, history, sequence and voice membership restored in standalone SQLite.",
  );
} finally {
  await api("/api/sign-out", alice.token, {});
  await api("/api/sign-out", bob.token, {});
}
