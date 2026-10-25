// Logical snapshots use only application tables. Transport state is rebuilt.
const transient = new Set([
  "tickets",
  "connections",
  "voices",
  "request_limits",
  "daily_limits",
  // Short-lived IP log for abuse follow-up; kept out of backups on purpose.
  "activity_log",
]);
const identifier = (name) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
    throw new Error("Unsupported snapshot table or column name.");
  return `"${name}"`;
};
// Derived tables added without a numbered migration. Backups taken before they
// existed are still restorable; the table simply starts empty.
const optionalTables = new Set(["media_fetches"]);
function tables(db) {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
      // Underscore-prefixed names belong to hosting infrastructure. Application
      // migrations must keep durable table names outside that reserved namespace.
      .filter(
        (name) =>
          !name.startsWith("sqlite_") &&
          !name.startsWith("_") &&
          !transient.has(name),
      )
  );
}
const columns = (db, name) =>
  db
    .prepare(`PRAGMA table_info(${identifier(name)})`)
    .all()
    .map((column) => column.name);

export function captureSnapshot(db) {
  let result;
  db.transaction(() => {
    let bytes = 0;
    result = {
      format: "gather-server-snapshot-v1",
      exportedAt: new Date().toISOString(),
      tables: tables(db).map((name) => {
        const count = db
          .prepare(`SELECT COUNT(*) AS count FROM ${identifier(name)}`)
          .get().count;
        if (count > 100000)
          throw new Error(
            "Snapshot requires a paged export for this database size.",
          );
        const rows = db.prepare(`SELECT * FROM ${identifier(name)}`).all();
        bytes += Buffer.byteLength(JSON.stringify(rows));
        if (bytes > 16 * 1024 * 1024)
          throw new Error(
            "Snapshot requires a paged export for this database size.",
          );
        return { name, columns: columns(db, name), rows };
      }),
      sequences: db.prepare("SELECT name,seq FROM sqlite_sequence").all(),
    };
  });
  return result;
}

// Restore is deliberately offline and empty-target-only. Never execute SQL
// supplied by a backup, even when that backup was authenticated/encrypted.
export function restoreSnapshot(db, snapshot) {
  if (
    snapshot?.format !== "gather-server-snapshot-v1" ||
    !Array.isArray(snapshot.tables) ||
    !Array.isArray(snapshot.sequences)
  )
    throw new Error("Unsupported snapshot format.");
  const expected = tables(db);
  const supplied = snapshot.tables.map((table) => table.name);
  const required = (names) => names.filter((name) => !optionalTables.has(name));
  if (
    new Set(supplied).size !== supplied.length ||
    supplied.some(
      (name) => optionalTables.has(name) && !expected.includes(name),
    ) ||
    JSON.stringify(required([...supplied].sort())) !==
      JSON.stringify(required(expected))
  )
    throw new Error("Snapshot schema does not match this server version.");
  for (const name of expected.filter(
    (value) => value !== "schema_versions" && value !== "server_state",
  ))
    if (
      db.prepare(`SELECT COUNT(*) AS count FROM ${identifier(name)}`).get()
        .count
    )
      throw new Error("Restore requires an empty destination database.");
  const definitions = new Map();
  for (const table of snapshot.tables) {
    const fields = columns(db, table.name);
    if (
      JSON.stringify(table.columns) !== JSON.stringify(fields) ||
      !Array.isArray(table.rows)
    )
      throw new Error("Snapshot columns do not match this server version.");
    for (const row of table.rows)
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== fields.length ||
        fields.some(
          (field) =>
            !Object.hasOwn(row, field) ||
            (row[field] !== null &&
              typeof row[field] !== "string" &&
              (typeof row[field] !== "number" ||
                !Number.isSafeInteger(row[field]))),
        )
      )
        throw new Error("Snapshot contains an invalid row.");
    definitions.set(table.name, fields);
  }
  const versions = snapshot.tables.find(
    (table) => table.name === "schema_versions",
  ).rows;
  if (
    JSON.stringify(versions.map((row) => row.version).sort((a, b) => a - b)) !==
    JSON.stringify(
      db
        .prepare("SELECT version FROM schema_versions ORDER BY version")
        .all()
        .map((row) => row.version),
    )
  )
    throw new Error("Snapshot schema version is unsupported.");
  for (const row of snapshot.sequences)
    if (
      !expected.includes(row.name) ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 0
    )
      throw new Error("Snapshot contains an invalid sequence.");
  // The local SQLite adapter enables deferred foreign keys for this transaction
  // so table insertion order cannot change referential integrity guarantees.
  db.transaction(() => {
    db.prepare("PRAGMA defer_foreign_keys=ON").run();
    db.prepare("DELETE FROM schema_versions").run();
    if (expected.includes("server_state"))
      db.prepare("DELETE FROM server_state").run();
    for (const table of snapshot.tables) {
      const fields = definitions.get(table.name);
      const insert = db.prepare(
        `INSERT INTO ${identifier(table.name)} (${fields.map(identifier).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      );
      for (const row of table.rows)
        insert.run(...fields.map((field) => row[field]));
    }
    for (const row of snapshot.sequences) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name=?").run(row.name);
      db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)").run(
        row.name,
        row.seq,
      );
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Snapshot contains broken references.");
  });
}
