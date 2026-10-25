import { _electron as electron, chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
const dir = await mkdtemp(join(tmpdir(), "gather-storage-ui-"));
const server = createGatherServer({
  dataDir: join(dir, "server"),
  env: {},
  sessionLimit: 100,
});
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const call = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const alice = {
  ...(await call("POST", "/api/sessions", { name: "Max" })),
  server: base,
};
const bob = {
  ...(await call("POST", "/api/sessions", { name: "Jamie" })),
  server: base,
};
const group = (await call("GET", "/api/bootstrap", {}, alice.token)).groups[0];
await call("POST", "/api/groups/join", { code: group.inviteCode }, bob.token);
const scope = (s) => JSON.stringify([base, s.user.id]);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
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
const launch = async () => {
  app = await electron.launch({
    args: [
      ".",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
    env,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
};
const openStorage = async (page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Files on this device", exact: true })
    .click();
  await expect(
    page.getByLabel("File storage limit", { exact: true }),
  ).toBeVisible();
};
const browserOriginal = (page, profile, id) =>
  page.evaluate(
    async ({ scope, id }) => {
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open("gather-media");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const saved = await new Promise((resolve, reject) => {
        const request = db
          .transaction("bytes")
          .objectStore("bytes")
          .get(JSON.stringify([scope, id]));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return Boolean(saved);
    },
    { scope: scope(profile), id },
  );
try {
  let page = await launch();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  await page.evaluate((s) => window.desktop.writeSession(s, null), alice);
  await page.evaluate(
    (g) => {
      localStorage.setItem("gather.theme", "dark");
      localStorage.setItem(`gather.selected.${g.userId}`, g.id);
    },
    { userId: alice.user.id, id: group.id },
  );
  await page.reload();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone"],
  });
  await context.addInitScript(
    (s) => {
      localStorage.setItem("gather.session", JSON.stringify(s.session));
      localStorage.setItem("gather.theme", "dark");
      localStorage.setItem(`gather.selected.${s.session.user.id}`, s.groupId);
    },
    { session: bob, groupId: group.id },
  );
  const friend = await context.newPage();
  friend.on("pageerror", (e) => errors.push(e.message));
  await friend.goto(base);
  for (const p of [page, friend])
    await expect(p.getByText("Online", { exact: true })).toBeVisible();
  for (const p of [page, friend])
    await p
      .getByRole("button", { name: "Join voice", exact: true })
      .first()
      .click();
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible({
      timeout: 20000,
    });
  let finalize;
  await page.route("**/api/groups/*/messages", async (route) => {
    if (route.request().method() === "POST") finalize = route;
    else await route.continue();
  });
  const original = Buffer.from("A kept original for our friends.\n");
  await page.locator("input[type=file]").first().setInputFiles({
    name: "inside-joke.txt",
    mimeType: "text/plain",
    buffer: original,
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => Boolean(finalize)).toBe(true);
  await page
    .getByRole("button", {
      name: "Keep inside-joke.txt on this device",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Stop keeping inside-joke.txt on this device",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await openStorage(page);
  await expect(page.locator(".storage-files")).toContainText("Pending message");
  await expect(
    page.getByRole("button", {
      name: "Remove inside-joke.txt from this device",
    }),
  ).toBeDisabled();
  await page
    .getByLabel("File storage limit", { exact: true })
    .selectOption("100000000");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await finalize.continue();
  await page.unroute("**/api/groups/*/messages");
  const row = friend
    .locator(".message-row")
    .filter({ hasText: "inside-joke.txt" });
  await expect(row).toBeVisible();
  await friend
    .getByRole("button", {
      name: "Keep inside-joke.txt on this device",
      exact: true,
    })
    .click();
  await expect(
    friend.getByRole("button", {
      name: "Stop keeping inside-joke.txt on this device",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  const messages = (
    await call("GET", `/api/groups/${group.id}/messages`, {}, alice.token)
  ).messages;
  const message = messages.find((m) =>
      m.attachments?.some((a) => a.name === "inside-joke.txt"),
    ),
    attachment = message.attachments[0];
  await expect
    .poll(() =>
      page.evaluate(
        ({ scope, id }) =>
          window.desktop.media({ operation: "entry", scope, id }),
        { scope: scope(alice), id: attachment.id },
      ),
    )
    .toMatchObject({ pending: false, kept: true });
  assert.equal(await browserOriginal(friend, bob, attachment.id), true);
  console.log(
    "PASS: keeping a pending original survives acknowledgement; both native and browser store the original.",
  );

  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "ordinary.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A disposable download"),
    });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.locator(".message-row").last().locator(".delivery-state"),
  ).toHaveText("Saved to chat");
  await openStorage(page);
  await page
    .getByRole("button", { name: "Clear downloaded files", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Confirm local file removal" }),
  ).toContainText("last available copy");
  await page
    .getByRole("button", { name: "Remove downloads", exact: true })
    .click();
  await expect(page.locator(".storage-files li")).toHaveCount(1);
  await expect(page.locator(".storage-files")).toContainText("inside-joke.txt");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await openStorage(friend);
  await mkdir("test-results", { recursive: true });
  await friend.screenshot({
    path: "test-results/storage-dark.png",
    animations: "disabled",
  });
  await friend.getByRole("button", { name: "Back to settings" }).click();
  await friend.getByLabel("Appearance").selectOption("light");
  await friend
    .getByRole("button", { name: "Files on this device", exact: true })
    .click();
  await expect(
    friend.getByLabel("File storage limit", { exact: true }),
  ).toBeVisible();
  await friend.screenshot({
    path: "test-results/storage-light.png",
    animations: "disabled",
  });
  await friend.getByRole("button", { name: "Close dialog" }).click();
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible();
  console.log(
    "PASS: storage controls preserve kept files, confirm last-copy removal and do not interrupt voice.",
  );
  // A failed archive import can leave local originals without a catalog entry.
  // They must remain manageable without exposing another profile's files.
  const orphanScope = JSON.stringify([scope(alice), "archive", "c".repeat(64)]),
    orphanId = randomUUID(),
    orphan = Buffer.from("unfinished import original");
  await page.evaluate(
    ({ scope, id, data, sha256 }) =>
      window.desktop.media({
        operation: "put",
        scope,
        id,
        data: Uint8Array.from(data),
        sha256,
        name: "unfinished-import.txt",
        type: "application/octet-stream",
        pinned: false,
      }),
    {
      scope: orphanScope,
      id: orphanId,
      data: [...orphan],
      sha256: createHash("sha256").update(orphan).digest("hex"),
    },
  );
  await openStorage(page);
  await page.getByLabel("Find a saved file").fill("unfinished");
  await expect(page.locator(".storage-files li")).toHaveCount(1);
  await expect(page.locator(".storage-files")).toContainText("Imported copy");
  await page
    .getByRole("button", {
      name: "Remove unfinished-import.txt from this device",
    })
    .click();
  await page.getByRole("button", { name: "Remove file", exact: true }).click();
  assert.equal(
    await page.evaluate(
      ({ scope, id }) =>
        window.desktop.media({ operation: "entry", scope, id }),
      { scope: orphanScope, id: orphanId },
    ),
    null,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();

  await app.evaluate(() => {
    const store = globalThis.__gatherTestMediaStore,
      original = store.execute;
    store.execute = (command) => {
      if (command.operation === "observe" && command.deleted)
        throw new Error("Injected cache interruption");
      return original(command);
    };
  });
  await friend.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === "bytes")
        throw new DOMException("Injected full disk", "QuotaExceededError");
      return remove.apply(this, args);
    };
  });
  const own = page.locator(`[data-message-id="${message.id}"]`);
  await own.hover();
  await own.getByRole("button", { name: "Message actions" }).click();
  await own.getByRole("button", { name: "Delete", exact: true }).click();
  await own.getByRole("button", { name: "Delete", exact: true }).click();
  for (const p of [page, friend])
    await expect(
      p
        .getByRole("alert")
        .filter({ hasText: "Some deleted files could not be removed" }),
    ).toBeVisible();
  assert.equal(
    Boolean(
      await page.evaluate(
        ({ scope, id }) =>
          window.desktop.media({ operation: "get", scope, id }),
        { scope: scope(alice), id: attachment.id },
      ),
    ),
    true,
  );
  assert.equal(await browserOriginal(friend, bob, attachment.id), true);
  const pendingCleanup = await page.evaluate(
    (scope) => window.desktop.history({ operation: "mediaCleanup", scope }),
    scope(alice),
  );
  assert.ok(
    pendingCleanup.some((task) => task.attachmentIds.includes(attachment.id)),
  );
  for (const p of [page, friend])
    await expect(p.getByText("Voice connected", { exact: true })).toBeVisible();
  await app.close();
  app = undefined;
  await friend.reload();
  await expect
    .poll(() => browserOriginal(friend, bob, attachment.id))
    .toBe(false);
  page = await launch();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        ({ scope, id }) =>
          window.desktop.media({ operation: "get", scope, id }),
        { scope: scope(alice), id: attachment.id },
      ),
    )
    .toBe(null);
  await expect
    .poll(() =>
      page.evaluate(
        (scope) => window.desktop.history({ operation: "mediaCleanup", scope }),
        scope(alice),
      ),
    )
    .toEqual([]);
  await expect(
    page.getByRole("region", { name: "Active voice call" }),
  ).toHaveCount(0);
  await expect(
    friend.getByRole("region", { name: "Active voice call" }),
  ).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: interrupted native/browser deletion retains a durable cleanup task; cold restart removes managed kept bytes and never opens the microphone.",
  );
} finally {
  await app?.close();
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
