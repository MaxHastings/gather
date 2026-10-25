import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
test("recovery preserves identity/history; code rotation and device revocation reject old credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-recovery-"));
  const server = createGatherServer({ dataDir: directory, env: {} });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = (method, path, body, token) =>
    server.domain.handle(method, "/api" + path, body, token);
  const alice = await api("POST", "/sessions", {
    name: "Alice",
    deviceName: "Original desktop",
  });
  const eve = await api("POST", "/sessions", { name: "Eve" });
  const group = (await api("GET", "/bootstrap", {}, alice.token)).groups[0];
  await api(
    "POST",
    `/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "My old history" },
    alice.token,
  );
  assert.equal(
    (await api("GET", "/recovery", {}, alice.token)).configured,
    false,
  );
  const recovery = await api("POST", "/recovery", {}, alice.token);
  assert.match(recovery.code, /^gather_[A-Za-z0-9_-]{43}$/);
  assert.ok(
    !JSON.stringify(
      server.db.prepare("SELECT * FROM recovery_codes").all(),
    ).includes(recovery.code),
  );
  const restored = await api("POST", "/recover", {
    code: recovery.code,
    deviceName: "Replacement laptop",
  });
  assert.equal(restored.user.id, alice.user.id);
  assert.equal(
    (await api("GET", `/groups/${group.id}/messages`, {}, restored.token))
      .messages[0].body,
    "My old history",
  );
  const devices = (await api("GET", "/devices", {}, restored.token)).devices;
  assert.equal(devices.length, 2);
  assert.equal(
    devices.find((device) => device.current).name,
    "Replacement laptop",
  );
  assert.ok(!JSON.stringify(devices).includes(alice.token));
  const oldDevice = devices.find((device) => !device.current);
  await assert.rejects(
    api("POST", "/devices/revoke", { id: oldDevice.id }, eve.token),
    { status: 404 },
  );
  const ticket = await api("POST", "/realtime-ticket", {}, alice.token);
  const connection = randomUUID();
  server.domain.realtimeOpen(
    connection,
    server.domain.claimTicket(ticket.ticket),
  );
  server.domain.realtimeMessage(connection, "voice:join", {
    groupId: group.id,
    muted: true,
  });
  await api("POST", "/devices/revoke", { id: oldDevice.id }, restored.token);
  await assert.rejects(api("GET", "/bootstrap", {}, alice.token), {
    status: 401,
  });
  assert.equal(server.domain.voicePeers(group.id).length, 0);
  assert.throws(
    () =>
      server.domain.realtimeMessage(connection, "voice:join", {
        groupId: group.id,
      }),
    { status: 401 },
  );
  const replacement = await api("POST", "/recovery", {}, restored.token);
  await assert.rejects(api("POST", "/recover", { code: recovery.code }), {
    status: 401,
  });
  const reset = await api("POST", "/recover", {
    code: replacement.code,
    signOutOthers: true,
  });
  await assert.rejects(api("GET", "/bootstrap", {}, restored.token), {
    status: 401,
  });
  assert.equal(
    (await api("GET", "/devices", {}, reset.token)).devices.length,
    1,
  );
  await assert.rejects(
    api(
      "POST",
      "/devices/revoke",
      { id: (await api("GET", "/devices", {}, reset.token)).devices[0].id },
      reset.token,
    ),
    { status: 409 },
  );
  for (let index = 0; index < 15; index++)
    await api("POST", "/recover", { code: replacement.code });
  await assert.rejects(api("POST", "/recover", { code: replacement.code }), {
    status: 409,
  });
  const boundedReset = await api("POST", "/recover", {
    code: replacement.code,
    signOutOthers: true,
  });
  assert.equal(
    (await api("GET", "/devices", {}, boundedReset.token)).devices.length,
    1,
  );
});
