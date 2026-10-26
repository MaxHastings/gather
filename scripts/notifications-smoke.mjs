import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";

const directory = await mkdtemp(join(tmpdir(), "gather-notifications-"));
const server = createGatherServer({
  dataDir: join(directory, "server"),
  env: {},
});
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const handle = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const a = await handle("POST", "/api/sessions", { name: "Max" });
const b = await handle("POST", "/api/sessions", { name: "Jamie" });
const group = (await handle("GET", "/api/bootstrap", {}, a.token)).groups[0];
await handle("POST", "/api/groups/join", { code: group.inviteCode }, b.token);
const other = await handle(
  "POST",
  "/api/groups",
  { name: "Other chat" },
  a.token,
);
const send = (body, token = b.token) =>
  handle(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: randomUUID(), body },
    token,
  );
await send("Old backlog is quiet");
const env = {
  ...process.env,
  GATHER_TEST_DATA: join(directory, "desktop"),
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
let app, browser;
const errors = [];
try {
  app = await electron.launch({ args: [resolve(".")], env, timeout: 30000 });
  const desktop = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.hide()),
  );
  desktop.on("pageerror", (error) => errors.push(error.message));
  await expect(
    desktop.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  await desktop.evaluate(
    (session) => window.desktop.writeSession(session, null),
    { ...a, server: base },
  );
  await desktop.evaluate(() => localStorage.setItem("gather.theme", "dark"));
  await desktop.reload();
  await expect(desktop.getByText("Online", { exact: true })).toBeVisible();
  await desktop.locator(".chat-item").filter({ hasText: other.name }).click();
  const nativeCount = () =>
    app.evaluate(() => globalThis.__gatherTestNotifications.length);
  expect(await nativeCount()).toBe(0);
  const first = await send("Native notification");
  await expect.poll(nativeCount).toBe(1);
  await app.evaluate(() =>
    globalThis.__gatherTestNotifications[0].emit("click"),
  );
  await expect(desktop.locator(".conversation-header h1")).toHaveText(
    group.name,
  );
  await expect(
    desktop.getByText("Native notification", { exact: true }).last(),
  ).toBeVisible();
  await handle(
    "POST",
    `/api/messages/${first.id}/reactions`,
    { emoji: "👍", active: true },
    b.token,
  );
  await expect(desktop.locator(".reaction-pill")).toHaveCount(1);
  expect(await nativeCount()).toBe(1);
  await send("My own message", a.token);
  await expect(
    desktop.getByText("My own message", { exact: true }).last(),
  ).toBeVisible();
  expect(await nativeCount()).toBe(1);
  await desktop.getByRole("button", { name: "Settings", exact: true }).click();
  await desktop
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await desktop.getByLabel("Show names and message previews").uncheck();
  await desktop
    .getByLabel(`Mute ${group.name}`, { exact: true })
    .selectOption("forever");
  await send("Muted native message");
  await expect(
    desktop.getByText("Muted native message", { exact: true }).last(),
  ).toBeVisible();
  expect(await nativeCount()).toBe(1);
  await mkdir("test-results", { recursive: true });
  await desktop.screenshot({
    path: "test-results/notifications-dark.png",
    animations: "disabled",
  });
  await app.close();
  app = undefined;

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  await context.addInitScript(
    (session) => {
      localStorage.setItem("gather.session", JSON.stringify(session));
      window.__notes = [];
      window.__focused = false;
      Object.defineProperty(document, "hasFocus", {
        value: () => window.__focused,
      });
      class FakeNotification {
        static permission = "default";
        static async requestPermission() {
          this.permission = window.__deny ? "denied" : "granted";
          return this.permission;
        }
        constructor(title, options) {
          this.title = title;
          this.options = options;
          window.__notes.push(this);
        }
        close() {
          this.closed = true;
          this.onclose?.();
        }
      }
      window.Notification = FakeNotification;
    },
    { ...a, server: base },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/?start");
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__notes.length)).toBe(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.getByLabel("Message notifications", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.locator(".chat-item").filter({ hasText: other.name }).click();
  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto(base + "/?start");
  await second.evaluate(() => {
    Notification.permission = "granted";
  });
  await expect(second.getByText("Online", { exact: true })).toBeVisible();
  const total = async () =>
    (await page.evaluate(() => window.__notes.length)) +
    (await second.evaluate(() => window.__notes.length));
  const message = await send("Only one alert across tabs");
  await expect.poll(total).toBe(1);
  await handle(
    "POST",
    `/api/groups/${group.id}/messages`,
    { clientId: message.clientId, body: message.body },
    b.token,
  );
  const alerted = (await page.evaluate(() => window.__notes.length))
    ? page
    : second;
  await alerted.evaluate(() => window.__notes[0].onclick());
  await expect(alerted.locator(".conversation-header h1")).toHaveText(
    group.name,
  );
  await handle(
    "POST",
    `/api/messages/${message.id}/reactions`,
    { emoji: "👍", active: true },
    b.token,
  );
  await expect(alerted.locator(".reaction-pill")).toHaveCount(2);
  expect(await total()).toBe(1);
  // Fresh pages and history synchronization do not generate replay notifications.
  await second.close();
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__notes.length)).toBe(0);
  await page.evaluate(() => {
    window.__focused = true;
  });
  await page.locator(".chat-item").filter({ hasText: group.name }).click();
  await send("Read in focused conversation");
  await expect(
    page.getByText("Read in focused conversation", { exact: true }).last(),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__notes.length)).toBe(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.getByLabel("Show names and message previews").uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(() => {
    window.__focused = false;
    Notification.permission = "granted";
  });
  // Use a new group to avoid intentionally throttled chat bursts.
  const privateGroup = await handle(
    "POST",
    "/api/groups",
    { name: "Private chat" },
    b.token,
  );
  await handle(
    "POST",
    "/api/groups/join",
    { code: privateGroup.inviteCode },
    a.token,
  );
  await expect(
    page.locator(".chat-item").filter({ hasText: privateGroup.name }),
  ).toBeVisible();
  await handle(
    "POST",
    `/api/groups/${privateGroup.id}/messages`,
    { clientId: randomUUID(), body: "Private contents" },
    b.token,
  );
  await expect.poll(() => page.evaluate(() => window.__notes.length)).toBe(1);
  expect(
    await page.evaluate(() => ({
      title: window.__notes[0].title,
      body: window.__notes[0].options.body,
    })),
  ).toEqual({ title: "Gather", body: "New message" });
  const denied = await browser.newContext();
  await denied.addInitScript(() => {
    window.Notification = class {
      static permission = "default";
      static async requestPermission() {
        this.permission = "denied";
        return "denied";
      }
    };
  });
  const denyPage = await denied.newPage();
  await denyPage.goto(base + "/?start");
  await denyPage.getByLabel("Your name", { exact: true }).fill("Denied friend");
  await denyPage.getByRole("button", { name: "Continue", exact: true }).click();
  await denyPage.getByRole("button", { name: "Settings", exact: true }).click();
  await denyPage
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await denyPage.getByLabel("Message notifications", { exact: true }).click();
  await expect(
    denyPage.getByText("Notifications are blocked.", { exact: false }),
  ).toBeVisible();
  await expect(
    denyPage.getByLabel("Message notifications", { exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
  console.log(
    "PASS notifications: native IPC/click lifecycle, browser opt-in/denial, per-chat mute, privacy, focus, quiet history/reactions/self, retry and cross-tab deduplication",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await app?.close();
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
