import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGatherServer } from "../server/app.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import { restoreDatabase } from "../server/restore.mjs";
const dir = await mkdtemp(join(tmpdir(), "gather-restore-client-")),
  oldDir = join(dir, "old"),
  newDir = join(dir, "restored");
let server = createGatherServer({ dataDir: oldDir, env: {} });
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const api = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const a = {
    ...(await api("POST", "/api/sessions", { name: "Restore Max" })),
    server: base,
  },
  g = (await api("GET", "/api/bootstrap", {}, a.token)).groups[0];
await api(
  "POST",
  `/api/groups/${g.id}/messages`,
  { clientId: randomUUID(), body: "Present at backup" },
  a.token,
);
const snapshot = captureSnapshot(sqliteAdapter(server.db));
await api(
  "POST",
  `/api/groups/${g.id}/messages`,
  { clientId: randomUUID(), body: "Only on newer server" },
  a.token,
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ session, id }) => {
      if (!localStorage.getItem("gather.session")) {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(`gather.selected.${session.user.id}`, id);
      }
    },
    { session: a, id: g.id },
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await expect(
    page.locator(".message-bubble").filter({ hasText: "Only on newer server" }),
  ).toBeVisible();
  await page.route("**/api/groups/*/messages", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Offline fixture"}',
        })
      : r.continue(),
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Do not silently republish");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".queue-actions")).toBeVisible();
  await page.unroute("**/api/groups/*/messages");
  let failedFresh = false;
  let captured = false,
    releaseOld;
  const oldBootstrapGate = new Promise((resolve) => (releaseOld = resolve));
  let fulfilled;
  const oldDone = new Promise((resolve) => (fulfilled = resolve));
  await page.route("**/api/bootstrap", async (route) => {
    if (captured) {
      if (!failedFresh) {
        failedFresh = true;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Temporary bootstrap failure"}',
        });
      }
      return route.continue();
    }
    const response = await route.fetch();
    const data = await response.json();
    captured = true;
    await oldBootstrapGate;
    await route.fulfill({ response, json: data });
    fulfilled();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => captured).toBe(true);
  await server.close();
  await mkdir(newDir, { recursive: true });
  restoreDatabase(snapshot, join(newDir, "gather.sqlite")).close();
  server = createGatherServer({ dataDir: newDir, env: {} });
  await server.listen(port);
  releaseOld();
  await oldDone;
  await expect(page.getByText("Online", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByText(/Earlier history is in History & archives/),
  ).toBeVisible();
  const queued = page
    .locator(".message-row")
    .filter({ hasText: "Do not silently republish" });
  assert.ok(failedFresh,"The restored bootstrap fault must actually be exercised");
  await expect(queued).toContainText("Paused");
  const next = await api(
    "POST",
    `/api/groups/${g.id}/messages`,
    { clientId: randomUUID(), body: "New server reuses sequence two" },
    a.token,
  );
  await expect(page.locator(`[data-message-id="${next.id}"]`)).toBeVisible();
  assert.equal(
    (
      await api("GET", `/api/groups/${g.id}/messages`, {}, a.token)
    ).messages.some((m) => m.body === "Do not silently republish"),
    false,
  );
  await expect(
    page.locator(".message-bubble").filter({ hasText: "Only on newer server" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Search messages", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "History source" }).locator("option"),
  ).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "History source" })
    .selectOption({ index: 1 });
  await page
    .getByRole("textbox", { name: "Search saved messages" })
    .fill("Only on newer server");
  await expect(page.locator(".history-results")).toContainText(
    "Only on newer server",
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await expect(queued).toContainText("Paused");
  await expect(page.locator(`[data-message-id="${next.id}"]`)).toBeVisible();
  assert.deepEqual(errors, []);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/restore-client.json",
    JSON.stringify(
      {
        passed: true,
        completedAt: new Date().toISOString(),
        preservedArchive: true,
        pausedOutbox: true,
        reusedSequence: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: populated live client reconciles older restored backend, archives previous mirror, pauses unsent work and accepts reused sequence without mixing histories; survives reload.",
  );
} finally {
  await browser.close();
  await server.close();
  assert.ok(dir.startsWith(join(tmpdir(), "gather-restore-client-")));
  await rm(dir, { recursive: true, force: true });
}
