import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";

const source = stripTypeScriptTypes(
  (
    await readFile(new URL("../src/realtime.ts", import.meta.url), "utf8")
  ).replace(
    'import { api } from "./api";',
    "const api = globalThis.__realtimeApi;",
  ),
);
async function setup(t) {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    WebSocket: globalThis.WebSocket,
  };
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  globalThis.__realtimeApi = async () => ({ ticket: "temporary" });
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    receive(packet) {
      this.onmessage?.({
        data: typeof packet === "string" ? packet : JSON.stringify(packet),
      });
    }
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const { RealtimeClient } = await import(
    "data:text/javascript;base64," +
      Buffer.from(source + `\n// ${Math.random()}`).toString("base64")
  );
  const client = new RealtimeClient({
    server: "https://gather.example",
    token: "private",
    user: { id: "a", name: "Alice" },
  });
  await setImmediate();
  t.after(() => {
    client.disconnect();
    Object.assign(globalThis, originals);
    delete globalThis.__realtimeApi;
    t.mock.timers.reset();
  });
  const welcome = (socket = sockets.at(-1)) =>
    socket.receive({
      event: "state",
      data: { connectionId: "connection-" + sockets.length },
    });
  return { client, sockets, welcome };
}
test("a stalled websocket handshake reconnects even without an onclose callback", async (t) => {
  const { client, sockets, welcome } = await setup(t);
  t.mock.timers.tick(12001);
  assert.equal(sockets[0].readyState, 3);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(sockets.length, 2);
  welcome();
  assert.equal(client.connected, true);
});
test("missed heartbeats recover; stale socket events and malformed packets cannot corrupt the connection", async (t) => {
  const { client, sockets, welcome } = await setup(t);
  welcome();
  const stale = sockets[0].onmessage;
  t.mock.timers.tick(60001);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(sockets.length, 2);
  welcome();
  stale({
    data: JSON.stringify({ event: "state", data: { connectionId: "stale" } }),
  });
  assert.equal(client.connectionId, "connection-2");
  sockets.at(-1).receive("invalid json");
  assert.equal(client.connected, false);
});
test("requests time out and disconnect rejects pending work immediately; online wakes a disconnected client", async (t) => {
  const { client, sockets, welcome } = await setup(t);
  welcome();
  const request = assert.rejects(client.request("voice:join"), /too long/);
  t.mock.timers.tick(10001);
  await request;
  const pending = assert.rejects(client.request("voice:join"), /interrupted/);
  sockets[0].onerror();
  await pending;
  window.dispatchEvent(new Event("online"));
  await setImmediate();
  welcome();
  assert.equal(client.connected, true);
  const last = assert.rejects(client.request("signal"), /interrupted/);
  client.disconnect();
  await last;
  t.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(sockets.length, 2);
});
test("remote sign-out expires only its credential immediately and stops reconnecting", async (t) => {
  const { client, sockets, welcome } = await setup(t);
  welcome();
  const expired = [];
  window.addEventListener("gather:session-expired", (event) =>
    expired.push(event.detail.token),
  );
  const staleClose = sockets[0].onclose;
  sockets[0].onerror();
  window.dispatchEvent(new Event("online"));
  await setImmediate();
  welcome();
  staleClose({ code: 4001 });
  assert.deepEqual(expired, []);
  assert.equal(client.connected, true);
  sockets.at(-1).onclose({ code: 4001 });
  assert.deepEqual(expired, ["private"]);
  assert.equal(client.connected, false);
  t.mock.timers.tick(60000);
  window.dispatchEvent(new Event("online"));
  await setImmediate();
  assert.equal(sockets.length, 2);
});

test("explicit recovery rejects pending work, announces disconnection and ignores retired socket events", async (t) => {
  const { client, sockets, welcome } = await setup(t);
  welcome();
  let disconnected = 0;
  client.on("disconnect", () => disconnected++);
  const close = sockets[0].onclose;
  const pending = assert.rejects(client.request("signal"), /interrupted/);
  client.reconnect();
  await pending;
  await setImmediate();
  welcome();
  close({ code: 4001 });
  assert.equal(disconnected, 1);
  assert.equal(client.connected, true);
  client.disconnect();
  client.reconnect();
  await setImmediate();
  assert.equal(sockets.length, 2);
});
