import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatherServer } from "../server/app.mjs";
import {
  desktopTargets,
  downloadFilename,
  readDesktopReleases,
  readDownloadManifest,
} from "../server/desktop-releases.mjs";

test("standalone hosting streams native installers and does not serve an HTML shell as a download", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gather-download-server-"));
  const dist = join(dir, "dist");
  await mkdir(join(dist, "downloads/linux-x64"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html>Gather");
  await writeFile(join(dist, "downloads/linux-x64/gather-1.2.3-0.bin"), "abc");
  await writeFile(
    join(dist, "downloads/linux-x64/manifest.json"),
    JSON.stringify({
      version: "1.2.3",
      filename: downloadFilename("linux-x64", "1.2.3"),
      size: 3,
      sha256: "a".repeat(64),
      parts: [{ name: "gather-1.2.3-0.bin", size: 3 }],
    }),
  );
  const server = createGatherServer({
    dataDir: join(dir, "server"),
    distDir: dist,
    env: {},
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { port } = await server.listen(0),
    base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/download/linux-x64`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "abc");
  assert.match(response.headers.get("Content-Disposition"), /AppImage/);
  assert.equal(
    (await fetch(`${base}/download/linux-x64`, { method: "HEAD" })).headers.get(
      "Content-Length",
    ),
    "3",
  );
  assert.equal((await fetch(`${base}/download/windows`)).status, 503);
  assert.equal((await fetch(`${base}/download/unknown`)).status, 404);
  assert.equal(
    (await fetch(`${base}/updates/Gather-1.2.3-Setup.exe`)).status,
    503,
  );
});
test("desktop catalog only exposes finite platforms with matching release names and bounded sizes", () => {
  const releases = Object.keys(desktopTargets).map((id) => ({
    id,
    version: "1.2.3",
    filename: downloadFilename(id, "1.2.3"),
    size: 1000,
    sha256: "a".repeat(64),
    status: "preview",
  }));
  const value = { format: "gather-downloads-v1", releases };
  assert.equal(readDesktopReleases(value).length, 5);
  for (const change of [
    { id: "other" },
    { filename: "https://bad.example/app.exe" },
    { size: 300_000_001 },
    { sha256: "bad" },
    { status: "unverified" },
  ])
    assert.throws(() =>
      readDesktopReleases({
        ...value,
        releases: [{ ...releases[0], ...change }],
      }),
    );
  assert.throws(() =>
    readDesktopReleases({ ...value, releases: [releases[0], releases[0]] }),
  );
});
test("download manifests reject missing, oversized, reordered or traversing chunks", () => {
  const value = {
    version: "1.2.3",
    filename: downloadFilename("linux-x64", "1.2.3"),
    size: 6,
    sha256: "b".repeat(64),
    parts: [
      { name: "gather-1.2.3-0.bin", size: 3 },
      { name: "gather-1.2.3-1.bin", size: 3 },
    ],
  };
  assert.equal(readDownloadManifest(value, "linux-x64"), value);
  for (const parts of [
    [],
    [...value.parts].reverse(),
    [{ name: "../other.bin", size: 6 }],
    [{ ...value.parts[0], size: 5 }],
    [{ ...value.parts[0], size: 20_000_000 }],
  ])
    assert.throws(() => readDownloadManifest({ ...value, parts }, "linux-x64"));
  assert.throws(() => readDownloadManifest(value, "macos-arm64"));
});
