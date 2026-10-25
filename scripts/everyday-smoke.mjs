import { chromium, expect } from "@playwright/test";
import { createGatherServer } from "../server/app.mjs";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "gather-everyday-"));
const server = createGatherServer({ dataDir: dir, env: {} }),
  { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const api = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const a = {
    ...(await api("POST", "/api/sessions", { name: "Max" })),
    server: base,
  },
  group = (await api("GET", "/api/bootstrap", {}, a.token)).groups[0];
const b = {
  ...(await api("POST", "/api/sessions", {
    name: "Jamie",
    inviteCode: group.inviteCode,
  })),
  server: base,
};
const second = await api(
  "POST",
  "/api/groups",
  { name: "Second room" },
  a.token,
);
const original = await api(
  "POST",
  `/api/groups/${group.id}/messages`,
  { clientId: randomUUID(), body: "Pizza at eight?" },
  a.token,
);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const errors = [];
try {
  const pages = [];
  for (const session of [a, b]) {
    const context = await browser.newContext({
      permissions: ["microphone", "clipboard-read", "clipboard-write"],
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(
      ({ session, id }) => {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(`gather.selected.${session.user.id}`, id);
        localStorage.setItem("gather.theme", "dark");
        window.__peers = [];
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(Target, args) {
            const pc = new Target(...args);
            window.__peers.push(pc);
            return pc;
          },
        });
      },
      { session, id: group.id },
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    pages.push(page);
  }
  const [page, friend] = pages;
  const send = async (p, text) => {
    await p.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await p.getByRole("button", { name: "Send message", exact: true }).click();
  };
  const originalFriend = friend.locator(`[data-message-id="${original.id}"]`);
  await originalFriend.hover();
  await originalFriend
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await originalFriend
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(friend.locator(".composer-reply")).toContainText(
    "Pizza at eight?",
  );
  await send(friend, "Yes, this one.");
  const reply = page
    .locator(".message-row")
    .filter({ hasText: "Yes, this one." });
  await expect(reply.locator(".reply-reference")).toContainText(
    "Pizza at eight?",
  );
  await api(
    "POST",
    `/api/messages/${original.id}/edit`,
    { body: "Pizza at nine?", baseRevision: original.contentRevision },
    a.token,
  );
  await expect(reply.locator(".reply-reference")).toContainText(
    "Pizza at nine?",
  );
  await api("POST", `/api/messages/${original.id}/delete`, {}, a.token);
  await expect(reply.locator(".reply-reference")).toContainText(
    "Message deleted",
  );
  await page.bringToFront();
  await reply.hover();
  await reply
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await reply.getByRole("button", { name: "Copy", exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "Yes, this one.",
  );
  await send(
    page,
    "**strong** *soft* ~~old~~ `code` https://example.com/a(b). <script>plain text</script>",
  );
  const formatted = friend
    .locator(".message-bubble")
    .filter({ hasText: "plain text" });
  await expect(formatted.locator("strong")).toHaveText("strong");
  await expect(formatted.locator("em")).toHaveText("soft");
  await expect(formatted.locator("s")).toHaveText("old");
  await expect(formatted.locator("code")).toHaveText("code");
  await expect(formatted.locator("a")).toHaveAttribute(
    "href",
    "https://example.com/a(b)",
  );
  assert.equal(await formatted.locator("script").count(), 0);
  console.log(
    "PASS: replies follow edits/deletion, copying another member’s message, safe formatting and clickable links.",
  );
  const bytes = await readFile("tests/fixtures/one-more-game.gif");
  const file = {
    id: randomUUID(),
    name: "game.gif",
    type: "image/gif",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await api("POST", `/api/groups/${group.id}/uploads`, file, a.token);
  const put = await server.domain.mediaRequest(
    new Request(base + `/api/uploads/${file.id}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}` },
      body: bytes,
    }),
  );
  assert.equal(put.status, 200);
  const media = await api(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "Look at this", attachmentIds: [file.id] },
    a.token,
  );
  await expect(
    page.locator(`[data-message-id="${media.id}"] .attachment img`),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View game.gif", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "View game.gif", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".media-viewer")).toHaveCount(0);
  for (const p of pages)
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of pages)
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 20000,
    });
  for (const p of pages)
    await expect
      .poll(
        () =>
          p.evaluate(async () => {
            let count = 0;
            for (const pc of window.__peers)
              for (const r of (await pc.getStats()).values())
                if (r.type === "inbound-rtp" && r.kind === "audio")
                  count += r.packetsReceived ?? 0;
            return count;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(10);
  console.log(
    "PASS: larger GIF viewing and keyboard return, with real two-way voice packets.",
  );
  const fail = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary send failure." }),
    });
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.continue(),
  );
  await send(page, "Needs correction");
  let queued = page
    .locator(".message-row")
    .filter({ hasText: "Needs correction" });
  await expect(queued).toContainText("Not sent");
  await queued.getByRole("button", { name: "Edit draft", exact: true }).click();
  await expect(
    queued.getByRole("textbox", { name: "Edit unsent message" }),
  ).toBeVisible();
  await queued
    .getByRole("textbox", { name: "Edit unsent message" })
    .fill("Corrected before sending");
  await page.unroute("**/api/groups/*/messages");
  await queued
    .getByRole("button", { name: "Send new message", exact: true })
    .click();
  await expect(
    friend
      .locator(".message-bubble")
      .filter({ hasText: "Corrected before sending" }),
  ).toBeVisible();
  assert.equal(
    (
      await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
    ).messages.some((m) => m.body === "Needs correction"),
    false,
  );
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.continue(),
  );
  await send(page, "Pause this item");
  queued = page.locator(".message-row").filter({ hasText: "Pause this item" });
  await expect(queued).toContainText("Not sent");
  await queued.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(queued).toContainText("Paused");
  await page.unroute("**/api/groups/*/messages");
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await expect(queued).toContainText("Paused");
  assert.equal(
    (
      await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
    ).messages.some((m) => m.body === "Pause this item"),
    false,
  );
  await queued.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    friend.locator(".message-bubble").filter({ hasText: "Pause this item" }),
  ).toBeVisible();
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.continue(),
  );
  await send(page, "Discard this item");
  queued = page
    .locator(".message-row")
    .filter({ hasText: "Discard this item" });
  await expect(queued).toContainText("Not sent");
  await queued.getByRole("button", { name: "Discard", exact: true }).click();
  await queued
    .getByRole("button", { name: "Discard unsent", exact: true })
    .click();
  await expect(queued).toHaveCount(0);
  await page.unroute("**/api/groups/*/messages");
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.continue(),
  );
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles("tests/fixtures/one-more-game.gif");
  await send(page, "Unsent picture draft");
  const fileQueue = page
    .locator(".message-row")
    .filter({ hasText: "Unsent picture draft" });
  await expect(fileQueue).toContainText("Not sent");
  await fileQueue
    .getByRole("button", { name: "Edit draft", exact: true })
    .click();
  await fileQueue
    .getByRole("textbox", { name: "Edit unsent message" })
    .fill("Corrected picture draft");
  await page.unroute("**/api/groups/*/messages");
  await fileQueue
    .getByRole("button", { name: "Send new message", exact: true })
    .click();
  await expect
    .poll(async () =>
      (
        await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
      ).messages.some((m) => m.body === "Corrected picture draft"),
    )
    .toBe(true);
  const fileMessage = (
    await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
  ).messages.find((m) => m.body === "Corrected picture draft");
  assert.equal(fileMessage.attachments.length, 1);
  const fileResponse = await server.domain.mediaRequest(
    new Request(
      base + `/api/attachments/${fileMessage.attachments[0].id}/content`,
      { headers: { Authorization: `Bearer ${b.token}` } },
    ),
  );
  assert.equal(fileResponse.status, 200);
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), bytes);
  await page.route("**/api/groups/*/messages", (route) =>
    route.request().method() === "POST" ? fail(route) : route.continue(),
  );
  await send(page, "First ordered item");
  await expect(
    page.locator(".message-row").filter({ hasText: "First ordered item" }),
  ).toContainText("Not sent");
  await send(page, "Second ordered item");
  await expect(
    page.locator(".message-row").filter({ hasText: "Second ordered item" }),
  ).toContainText("Queued");
  assert.equal(
    (
      await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
    ).messages.some((m) => m.body === "Second ordered item"),
    false,
  );
  await page.unroute("**/api/groups/*/messages");
  await page
    .locator(".message-row")
    .filter({ hasText: "First ordered item" })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(
    friend
      .locator(".message-bubble")
      .filter({ hasText: "Second ordered item" }),
  ).toBeVisible();
  const ordered = (
    await api("GET", `/api/groups/${group.id}/messages`, {}, a.token)
  ).messages;
  assert.ok(
    ordered.find((m) => m.body === "First ordered item").sequence <
      ordered.find((m) => m.body === "Second ordered item").sequence,
  );
  console.log(
    "PASS: server-reconciled edit/replacement, paused queue across restart, retry and durable discard.",
  );
  await page.locator(".chat-item").filter({ hasText: "Second room" }).click();
  await api(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "Unread from Jamie" },
    b.token,
  );
  await api(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body: "Later own message on another device" },
    a.token,
  );
  const chat = page.locator(".chat-item").filter({ hasText: "The usual crew" });
  await expect(chat.getByLabel("Unread messages")).toBeVisible();
  await chat.click();
  for (let i = 0; i < 120; i++)
    await api(
      "POST",
      `/api/groups/${group.id}/messages`,
      { clientId: randomUUID(), body: `Reading position ${i}` },
      b.token,
    );
  await expect(
    page.locator(".message-row").filter({ hasText: "Reading position 119" }),
  ).toBeVisible();
  await page.locator(".message-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  const anchor = await page.locator(".message-row").evaluateAll((rows) => {
    const top = document
      .querySelector(".message-scroll")
      .getBoundingClientRect().top;
    const r = rows.find((row) => row.getBoundingClientRect().bottom > top + 5);
    return { id: r.dataset.messageId, y: r.getBoundingClientRect().top };
  });
  await page.locator(".chat-item").filter({ hasText: "Second room" }).click();
  await chat.click();
  await expect
    .poll(() =>
      page
        .locator(`[data-message-id="${anchor.id}"]`)
        .evaluate((el) => Math.round(el.getBoundingClientRect().top)),
    )
    .toBe(Math.round(anchor.y));
  await page
    .getByRole("button", { name: "Search messages", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search saved messages" })
    .fill("Reading position 10");
  await page
    .locator(".history-results button")
    .filter({ hasText: "Reading position 10" })
    .first()
    .click();
  await page.getByRole("button", { name: "Open in chat", exact: true }).click();
  await expect(page.locator(".message-highlight")).toBeVisible();
  console.log(
    "PASS: unread survives a later own message; reading position survives chat switches; search navigates into the conversation.",
  );
  for (const p of pages)
    if (
      await p.getByRole("button", { name: "Leave call", exact: true }).count()
    )
      await p.getByRole("button", { name: "Leave call", exact: true }).click();
  assert.deepEqual(errors, []);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/everyday-dark.png" });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({ path: "test-results/everyday-light.png" });
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "test-results/everyday-narrow.png" });
  await writeFile(
    "test-results/everyday.json",
    JSON.stringify(
      {
        passed: true,
        completedAt: new Date().toISOString(),
        features: [
          "reply",
          "copy",
          "format",
          "links",
          "viewer",
          "voice",
          "queue-edit",
          "queue-pause",
          "queue-discard",
          "unread",
          "reading",
          "search",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  await mkdir("test-results", { recursive: true });
  for (const [i, p] of browser
    .contexts()
    .flatMap((c) => c.pages())
    .entries())
    await p
      .screenshot({
        path: `test-results/everyday-failure-${i}.png`,
        timeout: 5000,
      })
      .catch(() => {});
  throw e;
} finally {
  await browser.close();
  await server.close();
  assert.ok(dir.startsWith(join(tmpdir(), "gather-everyday-")));
  await rm(dir, { recursive: true, force: true });
}
