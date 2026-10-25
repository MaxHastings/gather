import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = (
  await readFile(new URL("../cloudflare/worker.mjs", import.meta.url), "utf8")
)
  .replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject {}",
  )
  .replace(
    '"../server/domain.mjs"',
    JSON.stringify(new URL("../server/domain.mjs", import.meta.url).href),
  )
  .replace(
    '"../server/object-storage.mjs"',
    JSON.stringify(
      new URL("../server/object-storage.mjs", import.meta.url).href,
    ),
  )
  .replace(
    '"../server/desktop-releases.mjs"',
    JSON.stringify(
      new URL("../server/desktop-releases.mjs", import.meta.url).href,
    ),
  )
  .replace(
    '"../server/desktop-download.mjs"',
    JSON.stringify(
      new URL("../server/desktop-download.mjs", import.meta.url).href,
    ),
  );
const { GatherRoom, default: worker } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);
test("Cloudflare expires ghost callers; auto-heartbeat timestamps keep healthy idle clients alive", async () => {
  const closed = [],
    cleaned = [],
    alarms = [];
  const socket = (id, age, autoAge) => ({
    readyState: 1,
    deserializeAttachment: () => ({ id, openedAt: Date.now() - age }),
    close: () => closed.push(id),
    autoAge,
  });
  const stale = socket("lost", 121000),
    healthy = socket("alive", 180000, 10000);
  const room = Object.create(GatherRoom.prototype);
  room.ctx = {
    getWebSockets: () => [stale, healthy],
    getWebSocketAutoResponseTimestamp: (s) =>
      s.autoAge === undefined ? null : new Date(Date.now() - s.autoAge),
    storage: { setAlarm: async (time) => alarms.push(time) },
  };
  room.domain = {
    realtimeClose: (id) => cleaned.push(id),
    expireFiles: async () => ({ expired: 0, more: false }),
  };
  await room.alarm();
  assert.deepEqual(closed, ["lost"]);
  assert.deepEqual(cleaned, ["lost"]);
  assert.equal(alarms.length, 1);
  room.ctx.getWebSockets = () => [];
  await room.alarm();
  // Idle rooms still wake, but only rarely, to expire old files.
  assert.equal(alarms.length, 2);
  assert.ok(alarms[1] - Date.now() > 3_600_000);
});
test("Windows download streams original bytes, supports HEAD, and fails on missing chunks", async () => {
  const manifest = {
    version: "1.2.3",
    filename: "Gather-1.2.3-Setup.exe",
    size: 6,
    sha256: "a".repeat(64),
    parts: [
      { name: "gather-1.2.3-0.bin", size: 3 },
      { name: "gather-1.2.3-1.bin", size: 3 },
    ],
  };
  let missing = false;
  const env = {
    ASSETS: {
      fetch: async (input) => {
        const url = new URL(input.url || input);
        if (url.pathname.endsWith("manifest.json"))
          return Response.json(manifest);
        if (missing) return new Response("missing", { status: 404 });
        return new Response(url.pathname.endsWith("-0.bin") ? "abc" : "def");
      },
    },
  };
  const url = "https://gather.example/download/windows";
  const head = await worker.fetch(new Request(url, { method: "HEAD" }), env);
  assert.equal(head.headers.get("Content-Length"), "6");
  assert.equal(head.body, null);
  const download = await worker.fetch(new Request(url), env);
  assert.equal(await download.text(), "abcdef");
  manifest.filename = "Gather-1.2.3-Setup.exe";
  const update = await worker.fetch(
    new Request("https://gather.example/updates/Gather-1.2.3-Setup.exe"),
    env,
  );
  assert.equal(await update.text(), "abcdef");
  assert.equal(update.headers.get("Cache-Control"), "no-store");
  assert.equal(
    (
      await worker.fetch(
        new Request("https://gather.example/updates/Gather-1.2.2-Setup.exe"),
        env,
      )
    ).status,
    404,
  );
  missing = true;
  await assert.rejects(
    (await worker.fetch(new Request(url), env)).text(),
    /unavailable/,
  );
  missing = false;
  manifest.filename = "Gather-1.2.3-Linux-x64.AppImage";
  assert.equal(
    await (
      await worker.fetch(
        new Request("https://gather.example/download/linux-x64"),
        env,
      )
    ).text(),
    "abcdef",
  );
  manifest.parts[0].size = 2;
  manifest.size = 5;
  await assert.rejects(
    (
      await worker.fetch(
        new Request("https://gather.example/download/linux-x64"),
        env,
      )
    ).text(),
    /exceeds/,
  );
  manifest.parts[0].name = "../wrong.bin";
  assert.equal(
    (
      await worker.fetch(
        new Request("https://gather.example/download/linux-x64"),
        env,
      )
    ).status,
    503,
  );
});
