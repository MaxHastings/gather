import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createGatherServer } from "../server/app.mjs";
import { desktopExecutable } from "./desktop-path.mjs";
const dir = await mkdtemp(join(tmpdir(), "gather-avatar-ui-"));
const server = createGatherServer({ dataDir: join(dir, "server"), env: {} });
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const call = (method, path, body, token) =>
  server.domain.handle(method, path, body, token);
const alice = {
    ...(await call("POST", "/api/sessions", { name: "Max" })),
    server: base,
  },
  bob = {
    ...(await call("POST", "/api/sessions", { name: "Jamie" })),
    server: base,
  };
const group = (await call("GET", "/api/bootstrap", {}, alice.token)).groups[0];
await call("POST", "/api/groups/join", { code: group.inviteCode }, bob.token);
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
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  await page.evaluate((s) => window.desktop.writeSession(s, null), alice);
  await page.evaluate(() => localStorage.setItem("gather.theme", "dark"));
  await page.evaluate(
    ({ userId, groupId }) =>
      localStorage.setItem(`gather.selected.${userId}`, groupId),
    { userId: alice.user.id, groupId: group.id },
  );
  await page.reload();
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(
    ({ s, groupId }) => {
      localStorage.setItem(`gather.selected.${s.user.id}`, groupId);
      localStorage.setItem("gather.session", JSON.stringify(s));
      localStorage.setItem("gather.theme", "dark");
    },
    { s: bob, groupId: group.id },
  );
  const friend = await context.newPage();
  friend.on("pageerror", (e) => errors.push(e.message));
  await friend.goto(base);
  for (const p of [page, friend])
    await expect(p.getByText("Online", { exact: true })).toBeVisible();
  const original = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ff3750";
      context.fillRect(0, 0, 800, 400);
      context.fillStyle = "#008dff";
      context.fillRect(200, 0, 400, 400);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }),
  );
  const file = {
    name: "my-wide-picture.png",
    mimeType: "image/png",
    buffer: original,
  };
  for (const p of [page, friend])
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 20000,
    });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const profile = page.getByRole("region", {
    name: "Profile picture",
    exact: true,
  });
  await profile
    .getByLabel("Upload profile picture", { exact: true })
    .setInputFiles({
      name: "wrong.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an image"),
    });
  await expect(profile.getByRole("alert")).toContainText("Choose a PNG");
  await profile
    .getByLabel("Upload profile picture", { exact: true })
    .setInputFiles(file);
  await expect(profile.getByAltText("Selected picture")).toBeVisible();
  const pixel = await profile
    .getByAltText("Selected picture")
    .evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0);
      return Array.from(context.getImageData(0, 128, 1, 1).data);
    });
  assert.deepEqual(
    pixel,
    [0, 141, 255, 255],
    "The preview uses the center square, not a stretched image",
  );
  await profile.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    server.db.prepare("SELECT COUNT(*) AS n FROM avatar_images").get().n,
    0,
  );
  await profile
    .getByLabel("Upload profile picture", { exact: true })
    .setInputFiles(file);
  await profile
    .getByRole("button", { name: "Save picture", exact: true })
    .click();
  await expect(
    profile.getByRole("button", { name: "Remove picture", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".profile-bar .avatar-image")).toBeVisible();
  await expect(
    friend
      .locator(".call-person, .call-tile")
      .filter({ hasText: "Max" })
      .locator(".avatar-image"),
  ).toBeVisible();
  const native = await page.evaluate(() => window.desktop.readSession());
  assert.ok(native.session.user.avatarId);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/avatar-profile-dark.png" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("New profile picture");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    friend
      .locator(".message-row")
      .filter({ hasText: "New profile picture" })
      .locator(".avatar-image"),
  ).toBeVisible();
  await page.getByTitle("Chat details", { exact: true }).click();
  const groupEditor = page.getByRole("region", {
    name: "Group picture",
    exact: true,
  });
  await groupEditor
    .getByLabel("Upload group picture", { exact: true })
    .setInputFiles(file);
  await groupEditor
    .getByRole("button", { name: "Save picture", exact: true })
    .click();
  await expect(
    groupEditor.getByRole("button", { name: "Remove picture", exact: true }),
  ).toBeVisible();
  for (const p of [page, friend])
    await expect(
      p.locator(".conversation-header .group-icon .avatar-image"),
    ).toBeVisible();
  await page.screenshot({ path: "test-results/avatar-group-dark.png" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await friend.getByTitle("Chat details", { exact: true }).click();
  await friend
    .getByRole("region", { name: "Group picture", exact: true })
    .getByRole("button", { name: "Remove picture", exact: true })
    .click();
  for (const p of [page, friend])
    await expect(
      p.locator(".conversation-header .group-icon .avatar-image"),
    ).toHaveCount(0);
  await friend
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".profile-bar .avatar-image")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await page.screenshot({ path: "test-results/avatar-profile-light.png" });
  await page
    .getByRole("region", { name: "Profile picture", exact: true })
    .getByRole("button", { name: "Remove picture", exact: true })
    .click();
  await expect(page.locator(".profile-bar .avatar-image")).toHaveCount(0);
  await expect(
    friend
      .locator(".call-person, .call-tile")
      .filter({ hasText: "Max" })
      .locator(".avatar-image"),
  ).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Electron/Edge profile and group pictures, square preview/cancel, private synchronization in chat/voice/sidebar, native profile persistence, removal, dark/light appearance and uninterrupted voice.",
  );
} finally {
  await app?.close();
  await browser.close();
  await server.close();
  assert.ok(dir.startsWith(join(tmpdir(), "gather-avatar-ui-")));
  await rm(dir, { recursive: true, force: true });
}
