// Exercises the HTTP/Durable Object/R2 adapter and real browser signaling.
// Uses disposable profiles and their own conversation, never existing chats.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = new URL(process.argv[2] || "http://127.0.0.1:18789").origin;
if (
  new URL(base).protocol !== "https:" &&
  new URL(base).hostname !== "127.0.0.1"
)
  throw new Error("Use HTTPS or loopback.");
async function api(path, token, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`);
  return value;
}
const alice = {
  ...(await api("/api/sessions", null, { name: "Release check A" })),
  server: base,
};
const bob = {
  ...(await api("/api/sessions", null, { name: "Release check B" })),
  server: base,
};
const stranger = await api("/api/sessions", null, {
  name: "Release check outsider",
});
const group = (await api("/api/bootstrap", alice.token)).groups[0];
await api("/api/groups/join", bob.token, { code: group.inviteCode });
const original = await readFile("tests/fixtures/one-more-game.gif");
const file = {
  id: randomUUID(),
  name: "release-check.gif",
  type: "image/gif",
  bytes: original.length,
  sha256: createHash("sha256").update(original).digest("hex"),
};
await api(`/api/groups/${group.id}/uploads`, alice.token, file);
const upload = await fetch(`${base}/api/uploads/${file.id}/content`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${alice.token}`,
    "Content-Type": "application/octet-stream",
  },
  body: original,
});
assert.equal(upload.status, 200, await upload.text());
const sent = await api(`/api/groups/${group.id}/messages`, alice.token, {
  clientId: randomUUID(),
  body: "Hosted GIF check",
  attachmentIds: [file.id],
});
const generation = (await api("/api/bootstrap", alice.token)).generation;
assert.match(generation, /^[a-f0-9]{32}$/);
assert.equal((await api("/api/bootstrap", alice.token)).generation, generation);
const reply = await api(`/api/groups/${group.id}/messages`, bob.token, {
  clientId: randomUUID(),
  body: "Hosted reply check",
  replyTo: sent.id,
});
assert.equal(reply.replyTo, sent.id);
assert.equal(reply.reply.body, sent.body);
const cancelled = randomUUID();
assert.equal(
  (
    await api(`/api/groups/${group.id}/outbox/${cancelled}`, alice.token, {
      action: "cancel",
    })
  ).cancelled,
  true,
);
const late = await fetch(base + `/api/groups/${group.id}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${alice.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ clientId: cancelled, body: "Must not send" }),
});
assert.equal(late.status, 409);
const content = `${base}/api/attachments/${file.id}/content`;
const full = await fetch(content, {
  headers: { Authorization: `Bearer ${bob.token}` },
});
assert.equal(full.status, 200);
assert.deepEqual(Buffer.from(await full.arrayBuffer()), original);
const range = await fetch(content, {
  headers: { Authorization: `Bearer ${bob.token}`, Range: "bytes=0-9" },
});
assert.equal(range.status, 206);
assert.deepEqual(
  Buffer.from(await range.arrayBuffer()),
  original.subarray(0, 10),
);
for (const token of [null, stranger.token]) {
  const response = await fetch(content, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.ok([401, 403].includes(response.status));
}
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const pages = [],
  errors = [];
try {
  for (const session of [alice, bob]) {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(
      ({ session, groupId, relay }) => {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(`gather.selected.${session.user.id}`, groupId);
        localStorage.setItem("gather.theme", "dark");
        if (relay) localStorage.setItem("gather.relayOnly", "true");
        window.__tracks = [];
        const capture = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await capture(constraints);
          window.__tracks.push(...stream.getTracks());
          return stream;
        };
        window.__peers = [];
        const Native = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Native {
          constructor(...args) {
            super(...args);
            window.__peers.push(this);
          }
        };
      },
      {
        session,
        groupId: group.id,
        relay: process.env.GATHER_HOSTED_RELAY === "1",
      },
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/join/${group.inviteCode}`);
    await expect(page.getByText("Online", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    pages.push(page);
  }
  await pages[0]
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hosted realtime works");
  await pages[0]
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    pages[1]
      .locator(".message-bubble")
      .filter({ hasText: "Hosted realtime works" }),
  ).toBeVisible();
  for (const page of pages)
    await page
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const page of pages) {
    await expect(
      page.getByText("Voice connected", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            let received = 0;
            for (const pc of window.__peers)
              for (const report of (await pc.getStats()).values())
                if (report.type === "inbound-rtp" && report.kind === "audio")
                  received += report.packetsReceived ?? 0;
            return received;
          }),
        { timeout: 20000 },
      )
      .toBeGreaterThan(10);
    if (process.env.GATHER_HOSTED_RELAY === "1")
      assert.equal(
        await page.evaluate(() =>
          window.__peers
            .filter((pc) => pc.connectionState === "connected")
            .every(
              (pc) => pc.getConfiguration().iceTransportPolicy === "relay",
            ),
        ),
        true,
      );
  }
  const picture = Buffer.from(
    await pages[0].evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      context.fillStyle = "#008dff";
      context.fillRect(0, 0, 256, 256);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }),
  );
  const avatarIds = [randomUUID(), randomUUID()];
  for (const [index, path] of [
    "/api/profile/avatar",
    `/api/groups/${group.id}/avatar`,
  ].entries()) {
    const response = await fetch(
      `${base}${path}/content?id=${avatarIds[index]}&revision=0`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "image/png",
        },
        body: picture,
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const url = `${base}/api/avatars/${avatarIds[index]}/content`;
    const shared = await fetch(url, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(shared.status, 200);
    assert.deepEqual(Buffer.from(await shared.arrayBuffer()), picture);
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: `Bearer ${stranger.token}` },
        })
      ).status,
      403,
    );
  }
  for (const page of pages)
    await expect(
      page.locator(".conversation-header .group-icon .avatar-image"),
    ).toBeVisible();
  await mkdir("test-results", { recursive: true });
  await pages[0].screenshot({
    path: `test-results/hosted-${new URL(base).protocol === "https:" ? "production" : "local"}.png`,
  });
  const audioBytes = await Promise.all(
    pages.map((page) =>
      page.evaluate(async () => {
        let sent = 0,
          received = 0,
          relayPairs = 0;
        for (const pc of window.__peers) {
          const stats = await pc.getStats();
          for (const r of stats.values()) {
            if (r.type === "outbound-rtp" && r.kind === "audio")
              sent += r.bytesSent ?? 0;
            if (r.type === "inbound-rtp" && r.kind === "audio")
              received += r.bytesReceived ?? 0;
            if (
              r.type === "candidate-pair" &&
              r.state === "succeeded" &&
              r.nominated &&
              stats.get(r.localCandidateId)?.candidateType === "relay"
            )
              relayPairs++;
          }
        }
        return { sent, received, relayPairs };
      }),
    ),
  );
  if (process.env.GATHER_HOSTED_RELAY === "1")
    for (const usage of audioBytes) assert.ok(usage.relayPairs > 0);
  const beforeRemoval = (await api("/api/bootstrap", alice.token)).groups.find(
    (g) => g.id === group.id,
  );
  assert.equal(beforeRemoval.ownerId, alice.user.id);
  const afterRemoval = await api(
    `/api/groups/${group.id}/membership`,
    alice.token,
    {
      action: "remove",
      userId: bob.user.id,
      revision: beforeRemoval.controlRevision,
    },
  );
  assert.notEqual(afterRemoval.inviteCode, group.inviteCode);
  await expect(pages[1].locator(".chat-readonly")).toBeVisible();
  await expect(pages[1].locator(".call-bar")).toHaveCount(0);
  assert.equal(
    await pages[1].evaluate(() =>
      window.__tracks.every((t) => t.readyState === "ended"),
    ),
    true,
  );
  assert.equal(
    await pages[1].evaluate(() =>
      window.__peers.every((p) => p.connectionState === "closed"),
    ),
    true,
  );
  for (const path of [
    content,
    ...avatarIds.map((id) => `${base}/api/avatars/${id}/content`),
  ]) {
    assert.equal(
      (await fetch(path, { headers: { Authorization: `Bearer ${bob.token}` } }))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(base + "/api/groups/join", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: group.inviteCode }),
      })
    ).status,
    404,
  );
  await expect(pages[0].locator(".call-bar, .call-stage")).toBeVisible();
  await expect(
    pages[0].getByText("Waiting for a friend", { exact: true }),
  ).toBeVisible();
  await pages[0]
    .getByRole("button", { name: "Leave call", exact: true })
    .click();
  await api("/api/groups/join", bob.token, { code: afterRemoval.inviteCode });
  await expect(
    pages[1].getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await api("/api/profile/avatar/remove", alice.token, { baseRevision: 1 });
  await api(`/api/groups/${group.id}/avatar/remove`, alice.token, {
    baseRevision: 1,
  });
  for (const id of avatarIds)
    assert.equal(
      (
        await fetch(`${base}/api/avatars/${id}/content`, {
          headers: { Authorization: `Bearer ${bob.token}` },
        })
      ).status,
      404,
    );
  assert.deepEqual(errors, []);
  await api(`/api/messages/${sent.id}/delete`, alice.token, {
    baseRevision: sent.contentRevision,
  });
  const refreshedReply = await api(
    `/api/groups/${group.id}/message/${reply.id}`,
    bob.token,
  );
  assert.equal(refreshedReply.reply.deleted, true);
  assert.equal(refreshedReply.reply.body, "");
  assert.equal(
    (
      await fetch(content, {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).status,
    404,
  );
  await writeFile(
    `test-results/hosted-${new URL(base).protocol === "https:" ? "production" : "local"}.json`,
    JSON.stringify(
      {
        origin: base,
        completedAt: new Date().toISOString(),
        repliesAndCancellation: true,
        generationStable: true,
        audioBytes,
        privateOriginal: true,
        ranges: true,
        unauthorizedDenied: true,
        deletionDenied: true,
        realtime: true,
        bidirectionalAudioPackets: true,
        privateAvatarsAndRemoval: true,
        membershipRevocationAndReadmission: true,
        forcedRelay: process.env.GATHER_HOSTED_RELAY === "1",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: hosted private GIF original/ranges/authorization/deletion, profile/group avatars and removal, realtime messages, bidirectional voice packets, member removal during voice and explicit readmission.",
  );
} finally {
  await browser.close();
}
