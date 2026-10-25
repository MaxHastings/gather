import { writeFile } from "node:fs/promises";
const serverUrl = process.argv[2];
if (!serverUrl || new URL(serverUrl).protocol !== "https:")
  throw new Error("Pass your deployed HTTPS server URL.");
await writeFile(
  "electron/config.json",
  JSON.stringify({ serverUrl: new URL(serverUrl).origin }, null, 2) + "\n",
);
console.log("Desktop default server configured.");
