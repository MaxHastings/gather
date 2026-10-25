import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../electron/session.mjs";
import { encryptSnapshot, decryptSnapshot } from "../scripts/backup-crypto.mjs";
import { loadSession } from "../src/api.ts";

const profile = () => ({
  server: "https://gather.example",
  token: randomBytes(32).toString("base64url"),
  user: { id: randomUUID(), name: "Original friend" },
});
function encryption() {
  const key = randomBytes(32).toString("hex");
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => encryptSnapshot({ text }, key),
    decryptStringAsync: async (bytes) => ({
      result: decryptSnapshot(bytes, key).text,
      shouldReEncrypt: false,
    }),
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gather-session-"));
  const filename = join(directory, "session.sqlite");
  const crypto = encryption();
  let store = createSessionStore(filename, crypto);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filename,
    crypto,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = createSessionStore(filename, crypto);
    },
  };
}
test("protected sessions survive restart, contain no plaintext token, and reject stale profile writes", async (t) => {
  const f = await fixture(t);
  const first = profile(),
    second = profile();
  assert.deepEqual(await f.store.read(), { initialized: false, session: null });
  await f.store.write(first, null);
  for (const suffix of ["", "-wal"]) {
    const bytes = await readFile(f.filename + suffix);
    assert.equal(bytes.includes(Buffer.from(first.token)), false);
    assert.equal(bytes.includes(Buffer.from(first.user.name)), false);
  }
  f.reopen();
  assert.deepEqual((await f.store.read()).session, first);
  await f.store.write(second, first.token);
  await assert.rejects(
    f.store.write(
      { ...first, user: { ...first.user, name: "Late rename" } },
      first.token,
    ),
    /profile changed/,
  );
  await assert.rejects(f.store.write(null, first.token), /profile changed/);
  assert.deepEqual((await f.store.read()).session, second);
  await f.store.write(null, second.token);
  await f.store.write(null, second.token); // lost sign-out response is retryable
  f.reopen();
  assert.deepEqual(await f.store.read(), { initialized: true, session: null });
  await assert.rejects(f.store.write(first, second.token), /profile changed/);
});
test("unavailable encryption and failed replacement preserve the existing credential", async (t) => {
  const f = await fixture(t),
    original = profile();
  await f.store.write(original, null);
  f.crypto.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(f.store.read(), /unavailable/);
  await assert.rejects(f.store.write(null, original.token), /unavailable/);
  f.crypto.isAsyncEncryptionAvailable = async () => true;
  const encrypt = f.crypto.encryptStringAsync;
  f.crypto.encryptStringAsync = async () => {
    throw new Error("Injected key store interruption");
  };
  await assert.rejects(f.store.write(profile(), original.token), /Injected/);
  f.crypto.encryptStringAsync = encrypt;
  assert.deepEqual((await f.store.read()).session, original);
  const decrypt = f.crypto.decryptStringAsync;
  f.crypto.decryptStringAsync = async () => {
    throw new Error("Wrong Windows account");
  };
  await assert.rejects(f.store.read(), /could not be unlocked/);
  f.crypto.decryptStringAsync = decrypt;
  assert.deepEqual((await f.store.read()).session, original);
});
test("legacy migration removes plaintext only after encrypted commit and never resurrects signed-out credentials", async (t) => {
  const f = await fixture(t),
    original = profile();
  let raw = JSON.stringify(original),
    fail = true;
  globalThis.localStorage = {
    getItem: () => raw,
    removeItem: () => {
      raw = null;
    },
  };
  globalThis.window = {
    desktop: {
      readSession: () => f.store.read(),
      writeSession: (value, expected) => {
        if (fail) return Promise.reject(new Error("Injected disk exhaustion"));
        return f.store.write(value, expected);
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
  });
  await assert.rejects(loadSession(), /Injected/);
  assert.equal(JSON.parse(raw).token, original.token);
  assert.equal((await f.store.read()).initialized, false);
  fail = false;
  const [a, b] = await Promise.all([loadSession(), loadSession()]);
  assert.deepEqual(a, original);
  assert.deepEqual(b, original);
  assert.equal(raw, null);
  await f.store.write(null, original.token);
  raw = JSON.stringify(original); // an old legacy copy must stay signed out
  assert.equal(await loadSession(), null);
  assert.equal(raw, null);
});

test("browser startup preserves unreadable profiles instead of silently starting another identity", async () => {
  const oldWindow = globalThis.window,
    oldStorage = globalThis.localStorage;
  try {
    globalThis.window = {};
    let raw = "{broken";
    globalThis.localStorage = { getItem: () => raw };
    await assert.rejects(loadSession(), /has been kept/);
    assert.equal(raw, "{broken");
    raw = JSON.stringify({ token: "incomplete" });
    await assert.rejects(loadSession(), /has been kept/);
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("Storage locked");
      },
    };
    await assert.rejects(loadSession(), /has been kept/);
    globalThis.localStorage = { getItem: () => null };
    assert.equal(await loadSession(), null);
  } finally {
    globalThis.window = oldWindow;
    globalThis.localStorage = oldStorage;
  }
});
