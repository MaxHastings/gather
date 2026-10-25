import { createHash, randomUUID } from "node:crypto";
import { validateMediaBytes } from "./media.mjs";
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function createAvatars(db, storage, member, authorize, changed) {
  const slot = (kind, id) =>
    db
      .prepare("SELECT * FROM avatar_slots WHERE kind=? AND targetId=?")
      .get(kind, id);
  const image = (id) =>
    db.prepare("SELECT * FROM avatar_images WHERE id=?").get(id);
  const info = (kind, id) => {
    const value = slot(kind, id);
    return value
      ? {
          avatarRevision: value.revision,
          ...(value.id ? { avatarId: value.id } : {}),
        }
      : {};
  };
  const allowed = (kind, targetId, user) => {
    if (kind === "group") member(targetId, user.id);
    else if (
      targetId !== user.id &&
      !db
        .prepare(
          "SELECT 1 FROM memberships a JOIN memberships b ON a.groupId=b.groupId WHERE a.userId=? AND b.userId=? LIMIT 1",
        )
        .get(targetId, user.id)
    )
      fail(403, "This picture is private.");
  };
  const retire = async (id) => {
    if (!id) return;
    const row = image(id);
    if (!row || row.state !== "retired") return;
    try {
      await storage.remove(row.key);
    } catch {
      /* Unconfirmed deletion stays charged. */
    }
  };
  const publish = (kind, targetId) => {
    changed(kind, targetId);
    return info(kind, targetId);
  };
  async function handle(method, path, body, user) {
    const match = path.match(
      /^\/api\/(profile|groups\/([^/]+))\/avatar\/remove$/,
    );
    if (!match || method !== "POST") return undefined;
    if (!storage) fail(503, "Pictures are unavailable on this server.");
    const kind = match[1] === "profile" ? "user" : "group",
      targetId = kind === "user" ? user.id : match[2];
    allowed(kind, targetId, user);
    let old;
    db.transaction(() => {
      const current = slot(kind, targetId);
      if (
        !Number.isSafeInteger(body.baseRevision) ||
        body.baseRevision < 0 ||
        body.baseRevision !== (current?.revision ?? 0)
      )
        fail(
          409,
          "This picture changed. Close and reopen these settings to try again.",
        );
      old = current?.id;
      if (!old) return;
      db.prepare(
        "UPDATE avatar_slots SET id=NULL,revision=revision+1 WHERE kind=? AND targetId=?",
      ).run(kind, targetId);
      db.prepare("UPDATE avatar_images SET state='retired' WHERE id=?").run(
        old,
      );
    });
    const value = publish(kind, targetId);
    await retire(old);
    return value;
  }
  async function request(request) {
    const url = new URL(request.url),
      upload = url.pathname.match(
        /^\/api\/(profile|groups\/([^/]+))\/avatar\/content$/,
      ),
      read = url.pathname.match(/^\/api\/avatars\/([^/]+)\/content$/);
    if (!upload && !read) return undefined;
    if (!storage) fail(503, "Pictures are unavailable on this server.");
    const user = authorize(
      request.headers.get("Authorization")?.replace(/^Bearer /, ""),
    );
    if (!user) fail(401, "Sign in again.");
    if (read && ["GET", "HEAD"].includes(request.method)) {
      const row = image(read[1]);
      const check = () => {
        if (
          !row ||
          row.state !== "active" ||
          slot(row.kind, row.targetId)?.id !== row.id
        )
          fail(404, "That picture is no longer available.");
        allowed(row.kind, row.targetId, user);
      };
      check();
      const object = await storage.get(row.key);
      const bytes = Buffer.from(await object.arrayBuffer());
      check();
      if (
        bytes.length !== row.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== row.sha256
      )
        fail(503, "The picture could not be verified.");
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Type": row.type,
          "Content-Length": String(row.bytes),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    if (!upload || request.method !== "PUT")
      fail(405, "This picture action is not supported.");
    const kind = upload[1] === "profile" ? "user" : "group",
      targetId = kind === "user" ? user.id : upload[2];
    allowed(kind, targetId, user);
    const id = url.searchParams.get("id"),
      baseRevision = Number(url.searchParams.get("revision"));
    if (
      !uuid(id) ||
      !url.searchParams.has("revision") ||
      !Number.isSafeInteger(baseRevision) ||
      baseRevision < 0
    )
      fail(400, "Invalid picture update.");
    if (request.headers.get("Content-Type") !== "image/png")
      fail(400, "Choose a supported image.");
    const declared = request.headers.get("Content-Length");
    if (
      declared !== null &&
      (!Number.isSafeInteger(Number(declared)) ||
        Number(declared) < 1 ||
        Number(declared) > 300_000)
    )
      fail(413, "The picture is too large.");
    const reader = request.body?.getReader();
    if (!reader) fail(400, "Choose an image.");
    let total = 0;
    const chunks = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 300_000) {
          await reader.cancel();
          fail(413, "The picture is too large.");
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    validateMediaBytes(bytes, "image/png");
    if (bytes.readUInt32BE(16) !== 256 || bytes.readUInt32BE(20) !== 256)
      fail(400, "Choose a square profile picture.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    let row = image(id);
    if (
      row &&
      (row.userId !== user.id ||
        row.kind !== kind ||
        row.targetId !== targetId ||
        row.sha256 !== digest ||
        row.baseRevision !== baseRevision)
    )
      fail(409, "That picture update ID was already used.");
    if (row?.state === "active" && slot(kind, targetId)?.id === id)
      return Response.json(publish(kind, targetId));
    if (row?.state === "retired")
      fail(
        409,
        "This picture was replaced. Choose it again to upload a new copy.",
      );
    if ((slot(kind, targetId)?.revision ?? 0) !== baseRevision)
      fail(
        409,
        "This picture changed. Close and reopen these settings to try again.",
      );
    if (!row) {
      db.prepare(
        "INSERT INTO avatar_images VALUES (?,?,?,?,?,?,?,?,?,'pending',?)",
      ).run(
        id,
        user.id,
        kind,
        targetId,
        baseRevision,
        `objects/${randomUUID()}`,
        "image/png",
        bytes.length,
        digest,
        Date.now(),
      );
      row = image(id);
    }
    await storage.reserve(row.bytes, row.sha256, row.key);
    await storage.writeReserved(row.key, bytes, row.type);
    let old;
    try {
      db.transaction(() => {
        allowed(kind, targetId, user);
        const current = slot(kind, targetId);
        if (current?.id === id) return;
        if (
          (current?.revision ?? 0) !== baseRevision ||
          image(id).state === "retired"
        )
          fail(
            409,
            "This picture changed. Close and reopen these settings to try again.",
          );
        old = current?.id;
        db.prepare(
          "INSERT INTO avatar_slots VALUES (?,?,?,?) ON CONFLICT(kind,targetId) DO UPDATE SET id=excluded.id,revision=excluded.revision",
        ).run(kind, targetId, id, baseRevision + 1);
        db.prepare("UPDATE avatar_images SET state='active' WHERE id=?").run(
          id,
        );
        if (old)
          db.prepare("UPDATE avatar_images SET state='retired' WHERE id=?").run(
            old,
          );
      });
    } catch (error) {
      db.prepare(
        "UPDATE avatar_images SET state='retired' WHERE id=? AND state='pending'",
      ).run(id);
      await retire(id);
      throw error;
    }
    const value = publish(kind, targetId);
    await retire(old);
    return Response.json(value);
  }
  return { info, handle, request };
}
