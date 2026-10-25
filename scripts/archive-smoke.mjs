import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatherServer } from "../server/app.mjs";

const directory = await mkdtemp(join(tmpdir(), "gather-archive-ui-"));
const server = createGatherServer({
  dataDir: directory,
  env: {},
  sessionLimit: 100,
});
const address = await server.listen(0);
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const profile = await server.domain.handle("POST", "/api/sessions", {
    name: "Archive friend",
  });
  const bootstrap = await server.domain.handle(
    "GET",
    "/api/bootstrap",
    {},
    profile.token,
  );
  const group = bootstrap.groups[0];
  for (let i = 1; i <= 121; i++)
    await server.domain.handle(
      "POST",
      `/api/groups/${group.id}/messages`,
      {
        clientId: randomUUID(),
        body:
          i === 1
            ? "Original needle from the first day"
            : `Saved conversation ${i}`,
      },
      profile.token,
    );
  const context = await browser.newContext({
    colorScheme: "dark",
    acceptDownloads: true,
  });
  await context.addInitScript(
    (session) =>
      localStorage.setItem("gather.session", JSON.stringify(session)),
    { ...profile, server: base },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  let messagePosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages$/.test(request.url()))
      messagePosts++;
  });
  await page.goto(base);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Search messages", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "History & archives",
    exact: true,
  });
  await page
    .getByLabel("Search saved messages", { exact: true })
    .fill("original needle");
  await expect(
    dialog.locator(".history-results").getByRole("button"),
  ).toHaveCount(1);
  await dialog.locator(".history-results").getByRole("button").click();
  await expect(dialog.locator("[data-highlight=true]")).toContainText(
    "Original needle from the first day",
  );
  await expect(
    dialog.getByRole("button", { name: "Earlier", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Later", exact: true }).click();
  await expect(dialog.locator(".history-message-list article")).toHaveCount(50);
  await expect(
    dialog.locator(".history-message-list article").first(),
  ).toContainText("Saved conversation 2");
  await dialog.getByRole("button", { name: "Earlier", exact: true }).click();
  await expect(dialog.locator(".history-message-list article")).toHaveCount(1);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/history-dark.png" });
  await page.route("**/api/**", (route) => route.abort());
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloading;
  const bytes = await readFile(await download.path());
  const archive = JSON.parse(bytes.toString("utf8"));
  expect(archive.format).toBe("gather-archive-v1");
  expect(archive.groups[0].messages).toHaveLength(121);
  expect(archive.groups[0].inviteCode).toBe("");
  expect(bytes.includes(Buffer.from(profile.token))).toBe(false);
  expect(bytes.includes(Buffer.from(group.inviteCode))).toBe(false);
  await expect(dialog.getByRole("status")).toContainText("Server unavailable");
  const originalIdentity = await page.evaluate(
    () => JSON.parse(localStorage.getItem("gather.session")).user.id,
  );
  const file = dialog.getByLabel("Import history file", { exact: true });
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === "messages" &&
        value.scope?.includes('"archive"') &&
        ++writes === 10
      ) {
        IDBObjectStore.prototype.put = original;
        throw new DOMException(
          "Injected import disk exhaustion",
          "QuotaExceededError",
        );
      }
      return original.call(this, value, ...args);
    };
  });
  await file.setInputFiles({
    name: "interrupted.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Injected import disk exhaustion",
  );
  await expect(
    dialog.getByLabel("History source").locator("option"),
  ).toHaveCount(1);
  await file.setInputFiles({
    name: "my-saved-friends.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(
    dialog.getByLabel("History source").locator("option"),
  ).toHaveCount(2);
  await expect(dialog.getByLabel("History source")).not.toHaveValue(
    JSON.stringify([base, originalIdentity]),
  );
  await expect(
    dialog.getByText("Archive saved on this device.", { exact: true }),
  ).toBeVisible();
  await file.setInputFiles({
    name: "my-saved-friends.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(dialog.getByRole("status")).toContainText("already saved");
  await expect(
    dialog.getByLabel("History source").locator("option"),
  ).toHaveCount(2);
  await dialog.locator(".history-results").getByRole("button").click();
  await expect(dialog.locator(".history-message-list article")).toHaveCount(50);
  const malformed = structuredClone(archive);
  malformed.groups[0].messages.push(malformed.groups[0].messages[0]);
  await file.setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(dialog.getByRole("alert")).toContainText("duplicate");
  await expect(
    dialog.getByLabel("History source").locator("option"),
  ).toHaveCount(2);
  await expect(dialog.locator(".history-message-list article")).toHaveCount(50);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("gather.session")).user.id,
    ),
  ).toBe(originalIdentity);
  expect(messagePosts).toBe(0);
  await dialog
    .getByRole("button", { name: "Remove imported copy", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    dialog.getByLabel("History source").locator("option"),
  ).toHaveCount(1);
  await dialog.getByLabel("Search saved messages").fill("original needle");
  await expect(
    dialog.locator(".history-results").getByRole("button"),
  ).toHaveCount(1);
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await page
    .getByRole("button", { name: "History & archives", exact: true })
    .click();
  await page.screenshot({ path: "test-results/history-light.png" });
  expect(
    (
      await server.domain.handle("GET", "/api/export", {}, profile.token)
    ).groups.find((entry) => entry.id === group.id).messages,
  ).toHaveLength(121);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: saved-message search/context, offline export, validated atomic import, deduplication and local-only removal; identity and live history preserved.",
  );
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
