import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decryptSnapshot } from "./backup-crypto.mjs";
import { restoreDatabase } from "../server/restore.mjs";
config({ quiet: true });
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error(
    "Usage: node scripts/restore-backup.mjs <backup> <new-database-path>",
  );
const snapshot = decryptSnapshot(
  await readFile(resolve(source)),
  process.env.GATHER_BACKUP_KEY,
);
const db = restoreDatabase(snapshot, resolve(destination));
db.close();
console.log(
  "Restored and verified a new database. The source backup was unchanged.",
);
