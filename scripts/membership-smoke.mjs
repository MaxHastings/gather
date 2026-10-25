import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createGatherServer } from "../server/app.mjs";
import { desktopExecutable } from "./desktop-path.mjs";

const dir = await mkdtemp(join(tmpdir(), "gather-membership-ui-"));
const server = createGatherServer({ dataDir: join(dir, "server"), env: {} });
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const api = (method, path, body, token) =>
  server.domain.handle(method, path, body, token);
const owner = {
  ...(await api("POST", "/api/sessions", { name: "Max" })),
  server: base,
};
const initial = (await api("GET", "/api/bootstrap", {}, owner.token)).groups[0];
const friend = {
  ...(await api("POST", "/api/sessions", {
    name: "Jamie",
    inviteCode: initial.inviteCode,
  })),
  server: base,
};
const third = {
  ...(await api("POST", "/api/sessions", {
    name: "Morgan",
    inviteCode: initial.inviteCode,
  })),
  server: base,
};
const original = await api(
  "POST",
  `/api/groups/${initial.id}/messages`,
  { clientId: randomUUID(), body: "Friday game night" },
  friend.token,
);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const env = {
  ...process.env,
  GATHER_TEST_DATA: join(dir, "desktop"),
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
const monitor = () => {
  window.__peers = [];
  window.__tracks = [];
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(Target, args) {
      const pc = new Target(...args);
      window.__peers.push(pc);
      return pc;
    },
  });
  const capture = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await capture(constraints);
    window.__tracks.push(...stream.getTracks());
    return stream;
  };
};
const stats = async (page) =>
  page.evaluate(async () => {
    let packets = 0;
    for (const pc of window.__peers ?? [])
      if (pc.connectionState !== "closed")
        for (const r of (await pc.getStats()).values())
          if (r.type === "inbound-rtp" && r.kind === "audio")
            packets += r.packetsReceived ?? 0;
    return packets;
  });
try {
  app = await electron.launch({
    ...(process.env.GATHER_SMOKE_PACKAGED === "1"
      ? { executablePath: desktopExecutable() }
      : {}),
    args: [
      ".",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env,
  });
  const page = await app.firstWindow();
  // The test profile deliberately starts hidden; show this isolated fixture for compositor screenshots.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.showInactive(),
  );
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  await page.evaluate((s) => window.desktop.writeSession(s, null), owner);
  await page.evaluate(
    ({ id, group }) => {
      localStorage.setItem(`gather.selected.${id}`, group);
      localStorage.setItem("gather.theme", "dark");
    },
    { id: owner.user.id, group: initial.id },
  );
  await page.reload();
  const pages = [page],
    contexts = [];
  for (const session of [friend, third, friend]) {
    const ctx = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 900 },
    });
    contexts.push(ctx);
    await ctx.addInitScript(
      ({ session, group }) => {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(`gather.selected.${session.user.id}`, group);
        localStorage.setItem("gather.theme", "dark");
      },
      { session, group: initial.id },
    );
    await ctx.addInitScript(monitor);
    const p = await ctx.newPage();
    await p.goto(base);
    pages.push(p);
  }
  for (const p of pages) {
    p.on("pageerror", (e) => errors.push(e.message));
    await expect(p.getByText("Online", { exact: true })).toBeVisible();
    await expect(p.locator(`[data-message-id="${original.id}"]`)).toBeVisible();
  }
  console.log("PASS: four isolated desktop/browser profiles loaded.");
  const [, peer, offline, secondDevice] = pages;
  await page.evaluate(monitor);
  await page.getByTitle("Chat details", { exact: true }).click();
  const details = page.getByRole("dialog", { name: "Chat details" });
  await expect(
    details.getByRole("button", { name: "Leave chat", exact: true }),
  ).toBeDisabled();
  await details
    .getByRole("button", { name: "Remove Jamie", exact: true })
    .click();
  const confirm = details.getByRole("group", {
    name: "Confirm membership change",
  });
  await expect(confirm).toContainText("old invite link will stop working");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    (await api("GET", "/api/bootstrap", {}, owner.token)).groups[0].members
      .length,
    3,
  );
  await mkdir("test-results", { recursive: true });
  await page.bringToFront();
  await page.screenshot({
    path: "test-results/membership-dark.png",
    timeout: 60000,
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({
    path: "test-results/membership-light.png",
    timeout: 60000,
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  for (const p of pages.slice(0, 3))
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of pages.slice(0, 3))
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 25000,
    });
  for (const p of pages.slice(0, 3))
    await expect.poll(() => stats(p), { timeout: 20000 }).toBeGreaterThan(5);
  console.log("PASS: real three-person audio packets received.");
  const staleBootstrap = await api("GET", "/api/bootstrap", {}, friend.token);
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => {
    releaseBootstrap = resolve;
  });
  let heldBootstraps = 0;
  await secondDevice.route("**/api/bootstrap", async (route) => {
    heldBootstraps++;
    await bootstrapGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staleBootstrap),
    });
  });
  await secondDevice.reload();
  await expect.poll(() => heldBootstraps).toBeGreaterThan(0);

  await page.getByTitle("Chat details", { exact: true }).click();
  await details
    .getByRole("button", { name: "Remove Jamie", exact: true })
    .click();
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  for (const p of [peer, secondDevice]) {
    await expect(p.locator(".chat-readonly")).toContainText(
      "no longer a member",
    );
    await expect(p.locator(".composer-area")).toHaveCount(0);
    await expect(
      p.getByRole("button", { name: "Invite a friend", exact: true }),
    ).toHaveCount(0);
  }

  releaseBootstrap();
  await secondDevice.unrouteAll({ behavior: "wait" });
  await expect(secondDevice.locator(".chat-readonly")).toBeVisible();
  await expect(secondDevice.locator(".composer-area")).toHaveCount(0);
  await expect(peer.locator(".call-bar")).toHaveCount(0);
  assert.equal(
    await peer.evaluate(() =>
      window.__tracks.every((t) => t.readyState === "ended"),
    ),
    true,
  );
  assert.equal(
    await peer.evaluate(() =>
      window.__peers.every((p) => p.connectionState === "closed"),
    ),
    true,
  );
  for (const p of [page, offline])
    await expect(p.locator(".call-person, .call-tile")).toHaveCount(2);
  const packets = await stats(offline);
  await expect
    .poll(() => stats(offline), { timeout: 10000 })
    .toBeGreaterThan(packets + 5);
  await assert.rejects(
    api("POST", "/api/groups/join", { code: initial.inviteCode }, friend.token),
    { status: 404 },
  );
  await peer.reload();
  await expect(peer.locator(".chat-readonly")).toBeVisible();
  await expect(
    peer.locator(`[data-message-id="${original.id}"]`),
  ).toContainText("Friday game night");
  await contexts[1].setOffline(true);
  await offline
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep this unsent thought");
  await offline
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    offline
      .locator(".message-row")
      .filter({ hasText: "Keep this unsent thought" }),
  ).toBeVisible();
  await details
    .getByRole("button", { name: "Remove Morgan", exact: true })
    .click();
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  await contexts[1].setOffline(false);
  await expect(offline.locator(".chat-readonly")).toBeVisible({
    timeout: 20000,
  });
  await expect(offline.locator(".call-bar")).toHaveCount(0);
  assert.equal(
    await offline.evaluate(() =>
      window.__tracks.every((t) => t.readyState === "ended"),
    ),
    true,
  );
  await expect(
    offline.locator(`[data-message-id="${original.id}"]`),
  ).toContainText("Friday game night");
  await expect(
    offline
      .locator(".message-row")
      .filter({ hasText: "Keep this unsent thought" }),
  ).toContainText("Not sent");
  const sent = (
    await api("GET", `/api/groups/${initial.id}/messages`, {}, owner.token)
  ).messages;
  assert.equal(
    sent.some((m) => m.body === "Keep this unsent thought"),
    false,
  );
  await page.screenshot({
    path: "test-results/membership-owner-after-removal.png",
  });
  await peer.screenshot({ path: "test-results/membership-removed.png" });
  let current = (
    await api("GET", "/api/bootstrap", {}, owner.token)
  ).groups.find((g) => g.id === initial.id);
  await api(
    "POST",
    "/api/groups/join",
    { code: current.inviteCode },
    friend.token,
  );
  await expect(
    peer.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Make Jamie owner", exact: true }),
  ).toBeVisible();
  await details
    .getByRole("button", { name: "Make Jamie owner", exact: true })
    .click();
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    details.getByRole("button", { name: "Replace invite link", exact: true }),
  ).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Leave chat", exact: true }),
  ).toBeEnabled();
  await details
    .getByRole("button", { name: "Leave chat", exact: true })
    .click();
  await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".chat-readonly")).toContainText(
    "You left this chat",
  );
  await expect(page.locator(".call-bar")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".chat-readonly")).toContainText(
    "You left this chat",
  );
  await expect(
    page.locator(`[data-message-id="${original.id}"]`),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: desktop/browser ownership controls, confirmations, live three-person RTP removal, all-device revocation, offline recovery, read-only local history, explicit readmission and ownership handoff.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  if (app)
    await (
      await app.firstWindow()
    )
      .screenshot({ path: "test-results/membership-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {});
  await browser.close();
  await server.close();
  assert.ok(
    resolve(dir).startsWith(resolve(tmpdir()) + "\\gather-membership-ui-"),
  );
  await rm(dir, { recursive: true, force: true });
}
