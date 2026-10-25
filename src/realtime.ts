import { api } from "./api";
import type { Session } from "./types";
type Handler = (data?: any) => void;

export class RealtimeClient {
  connectionId = "";
  connected = false;
  private handlers = new Map<string, Set<Handler>>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private epoch = 0;
  private lastPong = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private welcomeTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private session: Session;
  constructor(session: Session) {
    this.session = session;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    void this.connect();
  }
  private wake = () => {
    if (this.stopped || document.visibilityState === "hidden") return;
    if (!this.connected || Date.now() - this.lastPong > 45_000) {
      this.reconnect();
    }
  };
  reconnect() {
    if (this.stopped) return;
    this.release();
    clearTimeout(this.reconnectTimer);
    this.dispatch("disconnect");
    void this.connect();
  }
  on(event: string, callback: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(callback);
    return this;
  }
  off(event: string, callback: Handler) {
    this.handlers.get(event)?.delete(callback);
    return this;
  }
  private dispatch(event: string, data?: unknown) {
    for (const callback of this.handlers.get(event) ?? []) callback(data);
  }
  private release() {
    this.epoch++;
    this.connected = false;
    this.connectionId = "";
    clearTimeout(this.welcomeTimer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection interrupted."));
    }
    this.pending.clear();
  }
  private fail() {
    this.release();
    this.dispatch("disconnect");
    this.scheduleReconnect();
  }
  private async connect() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    try {
      const { ticket } = await api<{ ticket: string }>(
        this.session,
        "/api/realtime-ticket",
        { method: "POST" },
      );
      if (this.stopped || epoch !== this.epoch) return;
      const url = new URL("/realtime", this.session.server);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      const ws = new WebSocket(url);
      this.ws = ws;
      this.welcomeTimer = setTimeout(() => {
        if (epoch === this.epoch) this.fail();
      }, 12_000);
      ws.onmessage = (event) => {
        if (epoch !== this.epoch || this.stopped) return;
        if (event.data === "pong") {
          this.lastPong = Date.now();
          return;
        }
        let packet;
        try {
          packet = JSON.parse(event.data);
          if (!packet || typeof packet.event !== "string") throw new Error();
        } catch {
          this.fail();
          return;
        }
        if (packet.event === "state") {
          if (this.connected || typeof packet.data?.connectionId !== "string") {
            this.fail();
            return;
          }
          clearTimeout(this.welcomeTimer);
          this.connectionId = packet.data.connectionId;
          this.connected = true;
          this.lastPong = Date.now();
          this.retry = 0;
          this.dispatch("state", packet.data);
          this.dispatch("connect");
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong > 45_000) this.fail();
            else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
          }, 20_000);
          return;
        }
        if (packet.event === "reply") {
          const pending = this.pending.get(packet.data?.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(packet.data.requestId);
            packet.data.error
              ? pending.reject(new Error(packet.data.error))
              : pending.resolve(packet.data.result);
          }
        } else this.dispatch(packet.event, packet.data);
      };
      ws.onclose = (event) => {
        if (epoch !== this.epoch || this.stopped) return;
        if (event?.code === 4001) {
          this.dispatch("disconnect");
          this.disconnect();
          window.dispatchEvent(
            new CustomEvent("gather:session-expired", {
              detail: { token: this.session.token },
            }),
          );
          return;
        }
        this.fail();
      };
      ws.onerror = () => {
        if (epoch === this.epoch) this.fail();
      };
    } catch {
      if (epoch !== this.epoch || this.stopped) return;
      this.dispatch("connect_error");
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => void this.connect(),
      Math.min(500 * 2 ** Math.min(this.retry++, 5), 5000) +
        Math.random() * 250,
    );
  }
  request<T = any>(event: string, data: unknown = {}): Promise<T> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("Your connection is recovering. Try again in a moment."),
      );
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The server took too long to respond."));
      }, 10000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ event, data, requestId }));
      } catch {
        this.fail();
      }
    });
  }
  emit(event: string, data: unknown = {}) {
    void this.request(event, data).catch(() => {});
  }
  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.release();
    this.handlers.clear();
  }
}
