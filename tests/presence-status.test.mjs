import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { mentionsUser, splitMentions } from "../server/mentions.mjs";
import { notificationCandidate } from "../server/notification-policy.mjs";

async function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [];
  const domain = createDomain(db, {}, {
    group: (groupId, event, data) => events.push({ groupId, event, data }),
    connection: () => {},
  });
  const ana = await domain.handle("POST", "/api/sessions", { name: "Ana" });
  const group = (await domain.handle("GET", "/api/bootstrap", {}, ana.token))
    .groups[0];
  const ben = await domain.handle("POST", "/api/sessions", {
    name: "Ben",
    inviteCode: group.inviteCode,
  });
  async function connect(person) {
    const { ticket } = await domain.handle(
      "POST",
      "/api/realtime-ticket",
      {},
      person.token,
    );
    const id = randomUUID();
    domain.realtimeOpen(id, domain.claimTicket(ticket));
    return id;
  }
  const send = (person, body) =>
    domain.handle(
      "POST",
      `/api/groups/${group.id}/messages`,
      { body, clientId: randomUUID() },
      person.token,
    );
  return { domain, events, ana, ben, group, connect, send };
}

test("away is a per-person hint that clears on activity and disconnect", async (t) => {
  const { domain, events, ana, ben, group, connect } = await setup(t);
  const anaConn = await connect(ana);
  await connect(ben);
  events.length = 0;
  domain.realtimeMessage(anaConn, "presence:set", { away: true });
  const away = events.find((e) => e.event === "presence");
  assert.deepEqual(away.data, { userId: ana.user.id, online: true, away: true });
  const state = (
    await domain.handle("GET", "/api/bootstrap", {}, ben.token)
  ).awayIds;
  assert.deepEqual(state, [ana.user.id]);
  domain.realtimeMessage(anaConn, "presence:set", { away: false });
  assert.equal(events.at(-1).data.away, false);
  domain.realtimeMessage(anaConn, "presence:set", { away: true });
  domain.realtimeClose(anaConn);
  assert.equal(events.at(-1).data.online, false);
  assert.equal(events.at(-1).data.away, false);
  assert.ok(group.id);
});

test("a status message is saved, trimmed and shown to the chat", async (t) => {
  const { domain, ana, ben } = await setup(t);
  const result = await domain.handle(
    "POST",
    "/api/profile",
    { name: "Ana", status: "  back at 9  " },
    ana.token,
  );
  assert.equal(result.status, "back at 9");
  const seen = await domain.handle("GET", "/api/bootstrap", {}, ben.token);
  assert.equal(
    seen.groups[0].members.find((p) => p.id === ana.user.id).status,
    "back at 9",
  );
  await assert.rejects(
    domain.handle("POST", "/api/profile", { name: "Ana", status: 5 }, ana.token),
    { status: 400 },
  );
  // Renaming without a status keeps the old one.
  const renamed = await domain.handle(
    "POST",
    "/api/profile",
    { name: "Ana B" },
    ana.token,
  );
  assert.equal(renamed.status, "back at 9");
});

test("read positions only move forward, are capped and are shared with the chat", async (t) => {
  const { domain, events, ana, ben, group, connect, send } = await setup(t);
  const benConn = await connect(ben);
  const first = await send(ana, "hello");
  const second = await send(ana, "again");
  events.length = 0;
  domain.realtimeMessage(benConn, "read", {
    groupId: group.id,
    sequence: second.sequence,
  });
  assert.deepEqual(events.at(-1).data, {
    groupId: group.id,
    userId: ben.user.id,
    sequence: second.sequence,
  });
  events.length = 0;
  domain.realtimeMessage(benConn, "read", {
    groupId: group.id,
    sequence: first.sequence,
  });
  domain.realtimeMessage(benConn, "read", { groupId: group.id, sequence: 1e9 });
  assert.equal(events.filter((e) => e.event === "read").length, 0);
  const boot = await domain.handle("GET", "/api/bootstrap", {}, ana.token);
  assert.equal(boot.groups[0].reads[ben.user.id], second.sequence);
  const stranger = await domain.handle("POST", "/api/sessions", {
    name: "Cy",
  });
  const cyConn = await connect(stranger);
  assert.throws(
    () =>
      domain.realtimeMessage(cyConn, "read", {
        groupId: group.id,
        sequence: 1,
      }),
    { status: 403 },
  );
});

test("deleting an account removes content, passes ownership on and ends sign-in", async (t) => {
  const { domain, events, ana, ben, group, send } = await setup(t);
  const kept = await send(ben, "stays");
  const gone = await send(ana, "goes away");
  await assert.rejects(
    domain.handle("POST", "/api/account/delete", {}, ana.token),
    { status: 400 },
  );
  events.length = 0;
  await domain.handle(
    "POST",
    "/api/account/delete",
    { confirm: "delete my account" },
    ana.token,
  );
  await assert.rejects(domain.handle("GET", "/api/bootstrap", {}, ana.token), {
    status: 401,
  });
  const boot = await domain.handle("GET", "/api/bootstrap", {}, ben.token);
  const chat = boot.groups[0];
  assert.equal(chat.ownerId, ben.user.id);
  assert.deepEqual(
    chat.members.map((p) => p.id),
    [ben.user.id],
  );
  const history = await domain.handle(
    "GET",
    `/api/groups/${group.id}/messages`,
    {},
    ben.token,
  );
  const byId = new Map(history.messages.map((m) => [m.id, m]));
  assert.equal(byId.get(kept.id).body, "stays");
  assert.equal(byId.get(gone.id).body, "");
  assert.ok(byId.get(gone.id).deletedAt);
});

test("mentions match known names, including names with spaces and @everyone", () => {
  assert.equal(mentionsUser("hi @Mac well!", "Mac well"), true);
  assert.equal(mentionsUser("hi @max", "Max"), true);
  assert.equal(mentionsUser("mail me at a@max.com", "max"), false);
  assert.equal(mentionsUser("hi @maxine", "max"), false);
  assert.equal(mentionsUser("@everyone dinner", "anyone"), true);
  assert.deepEqual(
    splitMentions("yo @Ana, ok", ["Ana"]).map((p) => p.type),
    ["text", "mention", "text"],
  );
});

test("muted chats and Do Not Disturb silence alerts, but a mention beats a mute", () => {
  const group = { id: "g1", name: "Crew" };
  const input = {
    message: {
      id: "m1",
      groupId: "g1",
      userId: "other",
      name: "Ben",
      body: "hey @Ana",
      createdAt: 1_000_000,
    },
    changeKind: "create",
    userId: "me",
    group,
    selected: "g2",
    focused: true,
    now: 1_000_500,
    preferences: { enabled: true, preview: true, muted: [], mutedUntil: {} },
  };
  assert.ok(notificationCandidate(input));
  const muted = { ...input.preferences, mutedUntil: { g1: 2_000_000 } };
  assert.equal(notificationCandidate({ ...input, preferences: muted }), null);
  const mention = notificationCandidate({
    ...input,
    preferences: muted,
    mentioned: true,
  });
  assert.match(mention.title, /mentioned you/);
  assert.equal(
    notificationCandidate({
      ...input,
      mentioned: true,
      preferences: { ...input.preferences, dndUntil: 2_000_000 },
    }),
    null,
  );
  // An expired mute no longer applies.
  assert.ok(
    notificationCandidate({
      ...input,
      preferences: { ...input.preferences, mutedUntil: { g1: 900_000 } },
    }),
  );
});
