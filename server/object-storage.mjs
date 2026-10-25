import { createHash, randomUUID } from "node:crypto";

// Decimal GB, deliberately below 5 GiB. This is a ceiling, not a free-tier
// assumption or a per-conversation allowance. Every object shares this budget.
export const MAX_CLOUD_OBJECT_BYTES = 5_000_000_000;
export const MAX_OBJECT_BYTES = 10_000_000;
// Fairness ceilings inside the shared pool, so one group or one identity cannot
// exhaust it for everyone. They only gate NEW uploads; existing files stay.
export const DEFAULT_GROUP_LIMIT_BYTES = 250_000_000;
export const DEFAULT_USER_LIMIT_BYTES = 250_000_000;
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

// The only application writer to the private bucket. Keep it on the SAME
// serialized SQLite authority as chat; a per-Worker memory counter is unsafe.
// No presigned writes, multipart uploads, or overwrites bypass reservations.
export function createObjectStorage(
  db,
  bucket,
  {
    limitBytes = MAX_CLOUD_OBJECT_BYTES,
    groupLimitBytes = DEFAULT_GROUP_LIMIT_BYTES,
    userLimitBytes = DEFAULT_USER_LIMIT_BYTES,
  } = {},
) {
  if (!integer(limitBytes) || limitBytes > MAX_CLOUD_OBJECT_BYTES)
    throw new Error("Cloud storage cannot exceed the 5 GB safety limit.");
  let inventory;
  const writing = new Set();
  const lookup = (key) =>
    db.prepare("SELECT * FROM storage_objects WHERE key=?").get(key);
  const total = () =>
    db
      .prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM storage_objects")
      .get().bytes;

  async function initialize() {
    if (!bucket) throw failure(503, "File sharing is unavailable.");
    // Reconcile on each server instance, including after restoring an older
    // database. Unknown objects count too. Missing/uncertain reservations are
    // NEVER freed by a listing: an interrupted write could still complete.
    if (!inventory) {
      inventory = (async () => {
        let cursor;
        const seen = new Set();
        do {
          const page = await bucket.list({
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          });
          if (
            !page ||
            !Array.isArray(page.objects) ||
            typeof page.truncated !== "boolean"
          )
            throw new Error("Storage inventory could not be verified.");
          db.transaction(() => {
            for (const object of page.objects) {
              if (
                typeof object.key !== "string" ||
                !object.key ||
                !integer(object.size)
              )
                throw new Error("Storage inventory is invalid.");
              db.prepare(
                "INSERT INTO storage_objects VALUES (?,?,'external','',?) ON CONFLICT(key) DO UPDATE SET bytes=MAX(storage_objects.bytes,excluded.bytes)",
              ).run(object.key, object.size, Date.now());
            }
          });
          if (!page.truncated) break;
          if (
            typeof page.cursor !== "string" ||
            !page.cursor ||
            seen.has(page.cursor)
          )
            throw new Error("Storage inventory did not finish.");
          seen.add(page.cursor);
          if (seen.size > 1000)
            throw new Error("Storage inventory requires operator attention.");
          cursor = page.cursor;
        } while (true);
      })().catch((error) => {
        inventory = undefined;
        throw error;
      });
    }
    await inventory;
  }

  async function status() {
    await initialize();
    const bytes = total();
    return {
      limitBytes,
      chargedBytes: bytes,
      availableBytes: Math.max(0, limitBytes - bytes),
      objects: db.prepare("SELECT COUNT(*) AS count FROM storage_objects").get()
        .count,
      unsettledBytes: db
        .prepare(
          "SELECT COALESCE(SUM(bytes),0) AS bytes FROM storage_objects WHERE state<>'ready'",
        )
        .get().bytes,
    };
  }

  async function put(input, contentType = "application/octet-stream") {
    if (!(input instanceof Uint8Array) || !input.byteLength)
      throw failure(400, "Choose a nonempty file.");
    if (input.byteLength > MAX_OBJECT_BYTES)
      throw failure(413, "This file is too large.");
    if (input.byteLength > limitBytes)
      throw failure(
        507,
        "Cloud storage is full. Try again after space is available.",
      );
    if (
      typeof contentType !== "string" ||
      contentType.length > 128 ||
      /[\r\n]/.test(contentType)
    )
      throw failure(400, "Invalid file type.");
    // Own a bounded immutable copy before awaiting anything; neither headers
    // nor a mutable caller buffer determine how many bytes are charged.
    const bytes = Buffer.from(input);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const reservation = await reserve(bytes.length, digest);
    return writeReserved(reservation.key, bytes, contentType);
  }

  async function reserve(bytes, digest, key = `objects/${randomUUID()}`) {
    if (
      !integer(bytes) ||
      bytes < 1 ||
      bytes > MAX_OBJECT_BYTES ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !/^objects\/[a-f0-9-]{36}$/i.test(key)
    )
      throw failure(400, "Invalid upload reservation.");
    await initialize();
    db.transaction(() => {
      const old = lookup(key);
      if (old) {
        if (old.bytes !== bytes || old.sha256 !== digest)
          throw failure(409, "That upload ID was already used.");
        return;
      }
      if (bytes > limitBytes - total())
        throw failure(
          507,
          "Cloud storage is full. Try again after space is available.",
        );
      db.prepare("INSERT INTO storage_objects VALUES (?,?,'reserved',?,?)").run(
        key,
        bytes,
        digest,
        Date.now(),
      );
    });
    return lookup(key);
  }

  async function reconcile(key) {
    const row = lookup(key);
    if (
      !row ||
      !["writing", "uncertain"].includes(row.state) ||
      writing.has(key)
    )
      return row;
    const head = await bucket.head(key);
    const checksum = head?.checksums?.sha256;
    const digest =
      typeof checksum === "string"
        ? checksum
        : checksum
          ? Buffer.from(checksum).toString("hex")
          : undefined;
    if (head?.size === row.bytes && digest === row.sha256) {
      db.prepare(
        "UPDATE storage_objects SET state='ready' WHERE key=? AND state IN ('writing','uncertain')",
      ).run(key);
    }
    return lookup(key);
  }

  async function writeReserved(key, input, contentType) {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > MAX_OBJECT_BYTES ||
      typeof contentType !== "string" ||
      contentType.length > 128 ||
      /[\r\n]/.test(contentType)
    )
      throw failure(400, "Invalid upload content.");
    const bytes = Buffer.from(input);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await initialize();
    let row = lookup(key);
    if (!row || row.bytes !== bytes.length || row.sha256 !== digest)
      throw failure(409, "The file does not match its upload reservation.");
    if (["writing", "uncertain"].includes(row.state))
      row = await reconcile(key);
    if (row.state === "ready")
      return { key, bytes: row.bytes, sha256: row.sha256 };
    db.transaction(() => {
      if (lookup(key)?.state !== "reserved")
        throw failure(
          409,
          "This upload is still being checked. Please retry shortly.",
        );
      db.prepare("UPDATE storage_objects SET state='writing' WHERE key=?").run(
        key,
      );
      writing.add(key);
    });
    try {
      // Reserve BEFORE the asynchronous provider write. A second request sees
      // this reservation even while this upload is still in flight.
      const result = await bucket.put(key, bytes, {
        httpMetadata: { contentType },
        sha256: digest,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!result) throw new Error("Storage write was not confirmed.");
      db.prepare(
        "UPDATE storage_objects SET state='ready' WHERE key=? AND state='writing'",
      ).run(key);
      return { key, bytes: bytes.length, sha256: digest };
    } catch {
      // A provider timeout may mean the bytes WERE stored. Retain the full
      // charge and do not retry this immutable key or reclaim it on a timer.
      try {
        db.prepare(
          "UPDATE storage_objects SET state='uncertain' WHERE key=? AND state='writing'",
        ).run(key);
      } catch {
        /* The original writing reservation remains charged. */
      }
      throw failure(503, "The file could not be saved. Please try again.");
    } finally {
      writing.delete(key);
    }
  }

  async function remove(key) {
    await initialize();
    let found = false;
    db.transaction(() => {
      const row = db
        .prepare("SELECT state FROM storage_objects WHERE key=?")
        .get(key);
      if (!row) return;
      if (row.state === "reserved") {
        db.prepare(
          "DELETE FROM storage_objects WHERE key=? AND state='reserved'",
        ).run(key);
        return;
      }
      if (row.state !== "ready" && row.state !== "deleting")
        throw failure(
          409,
          "This file needs storage reconciliation before removal.",
        );
      db.prepare("UPDATE storage_objects SET state='deleting' WHERE key=?").run(
        key,
      );
      found = true;
    });
    if (!found) return;
    // Ready means its single write completed. No future write can race this
    // delete. A timeout/crash retains the charge and repeating deletion is safe.
    await bucket.delete(key);
    db.prepare(
      "DELETE FROM storage_objects WHERE key=? AND state='deleting'",
    ).run(key);
  }

  async function get(key) {
    await initialize();
    if (lookup(key)?.state !== "ready")
      throw failure(410, "This file is not available from the server.");
    const object = await bucket.get(key);
    if (!object)
      throw failure(410, "This file is no longer available from the server.");
    return object;
  }
  return {
    groupLimitBytes,
    userLimitBytes,
    initialize,
    status,
    put,
    reserve,
    writeReserved,
    reconcile,
    remove,
    get,
  };
}
