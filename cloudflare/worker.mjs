import { DurableObject } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { createDomain, initializeSchema } from "../server/domain.mjs";
import { createObjectStorage } from "../server/object-storage.mjs";
import { desktopTargets } from "../server/desktop-releases.mjs";
import { desktopDownload } from "../server/desktop-download.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/download/windows")
      return desktopDownload(request, env.ASSETS);
    const desktop = url.pathname.match(/^\/download\/([a-z0-9-]+)$/)?.[1];
    if (desktop && desktopTargets[desktop] && desktop !== "windows-x64")
      return desktopDownload(request, env.ASSETS, undefined, desktop);
    if (
      /^\/updates\/Gather-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-Setup\.exe$/.test(
        url.pathname,
      )
    )
      return desktopDownload(
        request,
        env.ASSETS,
        url.pathname.split("/").at(-1),
      );
    if (url.pathname === "/updates/latest.yml") {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/realtime")
      return env.GATHER.getByName("private-friends-v1").fetch(request);
    if (url.pathname.startsWith("/join/"))
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return env.ASSETS.fetch(request);
  },
};

export class GatherRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    const sql = ctx.storage.sql;
    const db = {
      prepare: (statement) => ({
        all: (...args) => sql.exec(statement, ...args).toArray(),
        get: (...args) => sql.exec(statement, ...args).toArray()[0],
        run: (...args) => {
          sql.exec(statement, ...args);
        },
      }),
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.db = db;
    initializeSchema(db);
    this.objectStorage = createObjectStorage(db, env.MEDIA);
    this.domain = createDomain(
      db,
      env,
      {
        group: (id, event, data) => {
          for (const socket of ctx.getWebSockets()) {
            try {
              this.domain.member(id, socket.deserializeAttachment().userId);
              this.send(socket, event, data);
            } catch {}
          }
        },
        connection: (id, event, data) => {
          for (const socket of ctx.getWebSockets(id))
            this.send(socket, event, data);
        },
        close: (id) => {
          for (const socket of ctx.getWebSockets(id))
            socket.close(4001, "Signed out");
        },
      },
      { objectStorage: this.objectStorage },
    );
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    const alive = new Set(
      ctx.getWebSockets().map((socket) => socket.deserializeAttachment()?.id),
    );
    for (const row of db.prepare("SELECT id FROM connections").all())
      if (!alive.has(row.id)) this.domain.realtimeClose(row.id);
  }
  send(socket, event, data) {
    try {
      socket.send(JSON.stringify({ event, data }));
    } catch {}
  }
  headers(request) {
    const origin = request.headers.get("Origin");
    const ownOrigin = new URL(request.url).origin;
    const allowed = [
      "app://gather",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      ownOrigin,
    ];
    return {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(origin && allowed.includes(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {}),
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
      "Access-Control-Expose-Headers": "Content-Range, X-Checksum-SHA256",
    };
  }
  limited(key, limit) {
    const slot = Math.floor(Date.now() / 60_000);
    this.db.prepare("DELETE FROM request_limits WHERE slot<?").run(slot - 1);
    this.db
      .prepare(
        "INSERT INTO request_limits VALUES (?,?,1) ON CONFLICT(key,slot) DO UPDATE SET count=count+1",
      )
      .run(key, slot);
    return (
      this.db
        .prepare("SELECT count FROM request_limits WHERE key=? AND slot=?")
        .get(key, slot).count > limit
    );
  }
  async fetch(request) {
    const headers = this.headers(request);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS request_limits (key TEXT NOT NULL, slot INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(key,slot))",
    );
    // Guarantee the retention sweep has an alarm even in a room with no sockets.
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const origin = request.headers.get("Origin");
      if (origin && !headers["Access-Control-Allow-Origin"])
        return json({ error: "This app origin is not allowed." }, 403);
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (this.limited(`ip:${ip}`, 600))
        return json({ error: "A little too fast. Try again shortly." }, 429);
      if (url.pathname === "/realtime") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "A WebSocket upgrade is required." }, 426);
        const user = this.domain.claimTicket(url.searchParams.get("ticket"));
        if (!user) return json({ error: "Sign-in expired." }, 401);
        const pair = new WebSocketPair();
        const id = randomUUID();
        pair[1].serializeAttachment({
          id,
          userId: user.id,
          openedAt: Date.now(),
          window: Date.now(),
          count: 0,
        });
        this.ctx.acceptWebSocket(pair[1], [id]);
        this.send(pair[1], "state", this.domain.realtimeOpen(id, user));
        if (!(await this.ctx.storage.getAlarm()))
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (
        ["/api/sessions", "/api/recover"].includes(url.pathname) &&
        this.limited(`sessions:${ip}`, 10)
      )
        return json(
          { error: "Too many sign-ins. Wait a minute before trying again." },
          429,
        );
      if (
        url.pathname.startsWith("/api/invites/") &&
        this.limited(`invites:${ip}`, 30)
      )
        return json({ error: "A little too fast. Try again shortly." }, 429);
      let body = {};
      const mediaResponse = await this.domain.mediaRequest(request);
      if (mediaResponse) {
        const combined = new Headers(headers);
        mediaResponse.headers.forEach((value, key) => combined.set(key, value));
        return new Response(mediaResponse.body, {
          status: mediaResponse.status,
          headers: combined,
        });
      }
      if (request.method === "POST") {
        const text = await request.text();
        if (text.length > 32000)
          return json({ error: "This request is too large." }, 413);
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          return json({ error: "Invalid JSON." }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json({ error: "An object is required." }, 400);
      }
      return json(
        await this.domain.handle(
          request.method,
          url.pathname,
          body,
          request.headers.get("Authorization")?.replace(/^Bearer /, ""),
          url.searchParams,
        ),
      );
    } catch (error) {
      return json(
        {
          error: error.status
            ? error.message
            : "The server couldn’t finish that request. Please try again.",
        },
        error.status || 500,
      );
    }
  }
  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    let packet;
    try {
      if (typeof message !== "string" || message.length > 32000) {
        socket.close(1009, "Message too large");
        return;
      }
      if (message === "ping") {
        socket.send("pong");
        return;
      }
      if (Date.now() - attachment.window > 60000) {
        attachment.window = Date.now();
        attachment.count = 0;
      }
      if (++attachment.count > 600) {
        socket.close(1008, "Rate limit");
        return;
      }
      socket.serializeAttachment(attachment);
      packet = JSON.parse(message);
      const result = this.domain.realtimeMessage(
        attachment.id,
        packet.event,
        packet.data,
      );
      if (packet.requestId)
        this.send(socket, "reply", { requestId: packet.requestId, result });
    } catch (error) {
      this.send(socket, "reply", {
        requestId: packet?.requestId,
        error: error.status ? error.message : "Realtime action failed.",
      });
    }
  }
  async alarm() {
    let live = false;
    // Daily-ish retention sweep, run from whatever alarm fires. Idle rooms
    // wake only for this; see schedule below.
    let more = false;
    if (Date.now() - (this.lastSweep || 0) > 3_600_000 || this.sweepMore) {
      this.lastSweep = Date.now();
      try {
        more = (await this.domain.expireFiles()).more;
      } catch {}
      this.sweepMore = more;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      const lastPing = this.ctx
        .getWebSocketAutoResponseTimestamp(socket)
        ?.getTime();
      const lastSeen = Math.max(
        lastPing || 0,
        attachment.openedAt || attachment.window || 0,
      );
      if (socket.readyState !== 1 || Date.now() - lastSeen > 120_000) {
        this.domain.realtimeClose(attachment.id);
        try {
          socket.close(4000, "Connection timed out");
        } catch {}
      } else live = true;
    }
    // Live rooms tick every 30 s; idle ones wake every 6 h just to expire files.
    await this.ctx.storage.setAlarm(
      Date.now() + (live ? 30_000 : more ? 60_000 : 21_600_000),
    );
  }
  webSocketClose(socket) {
    this.domain.realtimeClose(socket.deserializeAttachment().id);
    try {
      socket.close(1000, "Closed");
    } catch {}
  }
  webSocketError(socket) {
    this.domain.realtimeClose(socket.deserializeAttachment().id);
    try {
      socket.close(1011, "Connection interrupted");
    } catch {}
  }
}
