import { DatabaseSync } from "node:sqlite";
import { validateSession } from "../server/session-contract.mjs";

// SQLite's FULL transaction durability protects atomic replacement, including
// a signed-out tombstone. The database and its journal contain ciphertext only.
export function createSessionStore(filename, encryption) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  const version = sqlite.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) {
    sqlite.close();
    throw new Error("This profile needs a newer Gather version.");
  }
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS credential (id INTEGER PRIMARY KEY CHECK(id=1),ciphertext BLOB NOT NULL); PRAGMA user_version=1;",
  );
  let chain = Promise.resolve();
  let closed = false;
  function serialize(work) {
    const result = chain.then(() => {
      if (closed) throw new Error("Profile storage is closed.");
      return work();
    });
    chain = result.catch(() => {});
    return result;
  }
  async function available() {
    if (
      !(await encryption.isAsyncEncryptionAvailable()) ||
      encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error(
        "Protected profile storage is unavailable. Unlock your system key store and try again.",
      );
  }
  async function persist(session) {
    await available();
    const ciphertext = await encryption.encryptStringAsync(
      JSON.stringify({ format: "gather-session-v1", session }),
    );
    if (closed) throw new Error("Profile storage is closed.");
    sqlite
      .prepare(
        "INSERT INTO credential VALUES (1,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext",
      )
      .run(ciphertext);
  }
  async function read() {
    const row = sqlite
      .prepare("SELECT ciphertext FROM credential WHERE id=1")
      .get();
    if (!row) return { initialized: false, session: null };
    await available();
    let decoded;
    try {
      decoded = await encryption.decryptStringAsync(
        Buffer.from(row.ciphertext),
      );
    } catch {
      throw new Error(
        "Your saved profile could not be unlocked. Unlock your system key store and try again using the same computer account.",
      );
    }
    let payload;
    try {
      payload = JSON.parse(decoded.result);
    } catch {
      throw new Error(
        "Your saved profile could not be read. Restore it with your recovery code.",
      );
    }
    if (payload?.format !== "gather-session-v1")
      throw new Error("This profile needs a newer Gather version.");
    const session = validateSession(payload.session);
    if (decoded.shouldReEncrypt) await persist(session);
    return { initialized: true, session };
  }
  return {
    read: () => serialize(read),
    write: (input, expectedToken) =>
      serialize(async () => {
        const session = validateSession(input);
        if (
          expectedToken !== null &&
          (typeof expectedToken !== "string" || expectedToken.length > 200)
        )
          throw new Error("Invalid profile update.");
        const current = await read();
        if (session === null && current.initialized && current.session === null)
          return null;
        if (
          (current.session?.token ?? null) !== expectedToken &&
          !(session === null && current.session === null)
        )
          throw new Error("Your profile changed. Reopen Gather and try again.");
        await persist(session);
        return session;
      }),
    close: () => {
      closed = true;
      sqlite.close();
    },
  };
}
