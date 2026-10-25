import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGatherServer } from "../server/app.mjs";
import { desktopExecutable } from "./desktop-path.mjs";
const directory = await mkdtemp(join(tmpdir(), "gather-protected-session-"));
const data = join(directory, "desktop");
const filename = join(data, "session.sqlite");
const server = createGatherServer({
  dataDir: join(directory, "server"),
  env: {},
});
const { port } = await server.listen(0);
const env = {
  ...process.env,
  GATHER_TEST_DATA: data,
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
async function launch() {
  app = await electron.launch({
    ...(process.env.GATHER_SMOKE_PACKAGED === "1"
      ? { executablePath: desktopExecutable() }
      : {}),
    args: [resolve(".")],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => window.hide()),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
try {
  let page = await launch();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  // The first persistence attempt fails AFTER the server created the profile.
  // Retry must save that same token, never create another identity.
  await app.evaluate(({ safeStorage }) => {
    const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
    safeStorage.encryptStringAsync = async (...args) => {
      safeStorage.encryptStringAsync = encrypt;
      throw new Error("Injected key-store interruption");
    };
  });
  await page.getByLabel("Your name", { exact: true }).fill("Protected friend");
  await page.getByRole("button", { name: "Server", exact: true }).click();
  await page
    .getByLabel("Server address", { exact: true })
    .fill(`http://127.0.0.1:${port}`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Save your profile", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  const users = server.db
    .prepare("SELECT COUNT(*) AS count FROM users")
    .get().count;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Protected friend",
  );
  expect(
    server.db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
  ).toBe(users);
  const first = await page.evaluate(() => window.desktop.readSession());
  expect(
    await page.evaluate(() => localStorage.getItem("gather.session")),
  ).toBe(null);
  for (const suffix of ["", "-wal"])
    expect(
      (await readFile(filename + suffix)).includes(
        Buffer.from(first.session.token),
      ),
    ).toBe(false);
  await app.close();
  app = undefined;
  page = await launch();
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Protected friend",
  );
  expect(
    (await page.evaluate(() => window.desktop.readSession())).session.user.id,
  ).toBe(first.session.user.id);
  await app.close();
  app = undefined;
  const damaged = new DatabaseSync(filename);
  const original = damaged
    .prepare("SELECT ciphertext FROM credential")
    .get().ciphertext;
  damaged.prepare("UPDATE credential SET ciphertext=?").run(randomBytes(32));
  damaged.close();
  page = await launch();
  await expect(
    page.getByRole("heading", {
      name: "Couldn’t open your profile",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toHaveCount(0);
  expect(
    server.db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
  ).toBe(users);
  const repaired = new DatabaseSync(filename);
  repaired.prepare("UPDATE credential SET ciphertext=?").run(original);
  repaired.close();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Protected friend",
  );
  // Exercise actual native migration on this isolated profile, with no live
  // user's files involved. A missing vault is the old-app migration state.
  await page.evaluate(
    (session) =>
      localStorage.setItem("gather.session", JSON.stringify(session)),
    first.session,
  );
  await app.close();
  app = undefined;
  const old = new DatabaseSync(filename);
  old.prepare("DELETE FROM credential").run();
  old.close();
  page = await launch();
  await expect(page.locator(".profile-bar strong")).toHaveText(
    "Protected friend",
  );
  expect(
    (await page.evaluate(() => window.desktop.readSession())).session.user.id,
  ).toBe(first.session.user.id);
  expect(
    await page.evaluate(() => localStorage.getItem("gather.session")),
  ).toBe(null);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `PASS: real ${process.platform} system-backed encryption, durable restart, failed save retries one identity, damaged credentials block safely, repair/retry and legacy migration preserve the profile.`,
  );
} finally {
  await app?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
