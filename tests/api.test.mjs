import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeServer,
  parseInvite,
  readSession,
  request,
} from "../src/api.ts";

test("server and invite parsing accept supported addresses and reject unsafe or malformed URLs", () => {
  assert.equal(
    normalizeServer(" https://gather.example/ "),
    "https://gather.example",
  );
  assert.equal(
    normalizeServer("http://127.0.0.1:4318"),
    "http://127.0.0.1:4318",
  );
  for (const url of [
    "http://public.example",
    "https://user:password@gather.example",
    "https://gather.example/path",
    "file:///tmp/app",
    "https://gather.example?token=private",
  ])
    assert.throws(() => normalizeServer(url));
  assert.deepEqual(
    parseInvite("https://gather.example/join/abcdefghijklmnopqrstuvwx"),
    { code: "abcdefghijklmnopqrstuvwx", server: "https://gather.example" },
  );
  assert.throws(() => parseInvite("https://gather.example/wrong"));
});
test("malformed saved identities do not crash onboarding", () => {
  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify({
        token: "present",
        server: "https://gather.example",
        user: { id: "present" },
      }),
  };
  assert.equal(readSession(), null);
  delete globalThis.localStorage;
});
test("invalid server responses and network errors are actionable; expired responses identify only their own session", async (t) => {
  const original = globalThis.fetch;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.fetch = original;
    delete globalThis.window;
  });
  globalThis.fetch = async () => new Response("<html>wrong server</html>");
  await assert.rejects(
    request("https://gather.example", "/api/bootstrap"),
    /invalid response/,
  );
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  await assert.rejects(
    request("https://gather.example", "/api/bootstrap"),
    /Can’t reach/,
  );
  let expired;
  window.addEventListener("gather:session-expired", (event) => {
    expired = event.detail.token;
  });
  globalThis.fetch = async () =>
    Response.json({ error: "Expired" }, { status: 401 });
  await assert.rejects(
    request(
      "https://gather.example",
      "/api/bootstrap",
      {},
      "old-device-session",
    ),
    /Expired/,
  );
  assert.equal(expired, "old-device-session");
});
