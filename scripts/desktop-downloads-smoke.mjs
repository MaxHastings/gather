import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatherServer } from "../server/app.mjs";
import {
  desktopTargets,
  downloadFilename,
} from "../server/desktop-releases.mjs";
const dir = await mkdtemp(join(tmpdir(), "gather-download-ui-"));
const server = createGatherServer({ dataDir: dir, env: {} });
const { port } = await server.listen(0),
  base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const releases = Object.keys(desktopTargets).map((id) => ({
  id,
  version: "1.2.3",
  filename: downloadFilename(id, "1.2.3"),
  size: 1000,
  sha256: "a".repeat(64),
  status: id === "windows-x64" ? "stable" : "preview",
}));
try {
  for (const [agent, labels] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ["Windows"]],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      ["Mac · Apple Silicon", "Mac · Intel"],
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64)",
      ["Linux x64 · AppImage", "Linux x64 · Debian / Ubuntu"],
    ],
  ]) {
    const context = await browser.newContext({ userAgent: agent });
    await context.route("**/downloads/releases.json", (route) =>
      route.fulfill({ json: { format: "gather-downloads-v1", releases } }),
    );
    const page = await context.newPage();
    await page.goto(base + "/?start");
    for (const label of labels)
      await expect(
        page.getByRole("link", {
          name: `Download for ${label}`,
          exact: label === "Windows",
        }),
      ).toBeVisible();
    await page.getByText("Other platforms", { exact: true }).click();
    await expect(page.locator(".desktop-download a")).toHaveCount(5);
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    // Outages or malformed catalogs leave name-first browser joining usable.
    await context.unroute("**/downloads/releases.json");
    await context.route("**/downloads/releases.json", (route) =>
      route.fulfill({
        json: {
          format: "gather-downloads-v1",
          releases: [
            { ...releases[0], filename: "https://unexpected.example/file.exe" },
          ],
        },
      }),
    );
    await page.reload();
    await expect(page.locator(".desktop-download a")).toHaveCount(0);
    await page.getByLabel("Your name", { exact: true }).fill("Browser friend");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Online", { exact: true })).toBeVisible();
    await context.close();
  }
  console.log(
    "PASS: Windows/Mac/Linux download selection, all architecture choices and safe browser joining when release metadata is unavailable.",
  );
} finally {
  await browser.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
