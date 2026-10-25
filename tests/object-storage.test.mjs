import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSchema } from "../server/schema.mjs";
import { sqliteAdapter } from "../server/sqlite-adapter.mjs";
import {
  createObjectStorage,
  MAX_CLOUD_OBJECT_BYTES,
} from "../server/object-storage.mjs";
import { createDomain } from "../server/domain.mjs";
import { captureSnapshot } from "../server/snapshot.mjs";
import { restoreDatabase } from "../server/restore.mjs";

function fixture(t, limitBytes = 10, filename = ":memory:", bucket = {}) {
  const sqlite = new DatabaseSync(filename);
  t.after(() => sqlite.close());
  const db = sqliteAdapter(sqlite);
  initializeSchema(db);
  const objects = new Map();
  const calls = [];
  const provider = {
    list: async () => ({
      objects: [...objects].map(([key, size]) => ({ key, size })),
      truncated: false,
    }),
    put: async (key, bytes, options) => {
      calls.push({ key, bytes: bytes.length, options });
      objects.set(key, bytes.length);
      return { key };
    },
    delete: async (key) => {
      objects.delete(key);
    },
    ...bucket,
  };
  return {
    db,
    objects,
    calls,
    provider,
    store: createObjectStorage(db, provider, { limitBytes }),
  };
}

test("staged reservations block excess uploads and uncertain writes reconcile without a second PUT", async (t) => {
  const data = Buffer.from("12345678");
  const { createHash, randomUUID } = await import("node:crypto");
  const digest = createHash("sha256").update(data).digest("hex");
  let puts = 0;
  const f = fixture(t, 10, ":memory:", {
    put: async () => {
      puts++;
      throw new Error("Lost acknowledgement after commit");
    },
    head: async () => ({ size: 8, checksums: { sha256: digest } }),
  });
  const reservation = await f.store.reserve(
    8,
    digest,
    `objects/${randomUUID()}`,
  );
  await assert.rejects(f.store.put(new Uint8Array(3)), { status: 507 });
  await assert.rejects(
    f.store.writeReserved(reservation.key, data, "image/png"),
    { status: 503 },
  );
  await f.store.writeReserved(reservation.key, data, "image/png");
  assert.equal(puts, 1);
  assert.equal((await f.store.status()).unsettledBytes, 0);
  const pending = await f.store.reserve(
    2,
    createHash("sha256").update("12").digest("hex"),
  );
  await f.store.remove(pending.key);
  await assert.rejects(
    f.store.writeReserved(pending.key, Buffer.from("12"), "image/png"),
    { status: 409 },
  );
  assert.equal((await f.store.status()).chargedBytes, 8);
});

test("the decimal 5 GB ceiling includes existing objects and cannot be configured upward", async (t) => {
  const f = fixture(t, MAX_CLOUD_OBJECT_BYTES);
  f.objects.set("old-backup-or-orphan", 4_999_999_997);
  await f.store.put(new Uint8Array(3));
  assert.equal((await f.store.status()).chargedBytes, 5_000_000_000);
  await assert.rejects(f.store.put(new Uint8Array(1)), { status: 507 });
  assert.equal(f.calls.length, 1);
  for (const limitBytes of [5_000_000_001, 5 * 1024 ** 3, -1, NaN, 1.5])
    assert.throws(
      () => createObjectStorage(f.db, f.provider, { limitBytes }),
      /5 GB/,
    );
});

test("concurrent uploads reserve before I/O; deletion frees space only after confirmation", async (t) => {
  let started, finish;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(t, 10, ":memory:", {
    put: async () => {
      started();
      await gate;
      return {};
    },
  });
  const first = f.store.put(new Uint8Array(7));
  await began;
  await assert.rejects(f.store.put(new Uint8Array(4)), { status: 507 });
  assert.equal((await f.store.status()).chargedBytes, 7);
  finish();
  const saved = await first;
  let failDelete = true;
  f.provider.delete = async () => {
    if (failDelete) throw new Error("Lost deletion response");
  };
  await assert.rejects(f.store.remove(saved.key), /Lost deletion/);
  assert.equal((await f.store.status()).chargedBytes, 7);
  await assert.rejects(f.store.put(new Uint8Array(4)), { status: 507 });
  failDelete = false;
  await f.store.remove(saved.key);
  assert.equal((await f.store.status()).chargedBytes, 0);
  await f.store.remove(saved.key); // safe repeated delete
  await f.store.put(new Uint8Array(10));
  assert.equal((await f.store.status()).availableBytes, 0);
});

test("lost write responses stay charged across restart and snapshot restore", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-quota-"));
  // after hooks run in registration order; close the database before cleanup.
  const f = fixture(t, 10, join(directory, "gather.sqlite"), {
    put: async (key, bytes) => {
      f.objects.set(key, bytes.length);
      throw new Error("Response lost");
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(f.store.put(new Uint8Array(8)), { status: 503 });
  const before = await f.store.status();
  assert.equal(before.chargedBytes, 8);
  assert.equal(before.unsettledBytes, 8);
  const key = [...f.objects.keys()][0];
  await assert.rejects(f.store.remove(key), { status: 409 });
  // A server restart reconstructs inventory, preserving even reservations
  // whose objects are absent from a strongly consistent list.
  f.objects.clear();
  const reopened = new DatabaseSync(join(directory, "gather.sqlite"));
  try {
    const restarted = createObjectStorage(sqliteAdapter(reopened), f.provider, {
      limitBytes: 10,
    });
    assert.equal((await restarted.status()).chargedBytes, 8);
    await assert.rejects(restarted.put(new Uint8Array(3)), { status: 507 });
  } finally {
    reopened.close();
  }
  const restored = restoreDatabase(captureSnapshot(f.db));
  try {
    const store = createObjectStorage(sqliteAdapter(restored), f.provider, {
      limitBytes: 10,
    });
    assert.equal((await store.status()).chargedBytes, 8);
    await assert.rejects(store.put(new Uint8Array(3)), { status: 507 });
  } finally {
    restored.close();
  }
});

test("an older restored database inventories newer objects before any writes", async (t) => {
  const f = fixture(t, 10);
  const old = captureSnapshot(f.db);
  await f.store.put(new Uint8Array(8));
  const sqlite = restoreDatabase(old);
  t.after(() => sqlite.close());
  const restored = createObjectStorage(sqliteAdapter(sqlite), f.provider, {
    limitBytes: 10,
  });
  await assert.rejects(restored.put(new Uint8Array(3)), { status: 507 });
  assert.equal((await restored.status()).chargedBytes, 8);
  assert.equal(f.calls.length, 1);
});

test("partial or broken inventories fail closed and can retry without double counting", async (t) => {
  let broken = true;
  const f = fixture(t, 10, ":memory:", {
    list: async ({ cursor }) => {
      if (!cursor)
        return {
          objects: [{ key: "existing", size: 8 }],
          truncated: true,
          cursor: "next",
        };
      if (broken) throw new Error("Inventory unavailable");
      return { objects: [], truncated: false };
    },
  });
  await assert.rejects(f.store.put(new Uint8Array(1)), /Inventory unavailable/);
  assert.equal(f.calls.length, 0);
  broken = false;
  await f.store.put(new Uint8Array(2));
  assert.equal((await f.store.status()).chargedBytes, 10);
  assert.equal(f.calls.length, 1);
});

test("a database failure after a successful object write retains its reservation", async (t) => {
  const f = fixture(t, 10);
  const interrupted = {
    ...f.db,
    prepare: (sql) => {
      if (sql.includes("SET state='ready'"))
        throw new Error("Disk full after provider commit");
      return f.db.prepare(sql);
    },
  };
  const store = createObjectStorage(interrupted, f.provider, {
    limitBytes: 10,
  });
  await assert.rejects(store.put(new Uint8Array(9)), { status: 503 });
  assert.equal(f.objects.size, 1);
  assert.equal((await store.status()).chargedBytes, 9);
  await assert.rejects(store.put(new Uint8Array(2)), { status: 507 });
});

test("only the operator may inspect storage accounting", async (t) => {
  const f = fixture(t);
  const admin = "storage-test-operator-only-0000000000000000000000000000000000";
  const domain = createDomain(
    f.db,
    { GATHER_ADMIN_TOKEN: admin },
    {},
    { objectStorage: f.store },
  );
  for (const token of [undefined, "ordinary-session-token"])
    await assert.rejects(
      domain.handle("GET", "/api/admin/storage", {}, token),
      { status: 404 },
    );
  assert.equal(
    (await domain.handle("GET", "/api/admin/storage", {}, admin)).limitBytes,
    10,
  );
});

test("cancel during provider write retains the charge until completion; cleanup retries confirmed abandoned files only", async (t) => {
  const { createHash, randomUUID } = await import("node:crypto");
  const data = Buffer.from("a plain file"),
    digest = createHash("sha256").update(data).digest("hex");
  let started,
    finish,
    failDelete = true;
  const entered = new Promise((r) => (started = r)),
    complete = new Promise((r) => (finish = r));
  const f = fixture(t, 100, ":memory:", {
    put: async (key, bytes) => {
      started();
      await complete;
      return { key };
    },
    delete: async () => {
      if (failDelete) throw new Error("Provider delete unavailable");
    },
  });
  const domain = createDomain(f.db, {}, {}, { objectStorage: f.store });
  const call = (method, path, body = {}, token) =>
    domain.handle(method, path, body, token);
  const a = await call("POST", "/api/sessions", { name: "Max" }),
    g = (await call("GET", "/api/bootstrap", {}, a.token)).groups[0];
  const id = randomUUID();
  await call(
    "POST",
    `/api/groups/${g.id}/uploads`,
    {
      id,
      name: "plain.txt",
      type: "application/octet-stream",
      bytes: data.length,
      sha256: digest,
    },
    a.token,
  );
  const upload = domain.mediaRequest(
    new Request(`http://localhost/api/uploads/${id}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}` },
      body: data,
    }),
  );
  await entered;
  assert.equal(
    (await call("POST", `/api/uploads/${id}/cancel`, {}, a.token)).pending,
    true,
  );
  assert.equal((await f.store.status()).chargedBytes, data.length);
  finish();
  await upload;
  assert.equal(
    f.db.prepare("SELECT state FROM media_uploads WHERE id=?").get(id).state,
    "cancelled",
  );
  assert.equal((await f.store.status()).chargedBytes, data.length);
  assert.equal(
    (
      await domain
        .handle("POST", "/api/admin/media-cleanup", {}, "wrong")
        .catch((e) => e)
    ).status,
    404,
  );
  const operator = createDomain(
    f.db,
    { GATHER_ADMIN_TOKEN: "fixture-admin-token-".repeat(3) },
    {},
    { objectStorage: f.store },
  );
  let result = await operator.handle(
    "POST",
    "/api/admin/media-cleanup",
    {},
    "fixture-admin-token-".repeat(3),
  );
  assert.equal(result.pending, 1);
  assert.equal((await f.store.status()).chargedBytes, data.length);
  failDelete = false;
  result = await operator.handle(
    "POST",
    "/api/admin/media-cleanup",
    {},
    "fixture-admin-token-".repeat(3),
  );
  assert.equal(result.removed, 1);
  assert.equal((await f.store.status()).chargedBytes, 0);
  const diagnostics = await operator.handle(
    "GET",
    "/api/admin/diagnostics",
    {},
    "fixture-admin-token-".repeat(3),
  );
  assert.ok(diagnostics.schema >= 10);
  assert.equal(diagnostics.counts.media_uploads, 1);
  assert.ok(!JSON.stringify(diagnostics).includes(a.token));
});
