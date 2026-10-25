import { config } from "dotenv";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { encryptSnapshot, decryptSnapshot } from "./backup-crypto.mjs";
import { restoreDatabase } from "../server/restore.mjs";

config({ quiet: true });
const server = new URL(
  process.argv[2] ||
    process.env.PUBLIC_URL ||
    "https://gather-friends.max-jacob-hastings.workers.dev",
);
if (
  (server.protocol !== "https:" &&
    !(
      server.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(server.hostname)
    )) ||
  server.username ||
  server.password ||
  server.pathname !== "/" ||
  server.search ||
  server.hash
)
  throw new Error(
    "Use an HTTPS server origin, or local loopback for a restore drill.",
  );
if (!process.env.GATHER_ADMIN_TOKEN)
  throw new Error("Set GATHER_ADMIN_TOKEN before backing up.");
const response = await fetch(new URL("/api/admin/snapshot", server), {
  headers: { Authorization: `Bearer ${process.env.GATHER_ADMIN_TOKEN}` },
  redirect: "error",
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok)
  throw new Error(
    `Snapshot request failed (${response.status}); no backup was saved.`,
  );
const snapshot = await response.json();
const bytes = encryptSnapshot(snapshot, process.env.GATHER_BACKUP_KEY);
// Every backup must be decryptable and restorable before being marked valid.
const restored = restoreDatabase(
  decryptSnapshot(bytes, process.env.GATHER_BACKUP_KEY),
);
restored.close();
const directory = resolve(process.env.GATHER_BACKUP_DIR || ".gather-backups");
await mkdir(directory, { recursive: true });
const name = `gather-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.gather-backup`;
const temporary = join(directory, `.${name}.tmp`);
const destination = join(directory, name);
await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
await rename(temporary, destination);
console.log(
  JSON.stringify({
    file: destination,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    restored: true,
    rows: Object.fromEntries(
      snapshot.tables.map((table) => [table.name, table.rows.length]),
    ),
  }),
);
