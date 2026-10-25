import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema, createDomain } from "../server/domain.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";

test("four-person admission, full-call takeover, stale close and audio-only private signaling", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const events = [];
  const domain = createDomain(
    db,
    {},
    { connection: (id, event) => events.push({ id, event }) },
  );
  const people = [];
  let group;
  async function connection(person) {
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
  for (let index = 0; index < 5; index++) {
    const person = await domain.handle("POST", "/api/sessions", {
      name: `Friend ${index + 1}`,
      ...(group ? { inviteCode: group.inviteCode } : {}),
    });
    if (!group)
      group = (await domain.handle("GET", "/api/bootstrap", {}, person.token))
        .groups[0];
    people.push({ ...person, connection: await connection(person) });
  }
  for (const person of people.slice(0, 4))
    domain.realtimeMessage(person.connection, "voice:join", {
      groupId: group.id,
    });
  assert.throws(
    () =>
      domain.realtimeMessage(people[4].connection, "voice:join", {
        groupId: group.id,
      }),
    { status: 409 },
  );
  const next = await connection(people[0]);
  const roster = domain.realtimeMessage(next, "voice:join", {
    groupId: group.id,
    muted: true,
  });
  assert.equal(roster.peers.length, 4);
  assert.equal(new Set(roster.peers.map((peer) => peer.userId)).size, 4);
  assert.equal(
    roster.peers.find((peer) => peer.connectionId === next).muted,
    true,
  );
  assert.ok(
    events.some(
      (event) =>
        event.id === people[0].connection && event.event === "voice:replaced",
    ),
  );
  domain.realtimeClose(people[0].connection);
  assert.equal(domain.voicePeers(group.id).length, 4);
  assert.throws(
    () => domain.realtimeMessage(people[4].connection, "signal", { to: next }),
    { status: 403 },
  );
  assert.throws(() => domain.realtimeMessage(next, "signal", { to: next }), {
    status: 400,
  });
  assert.throws(
    () =>
      domain.realtimeMessage(next, "signal", {
        to: people[1].connection,
        description: {
          type: "offer",
          sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
        },
      }),
    { status: 400 },
  );
  domain.realtimeMessage(next, "signal", {
    to: people[1].connection,
    description: {
      type: "offer",
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    },
  });
  assert.ok(
    events.some(
      (event) => event.id === people[1].connection && event.event === "signal",
    ),
  );
});
