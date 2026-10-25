export function sqliteAdapter(sqlite) {
  return {
    prepare: (sql) => sqlite.prepare(sql),
    transaction: (fn) => {
      sqlite.exec("BEGIN");
      try {
        const result = fn();
        if (result && typeof result.then === "function")
          throw new Error("SQLite transactions must be synchronous.");
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
