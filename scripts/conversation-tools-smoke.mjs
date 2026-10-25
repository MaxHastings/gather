import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createGatherServer } from "../server/app.mjs";

const dir = await mkdtemp(join(tmpdir(), "gather-conversation-"));
const server = createGatherServer({ dataDir: dir, env: {} });
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const handle = (method, path, body = {}, token) =>
  server.domain.handle(method, path, body, token);
const alice = await handle("POST", "/api/sessions", { name: "Max" });
const bob = await handle("POST", "/api/sessions", { name: "Jamie" });
const group = (await handle("GET", "/api/bootstrap", {}, alice.token))
  .groups[0];
await handle("POST", "/api/groups/join", { code: group.inviteCode }, bob.token);
const original = await handle(
  "POST",
  `/api/groups/${group.id}/messages`,
  { clientId: randomUUID(), body: "Pizza at eight?" },
  alice.token,
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const pages = [];
  for (const session of [alice, bob]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: "dark",
    });
    await context.addInitScript(
      (session) => {
        localStorage.setItem("gather.session", JSON.stringify(session));
        localStorage.setItem(
          `gather.selected.${session.user.id}`,
          session.groupId,
        );
        localStorage.setItem("gather.theme", "dark");
      },
      { ...session, server: base, groupId: group.id },
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    pages.push(page);
  }
  const [page, friend] = pages;
  const row = page.locator(`[data-message-id="${original.id}"]`);
  const peerRow = friend.locator(`[data-message-id="${original.id}"]`);
  await expect(
    peerRow.getByRole("button", { name: "Message actions" }),
  ).toHaveCount(1);
  const edit = async () => {
    await row.hover();
    await row.getByRole("button", { name: "Message actions" }).click();
    await row.getByRole("button", { name: "Edit", exact: true }).click();
  };
  await edit();
  await row
    .getByRole("textbox", { name: "Edit message" })
    .fill("Pizza at nine?");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(peerRow.locator(".message-bubble")).toContainText(
    "Pizza at nine?",
  );
  await expect(peerRow.locator(".message-edited")).toHaveText("edited");
  assert.equal(await row.getAttribute("data-message-id"), original.id);

  await edit();
  const draft = row.getByRole("textbox", { name: "Edit message" });
  await draft.fill("Keep this draft during a failure");
  await page.route("**/api/messages/*/edit", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Please retry shortly." }),
    }),
  );
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByRole("alert")).toBeVisible();
  await expect(draft).toHaveValue("Keep this draft during a failure");
  await page.unroute("**/api/messages/*/edit");
  await page.reload();
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await edit();
  await expect(draft).toHaveValue("Keep this draft during a failure");
  const current = (
    await handle("GET", `/api/groups/${group.id}/messages`, {}, alice.token)
  ).messages.find((m) => m.id === original.id);
  await handle(
    "POST",
    `/api/messages/${original.id}/edit`,
    {
      body: "Changed on my other device",
      baseRevision: current.contentRevision,
    },
    alice.token,
  );
  await expect(row.getByRole("button", { name: "Use latest" })).toBeVisible();
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByRole("alert")).toBeVisible();
  await expect(draft).toHaveValue("Keep this draft during a failure");
  await row.getByRole("button", { name: "Use latest" }).click();
  await expect(draft).toHaveValue("Changed on my other device");
  await draft.fill("Pizza settled. See you soon.");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(peerRow.locator(".message-bubble")).toContainText(
    "Pizza settled. See you soon.",
  );

  const picker = page.locator(".emoji-picker");
  const trigger = page.getByRole("button", { name: "Add emoji", exact: true });
  await trigger.click();
  await expect(picker.getByRole("button", { name: "Show more" })).toHaveCount(
    0,
  );
  // The last section is long, so reach its header through the category rail.
  await picker
    .getByRole("toolbar", { name: "Emoji categories" })
    .getByRole("button", { name: "More", exact: true })
    .click();
  await expect(picker.getByText("More", { exact: true })).toBeVisible();
  await picker.getByLabel("Find an emoji").fill("octopus");
  await expect(
    picker.getByRole("button", { name: "Insert 🐙", exact: true }),
  ).toBeVisible();
  await picker.getByLabel("Find an emoji").fill("");
  await picker.getByRole("tab", { name: "Classic MSN" }).click();
  await expect(picker.getByRole("tabpanel").getByRole("button")).toHaveCount(
    81,
  );
  await page
    .locator(".conversation-header")
    .click({ position: { x: 400, y: 40 } });
  await expect(picker).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await trigger.click();
  await expect(picker).toHaveCount(0);
  await row.hover();
  await row.getByRole("button", { name: "React to message" }).click();
  await expect(page.locator(".reaction-picker")).toBeVisible();
  await page.locator(".composer-area textarea").focus();
  await expect(page.locator(".reaction-picker")).toHaveCount(0);
  console.log(
    "PASS: full emoticon catalog, search, classic set, outside click, focus and Escape dismissal.",
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const name of [
    "Microphone & headphones",
    "Recovery & devices",
    "History & archives",
    "Notifications",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Back to settings" }).click();
    await expect(
      page.getByRole("dialog", { name: "Settings", exact: true }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: group.name, exact: true }).click();
  await page.getByLabel("Chat name").fill("Weekend crew");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(friend.locator(".conversation-header h1")).toHaveText(
    "Weekend crew",
  );
  const renamed = (
    await handle("GET", "/api/bootstrap", {}, bob.token)
  ).groups.find((g) => g.id === group.id);
  assert.equal(renamed.inviteCode, group.inviteCode);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await mkdir("test-results", { recursive: true });
  await edit();
  await page.screenshot({
    path: "test-results/conversation-edit-dark.png",
    animations: "disabled",
  });
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.hover();
  await row.getByRole("button", { name: "Message actions" }).click();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(peerRow.locator(".message-deleted")).toHaveText(
    "Message deleted",
  );
  await expect(
    row.getByRole("button", { name: "Message actions" }),
  ).toHaveCount(0);
  await friend.reload();
  await expect(peerRow.locator(".message-deleted")).toHaveText(
    "Message deleted",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance").selectOption("light");
  await page.screenshot({
    path: "test-results/settings-navigation-light.png",
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: synchronized edits/deletes, saved failed drafts, conflict handling, settings return and group rename preserve identity/invite.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  for (const [i, page] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries())
    await page
      .screenshot({ path: `test-results/conversation-failure-${i}.png` })
      .catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
