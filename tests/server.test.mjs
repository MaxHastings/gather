import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createGatherServer } from "../server/app.mjs";

test("private chats, durable history, safe retries, realtime authorization and call limits", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "gather-test-"));
  let server = createGatherServer({ dataDir, env: {}, sessionLimit: 100 });
  const address = await server.listen(0);
  let base = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function api(path, body, token, method = body ? "POST" : "GET") {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal(
    (
      await fetch(base + "/api/sessions", {
        method: "POST",
        headers: {
          Origin: "https://untrusted.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Blocked origin" }),
      })
    ).status,
    403,
  );
  const alice = (await api("/sessions", { name: "Alice" })).data;
  const aliceData = (await api("/bootstrap", null, alice.token)).data;
  const group = aliceData.groups[0];
  const bob = (
    await api("/sessions", { name: "Bob", inviteCode: group.inviteCode })
  ).data;
  const eve = (await api("/sessions", { name: "Eve" })).data;
  assert.equal(
    (await api(`/groups/${group.id}/messages`, null, eve.token)).status,
    403,
  );
  assert.equal((await api("/bootstrap", null, "invalid")).status, 401);
  assert.equal(
    (await api("/sessions", { name: "Ghost", inviteCode: "nope" })).status,
    404,
  );
  const clientId = randomUUID();
  const message = await api(
    `/groups/${group.id}/messages`,
    { clientId, body: "Hey! Ready for a game?" },
    alice.token,
  );
  const retry = await api(
    `/groups/${group.id}/messages`,
    { clientId, body: "Hey! Ready for a game?" },
    alice.token,
  );
  assert.equal(retry.data.id, message.data.id);
  assert.equal(
    (
      await api(
        `/groups/${group.id}/messages`,
        { clientId, body: "Changed text" },
        alice.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await api(`/groups/${group.id}/messages`, null, bob.token)).data.messages
      .length,
    1,
  );
  assert.equal(
    (
      await api(
        `/groups/${group.id}/messages`,
        { clientId: randomUUID(), body: "x".repeat(4001) },
        bob.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await api(`/groups/${group.id}/messages?before=bad`, null, bob.token))
      .status,
    400,
  );
  for (let i = 0; i < 52; i++)
    await api(
      `/groups/${group.id}/messages`,
      { clientId: randomUUID(), body: `Message ${i}` },
      bob.token,
    );
  const latest = (await api(`/groups/${group.id}/messages`, null, alice.token))
    .data;
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.hasMore, true);
  const earlier = (
    await api(
      `/groups/${group.id}/messages?before=${latest.messages[0].sequence}`,
      null,
      alice.token,
    )
  ).data;
  assert.equal(earlier.messages.length, 3);
  assert.equal(earlier.hasMore, false);
  const catchup = (
    await api(`/groups/${group.id}/messages?after=0`, null, alice.token)
  ).data;
  assert.equal(catchup.messages.length, 50);
  assert.equal(catchup.hasMore, true);
  assert.ok(
    catchup.messages.every(
      (m, i, all) => i === 0 || m.sequence > all[i - 1].sequence,
    ),
  );
  const remainder = (
    await api(
      `/groups/${group.id}/messages?after=${catchup.messages.at(-1).sequence}`,
      null,
      alice.token,
    )
  ).data;
  assert.equal(remainder.messages.length, 3);
  assert.equal(remainder.hasMore, false);
  assert.equal(
    (await api(`/groups/${group.id}/messages?after=-1`, null, alice.token))
      .status,
    400,
  );
  assert.equal(
    (
      await api(
        `/groups/${group.id}/messages?after=0&before=10`,
        null,
        alice.token,
      )
    ).status,
    400,
  );
  const waitPacket = (ws, event) =>
    new Promise((yes, no) => {
      const timer = setTimeout(
        () => no(new Error(`Timed out: ${event}`)),
        5000,
      );
      const listener = (raw) => {
        const packet = JSON.parse(raw.toString());
        if (packet.event === event) {
          clearTimeout(timer);
          ws.off("message", listener);
          yes(packet.data);
        }
      };
      ws.on("message", listener);
    });
  async function connect(token) {
    const ticket = (await api("/realtime-ticket", {}, token)).data.ticket;
    const ws = new WebSocket(
      base.replace("http:", "ws:") + "/realtime?ticket=" + ticket,
      { origin: base },
    );
    sockets.push(ws);
    const state = await waitPacket(ws, "state");
    assert.ok(state.connectionId);
    ws.ask = async (event, data) => {
      const reply = waitPacket(ws, "reply");
      ws.send(JSON.stringify({ event, data, requestId: randomUUID() }));
      return reply;
    };
    return { ws, state };
  }
  const a = await connect(alice.token),
    b = await connect(bob.token),
    e = await connect(eve.token);
  const typingEvent = waitPacket(b.ws, "typing");
  await a.ws.ask("typing", { groupId: group.id, active: true });
  const typing = await typingEvent;
  assert.equal(typing.name, "Alice");
  assert.equal(typing.active, true);
  assert.equal(typing.connectionId, a.state.connectionId);
  assert.match(
    (await e.ws.ask("typing", { groupId: group.id, active: true })).error,
    /private/,
  );
  assert.ok(!e.state.onlineIds.includes(alice.user.id));
  await a.ws.ask("voice:join", { groupId: group.id, muted: true });
  await b.ws.ask("voice:join", { groupId: group.id });
  const aliceSecond = await connect(alice.token);
  const charlie = (
    await api("/sessions", { name: "Charlie", inviteCode: group.inviteCode })
  ).data;
  const third = await connect(charlie.token);
  assert.equal(
    (await third.ws.ask("voice:join", { groupId: group.id })).result.peers
      .length,
    3,
  );
  const dave = (
    await api("/sessions", { name: "Dave", inviteCode: group.inviteCode })
  ).data;
  const fourth = await connect(dave.token);
  assert.equal(
    (await fourth.ws.ask("voice:join", { groupId: group.id })).result.peers
      .length,
    4,
  );
  const ellie = (
    await api("/sessions", { name: "Ellie", inviteCode: group.inviteCode })
  ).data;
  const fifth = await connect(ellie.token);
  assert.match(
    (await fifth.ws.ask("voice:join", { groupId: group.id })).error,
    /four people/,
  );
  await third.ws.ask("voice:leave", {});
  await fourth.ws.ask("voice:leave", {});
  assert.match(
    (await e.ws.ask("voice:join", { groupId: group.id })).error,
    /private/,
  );
  assert.match(
    (
      await e.ws.ask("signal", {
        to: a.state.connectionId,
        description: { type: "offer", sdp: "fake" },
      })
    ).error,
    /not in your call/,
  );
  const incoming = waitPacket(b.ws, "signal");
  await a.ws.ask("signal", {
    to: b.state.connectionId,
    description: { type: "offer", sdp: "test-sdp" },
  });
  assert.equal((await incoming).from, a.state.connectionId);
  const notice = waitPacket(b.ws, "message");
  await api(
    `/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "Realtime works." },
    alice.token,
  );
  assert.equal((await notice).body, "Realtime works.");
  const replacement = waitPacket(a.ws, "voice:replaced");
  const joined = await aliceSecond.ws.ask("voice:join", {
    groupId: group.id,
    muted: true,
  });
  await replacement;
  assert.equal(joined.result.peers.length, 2);
  assert.ok(
    joined.result.peers.some(
      (p) => p.connectionId === aliceSecond.state.connectionId && p.muted,
    ),
  );
  assert.ok(
    !joined.result.peers.some((p) => p.connectionId === a.state.connectionId),
  );
  await a.ws.ask("voice:leave", {});
  assert.equal(server.domain.voicePeers(group.id).length, 2);
  const ice = (await api(`/groups/${group.id}/ice`, {}, alice.token)).data;
  assert.equal(ice.relayAvailable, false);
  const exported = (await api("/export", null, alice.token)).data;
  assert.equal(exported.format, "gather-export-v1");
  assert.equal(exported.groups[0].messages.length, 54);
  for (const ws of sockets) ws.close();
  await server.close();
  server = createGatherServer({ dataDir, env: {} });
  const restarted = await server.listen(0);
  base = `http://127.0.0.1:${restarted.port}`;
  assert.equal(
    (
      await api(`/groups/${group.id}/messages`, null, alice.token)
    ).data.messages.at(-1).body,
    "Realtime works.",
  );
  assert.deepEqual(
    (await api("/bootstrap", null, alice.token)).data.onlineIds,
    [],
  );
  assert.equal((await api("/sign-out", {}, alice.token)).status, 200);
  assert.equal((await api("/bootstrap", null, alice.token)).status, 401);
});
