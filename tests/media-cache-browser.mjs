import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mediaCacheContract } from "./media-cache-contract.mjs";
const sources = new Map();
for (const name of ["media", "api", "history"])
  sources.set(
    `/src/${name}`,
    stripTypeScriptTypes(
      await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    ),
  );
for (const name of [
  "media-contract",
  "history-contract",
  "history-message",
  "archive-format",
  "session-contract",
])
  sources.set(
    `/server/${name}.mjs`,
    await readFile(new URL(`../server/${name}.mjs`, import.meta.url), "utf8"),
  );
const server = createServer((request, response) => {
  if (sources.has(request.url)) {
    response.setHeader("Content-Type", "application/javascript");
    response.end(sources.get(request.url));
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Isolated media contract</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const load = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      window.cacheMedia = (await import("/src/media")).cacheMedia;
    });
  };
  await load();
  const legacyId = randomUUID(),
    legacyData = Buffer.from("browser original"),
    sha256 = createHash("sha256").update(legacyData).digest("hex");
  await page.evaluate(
    async ({ id, data, sha256 }) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("gather-media", 1);
        request.onupgradeneeded = () => {
          const metadata = request.result.createObjectStore("metadata", {
              keyPath: "key",
            }),
            bytes = request.result.createObjectStore("bytes", {
              keyPath: "key",
            }),
            key = JSON.stringify(["legacy", id]);
          metadata.put({
            key,
            bytes: data.length,
            sha256,
            pinned: true,
            touched: Date.now(),
          });
          bytes.put({ key, data: Uint8Array.from(data) });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      const entry = await window.cacheMedia({
        operation: "entry",
        scope: "legacy",
        id,
      });
      if (!entry.pending) throw new Error("Lost legacy pending flag");
      const original = await window.cacheMedia({
        operation: "get",
        scope: "legacy",
        id,
      });
      if (original.byteLength !== data.length)
        throw new Error("Lost legacy original");
    },
    { id: legacyId, data: [...legacyData], sha256 },
  );
  // Release this fixture's pin so it does not change the shared capacity scenario.
  await page.evaluate(async (id) => {
    await window.cacheMedia({ operation: "unpin", scope: "legacy", id });
    await window.cacheMedia({
      operation: "remove",
      scope: "legacy",
      id,
      allowUnconfirmed: true,
    });
  }, legacyId);
  await mediaCacheContract((command) => {
    const value = { ...command };
    if (value.data) {
      value.fixture = { length: value.data.length, fill: value.data[0] };
      delete value.data;
    }
    return page.evaluate(async (c) => {
      if (c.fixture) {
        c.data = new Uint8Array(c.fixture.length).fill(c.fixture.fill);
        delete c.fixture;
      }
      const value = await window.cacheMedia(c);
      if (value instanceof Uint8Array) {
        const digest = await crypto.subtle.digest("SHA-256", value);
        return {
          byteLength: value.length,
          sha256: [...new Uint8Array(digest)]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join(""),
        };
      }
      return value;
    }, value);
  }, load);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real browser media migration, independent keep/pending flags, confirmed-cloud eviction, scope, budgets, restart and deletion tombstones.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
