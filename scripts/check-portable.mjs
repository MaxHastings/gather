import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createGatherServer } from "../server/app.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const dir = await mkdtemp(path.join(tmpdir(), "gather-portable-"));
const server = createGatherServer({ dataDir: path.join(dir, "host"), env: {} });
const { port } = await server.listen(0);
const serverUrl = `http://127.0.0.1:${port}`;
const identity = await fetch(serverUrl + "/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Portable test" }),
}).then((response) => response.json());
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const debugPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = {
  ...process.env,
  GATHER_TEST_DATA: path.join(dir, "profile"),
  GATHER_TEST_PORT: String(port),
};
delete env.ELECTRON_RUN_AS_NODE;
let browser, page, child;
try {
  // NSIS does not forward the Node inspector stream expected by electron.launch.
  // Attach to Chromium and verify the actual wrapper's bundled client instead.
  child = spawn(
    path.resolve(`release/Gather-${version}-Windows.exe`),
    [`--remote-debugging-port=${debugPort}`],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let launchError;
  child.on("error", (error) => {
    launchError = error;
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (launchError) throw launchError;
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready)
    throw new Error(`Portable app did not start (test process ${child.pid}).`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().length).toBeGreaterThan(0);
  page = context.pages()[0];
  await expect(
    page.getByRole("heading", { name: "Welcome to Gather", exact: true }),
  ).toBeVisible();
  const localIndex = await readFile("dist/index.html", "utf8");
  const modulePath = localIndex.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  expect(await page.locator('script[type="module"]').getAttribute("src")).toBe(
    modulePath,
  );
  await page.evaluate(
    (session) => {
      window.desktop.minimize();
      localStorage.setItem("gather.session", JSON.stringify(session));
      localStorage.setItem("gather.theme", "dark");
    },
    { server: serverUrl, ...identity },
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "The usual crew", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .evaluate((element) => element.click());
  await expect(page.locator(".settings-footer")).toContainText(
    `Gather ${version}`,
  );
  console.log(
    `PASS: actual portable executable ${version} launches the current bundle and restores an isolated chat and dark appearance.`,
  );
} finally {
  if (page && !page.isClosed())
    await page.evaluate(() => window.desktop.close()).catch(() => {});
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
  await server.close();
  if (
    !path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(dir).startsWith("gather-portable-")
  )
    throw new Error("Unexpected test directory");
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
}
