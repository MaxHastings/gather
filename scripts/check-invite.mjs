import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const base = "https://gather-friends.max-jacob-hastings.workers.dev";
const signup = await fetch(base + "/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Invite test" }),
}).then((r) => r.json());
const data = await fetch(base + "/api/bootstrap", {
  headers: { Authorization: `Bearer ${signup.token}` },
}).then((r) => r.json());
const invite = base + "/join/" + data.groups[0].inviteCode;
const dir = await mkdtemp(path.join(tmpdir(), "gather-invite-"));
const env = { ...process.env, GATHER_TEST_DATA: dir };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.hide()),
  );
  const next = app.waitForEvent("window");
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL(url);
  }, invite);
  const page = await next;
  await expect(
    page.getByRole("heading", { name: "Join chat", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Download for Windows" }),
  ).toHaveAttribute("href", `/download/windows?v=${version}`);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/invite.png" });
  await page.getByLabel("Your name", { exact: true }).fill("Friend test");
  await page.getByRole("button", { name: "Join chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The usual crew", exact: true }),
  ).toBeVisible();
  const other = await fetch(base + "/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signup.token}`,
    },
    body: JSON.stringify({ name: "Another chat" }),
  }).then((r) => r.json());
  await page.goto(base + "/join/" + other.inviteCode);
  await expect(
    page.getByRole("heading", { name: "Another chat", exact: true }),
  ).toBeVisible();
  console.log(
    "PASS: browser invite has one name field and a Windows download; new and existing identities join the intended chats.",
  );
} finally {
  app.process().kill();
}
process.exit(0);
