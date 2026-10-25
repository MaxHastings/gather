import { createHash } from "node:crypto";
import { MAX_OBJECT_BYTES } from "./object-storage.mjs";

const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const allowed = new Set([
  "application/octet-stream",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
]);
// Retention policy. The server is a relay, not an archive: files only need to
// outlive the time it takes friends to come online and fetch them, and devices
// keep their own copies. Text is tiny and stays far longer than any file.
// Change these constants to tune retention; no other code depends on them.
const DAY = 86_400_000;
export const FILE_TTL_MS = 30 * DAY;
export const BIG_FILE_BYTES = 25_000_000;
export const BIG_FILE_TTL_MS = 7 * DAY;
export const fileTtl = (bytes) =>
  bytes >= BIG_FILE_BYTES ? BIG_FILE_TTL_MS : FILE_TTL_MS;

export const mediaMetadata = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  bytes: row.bytes,
  sha256: row.sha256,
});

// Inspect bounded headers only; actual decoding stays in the browser engine.
// Never render executable formats as messages or trust a filename extension.
export function validateMediaBytes(input, type) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > MAX_OBJECT_BYTES)
    fail(413, "Files must be under 10 MB.");
  if (type === "application/octet-stream") return;
  let valid = false,
    width,
    height;
  if (type === "image/png") {
    valid =
      bytes.length >= 33 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR";
    if (valid) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    }
  } else if (type === "image/gif") {
    valid =
      bytes.length >= 14 &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
    if (valid) {
      width = bytes.readUInt16LE(6);
      height = bytes.readUInt16LE(8);
    }
  } else if (type === "image/webp") {
    valid =
      bytes.length >= 30 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
    const chunk = bytes.toString("ascii", 12, 16);
    if (valid && chunk === "VP8X") {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (valid && chunk === "VP8 ") {
      valid = bytes.toString("hex", 23, 26) === "9d012a";
      width = bytes.readUInt16LE(26) & 16383;
      height = bytes.readUInt16LE(28) & 16383;
    } else if (valid && chunk === "VP8L") {
      valid = bytes[20] === 0x2f;
      const bits = bytes.readUInt32LE(21);
      width = 1 + (bits & 16383);
      height = 1 + ((bits >>> 14) & 16383);
    } else valid = false;
  } else if (type === "image/jpeg") {
    valid = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216;
    let pos = 2,
      steps = 0;
    while (valid && pos + 4 <= bytes.length && ++steps <= 4096) {
      if (bytes[pos++] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(pos + 3);
        width = bytes.readUInt16BE(pos + 5);
        break;
      }
      pos += length;
    }
    valid &&= Boolean(width && height);
  } else if (type === "audio/mpeg") {
    valid =
      bytes.length >= 4 &&
      (bytes.toString("ascii", 0, 3) === "ID3" ||
        (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0));
  } else if (type === "audio/wav") {
    valid =
      bytes.length >= 44 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE";
  } else if (type === "audio/ogg") {
    valid = bytes.length >= 27 && bytes.toString("ascii", 0, 4) === "OggS";
  } else if (type === "video/mp4" || type === "audio/mp4") {
    valid =
      bytes.length >= 16 &&
      bytes.toString("ascii", 4, 8) === "ftyp" &&
      bytes.readUInt32BE(0) >= 16 &&
      bytes.readUInt32BE(0) <= bytes.length;
  }
  if (!valid)
    fail(415, "This file does not match a supported image, GIF or MP4.");
  if (
    width !== undefined &&
    (!width ||
      !height ||
      width > 16384 ||
      height > 16384 ||
      width * height > 20_000_000)
  )
    fail(
      413,
      "This image is too large to display safely. Choose a smaller image.",
    );
}

export function createMedia(db, storage, member, authorize) {
  const uploadsInFlight = new Set();
  const row = (id) =>
    db.prepare("SELECT * FROM media_uploads WHERE id=?").get(id);
  const owned = (id, user) => {
    const upload = row(id);
    if (!upload || upload.userId !== user.id)
      fail(404, "That upload was not found.");
    member(upload.groupId, user.id);
    return upload;
  };
  const attachments = (messageId) =>
    db
      .prepare(
        "SELECT u.* FROM media_uploads u JOIN message_attachments a ON a.uploadId=u.id WHERE a.messageId=? ORDER BY a.position",
      )
      .all(messageId)
      .map(mediaMetadata);
  const withMedia = (message) =>
    message
      ? {
          ...message,
          ...(attachments(message.id).length
            ? { attachments: attachments(message.id) }
            : {}),
        }
      : message;
  async function handle(method, path, body, user) {
    const prepare = path.match(/^\/api\/groups\/([^/]+)\/uploads$/);
    if (prepare && method === "POST") {
      const groupId = prepare[1];
      member(groupId, user.id);
      if (!storage) fail(503, "File sharing is unavailable.");
      if (
        !uuid(body.id) ||
        !allowed.has(body.type) ||
        !Number.isSafeInteger(body.bytes) ||
        body.bytes < 1 ||
        body.bytes > MAX_OBJECT_BYTES ||
        typeof body.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.sha256) ||
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 180 ||
        /[\x00-\x1f\x7f/\\]/.test(body.name)
      )
        fail(400, "Choose a file under 10 MB for cloud sharing.");
      let upload = row(body.id);
      if (upload) {
        if (
          upload.userId !== user.id ||
          upload.groupId !== groupId ||
          ["name", "type", "bytes", "sha256"].some(
            (key) => upload[key] !== body[key],
          )
        )
          fail(409, "That upload ID was already used.");
        if (upload.state === "cancelled")
          fail(410, "This upload was cancelled.");
        return { ...mediaMetadata(upload), state: upload.state };
      }
      // Bound unfinished work per identity, separately from the shared byte cap.
      if (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM media_uploads WHERE userId=? AND state IN ('pending','ready')",
          )
          .get(user.id).count >= 12
      )
        fail(429, "Finish or cancel your pending files before adding more.");
      // Fair share of the common pool, checked before any bytes are reserved.
      // Only files still on the server count; expired or evicted ones are gone.
      // At a limit the oldest delivered files in that scope roll off first,
      // so sharing keeps working instead of blocking.
      const used = (column, id) =>
        db
          .prepare(
            `SELECT COALESCE(SUM(u.bytes),0) AS n FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE u.${column}=? AND u.state<>'cancelled'`,
          )
          .get(id).n;
      const makeRoom = async (column, id, limit) => {
        while (used(column, id) + body.bytes > limit) {
          const oldest = db
            .prepare(
              `SELECT u.key FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE u.${column}=? AND u.state='committed' AND s.state='ready' ORDER BY u.createdAt LIMIT 1`,
            )
            .get(id);
          if (!oldest) return false;
          await storage.remove(oldest.key);
        }
        return true;
      };
      if (!(await makeRoom("groupId", groupId, storage.groupLimitBytes)))
        fail(
          507,
          `This chat has used its ${Math.round(storage.groupLimitBytes / 1e6)} MB of shared file space. Text, emoji and voice still work.`,
        );
      if (!(await makeRoom("userId", user.id, storage.userLimitBytes)))
        fail(
          507,
          `You have reached your ${Math.round(storage.userLimitBytes / 1e6)} MB file-sharing allowance.`,
        );
      const key = `objects/${body.id}`;
      await storage.reserve(body.bytes, body.sha256, key);
      // A retry after a lost prepare response uses the same immutable key.
      db.transaction(() => {
        member(groupId, user.id);
        upload = row(body.id);
        if (!upload) {
          if (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM media_uploads WHERE userId=? AND state IN ('pending','ready')",
              )
              .get(user.id).count >= 12
          )
            fail(
              429,
              "Finish or cancel your pending files before adding more.",
            );
          db.prepare(
            "INSERT INTO media_uploads VALUES (?,?,?,?,?,?,?,?,'pending',?)",
          ).run(
            body.id,
            groupId,
            user.id,
            key,
            body.name,
            body.type,
            body.bytes,
            body.sha256,
            Date.now(),
          );
        } else if (
          upload.userId !== user.id ||
          upload.groupId !== groupId ||
          ["name", "type", "bytes", "sha256"].some((k) => upload[k] !== body[k])
        )
          fail(409, "That upload ID was already used.");
      });
      return { ...mediaMetadata(row(body.id)), state: row(body.id).state };
    }
    const match = path.match(/^\/api\/uploads\/([^/]+)(\/cancel)?$/);
    if (!match || !["GET", "POST"].includes(method)) return undefined;
    const upload = owned(match[1], user);
    if (method === "GET" && !match[2])
      return { ...mediaMetadata(upload), state: upload.state };
    if (method === "POST" && match[2]) {
      if (upload.state === "committed")
        fail(409, "This file was already sent.");

      db.prepare(
        "UPDATE media_uploads SET state='cancelled' WHERE id=? AND state<>'committed'",
      ).run(upload.id);
      if (uploadsInFlight.has(upload.id)) return { ok: true, pending: true };
      await storage.remove(upload.key);
      return { ok: true };
    }
  }
  function validateAttachments(ids, groupId, userId) {
    if (
      !Array.isArray(ids) ||
      ids.length > 4 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !uuid(id))
    )
      fail(400, "Choose up to four files per message.");
    return ids.map((id) => {
      const upload = row(id);
      if (
        !upload ||
        upload.userId !== userId ||
        upload.groupId !== groupId ||
        upload.state !== "ready"
      )
        fail(409, "A file has not finished uploading. Retry the message.");
      return upload;
    });
  }
  function commit(messageId, uploads) {
    uploads.forEach((upload, position) => {
      db.prepare("INSERT INTO message_attachments VALUES (?,?,?)").run(
        messageId,
        upload.id,
        position,
      );
      db.prepare("UPDATE media_uploads SET state='committed' WHERE id=?").run(
        upload.id,
      );
    });
  }
  async function request(request) {
    const path = new URL(request.url).pathname;
    const match = path.match(
      /^\/api\/(uploads|attachments)\/([^/]+)\/content$/,
    );
    if (!match) return undefined;
    const user = authorize(
      request.headers.get("Authorization")?.replace(/^Bearer /, ""),
    );
    if (!user) fail(401, "Please sign in again.");
    if (!storage) fail(503, "File sharing is unavailable.");
    if (match[1] === "uploads" && request.method === "PUT") {
      const upload = owned(match[2], user);
      if (!["pending", "ready", "committed"].includes(upload.state))
        fail(410, "This upload was cancelled.");
      if (uploadsInFlight.has(upload.id) || uploadsInFlight.size >= 2)
        fail(429, "Another upload is in progress. Retry shortly.");
      const declared = request.headers.get("Content-Length");
      if (declared !== null && Number(declared) !== upload.bytes)
        fail(400, "The file size does not match its reservation.");
      uploadsInFlight.add(upload.id);
      try {
        const reader = request.body?.getReader();
        if (!reader) fail(400, "The file is empty.");
        let total = 0;
        const chunks = [];
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > upload.bytes) {
              await reader.cancel();
              fail(413, "The file is larger than its reservation.");
            }
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        if (
          total !== upload.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== upload.sha256
        )
          fail(400, "The upload was incomplete or damaged. Please retry.");
        validateMediaBytes(bytes, upload.type);
        member(upload.groupId, user.id);
        await storage.writeReserved(upload.key, bytes, upload.type);
        member(upload.groupId, user.id);
        db.prepare(
          "UPDATE media_uploads SET state='ready' WHERE id=? AND state='pending'",
        ).run(upload.id);
        return Response.json({
          ...mediaMetadata(upload),
          state: row(upload.id).state,
        });
      } finally {
        uploadsInFlight.delete(upload.id);
        if (row(upload.id)?.state === "cancelled")
          await storage.remove(upload.key).catch(() => {});
      }
    }
    if (
      match[1] === "attachments" &&
      ["GET", "HEAD"].includes(request.method)
    ) {
      const upload = row(match[2]);
      if (
        !upload ||
        upload.state !== "committed" ||
        !db
          .prepare(
            "SELECT 1 FROM message_attachments a JOIN messages m ON m.id=a.messageId WHERE a.uploadId=? AND m.deletedAt IS NULL",
          )
          .get(upload.id)
      )
        fail(404, "That attachment was not found.");
      member(upload.groupId, user.id);
      const headers = {
        "Content-Type": upload.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Accept-Ranges": "bytes",
        "X-Checksum-SHA256": upload.sha256,
        "Content-Disposition": `${upload.type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
      };
      let start = 0,
        end = upload.bytes - 1,
        status = 200;
      const range = request.headers.get("Range");
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!parsed || (!parsed[1] && !parsed[2]))
          fail(416, "That byte range is not available.");
        start = parsed[1]
          ? Number(parsed[1])
          : Math.max(0, upload.bytes - Number(parsed[2]));
        end = parsed[1] && parsed[2] ? Math.min(end, Number(parsed[2])) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= upload.bytes
        )
          fail(416, "That byte range is not available.");
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${upload.bytes}`;
      }
      const object = await storage.get(upload.key).catch((error) => {
        if (error.status === 410)
          fail(
            410,
            "This file has expired from the server. Anyone who already received it still has a copy.",
          );
        throw error;
      });
      headers["Content-Length"] = String(end - start + 1);
      if (request.method === "HEAD")
        return new Response(null, { status, headers });
      const bytes = Buffer.from(await object.arrayBuffer());
      member(upload.groupId, user.id);
      if (
        bytes.length !== upload.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== upload.sha256
      )
        fail(503, "This file could not be verified. Please try again.");
      return new Response(bytes.subarray(start, end + 1), { status, headers });
    }
    fail(405, "This file action is not supported.");
  }
  return {
    handle,
    cleanupCancelled: async () => {
      let removed = 0,
        pending = 0;
      for (const item of db
        .prepare(
          "SELECT u.id,u.key,s.state FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE u.state='cancelled' LIMIT 20",
        )
        .all()) {
        if (
          uploadsInFlight.has(item.id) ||
          !["reserved", "ready", "deleting"].includes(item.state)
        ) {
          pending++;
          continue;
        }
        try {
          await storage.remove(item.key);
          removed++;
        } catch {
          pending++;
        }
      }
      return { removed, pending };
    },
    // Remove accepted files past their retention window. Messages stay; only
    // the bytes go. Bounded per call so one sweep never runs long.
    expireFiles: async (now = Date.now()) => {
      let expired = 0,
        pending = 0,
        more = false;
      const rows = db
        .prepare(
          "SELECT u.id,u.key,u.bytes,u.createdAt FROM media_uploads u JOIN storage_objects s ON s.key=u.key WHERE u.state='committed' AND s.state='ready' AND u.createdAt<? ORDER BY u.createdAt LIMIT 100",
        )
        .all(now - BIG_FILE_TTL_MS);
      for (const item of rows) {
        if (now - item.createdAt < fileTtl(item.bytes)) continue;
        try {
          await storage.remove(item.key);
          expired++;
        } catch {
          pending++;
        }
      }
      more = rows.length === 100;
      return { expired, pending, more };
    },
    request,
    attachments,
    withMedia,
    validateAttachments,
    commit,
  };
}
