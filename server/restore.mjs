import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync } from "node:fs";
import { initializeSchema, LATEST_SCHEMA_VERSION } from "./schema.mjs";
import { restoreSnapshot } from "./snapshot.mjs";
import { sqliteAdapter } from "./sqlite-adapter.mjs";

export function restoreDatabase(snapshot, destination = ":memory:") {
  if (destination !== ":memory:") closeSync(openSync(destination, "wx", 0o600));
  const sqlite = new DatabaseSync(destination);
  try {
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const versions = snapshot?.tables?.find(
      (table) => table.name === "schema_versions",
    )?.rows;
    if (
      !Array.isArray(versions) ||
      !versions.length ||
      versions.length > LATEST_SCHEMA_VERSION ||
      versions.some((row) => !Number.isInteger(row.version))
    )
      throw new Error("Snapshot schema version is unsupported.");
    initializeSchema(
      sqliteAdapter(sqlite),
      Math.max(...versions.map((row) => row.version)),
    );
    restoreSnapshot(sqliteAdapter(sqlite), snapshot);
    initializeSchema(sqliteAdapter(sqlite));
    sqlite
      .prepare(
        "UPDATE server_state SET value=lower(hex(randomblob(16))) WHERE key='generation'",
      )
      .run();
    if (sqlite.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Restored database failed integrity validation.");
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
