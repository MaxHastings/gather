import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatherServer } from "../server/app.mjs";
const directory = await mkdtemp(join(tmpdir(), "gather-identity-"));
const server = createGatherServer({
  dataDir: directory,
  env: {},
  sessionLimit: 100,
});
const address = await server.listen(0);
const base =
  process.env.GATHER_IDENTITY_SERVER || `http://127.0.0.1:${address.port}`;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Identity fixtures require an isolated loopback deployment.");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const damaged = await browser.newContext();
  await damaged.addInitScript(() =>
    localStorage.setItem("gather.session", "{broken"),
  );
  const damagedPage = await damaged.newPage();
  await damagedPage.goto(base + "/?start");
  await expect(
    damagedPage.getByRole("heading", { name: /open your profile/ }),
  ).toBeVisible();
  await expect(damagedPage.getByRole("alert")).toContainText("has been kept");
  await expect(
    damagedPage.getByRole("heading", { name: "Welcome to Gather" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      damagedPage.evaluate(() => localStorage.getItem("gather.session")),
    )
    .toBe("{broken");
  await damagedPage.evaluate(() => localStorage.removeItem("gather.session"));
  await damagedPage
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(
    damagedPage.getByRole("heading", { name: "Welcome to Gather" }),
  ).toBeVisible();
  await damaged.close();
  const contextA = await browser.newContext({
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const contextB = await browser.newContext({
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const a = await contextA.newPage(),
    b = await contextB.newPage();
  for (const page of [a, b])
    page.on("pageerror", (error) => errors.push(error.message));
  await a.goto(base + "/?start");
  await a.getByLabel("Your name", { exact: true }).fill("Recoverable friend");
  await a.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(a.getByText("Online", { exact: true })).toBeVisible();
  const original = await a.evaluate(() =>
    JSON.parse(localStorage.getItem("gather.session")),
  );
  await a
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("History follows the same identity");
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(a.locator(".delivery-state")).toHaveText("Saved to chat");
  await a.getByRole("button", { name: "Settings", exact: true }).click();
  await a
    .getByRole("button", { name: "Recovery & devices", exact: true })
    .click();
  await a
    .getByRole("button", { name: "Create recovery code", exact: true })
    .click();
  const code = await a
    .getByLabel("Your recovery code", { exact: true })
    .inputValue();
  await a
    .getByRole("button", { name: "Copy recovery code", exact: true })
    .click();
  await expect(
    a.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await a.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await a.getByRole("button", { name: "Close dialog", exact: true }).click();
  await b.goto(base + "/?start");
  await b
    .getByRole("button", { name: "Restore a profile", exact: true })
    .click();
  await b.getByLabel("Recovery code", { exact: true }).fill(code);
  await b.getByRole("button", { name: "Restore profile", exact: true }).click();
  await expect(b.locator(".profile-bar strong")).toHaveText(
    "Recoverable friend",
  );
  await expect(
    b
      .locator(".message-bubble")
      .getByText("History follows the same identity", { exact: true }),
  ).toBeVisible();
  expect(
    (await b.evaluate(() => JSON.parse(localStorage.getItem("gather.session"))))
      .user.id,
  ).toBe(original.user.id);
  await b.getByRole("button", { name: "Settings", exact: true }).click();
  await b
    .getByRole("button", { name: "Recovery & devices", exact: true })
    .click();
  await expect(b.locator(".device-row")).toHaveCount(2);
  await mkdir("test-results", { recursive: true });
  await b.screenshot({ path: "test-results/recovery-dark.png" });
  await b
    .getByRole("button", { name: "Sign out Web browser", exact: true })
    .click();
  await expect(b.locator(".device-row")).toHaveCount(1);
  await expect(
    a.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  await b
    .getByRole("button", { name: "Replace recovery code", exact: true })
    .click();
  const replacement = await b
    .getByLabel("Your recovery code", { exact: true })
    .inputValue();
  expect(replacement).not.toBe(code);
  await a
    .getByRole("button", { name: "Restore a profile", exact: true })
    .click();
  await a.getByLabel("Recovery code", { exact: true }).fill(code);
  await a.getByRole("button", { name: "Restore profile", exact: true }).click();
  await expect(a.getByRole("alert")).toContainText("not valid");
  await a.getByLabel("Recovery code", { exact: true }).fill(replacement);
  await a.getByLabel("Sign out other devices", { exact: true }).check();
  await a.getByRole("button", { name: "Restore profile", exact: true }).click();
  await expect(a.locator(".profile-bar strong")).toHaveText(
    "Recoverable friend",
  );
  await expect(
    b.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  expect(
    (await a.evaluate(() => JSON.parse(localStorage.getItem("gather.session"))))
      .user.id,
  ).toBe(original.user.id);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: real browser recovery, same identity/history, clipboard, device revocation, code rotation and remote sign-out.",
  );
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
