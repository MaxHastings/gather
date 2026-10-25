import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { archiveScope } from "../server/archive-format.mjs";
const hash = (data) => createHash("sha256").update(data).digest("hex");
export async function mediaCacheContract(execute, reopen) {
  const scope = `profile:${randomUUID()}`,
    other = `profile:${randomUUID()}`;
  const call = (operation, values = {}, target = scope) =>
    Promise.resolve().then(() =>
      execute({ operation, scope: target, ...values }),
    );
  const file = (n, fill, extra = {}) => {
    const data = new Uint8Array(n).fill(fill);
    return {
      id: randomUUID(),
      name: `file-${fill}.bin`,
      type: "application/octet-stream",
      data,
      sha256: hash(data),
      pinned: false,
      ...extra,
    };
  };
  const messageKey = `${randomUUID()}:${randomUUID()}`;
  const kept = file(31, 1, { pinned: true, messageKey });
  await call("put", kept);
  await call("keep", { id: kept.id, active: true });
  await call("unpin", { id: kept.id });
  assert.equal((await call("entry", { id: kept.id })).kept, true);
  assert.equal((await call("entry", { id: kept.id })).pending, false);
  assert.deepEqual(await call("get", { id: kept.id }), {
    byteLength: 31,
    sha256: kept.sha256,
  });
  await reopen();
  assert.equal((await call("entry", { id: kept.id })).kept, true);
  await assert.rejects(
    call("put", { ...kept, data: new Uint8Array(31).fill(9) }),
    /checksum/,
  );
  await assert.rejects(
    call("put", {
      ...kept,
      sha256: hash(new Uint8Array(31).fill(9)),
      data: new Uint8Array(31).fill(9),
    }),
    /already used/,
  );
  const pending = file(17, 2, { pinned: true }),
    ordinary = file(41, 3),
    sibling = file(13, 4);
  await call("put", pending);
  await call("put", ordinary);
  await call("put", sibling, other);
  await assert.rejects(call("clear"), /confirmed cloud/);
  await call("clear", { allowUnconfirmed: true });
  assert.equal(await call("entry", { id: ordinary.id }), null);
  assert.equal((await call("entry", { id: kept.id })).kept, true);
  assert.equal((await call("entry", { id: pending.id })).pending, true);
  assert.equal(await call("entry", { id: sibling.id }), null);
  assert.ok(await call("entry", { id: sibling.id }, other));
  await assert.rejects(
    call("remove", { id: pending.id, allowKept: true, allowUnconfirmed: true }),
    /pending message/,
  );
  await assert.rejects(
    call("remove", { id: kept.id, allowUnconfirmed: true }),
    /kept/,
  );
  await call("unpin", { id: pending.id });
  await call("remove", { id: pending.id, allowUnconfirmed: true });
  await call("observe", {
    messageKey,
    deleted: true,
    attachments: [
      { id: kept.id, name: kept.name, bytes: 31, sha256: kept.sha256 },
    ],
  });
  await reopen();
  assert.equal(await call("get", { id: kept.id }), null);
  await assert.rejects(call("put", kept), /deleted/);
  await assert.rejects(call("put", file(31, 1, { messageKey })), /deleted/);
  const unbound = file(37, 20);
  await call("put", unbound);
  await call("observe", {
    messageKey: `${randomUUID()}:${randomUUID()}`,
    deleted: true,
    attachments: [],
    attachmentIds: [unbound.id],
  });
  assert.equal(await call("get", { id: unbound.id }), null);
  await assert.rejects(call("put", unbound), /deleted/);
  const archiveId = "b".repeat(64),
    archiveFile = file(12, 5);
  await call("put", archiveFile, archiveScope(scope, archiveId));
  await call(
    "keep",
    { id: archiveFile.id, active: true },
    archiveScope(scope, archiveId),
  );
  assert.equal((await call("list", { includeArchives: true })).files.length, 1);
  assert.equal((await call("list")).files.length, 0);
  assert.equal((await call("status")).archiveBytes, 12);
  await call("clearArchive", { id: archiveId }, other);
  assert.ok(
    await call("entry", { id: archiveFile.id }, archiveScope(scope, archiveId)),
  );
  await call("clearArchive", { id: archiveId });
  assert.equal(
    await call("get", { id: archiveFile.id }, archiveScope(scope, archiveId)),
    null,
  );
  for (const [i, name] of ["Alpha", "Beta", "Alphabet"].entries())
    await call("put", file(5, i + 6, { name }));
  const first = await call("list", { query: "alpha", limit: 1 });
  assert.equal(first.files.length, 1);
  assert.equal(first.hasMore, true);
  const next = await call("list", { query: "alpha", limit: 1, offset: 1 });
  assert.notEqual(first.files[0].id, next.files[0].id);
  assert.equal(next.hasMore, false);
  await call("clear", { allowUnconfirmed: true });
  await call("configure", { limitBytes: 20_000_000, autoDownload: false });
  const k = file(4_000_000, 10),
    p = file(4_000_000, 11, { pinned: true }),
    e = file(8_000_000, 12, { cloudForMs: 0 }),
    u = file(8_000_000, 13);
  await call("put", k);
  await call("keep", { id: k.id, active: true });
  await call("put", p);
  await call("put", e);
  await assert.rejects(call("put", u), /storage is full/);
  assert.ok(await call("entry", { id: e.id }));
  await call("put", { ...e, cloudForMs: 3_600_000 });
  await call("put", u);
  assert.equal(await call("get", { id: e.id }), null);
  assert.equal((await call("entry", { id: k.id })).kept, true);
  assert.equal((await call("entry", { id: p.id })).pending, true);
  await assert.rejects(call("put", file(8_000_000, 14)), /storage is full/);
  await call("configure", { limitBytes: 100_000_000 });
  await call("put", file(8_000_000, 15));
  const partialEviction = file(50_000, 18, { cloudForMs: 3_600_000 });
  await call("put", partialEviction);
  const before = await call("status");
  await assert.rejects(
    call("configure", { limitBytes: 20_000_000 }),
    /storage is full/,
  );
  const after = await call("status");
  assert.equal(after.limitBytes, 100_000_000);
  assert.equal(after.bytes, before.bytes);
  assert.ok(await call("entry", { id: partialEviction.id }));
  await assert.rejects(
    call("configure", { limitBytes: 2_000_000_001 }),
    /20 MB and 2 GB/,
  );
  await reopen();
  assert.equal((await call("status")).limitBytes, 100_000_000);
  const fresh = file(50, 19, { cloudForMs: 3_600_000 });
  await call("put", fresh);
  assert.equal((await call("entry", { id: fresh.id })).cloudConfirmed, true);
  await reopen();
  assert.equal((await call("entry", { id: fresh.id })).cloudConfirmed, false);
}
