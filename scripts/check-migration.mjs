// Compare an encrypted pre-deploy snapshot with the live post-migration state.
// Outputs counts only; no identities, credentials, message bodies or media keys.
import dotenv from "dotenv";
import { LATEST_SCHEMA_VERSION } from "../server/schema.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { decryptSnapshot } from "./backup-crypto.mjs";
dotenv.config({ quiet: true });
if (!process.argv[2])
  throw new Error("Pass the encrypted pre-deploy snapshot.");
const before = decryptSnapshot(
  await readFile(process.argv[2]),
  process.env.GATHER_BACKUP_KEY,
);
const base = "https://gather-friends.max-jacob-hastings.workers.dev";
const headers = { Authorization: `Bearer ${process.env.GATHER_ADMIN_TOKEN}` };
const response = await fetch(base + "/api/admin/snapshot", {
  headers,
  signal: AbortSignal.timeout(30000),
  redirect: "error",
});
assert.equal(response.status, 200);
const after = await response.json(),
  preserved = {};
let activityUpdatedDevices = 0;
for (const table of before.tables) {
  if (table.name === "schema_versions") continue;
  const current = after.tables.find((t) => t.name === table.name);
  assert.ok(current, `Missing durable table ${table.name}`);
  // Ordinary authorized requests update lastSeen while a live deployment is
  // verified. Preserve every stable field and require activity to move forward.
  if (table.name === "devices") {
    for (const row of table.rows) {
      const device = current.rows.find((candidate) =>
        table.columns
          .filter((c) => c !== "lastSeen")
          .every((c) => candidate[c] === row[c]),
      );
      assert.ok(device, "Baseline device identity or grant changed");
      assert.ok(
        device.lastSeen >= row.lastSeen,
        "Device activity moved backward",
      );
      if (device.lastSeen > row.lastSeen) activityUpdatedDevices++;
    }
    preserved[table.name] = table.rows.length;
    continue;
  }
  const rows = new Set(
    current.rows.map((row) => JSON.stringify(table.columns.map((c) => row[c]))),
  );
  assert.ok(
    table.rows.every((row) =>
      rows.has(JSON.stringify(table.columns.map((c) => row[c]))),
    ),
    `Baseline rows changed in ${table.name}`,
  );
  preserved[table.name] = table.rows.length;
}
assert.equal(
  Math.max(
    ...after.tables
      .find((t) => t.name === "schema_versions")
      .rows.map((r) => r.version),
  ),
  LATEST_SCHEMA_VERSION,
);
const usageResponse = await fetch(base + "/api/admin/storage", {
  headers,
  signal: AbortSignal.timeout(30000),
});
assert.equal(usageResponse.status, 200);
const usage = await usageResponse.json();
assert.equal(usage.limitBytes, 5_000_000_000);
assert.ok(usage.chargedBytes <= usage.limitBytes);
await mkdir("test-results", { recursive: true });
await writeFile(
  "test-results/production-migration.json",
  JSON.stringify(
    {
      schema: LATEST_SCHEMA_VERSION,
      preserved,
      activityUpdatedDevices,
      storageCeiling: usage.limitBytes,
      chargedBytes: usage.chargedBytes,
      completedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  `PASS: every pre-deploy durable row is preserved under schema ${LATEST_SCHEMA_VERSION}; private bucket accounting is within the 5 GB ceiling.`,
);
