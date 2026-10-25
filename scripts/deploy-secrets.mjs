import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
const values = parse(await readFile(new URL("../.env", import.meta.url)));
const secrets = Object.fromEntries(
  ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"].map((key) => [
    key,
    values[key]?.trim(),
  ]),
);
if (Object.values(secrets).some((value) => !value))
  throw new Error("Set both TURN values in .env first.");
if (values.GATHER_ADMIN_TOKEN?.trim())
  secrets.GATHER_ADMIN_TOKEN = values.GATHER_ADMIN_TOKEN.trim();
if (values.KLIPY_API_KEY?.trim())
  secrets.KLIPY_API_KEY = values.KLIPY_API_KEY.trim();
const child = spawn(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk"],
  { stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.end(JSON.stringify(secrets));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
