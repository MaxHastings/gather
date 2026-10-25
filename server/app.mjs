import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createDomain, initializeSchema } from "./domain.mjs";
import { sqliteAdapter } from "./sqlite-adapter.mjs";
import { createObjectStorage } from "./object-storage.mjs";
import { createFileBucket } from "./file-bucket.mjs";
import { desktopTargets } from "./desktop-releases.mjs";
import { desktopDownload } from "./desktop-download.mjs";

export function createGatherServer(config = {}) {
  const dataDir = resolve(config.dataDir ?? process.env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new DatabaseSync(join(dataDir, "gather.sqlite"));
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  const db = sqliteAdapter(sqlite);
  try {
    initializeSchema(db);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  sqlite.exec("DELETE FROM voices; DELETE FROM connections;");
  const peers = new Map();
  let closing = false;
  const send = (socket, event, data) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ event, data }));
  };
  const domain = createDomain(
    db,
    config.env ?? process.env,
    {
      group: (id, event, data) => {
        for (const peer of peers.values()) {
          try {
            domain.member(id, peer.userId);
            send(peer.socket, event, data);
          } catch {}
        }
      },
      connection: (id, event, data) => {
        if (peers.has(id)) send(peers.get(id).socket, event, data);
      },
      close: (id) => peers.get(id)?.socket.close(4001, "Signed out"),
    },
    {
      fetch: config.fetch,
      objectStorage: createObjectStorage(
        db,
        config.bucket ?? createFileBucket(join(dataDir, "objects")),
        config.storageOptions,
      ),
    },
  );
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy ?? process.env.TRUST_PROXY === "1")
    app.set("trust proxy", 1);
  const publicUrl = config.publicUrl ?? process.env.PUBLIC_URL;
  const allowed = new Set([
    "app://gather",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    ...(publicUrl ? [new URL(publicUrl).origin] : []),
  ]);
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    const protocol = req.protocol || (req.socket.encrypted ? "https" : "http");
    return (
      !origin ||
      allowed.has(origin) ||
      origin === `${protocol}://${req.headers.host}`
    );
  };
  app.use((req, res, next) => {
    if (!originAllowed(req))
      return res.status(403).json({ error: "This app origin is not allowed." });
    next();
  });
  app.use(
    cors({
      origin: true,
      methods: ["GET", "HEAD", "POST", "PUT"],
      allowedHeaders: ["Content-Type", "Authorization", "Range"],
      exposedHeaders: ["Content-Range", "X-Checksum-SHA256"],
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    ["/api/sessions", "/api/recover"],
    rateLimit({
      windowMs: 15 * 60_000,
      limit: config.sessionLimit ?? 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: "Too many sign-ins. Wait a few minutes and try again.",
      },
    }),
  );
  app.use(
    "/api/invites",
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "A little too fast. Try again shortly." },
    }),
  );
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "A little too fast. Try again shortly." },
    }),
  );
  app.use("/api", async (req, res, next) => {
    try {
      if (
        /^\/api\/(?:(uploads|attachments|avatars)\/[^/]+|profile\/avatar|groups\/[^/]+\/avatar)\/content$/.test(
          req.originalUrl.split("?")[0],
        )
      ) {
        const response = await domain.mediaRequest(
          new Request(new URL(req.originalUrl, "http://local"), {
            method: req.method,
            headers: req.headers,
            ...(["GET", "HEAD"].includes(req.method)
              ? {}
              : { body: req, duplex: "half" }),
          }),
        );
        if (response) {
          res.status(response.status);
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
      }
      res.json(
        await domain.handle(
          req.method,
          req.originalUrl.split("?")[0],
          req.body ?? {},
          req.headers.authorization?.replace(/^Bearer /, ""),
          new URL(req.originalUrl, "http://local").searchParams,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  const dist = resolve(config.distDir ?? "./dist");
  if (existsSync(join(dist, "index.html"))) {
    const assets = {
      async fetch(input) {
        const pathname = new URL(input.url || input).pathname;
        if (
          !/^\/downloads\/(?:[a-z0-9-]+\/)?(?:manifest\.json|gather-[0-9.]+-\d+\.bin)$/.test(
            pathname,
          )
        )
          return new Response("Not found", { status: 404 });
        const filename = join(dist, pathname.slice(1));
        try {
          const info = await stat(filename);
          if (!info.isFile() || info.size > 16 * 1024 * 1024)
            return new Response("Not found", { status: 404 });
          return new Response(Readable.toWeb(createReadStream(filename)), {
            headers: {
              "Content-Type": pathname.endsWith(".json")
                ? "application/json"
                : "application/octet-stream",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    };
    const sendDownload = async (req, res, next, id, expectedFilename) => {
      try {
        const response = await desktopDownload(
          new Request(new URL(req.originalUrl, "http://gather.local"), {
            method: req.method,
          }),
          assets,
          expectedFilename,
          id,
        );
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) {
          res.end();
          return;
        }
        const body = Readable.fromWeb(response.body);
        res.once("close", () => body.destroy());
        body.once("error", (error) => res.destroy(error));
        body.pipe(res);
      } catch (error) {
        next(error);
      }
    };
    app.all("/download/:target", (req, res, next) => {
      const id =
        req.params.target === "windows" ? "windows-x64" : req.params.target;
      if (!desktopTargets[id]) {
        res.status(404).end();
        return;
      }
      void sendDownload(req, res, next, id);
    });
    app.all("/updates/:filename", (req, res, next) => {
      if (req.params.filename === "latest.yml") {
        res.setHeader("Cache-Control", "no-store");
        next();
        return;
      }
      if (
        !/^Gather-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-Setup\.exe$/.test(
          req.params.filename,
        )
      ) {
        res.status(404).end();
        return;
      }
      void sendDownload(req, res, next, "windows-x64", req.params.filename);
    });
    app.use(express.static(dist, { index: false }));
    app.get(["/", "/join/:code"], (_req, res) =>
      res.sendFile(join(dist, "index.html")),
    );
  }
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({
      error: error.status
        ? error.message
        : "The server couldn’t finish that request. Please try again.",
    }),
  );
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_000 });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://local");
    if (url.pathname !== "/realtime" || !originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const user = domain.claimTicket(url.searchParams.get("ticket"));
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = randomUUID();
      peers.set(id, { socket: ws, userId: user.id });
      send(ws, "state", domain.realtimeOpen(id, user));
      let windowStart = Date.now(),
        count = 0,
        alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        else {
          alive = false;
          ws.ping();
        }
      }, 30_000);
      ws.on("message", (raw) => {
        if (raw.toString() === "ping") {
          ws.send("pong");
          return;
        }
        if (Date.now() - windowStart > 60_000) {
          count = 0;
          windowStart = Date.now();
        }
        if (++count > 600) {
          ws.close(1008, "Rate limit");
          return;
        }
        let packet;
        try {
          packet = JSON.parse(raw.toString());
          const result = domain.realtimeMessage(id, packet.event, packet.data);
          if (packet.requestId)
            send(ws, "reply", { requestId: packet.requestId, result });
        } catch (error) {
          send(ws, "reply", {
            requestId: packet?.requestId,
            error: error.status ? error.message : "Realtime action failed.",
          });
        }
      });
      ws.on("close", () => {
        clearInterval(heartbeat);
        peers.delete(id);
        if (!closing) domain.realtimeClose(id);
      });
      ws.on("error", () => {});
    });
  });
  // Retention sweep for the self-hosted server; Cloudflare uses a DO alarm.
  const sweep = setInterval(
    () => domain.expireFiles().catch(() => {}),
    3_600_000,
  );
  sweep.unref();
  return {
    app,
    http,
    db: sqlite,
    domain,
    listen: (
      port = Number(process.env.PORT ?? 4318),
      host = process.env.HOST ?? "127.0.0.1",
    ) =>
      new Promise((yes, no) => {
        http.once("error", no);
        http.listen(port, host, () => {
          http.off("error", no);
          yes(http.address());
        });
      }),
    close: () =>
      new Promise((done) => {
        closing = true;
        clearInterval(sweep);
        for (const peer of peers.values()) peer.socket.terminate();
        wss.close();
        if (!http.listening) {
          sqlite.close();
          done();
        } else
          http.close(() => {
            sqlite.close();
            done();
          });
      }),
  };
}
