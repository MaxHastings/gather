import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { captureSnapshot } from "./snapshot.mjs";
import { LATEST_SCHEMA_VERSION } from "./schema.mjs";
import { MAX_VOICE_PARTICIPANTS, VOICE_TOPOLOGY } from "./voice-policy.mjs";
import { createMedia } from "./media.mjs";
import { createModeration } from "./moderation.mjs";
import { createAvatars } from "./avatars.mjs";
import { createGifService } from "./gifs.mjs";
import { isReactionEmoji } from "./emoji-policy.mjs";
export { initializeSchema } from "./schema.mjs";

export const hash = (token) => createHash("sha256").update(token).digest("hex");
export const problem = (status, message) =>
  Object.assign(new Error(message), { status });
const clean = (value, label, max) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw problem(400, `${label} must be between 1 and ${max} characters.`);
  return value.trim();
};
const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const capabilities = [
  "text",
  "voice:mesh-4",
  "history-export",
  "identity-recovery",
  "devices",
  "reactions-v1",
  "message-changes-v1",
  "message-mutations-v1",
  "group-profile-v1",
  "group-membership-v1",
  "replies-v1",
  "sync-generation-v1",
  "outbox-control-v1",
  "call-ring-v1",
];

// Hosting adapters supply SQLite and event delivery; product logic is portable.
const RING_MS = 30000;
export function createDomain(db, env = {}, events = {}, services = {}) {
  const emitGroup = (id, event, data) => events.group?.(id, event, data);
  const groupIds = (userId) =>
    db
      .prepare(
        "SELECT m.groupId FROM memberships m JOIN groups g ON g.id=m.groupId WHERE m.userId=? ORDER BY g.createdAt,g.id",
      )
      .all(userId)
      .map((r) => r.groupId);
  const authorize = (token) => {
    if (typeof token !== "string" || token.length > 200) return undefined;
    const row = db
      .prepare(
        "SELECT u.id,u.name,s.tokenHash,s.createdAt,COALESCE(d.lastSeen,0) AS lastSeen FROM sessions s JOIN users u ON s.userId=u.id LEFT JOIN devices d ON d.tokenHash=s.tokenHash WHERE s.tokenHash=?",
      )
      .get(hash(token));
    if (!row) return undefined;
    if (Date.now() - row.lastSeen > 300000)
      db.prepare(
        "INSERT INTO devices VALUES (?,?,?,?) ON CONFLICT(tokenHash) DO UPDATE SET lastSeen=excluded.lastSeen",
      ).run(row.tokenHash, "Existing device", row.createdAt, Date.now());
    return { id: row.id, name: row.name, ...avatars.info("user", row.id) };
  };
  const deviceLabel = (body) =>
    body.deviceName === undefined
      ? "Device"
      : clean(body.deviceName, "Device name", 64);
  const addSession = (token, userId, name) => {
    const now = Date.now();
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      hash(token),
      userId,
      now,
    );
    db.prepare("INSERT INTO devices VALUES (?,?,?,?)").run(
      hash(token),
      name,
      now,
      now,
    );
  };
  const revokeSession = (tokenHash) => {
    db.prepare("DELETE FROM sessions WHERE tokenHash=?").run(tokenHash);
    for (const connection of db
      .prepare("SELECT id FROM connections WHERE tokenHash=?")
      .all(tokenHash)) {
      realtimeClose(connection.id);
      events.close?.(connection.id);
    }
  };
  const member = (groupId, userId) => {
    if (
      !db
        .prepare("SELECT 1 FROM memberships WHERE groupId=? AND userId=?")
        .get(groupId, userId)
    )
      throw problem(403, "This chat is private. Ask a friend for an invite.");
  };
  const messageSelect =
    "SELECT m.*,u.name,COALESCE((SELECT MAX(sequence) FROM message_changes WHERE messageId=m.id),0) AS revision,COALESCE((SELECT MAX(sequence) FROM message_changes WHERE messageId=m.id AND kind IN ('create','edit','delete')),0) AS contentRevision FROM messages m JOIN users u ON m.userId=u.id";
  const moderation = createModeration({
    db,
    storage: services.objectStorage,
    problem,
    member,
    loadMessage: (id) =>
      enrich(db.prepare(`${messageSelect} WHERE m.id=?`).get(id)),
    emitGroup,
    events,
    revokeSession,
    stateFor: (...args) => stateFor(...args),
    broadcastVoice: (...args) => broadcastVoice(...args),
    changedGroup: (...args) => changedGroup(...args),
  });
  const media = createMedia(
    db,
    services.objectStorage,
    member,
    authorize,
    moderation,
  );
  const avatars = createAvatars(
    db,
    services.objectStorage,
    member,
    authorize,
    (kind, id) => {
      for (const groupId of kind === "group" ? [id] : groupIds(id)) {
        changedGroup(groupId);
        if (kind === "user") broadcastVoice(groupId);
      }
    },
  );
  const availableCapabilities = [
    ...capabilities,
    ...(services.objectStorage ? ["attachments-v1", "avatars-v1"] : []),
    ...(env.KLIPY_API_KEY ? ["gif-search-v1"] : []),
  ];
  const gifs = createGifService(env, services.fetch);
  const enrich = (message) => {
    // Resolve references from current authoritative content; never copy a quote into storage.

    if (!message) return message;
    const { editedAt, deletedAt, ...base } = message;
    const normalized = {
      ...base,
      ...(editedAt ? { editedAt } : {}),
      ...(deletedAt ? { deletedAt } : {}),
    };
    if (deletedAt) {
      const ids = db
        .prepare(
          "SELECT uploadId FROM message_attachments WHERE messageId=? ORDER BY position",
        )
        .all(message.id)
        .map((row) => row.uploadId);
      return {
        ...normalized,
        body: "",
        ...(ids.length ? { deletedAttachmentIds: ids } : {}),
      };
    }
    const reactions = new Map();
    for (const row of db
      .prepare(
        "SELECT emoji,userId FROM message_reactions WHERE messageId=? ORDER BY emoji,userId",
      )
      .all(message.id)) {
      if (!reactions.has(row.emoji)) reactions.set(row.emoji, []);
      reactions.get(row.emoji).push(row.userId);
    }
    return {
      ...media.withMedia(normalized),
      ...(() => {
        const ref = db
          .prepare("SELECT targetId FROM message_replies WHERE messageId=?")
          .get(message.id);
        if (!ref) return {};
        const target = db
          .prepare(`${messageSelect} WHERE m.id=? AND m.groupId=?`)
          .get(ref.targetId, message.groupId);
        return {
          replyTo: ref.targetId,
          reply: target
            ? {
                id: target.id,
                name: target.name,
                body: target.deletedAt ? "" : target.body,
                deleted: Boolean(target.deletedAt),
                revision: target.revision,
              }
            : { id: ref.targetId, deleted: true, body: "", name: "" },
        };
      })(),
      ...(reactions.size
        ? {
            reactions: [...reactions].map(([emoji, userIds]) => ({
              emoji,
              userIds,
            })),
          }
        : {}),
    };
  };
  const getGroup = (id) => ({
    ...db.prepare("SELECT * FROM groups WHERE id=?").get(id),
    ...db
      .prepare(
        "SELECT ownerId,revision AS controlRevision FROM group_controls WHERE groupId=?",
      )
      .get(id),
    access: "active",
    ...avatars.info("group", id),
    members: db
      .prepare(
        "SELECT u.id,u.name FROM users u JOIN memberships m ON u.id=m.userId WHERE m.groupId=? ORDER BY u.createdAt",
      )
      .all(id)
      .map((person) => ({ ...person, ...avatars.info("user", person.id) })),
    lastMessage: enrich(
      db
        .prepare(
          `${messageSelect} WHERE m.groupId=? ORDER BY m.sequence DESC LIMIT 1`,
        )
        .get(id) ?? null,
    ),
  });
  const voicePeers = (id) =>
    db
      .prepare(
        "SELECT v.connectionId,c.userId,u.name,v.muted FROM voices v JOIN connections c ON c.id=v.connectionId JOIN users u ON u.id=c.userId WHERE v.groupId=?",
      )
      .all(id)
      .map((p) => ({
        ...p,
        ...avatars.info("user", p.userId),
        muted: Boolean(p.muted),
      }));
  const voiceState = (id) => {
    const peers = voicePeers(id);
    return {
      groupId: id,
      userIds: [...new Set(peers.map((p) => p.userId))],
      peers,
    };
  };
  const broadcastVoice = (id) => emitGroup(id, "voice", voiceState(id));
  // Rings are ephemeral: they live in memory for RING_MS and are never stored,
  // so a restarted server simply forgets them and callers see "No answer".
  const rings = new Map();
  const ringBursts = new Map();
  const ringKey = (groupId, userId) => `${groupId}|${userId}`;
  const emitUser = (userId, event, data) => {
    for (const connection of db
      .prepare("SELECT id FROM connections WHERE userId=?")
      .all(userId))
      events.connection?.(connection.id, event, data);
  };
  const endRing = (key, status) => {
    const ring = rings.get(key);
    if (!ring) return;
    clearTimeout(ring.timer);
    rings.delete(key);
    emitUser(ring.target, "call:ring-end", {
      groupId: ring.groupId,
      from: ring.from,
    });
    if (status)
      emitUser(ring.from, "call:ring-status", {
        groupId: ring.groupId,
        userId: ring.target,
        status,
      });
  };
  const ringsFrom = (userId, groupId, targets) =>
    [...rings.entries()].filter(
      ([, r]) =>
        r.from === userId &&
        r.groupId === groupId &&
        (!targets || targets.includes(r.target)),
    );
  // Once nobody is left in the call there is nothing to join, so stop ringing.
  const settleRings = (groupId) => {
    if (voicePeers(groupId).length) return;
    for (const [key, r] of [...rings])
      if (r.groupId === groupId) endRing(key, null);
  };
  const stateFor = (userId) => {
    const ids = groupIds(userId);
    const people = new Set(
      ids.flatMap((id) => getGroup(id).members.map((p) => p.id)),
    );
    return {
      onlineIds: [
        ...new Set(
          db
            .prepare("SELECT userId FROM connections")
            .all()
            .map((r) => r.userId),
        ),
      ].filter((id) => people.has(id)),
      voice: Object.fromEntries(ids.map((id) => [id, voiceState(id).userIds])),
    };
  };
  const changedGroup = (id) => {
    const group = getGroup(id);
    emitGroup(id, "group", group);
    for (const p of group.members)
      emitGroup(id, "presence", {
        userId: p.id,
        online: Boolean(
          db.prepare("SELECT 1 FROM connections WHERE userId=?").get(p.id),
        ),
      });
    return group;
  };
  const makeGroup = (name, userId) => {
    const g = {
      id: randomUUID(),
      name,
      inviteCode: randomBytes(18).toString("base64url"),
      createdAt: Date.now(),
    };
    db.prepare("INSERT INTO groups VALUES (?,?,?,?)").run(
      g.id,
      g.name,
      g.inviteCode,
      g.createdAt,
    );
    db.prepare("INSERT INTO memberships VALUES (?,?)").run(g.id, userId);
    db.prepare("INSERT INTO group_controls VALUES (?,?,1)").run(g.id, userId);
    return g;
  };
  const addMember = (groupId, userId) => {
    if (
      !db
        .prepare("SELECT 1 FROM memberships WHERE groupId=? AND userId=?")
        .get(groupId, userId)
    ) {
      db.prepare("INSERT INTO memberships VALUES (?,?)").run(groupId, userId);
      db.prepare(
        "UPDATE group_controls SET revision=revision+1 WHERE groupId=?",
      ).run(groupId);
      db.prepare(
        "DELETE FROM group_departures WHERE groupId=? AND userId=?",
      ).run(groupId, userId);
    }
  };
  const changeMembership = (groupId, user, body) => {
    let departure;
    db.transaction(() => {
      member(groupId, user.id);
      const control = db
        .prepare("SELECT * FROM group_controls WHERE groupId=?")
        .get(groupId);
      if (body.revision !== control.revision)
        throw problem(
          409,
          "This chat changed. Close and reopen its details, then try again.",
        );
      const action = body.action;
      if (!["remove", "rotate", "transfer", "leave"].includes(action))
        throw problem(400, "Choose a chat action.");
      if (action !== "leave" && control.ownerId !== user.id)
        throw problem(403, "Only the chat owner can do that.");
      const target = action === "leave" ? user.id : body.userId;
      if (action === "remove" || action === "transfer") {
        if (typeof target !== "string" || target === user.id)
          throw problem(400, "Choose another member.");
        member(groupId, target);
      }
      if (
        action === "leave" &&
        control.ownerId === user.id &&
        groupIdsForChat(groupId).length > 1
      )
        throw problem(409, "Make another member the owner before leaving.");
      if (action === "transfer")
        db.prepare("UPDATE group_controls SET ownerId=? WHERE groupId=?").run(
          target,
          groupId,
        );
      if (action === "remove" || action === "leave") {
        db.prepare("DELETE FROM memberships WHERE groupId=? AND userId=?").run(
          groupId,
          target,
        );
        if (control.ownerId === target)
          db.prepare(
            "UPDATE group_controls SET ownerId=NULL WHERE groupId=?",
          ).run(groupId);
        db.prepare(
          "DELETE FROM voices WHERE groupId=? AND connectionId IN (SELECT id FROM connections WHERE userId=?)",
        ).run(groupId, target);
        departure = {
          groupId,
          access: action === "leave" ? "left" : "removed",
          controlRevision: control.revision + 1,
          userId: target,
        };
        db.prepare(
          "INSERT INTO group_departures VALUES (?,?,?,?) ON CONFLICT(groupId,userId) DO UPDATE SET access=excluded.access,revision=excluded.revision",
        ).run(groupId, target, departure.access, departure.controlRevision);
      }
      // Old links must not allow a removed member (or a closed chat) to rejoin.
      if (
        action === "rotate" ||
        action === "remove" ||
        !groupIdsForChat(groupId).length
      )
        db.prepare("UPDATE groups SET inviteCode=? WHERE id=?").run(
          randomBytes(18).toString("base64url"),
          groupId,
        );
      db.prepare(
        "UPDATE group_controls SET revision=revision+1 WHERE groupId=?",
      ).run(groupId);
    });
    if (departure) {
      for (const connection of db
        .prepare("SELECT id FROM connections WHERE userId=?")
        .all(departure.userId)) {
        events.connection?.(connection.id, "group-access", departure);
        emitGroup(groupId, "typing", {
          groupId,
          connectionId: connection.id,
          userId: departure.userId,
          active: false,
        });
        events.connection?.(
          connection.id,
          "membership-state",
          stateFor(departure.userId),
        );
      }
      broadcastVoice(groupId);
    }
    const group = changedGroup(groupId);
    return departure?.userId === user.id ? departure : group;
  };
  const groupIdsForChat = (id) =>
    db.prepare("SELECT userId FROM memberships WHERE groupId=?").all(id);
  function realtimeClose(id) {
    const c = db.prepare("SELECT * FROM connections WHERE id=?").get(id);
    if (!c) return;
    const v = db
      .prepare("SELECT groupId FROM voices WHERE connectionId=?")
      .get(id);
    db.prepare("DELETE FROM voices WHERE connectionId=?").run(id);
    db.prepare("DELETE FROM connections WHERE id=?").run(id);
    if (v) settleRings(v.groupId);
    groupIds(c.userId).forEach((groupId) =>
      emitGroup(groupId, "typing", {
        groupId,
        connectionId: id,
        userId: c.userId,
        active: false,
      }),
    );
    if (v) broadcastVoice(v.groupId);
    if (!db.prepare("SELECT 1 FROM connections WHERE userId=?").get(c.userId))
      groupIds(c.userId).forEach((g) =>
        emitGroup(g, "presence", { userId: c.userId, online: false }),
      );
  }
  function claimTicket(ticket) {
    if (typeof ticket !== "string" || ticket.length > 100) return null;
    const row = db
      .prepare(
        "SELECT t.tokenHash,u.id,u.name,t.expires FROM tickets t JOIN sessions s ON t.tokenHash=s.tokenHash JOIN users u ON u.id=s.userId WHERE t.hash=?",
      )
      .get(hash(ticket));
    db.prepare("DELETE FROM tickets WHERE hash=?").run(hash(ticket));
    return row && row.expires > Date.now() ? row : null;
  }
  function realtimeOpen(id, user) {
    db.prepare("INSERT INTO connections VALUES (?,?,?)").run(
      id,
      user.id,
      user.tokenHash,
    );
    groupIds(user.id).forEach((g) =>
      emitGroup(g, "presence", { userId: user.id, online: true }),
    );
    return { connectionId: id, ...stateFor(user.id) };
  }
  function realtimeMessage(connectionId, event, data = {}) {
    const c = db
      .prepare("SELECT * FROM connections WHERE id=?")
      .get(connectionId);
    if (
      !c ||
      !db.prepare("SELECT 1 FROM sessions WHERE tokenHash=?").get(c.tokenHash)
    )
      throw problem(401, "Please reconnect to your chat.");
    const current = db
      .prepare("SELECT groupId FROM voices WHERE connectionId=?")
      .get(connectionId);
    if (event === "typing") {
      member(data.groupId, c.userId);
      const user = db
        .prepare("SELECT name FROM users WHERE id=?")
        .get(c.userId);
      emitGroup(data.groupId, "typing", {
        groupId: data.groupId,
        connectionId,
        userId: c.userId,
        name: user.name,
        active: data.active === true,
      });
      return { ok: true };
    }
    if (event === "voice:join") {
      member(data.groupId, c.userId);
      if (
        voicePeers(data.groupId).filter((p) => p.userId !== c.userId).length >=
        MAX_VOICE_PARTICIPANTS
      )
        throw problem(
          409,
          "This call is full. Up to four people can join voice.",
        );
      // A reconnect must replace this identity's old socket immediately, even
      // while a dead TCP connection is still waiting for its timeout.
      for (const old of db
        .prepare(
          "SELECT v.connectionId,v.groupId FROM voices v JOIN connections c ON c.id=v.connectionId WHERE c.userId=? AND v.connectionId<>?",
        )
        .all(c.userId, connectionId)) {
        db.prepare("DELETE FROM voices WHERE connectionId=?").run(
          old.connectionId,
        );
        events.connection?.(old.connectionId, "voice:replaced", {});
        broadcastVoice(old.groupId);
        if (old.groupId !== data.groupId) settleRings(old.groupId);
      }
      db.prepare(
        "INSERT INTO voices VALUES (?,?,?) ON CONFLICT(connectionId) DO UPDATE SET groupId=excluded.groupId,muted=excluded.muted",
      ).run(connectionId, data.groupId, data.muted ? 1 : 0);
      if (current && current.groupId !== data.groupId)
        broadcastVoice(current.groupId);
      broadcastVoice(data.groupId);
      endRing(ringKey(data.groupId, c.userId), "answered");
      return voiceState(data.groupId);
    }
    if (event === "voice:leave") {
      db.prepare("DELETE FROM voices WHERE connectionId=?").run(connectionId);
      if (current) {
        broadcastVoice(current.groupId);
        settleRings(current.groupId);
      }
      return { ok: true };
    }
    if (event === "call:ring") {
      const groupId = data.groupId;
      if (!current || current.groupId !== groupId)
        throw problem(403, "Join the call before ringing a friend.");
      member(groupId, c.userId);
      const now = Date.now();
      const burst = (ringBursts.get(c.userId) ?? []).filter(
        (at) => now - at < 60000,
      );
      if (burst.length >= 5)
        throw problem(429, "You have rung a lot of friends. Try again soon.");
      ringBursts.set(c.userId, [...burst, now]);
      const members = db
        .prepare("SELECT userId FROM memberships WHERE groupId=?")
        .all(groupId)
        .map((r) => r.userId)
        .filter((id) => id !== c.userId);
      const wanted =
        data.all === true
          ? members
          : Array.isArray(data.userIds)
            ? [...new Set(data.userIds)]
                .slice(0, 20)
                .filter((id) => members.includes(id))
            : [];
      if (!wanted.length) throw problem(400, "Choose someone to ring.");
      const inCall = new Set(voicePeers(groupId).map((p) => p.userId));
      const group = db
        .prepare("SELECT name FROM groups WHERE id=?")
        .get(groupId);
      const from = { id: c.userId, ...avatars.info("user", c.userId) };
      const caller = db
        .prepare("SELECT name FROM users WHERE id=?")
        .get(c.userId);
      const result = { ringing: [], skipped: [] };
      for (const target of wanted) {
        const key = ringKey(groupId, target);
        const online = db
          .prepare("SELECT 1 FROM connections WHERE userId=?")
          .get(target);
        const reason = inCall.has(target)
          ? "in-call"
          : rings.has(key)
            ? "already-ringing"
            : !online
              ? "offline"
              : null;
        if (reason) {
          result.skipped.push({ userId: target, reason });
          continue;
        }
        const timer = setTimeout(() => endRing(key, "no-answer"), RING_MS);
        timer.unref?.();
        rings.set(key, { groupId, from: c.userId, target, timer });
        emitUser(target, "call:ring", {
          groupId,
          groupName: group.name,
          from: { ...from, name: caller.name },
          peers: [...inCall],
          expiresIn: RING_MS,
        });
        emitUser(c.userId, "call:ring-status", {
          groupId,
          userId: target,
          status: "ringing",
        });
        result.ringing.push(target);
      }
      return result;
    }
    if (event === "call:ring-cancel") {
      member(data.groupId, c.userId);
      const targets = Array.isArray(data.userIds) ? data.userIds : undefined;
      for (const [key, r] of ringsFrom(c.userId, data.groupId, targets)) {
        endRing(key, null);
        emitUser(c.userId, "call:ring-status", {
          groupId: r.groupId,
          userId: r.target,
          status: "cancelled",
        });
      }
      return { ok: true };
    }
    if (event === "call:ring-decline") {
      member(data.groupId, c.userId);
      endRing(ringKey(data.groupId, c.userId), "declined");
      return { ok: true };
    }
    if (event === "voice:mute" && current) {
      db.prepare("UPDATE voices SET muted=? WHERE connectionId=?").run(
        data.muted ? 1 : 0,
        connectionId,
      );
      broadcastVoice(current.groupId);
      return { ok: true };
    }
    if (event === "signal") {
      if (!isUuid(data.to) || data.to === connectionId)
        throw problem(400, "A different caller is required.");
      const target = db
        .prepare("SELECT groupId FROM voices WHERE connectionId=?")
        .get(data.to);
      if (!current || !target || current.groupId !== target.groupId)
        throw problem(403, "That person is not in your call.");
      if (
        data.description &&
        (!["offer", "answer"].includes(data.description.type) ||
          typeof data.description.sdp !== "string" ||
          data.description.sdp.length > 24000)
      )
        throw problem(400, "Invalid voice negotiation.");
      if (data.description && /^m=(?!audio\s)/m.test(data.description.sdp))
        throw problem(400, "Only audio is supported in this call.");
      if (
        data.candidate &&
        (typeof data.candidate.candidate !== "string" ||
          data.candidate.candidate.length > 4000)
      )
        throw problem(400, "Invalid voice candidate.");
      events.connection?.(data.to, "signal", {
        from: connectionId,
        restart: data.restart === true,
        description: data.description,
        candidate: data.candidate,
      });
      return { ok: true };
    }
    throw problem(400, "Unknown realtime action.");
  }
  async function handle(
    method,
    path,
    body = {},
    token,
    query = new URLSearchParams(),
    context = {},
  ) {
    if (method === "GET" && path === "/api/health")
      return {
        service: "gather",
        version: 1,
        voiceAvailable: true,
        voiceLimit: MAX_VOICE_PARTICIPANTS,
        voiceTopology: VOICE_TOPOLOGY,
        relayAvailable: Boolean(
          (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) || env.TURN_SHARED_SECRET,
        ),
        transport: "websocket",
        protocol: { current: 1, minimum: 1 },
        capabilities: availableCapabilities,
        schemaVersion: LATEST_SCHEMA_VERSION,
      };
    if (path.startsWith("/api/admin/")) {
      const configured = env.GATHER_ADMIN_TOKEN;
      if (
        typeof configured !== "string" ||
        configured.length < 43 ||
        typeof token !== "string" ||
        token.length > 200 ||
        !timingSafeEqual(
          Buffer.from(hash(configured)),
          Buffer.from(hash(token)),
        )
      )
        throw problem(404, "That action was not found.");
      if (method === "GET" && path === "/api/admin/snapshot")
        return captureSnapshot(db);
      if (
        method === "GET" &&
        path === "/api/admin/storage" &&
        services.objectStorage
      )
        return services.objectStorage.status();
      if (method === "POST" && path === "/api/admin/media-expire")
        return media.expireFiles();
      if (method === "GET" && path === "/api/admin/reports")
        return {
          reports: moderation.listReports(query.get("status") ?? "open"),
        };
      if (method === "POST" && path === "/api/admin/reports/resolve")
        return moderation.resolveReport(body.id, body.status);
      if (method === "POST" && path === "/api/admin/remove-message")
        return moderation.removeMessage(body.messageId);
      if (method === "POST" && path === "/api/admin/remove-file")
        return moderation.removeFile(body.uploadId);
      if (method === "POST" && path === "/api/admin/remove-group")
        return moderation.removeGroup(body.groupId);
      if (method === "POST" && path === "/api/admin/ban")
        return moderation.banUser(body.userId, body);
      if (method === "POST" && path === "/api/admin/unban")
        return moderation.unbanUser(body.userId);
      if (method === "GET" && path === "/api/admin/limits")
        return moderation.limits();
      if (method === "POST" && path === "/api/admin/limits")
        return moderation.setLimits(body);
      if (method === "POST" && path === "/api/admin/media-cleanup")
        return media.cleanupCancelled();
      if (method === "GET" && path === "/api/admin/diagnostics")
        return {
          schema: LATEST_SCHEMA_VERSION,
          generation: db
            .prepare("SELECT value FROM server_state WHERE key='generation'")
            .get().value,
          counts: Object.fromEntries(
            [
              "users",
              "sessions",
              "groups",
              "memberships",
              "messages",
              "media_uploads",
              "cancelled_messages",
              "connections",
              "voices",
            ].map((table) => [
              table,
              db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
            ]),
          ),
          messageCharacters: db
            .prepare("SELECT COALESCE(SUM(length(body)),0) n FROM messages")
            .get().n,
        };
      throw problem(404, "That action was not found.");
    }
    const preview = path.match(/^\/api\/invites\/([^/]{1,64})$/);
    if (method === "GET" && preview) {
      // Public so an invite page can say where it leads. Only the chat name and
      // headcount are exposed, and only to someone holding the unguessable code.
      const g = db
        .prepare(
          "SELECT g.id,g.name FROM groups g JOIN group_controls c ON c.groupId=g.id WHERE g.inviteCode=? AND c.ownerId IS NOT NULL",
        )
        .get(decodeURIComponent(preview[1]));
      if (!g)
        throw problem(
          404,
          "That invite was not found. Double-check it with your friend.",
        );
      return {
        name: g.name,
        memberCount: db
          .prepare("SELECT COUNT(*) n FROM memberships WHERE groupId=?")
          .get(g.id).n,
      };
    }
    if (method === "POST" && path === "/api/public-reports")
      return moderation.publicReport(body, context.ip);
    if (method === "POST" && path === "/api/sessions") {
      const name = clean(body.name, "Your name", 32);
      const label = deviceLabel(body);
      let existing;
      if (body.inviteCode !== undefined) {
        const code = clean(body.inviteCode, "Invite code", 64);
        existing = db
          .prepare(
            "SELECT g.* FROM groups g JOIN group_controls c ON c.groupId=g.id WHERE g.inviteCode=? AND c.ownerId IS NOT NULL",
          )
          .get(code);
        if (!existing)
          throw problem(
            404,
            "That invite was not found. Double-check it with your friend.",
          );
      }
      moderation.admitSignup({ newGroup: !existing, ip: context.ip });
      const user = { id: randomUUID(), name };
      const token = randomBytes(32).toString("base64url");
      db.transaction(() => {
        db.prepare("INSERT INTO users VALUES (?,?,?)").run(
          user.id,
          name,
          Date.now(),
        );
        addSession(token, user.id, label);
        if (existing) addMember(existing.id, user.id);
        else makeGroup("The usual crew", user.id);
        moderation.log("signup", context.ip, { userId: user.id });
      });
      if (existing) changedGroup(existing.id);
      return { token, user };
    }
    if (method === "POST" && path === "/api/recover") {
      if (moderation.isBlocked(context.ip))
        throw problem(403, "This connection can’t use Gather right now.");
      if (
        typeof body.code !== "string" ||
        !/^gather_[A-Za-z0-9_-]{43}$/.test(body.code.trim())
      )
        throw problem(
          401,
          "That recovery code is not valid. Check the complete code and try again.",
        );
      const user = db
        .prepare(
          "SELECT u.id,u.name FROM recovery_codes r JOIN users u ON u.id=r.userId WHERE r.codeHash=?",
        )
        .get(hash(body.code.trim()));
      if (!user)
        throw problem(
          401,
          "That recovery code is not valid. Check the complete code and try again.",
        );
      const label = deviceLabel(body);
      const existing = db
        .prepare("SELECT tokenHash FROM sessions WHERE userId=?")
        .all(user.id);
      if (existing.length >= 16 && body.signOutOthers !== true)
        throw problem(
          409,
          "Your device list is full. Choose Sign out other devices to recover.",
        );
      const recoveredToken = randomBytes(32).toString("base64url");
      db.transaction(() => {
        if (body.signOutOthers === true)
          for (const row of existing)
            db.prepare("DELETE FROM sessions WHERE tokenHash=?").run(
              row.tokenHash,
            );
        addSession(recoveredToken, user.id, label);
      });
      if (body.signOutOthers === true)
        for (const row of existing) revokeSession(row.tokenHash);
      return { token: recoveredToken, user };
    }
    const user = authorize(token);
    if (!user)
      throw problem(
        401,
        "Your sign-in is no longer available on this server. Please reconnect.",
      );
    if (method === "GET" && path === "/api/bootstrap")
      return {
        user,
        generation: db
          .prepare("SELECT value FROM server_state WHERE key='generation'")
          .get().value,
        groups: groupIds(user.id).map(getGroup),
        departures: db
          .prepare(
            "SELECT groupId,access,revision AS controlRevision FROM group_departures WHERE userId=?",
          )
          .all(user.id),
        ...stateFor(user.id),
        voiceAvailable: true,
        voiceLimit: MAX_VOICE_PARTICIPANTS,
        capabilities: availableCapabilities,
      };
    if (method === "POST" && path === "/api/reports")
      return moderation.report(user, body, context.ip);
    const mediaResult = await media.handle(method, path, body, user, context);
    if (mediaResult !== undefined) return mediaResult;
    if (method === "GET" && /^\/api\/gifs\/(search|trending)$/.test(path))
      return gifs.request(user.id, path.split("/").at(-1), query);
    const lookup = path.match(/^\/api\/groups\/([^/]+)\/message\/([^/]+)$/);
    if (method === "GET" && lookup) {
      member(lookup[1], user.id);
      const message = db
        .prepare(`${messageSelect} WHERE m.id=? AND m.groupId=?`)
        .get(lookup[2], lookup[1]);
      if (!message)
        throw problem(404, "This message is not available on the server.");
      return enrich(message);
    }
    const outbox = path.match(/^\/api\/groups\/([^/]+)\/outbox\/([^/]+)$/);
    if (outbox && method === "GET") {
      member(outbox[1], user.id);
      const message = db
        .prepare(
          `${messageSelect} WHERE m.clientId=? AND m.groupId=? AND m.userId=?`,
        )
        .get(outbox[2], outbox[1], user.id);
      return { message: message ? enrich(message) : null };
    }
    if (outbox && method === "POST") {
      if (
        body.discardAttachments !== undefined &&
        (!Array.isArray(body.discardAttachments) ||
          body.discardAttachments.length > 4 ||
          body.discardAttachments.some((id) => !isUuid(id)))
      )
        throw problem(400, "Invalid unsent files.");

      member(outbox[1], user.id);
      if (!isUuid(outbox[2]) || body.action !== "cancel")
        throw problem(400, "Choose an unsent message.");
      let result;
      db.transaction(() => {
        const accepted = db
          .prepare(`${messageSelect} WHERE m.clientId=? AND m.userId=?`)
          .get(outbox[2], user.id);
        if (accepted) {
          if (accepted.groupId !== outbox[1])
            throw problem(403, "That message belongs to another chat.");
          result = { message: enrich(accepted) };
          return;
        }
        const old = db
          .prepare(
            "SELECT groupId FROM cancelled_messages WHERE userId=? AND clientId=?",
          )
          .get(user.id, outbox[2]);
        if (old && old.groupId !== outbox[1])
          throw problem(409, "That message ID was used in another chat.");
        if (
          !old &&
          db
            .prepare("SELECT COUNT(*) n FROM cancelled_messages WHERE userId=?")
            .get(user.id).n >= 10000
        )
          throw problem(
            429,
            "The cancellation history is full. Ask the host to review its storage allowance.",
          );
        db.prepare(
          "INSERT OR IGNORE INTO cancelled_messages VALUES (?,?,?)",
        ).run(user.id, outbox[2], outbox[1]);
        result = { message: null, cancelled: true };
      });
      if (!result.message)
        for (const id of body.discardAttachments ?? [])
          await media
            .handle("POST", `/api/uploads/${id}/cancel`, {}, user)
            .catch(() => {});
      return result;
    }
    const membershipMatch = path.match(/^\/api\/groups\/([^/]+)\/membership$/);
    if (method === "POST" && membershipMatch)
      return changeMembership(membershipMatch[1], user, body);
    const profileMatch = path.match(/^\/api\/groups\/([^/]+)\/profile$/);
    if (profileMatch && method === "POST") {
      member(profileMatch[1], user.id);
      const name = clean(body.name, "Chat name", 48);
      db.prepare("UPDATE groups SET name=? WHERE id=?").run(
        name,
        profileMatch[1],
      );
      return changedGroup(profileMatch[1]);
    }
    const changesMatch = path.match(/^\/api\/groups\/([^/]+)\/changes$/);
    if (changesMatch && method === "GET") {
      member(changesMatch[1], user.id);
      const after = Number(query.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw problem(400, "Invalid change cursor.");
      const changes = db
        .prepare(
          "SELECT sequence,messageId FROM message_changes WHERE groupId=? AND sequence>? ORDER BY sequence LIMIT 51",
        )
        .all(changesMatch[1], after);
      return {
        changes: changes.slice(0, 50).map((c) => ({
          sequence: c.sequence,
          message: enrich(
            db.prepare(`${messageSelect} WHERE m.id=?`).get(c.messageId),
          ),
        })),
        hasMore: changes.length > 50,
      };
    }
    const mutationMatch = path.match(
      /^\/api\/messages\/([^/]+)\/(edit|delete)$/,
    );
    if (mutationMatch && method === "POST") {
      let changed = false;
      db.transaction(() => {
        const message = db
          .prepare(`${messageSelect} WHERE m.id=?`)
          .get(mutationMatch[1]);
        if (!message) throw problem(404, "That message was not found.");
        member(message.groupId, user.id);
        if (message.userId !== user.id)
          throw problem(403, "You can only change your own messages.");
        const now = Date.now();
        if (mutationMatch[2] === "delete") {
          if (message.deletedAt) return;
          db.prepare("UPDATE messages SET body='',deletedAt=? WHERE id=?").run(
            now,
            message.id,
          );
          db.prepare("DELETE FROM message_reactions WHERE messageId=?").run(
            message.id,
          );
        } else {
          if (message.deletedAt)
            throw problem(
              409,
              "This message was deleted. Your edit has not been sent.",
            );
          if (
            typeof body.body !== "string" ||
            body.body.trim().length > 4000 ||
            (!body.body.trim() && !media.attachments(message.id).length)
          )
            throw problem(
              400,
              "Enter a message, or keep a caption empty when it has a file.",
            );
          const text = body.body.trim();
          if (message.body === text) return;
          if (
            !Number.isSafeInteger(body.baseRevision) ||
            body.baseRevision !== message.contentRevision
          )
            throw problem(
              409,
              "This message changed elsewhere. Use the latest version before saving.",
            );
          db.prepare("UPDATE messages SET body=?,editedAt=? WHERE id=?").run(
            text,
            now,
            message.id,
          );
        }
        db.prepare(
          "INSERT INTO message_changes(messageId,groupId,createdAt,kind) VALUES (?,?,?,?)",
        ).run(message.id, message.groupId, now, mutationMatch[2]);
        for (const reply of db
          .prepare("SELECT messageId FROM message_replies WHERE targetId=?")
          .all(message.id))
          db.prepare(
            "INSERT INTO message_changes(messageId,groupId,createdAt,kind) VALUES (?,?,?,'reply')",
          ).run(reply.messageId, message.groupId, now);
        changed = true;
      });
      const updated = enrich(
        db.prepare(`${messageSelect} WHERE m.id=?`).get(mutationMatch[1]),
      );
      if (changed)
        emitGroup(updated.groupId, "message", {
          ...updated,
          changeKind: mutationMatch[2],
        });
      if (changed)
        for (const reply of db
          .prepare("SELECT messageId FROM message_replies WHERE targetId=?")
          .all(updated.id))
          emitGroup(updated.groupId, "message", {
            ...enrich(
              db.prepare(`${messageSelect} WHERE m.id=?`).get(reply.messageId),
            ),
            changeKind: "reply",
          });
      return updated;
    }
    const reactionMatch = path.match(/^\/api\/messages\/([^/]+)\/reactions$/);
    if (reactionMatch && method === "POST") {
      const message = db
        .prepare(`${messageSelect} WHERE m.id=?`)
        .get(reactionMatch[1]);
      if (!message) throw problem(404, "That message was not found.");
      member(message.groupId, user.id);
      if (message.deletedAt) throw problem(409, "This message was deleted.");
      const emoji = body.emoji;
      if (!isReactionEmoji(emoji) || typeof body.active !== "boolean")
        throw problem(400, "Choose an emoji reaction.");
      db.transaction(() => {
        const old = db
          .prepare(
            "SELECT 1 FROM message_reactions WHERE messageId=? AND userId=? AND emoji=?",
          )
          .get(message.id, user.id, emoji);
        if (Boolean(old) === body.active) return;
        if (body.active) {
          if (
            !db
              .prepare(
                "SELECT 1 FROM message_reactions WHERE messageId=? AND emoji=?",
              )
              .get(message.id, emoji) &&
            db
              .prepare(
                "SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE messageId=?",
              )
              .get(message.id).n >= 8
          )
            throw problem(409, "Choose an existing reaction for this message.");
          if (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM message_reactions WHERE messageId=?",
              )
              .get(message.id).n >= 100
          )
            throw problem(409, "This message has reached its reaction limit.");
          db.prepare("INSERT INTO message_reactions VALUES (?,?,?)").run(
            message.id,
            user.id,
            emoji,
          );
        } else
          db.prepare(
            "DELETE FROM message_reactions WHERE messageId=? AND userId=? AND emoji=?",
          ).run(message.id, user.id, emoji);
        db.prepare(
          "INSERT INTO message_changes(messageId,groupId,createdAt) VALUES (?,?,?)",
        ).run(message.id, message.groupId, Date.now());
      });
      const updated = enrich(
        db.prepare(`${messageSelect} WHERE m.id=?`).get(message.id),
      );
      emitGroup(message.groupId, "message", {
        ...updated,
        changeKind: "reaction",
      });
      return updated;
    }
    if (method === "GET" && path === "/api/recovery") {
      const recovery = db
        .prepare("SELECT createdAt FROM recovery_codes WHERE userId=?")
        .get(user.id);
      return {
        configured: Boolean(recovery),
        createdAt: recovery?.createdAt ?? null,
      };
    }
    if (method === "POST" && path === "/api/recovery") {
      const code = `gather_${randomBytes(32).toString("base64url")}`;
      db.prepare(
        "INSERT INTO recovery_codes VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET codeHash=excluded.codeHash,createdAt=excluded.createdAt",
      ).run(user.id, hash(code), Date.now());
      return { code };
    }
    if (method === "GET" && path === "/api/devices")
      return {
        devices: db
          .prepare(
            "SELECT s.tokenHash AS id,COALESCE(d.name,'Existing device') AS name,s.createdAt,COALESCE(d.lastSeen,s.createdAt) AS lastSeen FROM sessions s LEFT JOIN devices d ON d.tokenHash=s.tokenHash WHERE s.userId=? ORDER BY s.createdAt DESC,s.tokenHash",
          )
          .all(user.id)
          .map((device) => ({
            ...device,
            current: device.id === hash(token),
            online: Boolean(
              db
                .prepare("SELECT 1 FROM connections WHERE tokenHash=?")
                .get(device.id),
            ),
          })),
      };
    if (method === "POST" && path === "/api/devices/revoke") {
      if (typeof body.id !== "string" || !/^[a-f0-9]{64}$/.test(body.id))
        throw problem(400, "Choose a signed-in device.");
      if (body.id === hash(token))
        throw problem(409, "Use Sign out to leave this device.");
      if (
        !db
          .prepare("SELECT 1 FROM sessions WHERE userId=? AND tokenHash=?")
          .get(user.id, body.id)
      )
        throw problem(404, "That device is no longer signed in.");
      revokeSession(body.id);
      return { ok: true };
    }
    if (method === "POST" && path === "/api/realtime-ticket") {
      db.prepare("DELETE FROM tickets WHERE expires<?").run(Date.now());
      const ticket = randomBytes(24).toString("base64url");
      db.prepare("INSERT INTO tickets VALUES (?,?,?)").run(
        hash(ticket),
        hash(token),
        Date.now() + 60000,
      );
      return { ticket };
    }
    if (method === "POST" && path === "/api/groups") {
      const name = clean(body.name, "Chat name", 48);
      if (groupIds(user.id).length >= 50)
        throw problem(400, "You can have up to 50 chats.");
      if (
        db
          .prepare(
            "SELECT COUNT(*) n FROM group_controls c JOIN groups g ON g.id=c.groupId WHERE c.ownerId=? AND g.createdAt>?",
          )
          .get(user.id, Date.now() - 86_400_000).n >= 5
      )
        throw problem(
          429,
          "You’ve started a lot of chats today. Try again tomorrow.",
        );
      moderation.admitGroup();
      return changedGroup(db.transaction(() => makeGroup(name, user.id)).id);
    }
    if (method === "POST" && path === "/api/groups/join") {
      const code = clean(body.code, "Invite code", 64);
      const g = db
        .prepare(
          "SELECT g.* FROM groups g JOIN group_controls c ON c.groupId=g.id WHERE g.inviteCode=? AND c.ownerId IS NOT NULL",
        )
        .get(code);
      if (!g)
        throw problem(
          404,
          "That invite was not found. Double-check it with your friend.",
        );
      db.transaction(() => addMember(g.id, user.id));
      return changedGroup(g.id);
    }
    const match = path.match(/^\/api\/groups\/([^/]+)\/(messages|ice)$/);
    if (match) {
      const [, groupId, action] = match;
      member(groupId, user.id);
      if (action === "messages" && method === "GET") {
        if (query.has("after")) {
          const after = Number(query.get("after"));
          if (query.has("before") || !Number.isSafeInteger(after) || after < 0)
            throw problem(400, "That message cursor is not valid.");
          const messages = db
            .prepare(
              `${messageSelect} WHERE m.groupId=? AND m.sequence>? ORDER BY m.sequence ASC LIMIT 51`,
            )
            .all(groupId, after);
          return {
            messages: messages.slice(0, 50).map(enrich),
            hasMore: messages.length > 50,
          };
        }
        const before = query.has("before")
          ? Number(query.get("before"))
          : Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(before) || before < 1)
          throw problem(400, "That message cursor is not valid.");
        const messages = db
          .prepare(
            `${messageSelect} WHERE m.groupId=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT 51`,
          )
          .all(groupId, before);
        return {
          messages: messages.slice(0, 50).reverse().map(enrich),
          hasMore: messages.length > 50,
        };
      }
      if (action === "messages" && method === "POST") {
        const text = clean(body.body, "Message", 4000);
        if (!isUuid(body.clientId))
          throw problem(400, "A valid message ID is required.");
        if (
          body.replyTo !== undefined &&
          body.replyTo !== null &&
          !isUuid(body.replyTo)
        )
          throw problem(400, "Choose a message to reply to.");
        const ids = body.attachmentIds ?? [];
        if (
          !Array.isArray(ids) ||
          ids.length > 4 ||
          ids.some((id) => !isUuid(id)) ||
          new Set(ids).size !== ids.length
        )
          throw problem(400, "Choose up to four files per message.");
        const old = db
          .prepare(`${messageSelect} WHERE m.userId=? AND m.clientId=?`)
          .get(user.id, body.clientId);
        if (old) {
          if (old.groupId === groupId && old.deletedAt) return enrich(old);
          if (
            old.groupId !== groupId ||
            old.body !== text ||
            (db
              .prepare("SELECT targetId FROM message_replies WHERE messageId=?")
              .get(old.id)?.targetId ?? null) !== (body.replyTo ?? null) ||
            JSON.stringify(media.attachments(old.id).map((a) => a.id)) !==
              JSON.stringify(ids)
          )
            throw problem(409, "That message ID was already used.");
          return enrich(old);
        }
        const id = randomUUID();
        db.transaction(() => {
          if (
            db
              .prepare(
                "SELECT 1 FROM cancelled_messages WHERE userId=? AND clientId=?",
              )
              .get(user.id, body.clientId)
          )
            throw problem(
              409,
              "This queued message was cancelled. Restore it to a new draft to send it.",
            );
          if (
            body.replyTo &&
            !db
              .prepare("SELECT 1 FROM messages WHERE id=? AND groupId=?")
              .get(body.replyTo, groupId)
          )
            throw problem(
              400,
              "That reply belongs to another chat or is unavailable.",
            );
          const uploads = media.validateAttachments(ids, groupId, user.id);
          db.prepare(
            "INSERT INTO messages (id,clientId,groupId,userId,body,createdAt) VALUES (?,?,?,?,?,?)",
          ).run(id, body.clientId, groupId, user.id, text, Date.now());
          media.commit(id, uploads);
          if (body.replyTo)
            db.prepare("INSERT INTO message_replies VALUES (?,?)").run(
              id,
              body.replyTo,
            );
          db.prepare(
            "INSERT INTO message_changes(messageId,groupId,createdAt,kind) VALUES (?,?,?,'create')",
          ).run(id, groupId, Date.now());
        });
        const m = enrich(db.prepare(`${messageSelect} WHERE m.id=?`).get(id));
        emitGroup(groupId, "message", { ...m, changeKind: "create" });
        return m;
      }
      if (action === "ice" && method === "POST") {
        // Past the daily relay budget (or with the switch off) calls fall back
        // to direct connections, which are free.
        if (!moderation.relayAllowed(user.id, context.ip))
          return {
            iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
            relayAvailable: false,
          };
        if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
          const r = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ttl: 86400 }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!r.ok)
            throw problem(
              503,
              "The audio relay is unavailable. Ask your host to check the TURN key.",
            );
          const result = await r.json();
          return {
            iceServers: result.iceServers,
            relayAvailable: true,
            expiresIn: 86400,
          };
        }
        if (env.TURN_SHARED_SECRET && env.TURN_URLS) {
          const username = `${Math.floor(Date.now() / 1000) + 86400}:${user.id}`;
          return {
            iceServers: [
              {
                urls: env.TURN_URLS.split(","),
                username,
                credential: createHmac("sha1", env.TURN_SHARED_SECRET)
                  .update(username)
                  .digest("base64"),
              },
            ],
            relayAvailable: true,
            expiresIn: 86400,
          };
        }
        return {
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
          relayAvailable: false,
        };
      }
    }
    if (method === "POST" && path === "/api/profile") {
      const name = clean(body.name, "Your name", 32);
      db.prepare("UPDATE users SET name=? WHERE id=?").run(name, user.id);
      for (const id of groupIds(user.id)) {
        changedGroup(id);
        broadcastVoice(id);
      }
      return { id: user.id, name, ...avatars.info("user", user.id) };
    }
    if (method === "POST" && path === "/api/sign-out") {
      revokeSession(hash(token));
      return { ok: true };
    }
    if (method === "GET" && path === "/api/export")
      return {
        format: "gather-export-v1",
        features: [
          "text",
          "attachments-v1",
          "reactions-v1",
          "message-mutations-v1",
          "replies-v1",
        ],
        exportedAt: new Date().toISOString(),
        user,
        groups: groupIds(user.id).map((id) => ({
          ...getGroup(id),
          inviteCode: "",
          messages: db
            .prepare(`${messageSelect} WHERE m.groupId=? ORDER BY m.sequence`)
            .all(id)
            .map(enrich),
        })),
      };
    const avatarResult = await avatars.handle(method, path, body, user);
    if (avatarResult !== undefined) return avatarResult;
    throw problem(404, "That action was not found.");
  }
  return {
    handle,
    mediaRequest: async (request) =>
      (await avatars.request(request)) ?? media.request(request),
    authorize,
    member,
    groupIds,
    claimTicket,
    realtimeOpen,
    realtimeClose,
    expireFiles: (now) => {
      moderation.pruneLog(now);
      return media.expireFiles(now);
    },
    realtimeMessage,
    stateFor,
    voicePeers,
  };
}
