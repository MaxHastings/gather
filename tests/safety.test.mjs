import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initializeSchema } from "../server/schema.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { createObjectStorage } from "../server/object-storage.mjs";
import { createDomain } from "../server/domain.mjs";

const ADMIN = "safety-test-operator-token-000000000000000000000000000000";
const MB = 1_000_000;

function fixture(t, env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const objects = new Map();
  const provider = {
    list: async () => ({
      objects: [...objects].map(([key, size]) => ({ key, size })),
      truncated: false,
    }),
    put: async (key, bytes) => objects.set(key, bytes.length),
    delete: async (key) => objects.delete(key),
  };
  const storage = createObjectStorage(db, provider);
  const events = [];
  const domain = createDomain(
    db,
    { GATHER_ADMIN_TOKEN: ADMIN, ...env },
    {
      connection: (id, event, data) => events.push({ id, event, data }),
    },
    { objectStorage: storage },
  );
  const call = (method, path, body = {}, token, context = {}) =>
    domain.handle(method, path, body, token, new URLSearchParams(), context);
  const admin = (method, path, body) => call(method, path, body, ADMIN);
  return { sqlite, db, domain, storage, objects, events, call, admin };
}

// Prepare a real upload through the policy, then settle it as a sent file
// without moving bytes (the policy only cares about accounting).
async function share(f, token, groupId, bytes = 10 * MB) {
  const id = randomUUID();
  try {
    await f.call(
      "POST",
      `/api/groups/${groupId}/uploads`,
      {
        id,
        name: "clip.bin",
        type: "application/octet-stream",
        bytes,
        sha256: "a".repeat(64),
      },
      token,
    );
  } catch (error) {
    return { ok: false, status: error.status, message: error.message };
  }
  f.sqlite
    .prepare("UPDATE media_uploads SET state='committed' WHERE id=?")
    .run(id);
  f.sqlite
    .prepare(
      "UPDATE storage_objects SET state='ready' WHERE key=(SELECT key FROM media_uploads WHERE id=?)",
    )
    .run(id);
  return { ok: true, id };
}
const join = async (f, name, code) => {
  const session = await f.call("POST", "/api/sessions", {
    name,
    ...(code ? { inviteCode: code } : {}),
  });
  const group = (await f.call("GET", "/api/bootstrap", {}, session.token))
    .groups[0];
  return { ...session, group };
};

test("people can report a message; the operator can remove it, its file, the person and the chat", async (t) => {
  const f = fixture(t);
  const alice = await join(f, "Alice");
  const bob = await join(f, "Bob", alice.group.inviteCode);
  const outsider = await join(f, "Outsider");
  const message = await f.call(
    "POST",
    `/api/groups/${alice.group.id}/messages`,
    { clientId: randomUUID(), body: "something awful" },
    bob.token,
    { ip: "203.0.113.9" },
  );
  await assert.rejects(
    f.call(
      "POST",
      "/api/reports",
      { groupId: alice.group.id, messageId: message.id, reason: "illegal" },
      outsider.token,
    ),
    { status: 403 },
  );
  await assert.rejects(
    f.call(
      "POST",
      "/api/reports",
      { groupId: alice.group.id, messageId: message.id, reason: "nope" },
      alice.token,
    ),
    { status: 400 },
  );
  await assert.rejects(
    f.call(
      "POST",
      "/api/reports",
      { groupId: alice.group.id, messageId: message.id, reason: "abuse" },
      bob.token,
    ),
    { status: 400 },
  );
  const sent = await f.call(
    "POST",
    "/api/reports",
    {
      groupId: alice.group.id,
      messageId: message.id,
      reason: "illegal",
      detail: "please look",
    },
    alice.token,
    { ip: "198.51.100.1" },
  );
  // Reporting twice does not pile up duplicates.
  const again = await f.call(
    "POST",
    "/api/reports",
    { groupId: alice.group.id, messageId: message.id, reason: "illegal" },
    alice.token,
  );
  assert.equal(again.id, sent.id);
  await assert.rejects(f.call("GET", "/api/admin/reports", {}, alice.token), {
    status: 404,
  });
  const { reports } = await f.admin("GET", "/api/admin/reports");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].excerpt, "something awful");
  assert.equal(reports[0].targetName, "Bob");

  const file = await share(f, bob.token, alice.group.id, 1 * MB);
  assert.ok(file.ok);
  const removedFile = await f.admin("POST", "/api/admin/remove-file", {
    uploadId: file.id,
  });
  assert.equal(removedFile.removed, 1);

  await f.admin("POST", "/api/admin/remove-message", { messageId: message.id });
  const history = await f.call(
    "GET",
    `/api/groups/${alice.group.id}/messages`,
    {},
    alice.token,
  );
  assert.equal(history.messages.find((m) => m.id === message.id).body, "");

  const ban = await f.admin("POST", "/api/admin/ban", {
    userId: bob.user.id,
    reason: "test",
    purge: true,
  });
  assert.equal(ban.sessionsEnded, 1);
  await assert.rejects(f.call("GET", "/api/bootstrap", {}, bob.token), {
    status: 401,
  });
  await f.admin("POST", "/api/admin/reports/resolve", {
    id: sent.id,
    status: "actioned",
  });
  assert.equal((await f.admin("GET", "/api/admin/reports")).reports.length, 0);

  const removed = await f.admin("POST", "/api/admin/remove-group", {
    groupId: alice.group.id,
  });
  assert.equal(removed.members, 2);
  const after = await f.call("GET", "/api/bootstrap", {}, alice.token);
  assert.equal(after.groups.length, 0);
  // The old invite link is dead.
  await assert.rejects(
    f.call(
      "POST",
      "/api/groups/join",
      { code: alice.group.inviteCode },
      outsider.token,
    ),
    { status: 404 },
  );
});

test("anyone can send a report from the public page without an account", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.call("POST", "/api/public-reports", { detail: "hi" }),
    { status: 400 },
  );
  await f.call(
    "POST",
    "/api/public-reports",
    {
      reason: "illegal",
      detail: "Seen a bad file in chat 'x'",
      contact: "me@example.test",
    },
    undefined,
    { ip: "203.0.113.5" },
  );
  const { reports } = await f.admin("GET", "/api/admin/reports");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reporterName, "(web form)");
  assert.equal(reports[0].contact, "me@example.test");
});

test("a banned person's address can be blocked and an operator can pause sign-ups", async (t) => {
  const f = fixture(t);
  const troll = await f.call(
    "POST",
    "/api/sessions",
    { name: "Troll" },
    undefined,
    { ip: "192.0.2.7" },
  );
  const ban = await f.admin("POST", "/api/admin/ban", {
    userId: troll.user.id,
    blockIp: true,
  });
  assert.deepEqual(ban.blockedIps, ["192.0.2.7"]);
  await assert.rejects(
    f.call("POST", "/api/sessions", { name: "Troll again" }, undefined, {
      ip: "192.0.2.7",
    }),
    { status: 403 },
  );
  await f.call("POST", "/api/sessions", { name: "Neighbour" }, undefined, {
    ip: "192.0.2.8",
  });
  await f.admin("POST", "/api/admin/limits", { signupsPerDay: 0 });
  await assert.rejects(
    f.call("POST", "/api/sessions", { name: "Late" }, undefined, {
      ip: "192.0.2.9",
    }),
    { status: 503 },
  );
  assert.equal((await f.admin("GET", "/api/admin/limits")).signupsPerDay, 0);
});

test("relay credentials stop at a per-person and a global daily budget", async (t) => {
  const f = fixture(t, {
    TURN_SHARED_SECRET: "x".repeat(32),
    TURN_URLS: "turn:relay.test:3478",
  });
  await f.admin("POST", "/api/admin/limits", { relayPerDay: 60 });
  const people = [];
  for (let i = 0; i < 3; i++) people.push(await join(f, `P${i}`));
  let issued = 0;
  for (const p of people)
    for (let n = 0; n < 50; n++) {
      const ice = await f.call(
        "POST",
        `/api/groups/${p.group.id}/ice`,
        {},
        p.token,
      );
      if (ice.relayAvailable) issued++;
      else assert.ok(ice.iceServers.length > 0, "calls still get free STUN");
    }
  assert.equal(issued, 60);
  await f.admin("POST", "/api/admin/limits", {
    relay: false,
    relayPerDay: 9999,
  });
  const ice = await f.call(
    "POST",
    `/api/groups/${people[0].group.id}/ice`,
    {},
    people[0].token,
  );
  assert.equal(ice.relayAvailable, false);
});

test("viral scenario: 1,000+ people, hoarders and abusers; the 5 GB pool stays capped and newcomers are never locked out", async (t) => {
  const f = fixture(t);
  const DAY = 86_400_000;
  const poolLimit = f.storage.limitBytes;
  const used = () => f.storage.used();
  const stats = { refused: 0, shared: 0 };
  const attempt = async (person, bytes) => {
    const result = await share(f, person.token, person.group.id, bytes);
    result.ok ? stats.shared++ : stats.refused++;
    assert.ok(used() <= poolLimit, "pool never exceeds the hard cap");
    return result;
  };

  // A friendly early user with one small file, to check light users are spared.
  const light = await join(f, "Light");
  const lightFile = await attempt(light, 1 * MB);
  assert.ok(lightFile.ok);

  // Hoarders: older accounts that max out their daily allowance, 30 of them.
  const hoarders = [];
  for (let i = 0; i < 30; i++) {
    const h = await join(f, `Hoarder${i}`);
    f.sqlite
      .prepare("UPDATE users SET createdAt=? WHERE id=?")
      .run(Date.now() - 5 * DAY, h.user.id);
    hoarders.push(h);
    for (let n = 0; n < 25; n++) await attempt(h, 10 * MB);
  }
  assert.ok(used() > poolLimit * 0.5, "hoarders put real pressure on the pool");

  // The crowd: 1,200 new people in ~240 chats of five, sharing as they arrive.
  let newcomersTried = 0;
  let newcomersLockedOut = 0;
  let lastGroup;
  for (let i = 0; i < 1200; i++) {
    const person =
      i % 5 === 0 || !lastGroup
        ? await join(f, `Crowd${i}`)
        : await join(f, `Crowd${i}`, lastGroup.inviteCode);
    if (i % 5 === 0) lastGroup = person.group;
    for (let n = 0; n < 6; n++) {
      const result = await attempt(person, 10 * MB);
      if (n === 0) {
        newcomersTried++;
        if (!result.ok) newcomersLockedOut++;
      }
    }
    // Text never stops, whatever the file pool looks like.
    if (i % 100 === 0) {
      const message = await f.call(
        "POST",
        `/api/groups/${person.group.id}/messages`,
        { clientId: randomUUID(), body: "still talking" },
        person.token,
      );
      assert.equal(message.body, "still talking");
    }
  }
  assert.equal(newcomersTried, 1200);
  assert.equal(
    newcomersLockedOut,
    0,
    "every newcomer's first file was accepted",
  );

  // Abusers: fresh accounts hammering uploads are held to the new-account cap.
  for (let i = 0; i < 10; i++) {
    const abuser = await join(f, `Abuser${i}`);
    let accepted = 0;
    for (let n = 0; n < 100; n++)
      if ((await attempt(abuser, 10 * MB)).ok) accepted++;
    assert.ok(accepted <= 5, `fresh account accepted ${accepted} files`);
  }

  // Heaviest users gave up files before light ones did.
  const ready = (userId) =>
    f.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE u.userId=? AND u.state='committed' AND s.state='ready'",
      )
      .get(userId).n;
  const hoarderMean =
    hoarders.reduce((n, h) => n + ready(h.user.id), 0) / hoarders.length;
  assert.ok(
    hoarderMean < 25,
    `hoarders were trimmed (${hoarderMean} files left of 25)`,
  );
  assert.equal(
    ready(light.user.id),
    1,
    "a light user's file survived the squeeze",
  );

  // Late arrival after everything: still welcome.
  const late = await join(f, "Latecomer");
  assert.ok((await attempt(late, 10 * MB)).ok);
  assert.ok(used() <= poolLimit);

  // Age-based expiry gets more aggressive under pressure.
  const before = f.sqlite
    .prepare(
      "SELECT COUNT(*) n FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE s.state='ready'",
    )
    .get().n;
  const swept = await f.domain.expireFiles(Date.now() + 2 * DAY);
  const after = f.sqlite
    .prepare(
      "SELECT COUNT(*) n FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE s.state='ready'",
    )
    .get().n;
  if (used() / poolLimit >= 0.7) assert.ok(swept.expired > 0 && after < before);
  console.log(
    `viral sim: ${stats.shared} files accepted, ${stats.refused} politely refused, pool ${(used() / 1e9).toFixed(2)} GB of ${(poolLimit / 1e9).toFixed(1)} GB`,
  );
});
