import { randomBytes, randomUUID } from "node:crypto";

// Safety rails for an open, anonymous service: user reports, an operator
// tool to remove content and people, and global ceilings that pause growth
// instead of letting costs run away. Everything here is deliberately small.
const DAY = 86_400_000;
const LOG_KEEP_MS = 90 * DAY;
export const REPORT_REASONS = ["illegal", "abuse", "spam", "other"];

// Defaults for the operator-adjustable ceilings. Override with
// POST /api/admin/limits (see OPERATIONS.md); stored in server_state.
export const DEFAULT_LIMITS = {
  maxGroups: 3000,
  maxUsers: 6000,
  signupsPerDay: 2000,
  uploadsPerDay: 6000,
  relayPerDay: 1500,
  relayPerUserPerDay: 40,
  relay: true,
};

export function createModeration({
  db,
  storage,
  problem,
  member,
  loadMessage,
  emitGroup,
  events,
  revokeSession,
  stateFor,
  broadcastVoice,
  changedGroup,
}) {
  const state = (key) =>
    db.prepare("SELECT value FROM server_state WHERE key=?").get(key)?.value;
  const setState = (key, value) =>
    db
      .prepare(
        "INSERT INTO server_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);

  function limits() {
    let saved = {};
    try {
      saved = JSON.parse(state("limits") ?? "{}");
    } catch {}
    const result = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS))
      if (typeof saved[key] === typeof DEFAULT_LIMITS[key])
        result[key] = saved[key];
    return result;
  }
  function setLimits(body) {
    const next = limits();
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== typeof DEFAULT_LIMITS[key])
        throw problem(400, `${key} has the wrong type.`);
      if (typeof body[key] === "number" && !(body[key] >= 0))
        throw problem(400, `${key} must be zero or more.`);
      next[key] = body[key];
    }
    setState("limits", JSON.stringify(next));
    return next;
  }

  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const log = (kind, ip, { userId, groupId, ref } = {}) =>
    db
      .prepare(
        "INSERT INTO activity_log(kind,userId,groupId,ref,ip,createdAt) VALUES (?,?,?,?,?,?)",
      )
      .run(
        kind,
        userId ?? null,
        groupId ?? null,
        ref ?? null,
        ip || "unknown",
        Date.now(),
      );
  // IPs are kept only long enough to act on a report.
  function pruneLog(now = Date.now()) {
    db.prepare("DELETE FROM activity_log WHERE createdAt<?").run(
      now - LOG_KEEP_MS,
    );
    db.prepare("DELETE FROM activity_log WHERE kind='ice' AND createdAt<?").run(
      now - 2 * DAY,
    );
  }

  const blockedIps = () => {
    try {
      return JSON.parse(state("blockedIps") ?? "[]");
    } catch {
      return [];
    }
  };
  const isBlocked = (ip) => Boolean(ip) && blockedIps().includes(ip);

  // Called before creating an account or a new chat. Pauses rather than bills.
  function admitSignup({ newGroup, ip }) {
    if (isBlocked(ip))
      throw problem(403, "This connection can’t use Gather right now.");
    const cap = limits();
    if (
      count("SELECT COUNT(*) n FROM users") >= cap.maxUsers ||
      count(
        "SELECT COUNT(*) n FROM users WHERE createdAt>?",
        Date.now() - DAY,
      ) >= cap.signupsPerDay
    )
      throw problem(
        503,
        "Gather is getting a lot of new people right now, so sign-ups are paused for a bit. Please try again tomorrow.",
      );
    if (newGroup) admitGroup();
  }
  function admitGroup() {
    if (count("SELECT COUNT(*) n FROM groups") >= limits().maxGroups)
      throw problem(
        503,
        "Gather is full for new chats right now. Please try again tomorrow.",
      );
  }

  // Per-person upload allowance, plus a global ceiling per day.
  function admitUpload(userId, bytes, groupId, ip) {
    const cap = limits();
    const since = Date.now() - DAY;
    const created =
      db.prepare("SELECT createdAt FROM users WHERE id=?").get(userId)
        ?.createdAt ?? 0;
    const fresh = Date.now() - created < DAY;
    const mine = db
      .prepare(
        "SELECT COUNT(*) n,COALESCE(SUM(bytes),0) b FROM media_uploads WHERE userId=? AND createdAt>? AND state<>'cancelled'",
      )
      .get(userId, since);
    if (
      mine.n >= (fresh ? 10 : 60) ||
      mine.b + bytes > (fresh ? 50_000_000 : 200_000_000)
    )
      throw problem(
        429,
        "You’ve shared a lot of files today. Try again tomorrow.",
      );
    // On a very busy day the global ceiling pauses heavy sharing first; a
    // person's first couple of files always go through so newcomers aren't shut out.
    if (
      mine.n >= 2 &&
      count(
        "SELECT COUNT(*) n FROM media_uploads WHERE createdAt>? AND state<>'cancelled'",
        since,
      ) >= cap.uploadsPerDay
    )
      throw problem(
        503,
        "File sharing is paused for today because Gather is very busy. Text and voice still work.",
      );
    return () => log("upload", ip, { userId, groupId });
  }

  // TURN is the one metered thing a stranger could burn; cap credential use.
  function relayAllowed(userId, ip) {
    const cap = limits();
    if (!cap.relay) return false;
    const since = Date.now() - DAY;
    if (
      count(
        "SELECT COUNT(*) n FROM activity_log WHERE kind='ice' AND createdAt>?",
        since,
      ) >= cap.relayPerDay ||
      count(
        "SELECT COUNT(*) n FROM activity_log WHERE kind='ice' AND userId=? AND createdAt>?",
        userId,
        since,
      ) >= cap.relayPerUserPerDay
    )
      return false;
    log("ice", ip, { userId });
    return true;
  }

  // ---- reports ----------------------------------------------------------
  function report(user, body, ip) {
    const groupId = body.groupId;
    if (typeof groupId !== "string")
      throw problem(400, "Choose a chat to report.");
    member(groupId, user.id);
    if (!REPORT_REASONS.includes(body.reason))
      throw problem(400, "Choose a reason for the report.");
    const detail =
      typeof body.detail === "string" ? body.detail.trim().slice(0, 500) : "";
    if (
      count(
        "SELECT COUNT(*) n FROM reports WHERE reporterId=? AND createdAt>?",
        user.id,
        Date.now() - DAY,
      ) >= 20
    )
      throw problem(429, "You’ve sent a lot of reports today. Thank you.");
    let messageId = null,
      uploadId = null,
      targetUserId = null,
      excerpt = "";
    if (body.messageId !== undefined) {
      const message = db
        .prepare(
          "SELECT id,userId,body,deletedAt FROM messages WHERE id=? AND groupId=?",
        )
        .get(body.messageId, groupId);
      if (!message) throw problem(404, "That message was not found.");
      messageId = message.id;
      targetUserId = message.userId;
      excerpt = message.deletedAt ? "(deleted)" : message.body.slice(0, 300);
      const file = db
        .prepare(
          "SELECT u.id,u.name,u.type,u.bytes FROM message_attachments a JOIN media_uploads u ON u.id=a.uploadId WHERE a.messageId=? ORDER BY a.position LIMIT 1",
        )
        .get(message.id);
      if (file) {
        uploadId = file.id;
        excerpt =
          `${excerpt} [file: ${file.name}, ${file.type}, ${file.bytes} bytes]`.trim();
      }
      if (targetUserId === user.id)
        throw problem(400, "You can’t report your own message.");
    }
    const duplicate = db
      .prepare(
        "SELECT id FROM reports WHERE reporterId=? AND groupId=? AND COALESCE(messageId,'')=? AND status='open'",
      )
      .get(user.id, groupId, messageId ?? "");
    if (duplicate) return { ok: true, id: duplicate.id };
    const id = randomUUID();
    db.prepare(
      "INSERT INTO reports(id,reporterId,groupId,messageId,uploadId,targetUserId,reason,detail,excerpt,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,'open',?)",
    ).run(
      id,
      user.id,
      groupId,
      messageId,
      uploadId,
      targetUserId,
      body.reason,
      detail,
      excerpt,
      Date.now(),
    );
    log("report", ip, { userId: user.id, groupId, ref: id });
    return { ok: true, id };
  }

  // Anyone, signed in or not, can tell the operator about a problem from the
  // public report page. Bounded so the form can't be used to flood the list.
  function publicReport(body, ip) {
    const text = (value, max) =>
      typeof value === "string" ? value.trim().slice(0, max) : "";
    const detail = text(body.detail, 2000);
    if (detail.length < 10)
      throw problem(400, "Please describe what you saw (a sentence or two).");
    if (count("SELECT COUNT(*) n FROM reports WHERE status='open'") >= 500)
      throw problem(
        503,
        "The report inbox is full. Please use the in-app Report button or try again later.",
      );
    if (
      count(
        "SELECT COUNT(*) n FROM activity_log WHERE kind='webreport' AND ip=? AND createdAt>?",
        ip || "unknown",
        Date.now() - DAY,
      ) >= 10
    )
      throw problem(
        429,
        "Thanks, we have your reports. Please try again tomorrow.",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO reports(id,contact,reason,detail,excerpt,status,createdAt) VALUES (?,?,?,?,?,'open',?)",
    ).run(
      id,
      text(body.contact, 200),
      REPORT_REASONS.includes(body.reason) ? body.reason : "other",
      detail,
      text(body.where, 300),
      Date.now(),
    );
    log("webreport", ip, { ref: id });
    return { ok: true };
  }

  function listReports(status = "open") {
    if (!["open", "actioned", "dismissed", "all"].includes(status))
      throw problem(400, "Unknown report status.");
    const rows = db
      .prepare(
        `SELECT r.*,COALESCE(ru.name,'(web form)') AS reporterName,g.name AS groupName,tu.name AS targetName FROM reports r LEFT JOIN users ru ON ru.id=r.reporterId LEFT JOIN groups g ON g.id=r.groupId LEFT JOIN users tu ON tu.id=r.targetUserId ${status === "all" ? "" : "WHERE r.status=?"} ORDER BY r.createdAt DESC LIMIT 100`,
      )
      .all(...(status === "all" ? [] : [status]));
    return rows.map((r) => ({
      ...r,
      banned: Boolean(
        r.targetUserId &&
        db.prepare("SELECT 1 FROM bans WHERE userId=?").get(r.targetUserId),
      ),
      // What a follow-up needs: when and from where the sender joined or uploaded.
      targetActivity: r.targetUserId
        ? db
            .prepare(
              "SELECT kind,ip,createdAt FROM activity_log WHERE userId=? AND kind IN ('signup','upload') ORDER BY createdAt DESC LIMIT 10",
            )
            .all(r.targetUserId)
        : [],
    }));
  }
  function resolveReport(id, status) {
    if (!["actioned", "dismissed", "open"].includes(status))
      throw problem(400, "Choose actioned, dismissed or open.");
    if (!db.prepare("SELECT 1 FROM reports WHERE id=?").get(id))
      throw problem(404, "That report was not found.");
    db.prepare("UPDATE reports SET status=? WHERE id=?").run(status, id);
    return { ok: true };
  }

  // ---- operator actions -------------------------------------------------
  async function removeFiles(rows) {
    let removed = 0;
    for (const row of rows) {
      try {
        await storage.remove(row.key);
        removed++;
      } catch {}
    }
    return removed;
  }
  async function removeFile(uploadId) {
    const row = db
      .prepare("SELECT key FROM media_uploads WHERE id=?")
      .get(uploadId);
    if (!row) throw problem(404, "That file was not found.");
    return { removed: await removeFiles([row]) };
  }
  async function removeMessage(messageId) {
    const message = db
      .prepare("SELECT id,groupId,deletedAt FROM messages WHERE id=?")
      .get(messageId);
    if (!message) throw problem(404, "That message was not found.");
    const files = db
      .prepare(
        "SELECT u.key FROM message_attachments a JOIN media_uploads u ON u.id=a.uploadId WHERE a.messageId=?",
      )
      .all(messageId);
    const removed = await removeFiles(files);
    if (!message.deletedAt) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare("UPDATE messages SET body='',deletedAt=? WHERE id=?").run(
          now,
          messageId,
        );
        db.prepare("DELETE FROM message_reactions WHERE messageId=?").run(
          messageId,
        );
        db.prepare(
          "INSERT INTO message_changes(messageId,groupId,createdAt,kind) VALUES (?,?,?,'delete')",
        ).run(messageId, message.groupId, now);
      });
      emitGroup(message.groupId, "message", {
        ...loadMessage(messageId),
        changeKind: "delete",
      });
    }
    return { ok: true, filesRemoved: removed };
  }

  async function banUser(userId, { reason, purge, blockIp }) {
    const user = db.prepare("SELECT id,name FROM users WHERE id=?").get(userId);
    if (!user) throw problem(404, "That person was not found.");
    const text =
      typeof reason === "string" && reason.trim()
        ? reason.trim().slice(0, 200)
        : "Banned by the operator";
    const tokens = db
      .prepare("SELECT tokenHash FROM sessions WHERE userId=?")
      .all(userId);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO bans VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET reason=excluded.reason",
      ).run(userId, text, Date.now());
      db.prepare("DELETE FROM recovery_codes WHERE userId=?").run(userId);
    });
    for (const row of tokens) revokeSession(row.tokenHash);
    let blocked = [];
    if (blockIp) {
      blocked = [
        ...new Set(
          db
            .prepare(
              "SELECT ip FROM activity_log WHERE userId=? AND kind='signup'",
            )
            .all(userId)
            .map((r) => r.ip)
            .filter((ip) => ip !== "unknown"),
        ),
      ];
      setState(
        "blockedIps",
        JSON.stringify([...new Set([...blockedIps(), ...blocked])].slice(-200)),
      );
    }
    let purged = 0;
    if (purge) {
      for (const m of db
        .prepare("SELECT id FROM messages WHERE userId=? AND deletedAt IS NULL")
        .all(userId)) {
        await removeMessage(m.id);
        purged++;
      }
      await removeFiles(
        db
          .prepare(
            "SELECT key FROM media_uploads WHERE userId=? AND state<>'cancelled'",
          )
          .all(userId),
      );
    }
    for (const g of db
      .prepare("SELECT groupId FROM memberships WHERE userId=?")
      .all(userId)) {
      changedGroup(g.groupId);
      broadcastVoice(g.groupId);
    }
    return {
      ok: true,
      name: user.name,
      sessionsEnded: tokens.length,
      purged,
      blockedIps: blocked,
    };
  }
  // Self-service deletion: messages and files go, the person leaves every chat
  // (ownership passes to the longest-standing member), and the name is wiped.
  // The bare user row stays only because old rows still point at it.
  async function deleteAccount(userId) {
    const user = db.prepare("SELECT id FROM users WHERE id=?").get(userId);
    if (!user) throw problem(404, "That account was not found.");
    const tokens = db
      .prepare("SELECT tokenHash FROM sessions WHERE userId=?")
      .all(userId);
    const groups = db
      .prepare("SELECT groupId FROM memberships WHERE userId=?")
      .all(userId)
      .map((r) => r.groupId);
    for (const m of db
      .prepare("SELECT id FROM messages WHERE userId=? AND deletedAt IS NULL")
      .all(userId))
      await removeMessage(m.id);
    await removeFiles(
      db
        .prepare(
          "SELECT key FROM media_uploads WHERE userId=? AND state<>'cancelled'",
        )
        .all(userId),
    );
    await removeFiles(
      db.prepare("SELECT key FROM avatar_images WHERE userId=?").all(userId),
    );
    db.transaction(() => {
      for (const groupId of groups) {
        const control = db
          .prepare("SELECT * FROM group_controls WHERE groupId=?")
          .get(groupId);
        db.prepare("DELETE FROM memberships WHERE groupId=? AND userId=?").run(
          groupId,
          userId,
        );
        db.prepare(
          "DELETE FROM voices WHERE groupId=? AND connectionId IN (SELECT id FROM connections WHERE userId=?)",
        ).run(groupId, userId);
        const heir = db
          .prepare(
            "SELECT userId FROM memberships WHERE groupId=? ORDER BY rowid LIMIT 1",
          )
          .get(groupId)?.userId;
        db.prepare(
          "UPDATE group_controls SET ownerId=?,revision=revision+1 WHERE groupId=?",
        ).run(
          control.ownerId === userId ? (heir ?? null) : control.ownerId,
          groupId,
        );
        // With nobody left, the old invite link must stop working.
        if (!heir)
          db.prepare("UPDATE groups SET inviteCode=? WHERE id=?").run(
            randomBytes(18).toString("base64url"),
            groupId,
          );
        db.prepare(
          "INSERT INTO group_departures VALUES (?,?,'left',?) ON CONFLICT(groupId,userId) DO UPDATE SET access='left',revision=excluded.revision",
        ).run(groupId, userId, control.revision + 1);
      }
      db.prepare("DELETE FROM message_reactions WHERE userId=?").run(userId);
      db.prepare("DELETE FROM read_marks WHERE userId=?").run(userId);
      db.prepare("DELETE FROM recovery_codes WHERE userId=?").run(userId);
      db.prepare("DELETE FROM avatar_images WHERE userId=?").run(userId);
      db.prepare(
        "UPDATE avatar_slots SET id=NULL,revision=revision+1 WHERE kind='user' AND targetId=?",
      ).run(userId);
      db.prepare("UPDATE users SET name='Deleted person',status='' WHERE id=?").run(
        userId,
      );
    });
    for (const row of tokens) revokeSession(row.tokenHash);
    for (const groupId of groups) {
      changedGroup(groupId);
      broadcastVoice(groupId);
    }
    return { ok: true };
  }
  function unbanUser(userId) {
    db.prepare("DELETE FROM bans WHERE userId=?").run(userId);
    return {
      ok: true,
      note: "They need a fresh sign-in; their old devices stay signed out.",
    };
  }
  const isBanned = (userId) =>
    Boolean(db.prepare("SELECT 1 FROM bans WHERE userId=?").get(userId));

  async function removeGroup(groupId) {
    const group = db
      .prepare("SELECT id,name FROM groups WHERE id=?")
      .get(groupId);
    if (!group) throw problem(404, "That chat was not found.");
    const members = db
      .prepare("SELECT userId FROM memberships WHERE groupId=?")
      .all(groupId)
      .map((r) => r.userId);
    const files = await removeFiles(
      db
        .prepare(
          "SELECT key FROM media_uploads WHERE groupId=? AND state<>'cancelled'",
        )
        .all(groupId),
    );
    const now = Date.now();
    let revision;
    db.transaction(() => {
      const ids = db
        .prepare(
          "SELECT id FROM messages WHERE groupId=? AND deletedAt IS NULL",
        )
        .all(groupId);
      for (const { id } of ids) {
        db.prepare("UPDATE messages SET body='',deletedAt=? WHERE id=?").run(
          now,
          id,
        );
        db.prepare("DELETE FROM message_reactions WHERE messageId=?").run(id);
        db.prepare(
          "INSERT INTO message_changes(messageId,groupId,createdAt,kind) VALUES (?,?,?,'delete')",
        ).run(id, groupId, now);
      }
      db.prepare("DELETE FROM memberships WHERE groupId=?").run(groupId);
      db.prepare("DELETE FROM voices WHERE groupId=?").run(groupId);
      db.prepare(
        "UPDATE groups SET name='Removed chat',inviteCode=? WHERE id=?",
      ).run(randomBytes(18).toString("base64url"), groupId);
      db.prepare(
        "UPDATE group_controls SET ownerId=NULL,revision=revision+1 WHERE groupId=?",
      ).run(groupId);
      revision = db
        .prepare("SELECT revision FROM group_controls WHERE groupId=?")
        .get(groupId).revision;
      for (const userId of members)
        db.prepare(
          "INSERT INTO group_departures VALUES (?,?,?,?) ON CONFLICT(groupId,userId) DO UPDATE SET access=excluded.access,revision=excluded.revision",
        ).run(groupId, userId, "removed", revision);
    });
    for (const userId of members)
      for (const c of db
        .prepare("SELECT id FROM connections WHERE userId=?")
        .all(userId)) {
        events.connection?.(c.id, "group-access", {
          groupId,
          access: "removed",
          controlRevision: revision,
          userId,
        });
        events.connection?.(c.id, "membership-state", stateFor(userId));
      }
    return { ok: true, members: members.length, filesRemoved: files };
  }

  return {
    limits,
    setLimits,
    log,
    pruneLog,
    isBlocked,
    isBanned,
    admitSignup,
    admitGroup,
    admitUpload,
    relayAllowed,
    report,
    publicReport,
    listReports,
    resolveReport,
    removeFile,
    removeMessage,
    banUser,
    deleteAccount,
    unbanUser,
    removeGroup,
  };
}
