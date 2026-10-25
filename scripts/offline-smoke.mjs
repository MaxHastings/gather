import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatherServer } from "../server/app.mjs";
const directory = await mkdtemp(join(tmpdir(), "gather-offline-"));
const server = createGatherServer({ dataDir: directory, env: {} });
const address = await server.listen(0),
  base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  context.on("page", (entry) =>
    entry.on("pageerror", (error) => errors.push(error.message)),
  );
  await page.goto(base + "/?start");
  await page.getByLabel("Your name", { exact: true }).fill("Offline friend");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Read this when everything is offline");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".delivery-state")).toHaveText("Saved to chat");
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.active),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  const cached = await page.evaluate(async () =>
    (await (await caches.open("gather-shell-v1")).keys()).map(
      (request) => new URL(request.url).pathname,
    ),
  );
  expect(cached).toContain("/");
  expect(
    cached.some((path) => /^\/(api|realtime|download|join)(\/|$)/.test(path)),
  ).toBe(false);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page
      .locator(".message-bubble")
      .getByText("Read this when everything is offline", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Written fully offline");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto(base, { waitUntil: "domcontentloaded" });
  await expect(
    reopened
      .locator(".message-bubble")
      .getByText("Written fully offline", { exact: true }),
  ).toHaveCount(1);
  await context.setOffline(false);
  await reopened.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(reopened.getByText("Online", { exact: true })).toBeVisible();
  await expect(
    reopened.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  expect(
    server.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE body=?")
      .get("Written fully offline").count,
  ).toBe(1);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: a new browser page starts with all networking disabled, reads history and preserves an outbox that delivers once after reconnection; private responses never enter the shell cache.",
  );
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
