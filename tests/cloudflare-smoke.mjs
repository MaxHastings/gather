import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
const base = process.argv[2] || "http://127.0.0.1:8787";
async function api(path, body, token) {
  const r = await fetch(`${base}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert.equal(r.ok, true, JSON.stringify(data));
  return data;
}
const health = await api("/health");
assert.equal(health.service, "gather");
const alice = await api("/sessions", { name: "Connection test A" });
const bootstrap = await api("/bootstrap", null, alice.token);
const group = bootstrap.groups[0];
const bob = await api("/sessions", {
  name: "Connection test B",
  inviteCode: group.inviteCode,
});
const ticket = await api("/realtime-ticket", {}, bob.token);
const ws = new WebSocket(
  `${base.replace(/^http/, "ws")}/realtime?ticket=${ticket.ticket}`,
);
const wait = (event) =>
  new Promise((yes, no) => {
    const timeout = setTimeout(
      () => no(new Error("Timed out: " + event)),
      10000,
    );
    const listener = (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.event === event) {
        clearTimeout(timeout);
        ws.off("message", listener);
        yes(packet.data);
      }
    };
    ws.on("message", listener);
  });
try {
  const state = await wait("state");
  assert.ok(state.connectionId);
  const received = wait("message");
  const clientId = randomUUID();
  const first = await api(
    `/groups/${group.id}/messages`,
    { body: "Cloudflare adapter verified.", clientId },
    alice.token,
  );
  assert.equal((await received).id, first.id);
  const second = await api(
    `/groups/${group.id}/messages`,
    { body: "Cloudflare adapter verified.", clientId },
    alice.token,
  );
  assert.equal(first.id, second.id);
  assert.equal(
    (await api(`/groups/${group.id}/messages`, null, bob.token)).messages
      .length,
    1,
  );
  const reply = wait("reply");
  ws.send(
    JSON.stringify({
      event: "voice:join",
      data: { groupId: group.id, muted: true },
      requestId: randomUUID(),
    }),
  );
  assert.equal((await reply).result.peers[0].muted, true);
  const exported = await api("/export", null, alice.token);
  assert.equal(
    exported.groups[0].messages[0].body,
    "Cloudflare adapter verified.",
  );
  const inviteResponse = await fetch(`${base}/join/${group.inviteCode}`);
  const html = await inviteResponse.text();
  assert.equal(inviteResponse.ok, true);
  assert.match(html, /id="root"/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  const assetResponse = await fetch(new URL(asset, base));
  assert.equal(assetResponse.ok, true);
  assert.match(assetResponse.headers.get("content-type"), /javascript/);
  console.log(
    "PASS: Cloudflare health, private join, live WebSocket messages, idempotency, voice membership, history export, invite page, and assets.",
  );
} finally {
  ws.close();
  await api("/sign-out", {}, alice.token);
  await api("/sign-out", {}, bob.token);
}
