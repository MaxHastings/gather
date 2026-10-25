import { test } from "node:test";
import assert from "node:assert/strict";
import { joinVoice } from "../src/voiceProtocol.ts";
function client() {
  const events = new Map();
  let resolve, reject;
  return {
    connectionId: "self",
    events,
    request() {
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
    on(event, fn) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event).add(fn);
      return this;
    },
    off(event, fn) {
      events.get(event)?.delete(fn);
      return this;
    },
    emit(event, data) {
      for (const fn of events.get(event) || []) fn(data);
    },
    reply(value) {
      resolve(value);
    },
    error(value) {
      reject(value);
    },
  };
}
const snapshot = {
  groupId: "room",
  peers: [{ connectionId: "self", userId: "user", name: "Alice", muted: true }],
};
test("the authoritative roster confirms a voice join even if the RPC reply is lost", async () => {
  const c = client(),
    joined = joinVoice(c, "room", true);
  c.emit("voice", snapshot);
  assert.deepEqual(await joined, snapshot);
  c.error(new Error("The reply timed out"));
  assert.ok([...c.events.values()].every((listeners) => listeners.size === 0));
});
test("a direct reply confirms a join if the roster event is lost", async () => {
  const c = client(),
    joined = joinVoice(c, "room", true);
  c.emit("voice", { groupId: "other", peers: snapshot.peers });
  c.emit("voice", { groupId: "room", peers: [] });
  c.reply(snapshot);
  assert.deepEqual(await joined, snapshot);
  assert.ok([...c.events.values()].every((listeners) => listeners.size === 0));
});
test("disconnect and rejection clean up temporary voice listeners", async () => {
  const c = client(),
    joined = assert.rejects(joinVoice(c, "room", false), /interrupted/);
  c.emit("disconnect");
  await joined;
  c.error(new Error("late rejection"));
  assert.ok([...c.events.values()].every((listeners) => listeners.size === 0));
});
