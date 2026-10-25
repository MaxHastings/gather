import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createMediaCache } from "../electron/media.mjs";
import { DatabaseSync } from "node:sqlite";
import { mediaCacheContract } from "./media-cache-contract.mjs";
import { createMediaClock } from "../server/media-contract.mjs";

test("clock changes invalidate cloud guarantees; entry bounds do not evict unconfirmed files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-cache-clock-"));
  let wall = 1_000_000,
    mono = 1000;
  const clock = createMediaClock({ wall: () => wall, mono: () => mono });
  const cache = createMediaCache(join(directory, "media.sqlite"), {
    clock,
    entryLimit: 2,
  });
  t.after(async () => {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });
  const data = Buffer.from("clock proof"),
    sha256 = createHash("sha256").update(data).digest("hex"),
    id = randomUUID(),
    scope = "clock";
  cache.execute({
    operation: "put",
    scope,
    id,
    data,
    sha256,
    pinned: false,
    cloudForMs: 10_000,
  });
  assert.equal(
    cache.execute({ operation: "entry", scope, id }).cloudConfirmed,
    true,
  );
  wall += 86_400_000;
  mono += 10;
  assert.equal(
    cache.execute({ operation: "entry", scope, id }).cloudConfirmed,
    false,
  );
  assert.throws(
    () => cache.execute({ operation: "remove", scope, id }),
    /last available copy/,
  );
  cache.execute({
    operation: "put",
    scope,
    id: randomUUID(),
    data,
    sha256,
    pinned: false,
  });
  assert.throws(
    () =>
      cache.execute({
        operation: "put",
        scope,
        id: randomUUID(),
        data,
        sha256,
        pinned: false,
      }),
    /storage is full/,
  );
  assert.equal(cache.execute({ operation: "status", scope }).count, 2);
  wall -= 172_800_000;
  mono += 10;
  assert.equal(
    cache.execute({ operation: "entry", scope, id }).cloudConfirmed,
    false,
  );
});

test("native cache preserves keep/pending flags, last copies, budgets, scope and deletion tombstones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-cache-contract-")),
    filename = join(directory, "media.sqlite");
  let cache = createMediaCache(filename);
  t.after(async () => {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mediaCacheContract(
    async (command) => {
      const value = cache.execute(command);
      return value instanceof Uint8Array
        ? {
            byteLength: value.byteLength,
            sha256: createHash("sha256").update(value).digest("hex"),
          }
        : value;
    },
    async () => {
      cache.close();
      cache = createMediaCache(filename);
    },
  );
});
test("legacy media migrates without losing pending originals and low free space preserves existing data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-cache-migration-")),
    filename = join(directory, "media.sqlite"),
    id = randomUUID(),
    data = Buffer.from("old original"),
    sha256 = createHash("sha256").update(data).digest("hex");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE media(scope TEXT,id TEXT,sha256 TEXT,bytes INTEGER,pinned INTEGER,touched INTEGER,data BLOB,PRIMARY KEY(scope,id))",
  );
  db.prepare("INSERT INTO media VALUES (?,?,?,?,?,?,?)").run(
    "legacy",
    id,
    sha256,
    data.length,
    1,
    Date.now(),
    data,
  );
  db.close();
  const cache = createMediaCache(filename, { freeBytes: () => 50_000_000 });
  t.after(async () => {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(
    Buffer.from(cache.execute({ operation: "get", scope: "legacy", id })),
    data,
  );
  assert.equal(
    cache.execute({ operation: "entry", scope: "legacy", id }).pending,
    true,
  );
  assert.throws(
    () =>
      cache.execute({
        operation: "put",
        scope: "legacy",
        id: randomUUID(),
        data,
        sha256,
        pinned: false,
      }),
    /low on disk/,
  );
  assert.equal(
    cache.execute({ operation: "status", scope: "legacy" }).bytes,
    data.length,
  );
});
test("native originals survive restart, reject corruption and remain isolated by profile", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-local-media-"));
  let cache = createMediaCache(join(directory, "media.sqlite"));
  t.after(async () => {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  });
  const data = Buffer.from("an original file"),
    id = randomUUID(),
    scope = "a-profile",
    sha256 = createHash("sha256").update(data).digest("hex");
  const command = { operation: "put", scope, id, sha256, data, pinned: true };
  cache.execute(command);
  cache.close();
  cache = createMediaCache(join(directory, "media.sqlite"));
  assert.deepEqual(
    Buffer.from(cache.execute({ operation: "get", scope, id })),
    data,
  );
  assert.equal(
    cache.execute({ operation: "get", scope: "another-profile", id }),
    null,
  );
  assert.throws(
    () => cache.execute({ ...command, data: Buffer.from("changed") }),
    /checksum/,
  );
  assert.deepEqual(
    Buffer.from(cache.execute({ operation: "get", scope, id })),
    data,
  );
  assert.equal(
    cache.execute({ operation: "status", scope }).bytes,
    data.length,
  );
  cache.execute({ operation: "unpin", scope, id });
});
