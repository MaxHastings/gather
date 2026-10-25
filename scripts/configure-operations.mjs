import { readFile, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
const path = new URL("../.env", import.meta.url);
const text = await readFile(path, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const values = parse(text);
const additions = [];
if (!values.GATHER_ADMIN_TOKEN)
  additions.push(`GATHER_ADMIN_TOKEN=${randomBytes(32).toString("base64url")}`);
if (!values.GATHER_BACKUP_KEY)
  additions.push(`GATHER_BACKUP_KEY=${randomBytes(32).toString("hex")}`);
if (additions.length)
  await appendFile(path, `\n${additions.join("\n")}\n`, { mode: 0o600 });
console.log(
  "Operational secrets configured in ignored .env; values were not displayed. Back up this file in your password manager.",
);
