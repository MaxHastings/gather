import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";

async function setup(t, count = 3) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [];
  const domain = createDomain(
    db,
    {},
    { connection: (id, event, data) => events.push({ id, event, data }) },
  );
  const people = [];
  let group;
  for (let index = 0; index < count; index++) {
    const person = await domain.handle("POST", "/api/sessions", {
      name: `Friend ${index + 1}`,
      ...(group ? { inviteCode: group.inviteCode } : {}),
    });
    if (!group)
      group = (await domain.handle("GET", "/api/bootstrap", {}, person.token))
        .groups[0];
    const { ticket } = await domain.handle(
      "POST",
      "/api/realtime-ticket",
      {},
      person.token,
    );
    const connection = randomUUID();
    domain.realtimeOpen(connection, domain.claimTicket(ticket));
    people.push({ ...person, connection });
  }
  const sent = (person, event) =>
    events.filter((e) => e.id === person.connection && e.event === event);
  return { domain, people, group, events, sent };
}

test("only someone in the call can ring a member, and the member sees who is calling", async (t) => {
  const { domain, people, group, sent } = await setup(t);
  const [a, b] = people;
  assert.throws(
    () =>
      domain.realtimeMessage(a.connection, "call:ring", {
        groupId: group.id,
        userIds: [b.user.id],
      }),
    { status: 403 },
  );
  domain.realtimeMessage(a.connection, "voice:join", { groupId: group.id });
  const result = domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    userIds: [b.user.id],
  });
  assert.deepEqual(result.ringing, [b.user.id]);
  const ring = sent(b, "call:ring")[0].data;
  assert.equal(ring.from.name, "Friend 1");
  assert.equal(ring.groupName, group.name);
  assert.equal(sent(a, "call:ring-status")[0].data.status, "ringing");
});

test("ringing skips people already ringing or in the call and is rate limited", async (t) => {
  const { domain, people, group } = await setup(t);
  const [a, b, c] = people;
  domain.realtimeMessage(a.connection, "voice:join", { groupId: group.id });
  domain.realtimeMessage(b.connection, "voice:join", { groupId: group.id });
  const first = domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    all: true,
  });
  assert.deepEqual(first.ringing, [c.user.id]);
  assert.deepEqual(first.skipped, [{ userId: b.user.id, reason: "in-call" }]);
  const again = domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    all: true,
  });
  assert.deepEqual(again.skipped.map((s) => s.reason).sort(), [
    "already-ringing",
    "in-call",
  ]);
  for (let i = 0; i < 3; i++)
    domain.realtimeMessage(a.connection, "call:ring", {
      groupId: group.id,
      all: true,
    });
  assert.throws(
    () =>
      domain.realtimeMessage(a.connection, "call:ring", {
        groupId: group.id,
        all: true,
      }),
    { status: 429 },
  );
});

test("declining, answering, cancelling and everyone leaving all end the ring", async (t) => {
  const { domain, people, group, sent } = await setup(t);
  const [a, b, c] = people;
  domain.realtimeMessage(a.connection, "voice:join", { groupId: group.id });
  domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    all: true,
  });
  domain.realtimeMessage(b.connection, "call:ring-decline", {
    groupId: group.id,
  });
  assert.equal(sent(b, "call:ring-end").length, 1);
  assert.ok(
    sent(a, "call:ring-status").some(
      (e) => e.data.userId === b.user.id && e.data.status === "declined",
    ),
  );
  domain.realtimeMessage(c.connection, "voice:join", { groupId: group.id });
  assert.ok(
    sent(a, "call:ring-status").some(
      (e) => e.data.userId === c.user.id && e.data.status === "answered",
    ),
  );
  assert.equal(sent(c, "call:ring-end").length, 1);

  domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    userIds: [b.user.id],
  });
  domain.realtimeMessage(a.connection, "call:ring-cancel", {
    groupId: group.id,
  });
  assert.equal(sent(b, "call:ring-end").length, 2);

  domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    userIds: [b.user.id],
  });
  domain.realtimeMessage(a.connection, "voice:leave");
  assert.equal(
    sent(b, "call:ring-end").length,
    2,
    "others are still in the call",
  );
  domain.realtimeMessage(c.connection, "voice:leave");
  assert.equal(sent(b, "call:ring-end").length, 3);
});

test("offline members are not rung", async (t) => {
  const { domain, people, group } = await setup(t);
  const [a, b] = people;
  domain.realtimeMessage(a.connection, "voice:join", { groupId: group.id });
  domain.realtimeClose(b.connection);
  const result = domain.realtimeMessage(a.connection, "call:ring", {
    groupId: group.id,
    userIds: [b.user.id],
  });
  assert.deepEqual(result.skipped, [{ userId: b.user.id, reason: "offline" }]);
});
