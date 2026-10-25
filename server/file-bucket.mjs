import { mkdir, readdir, readFile, stat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Standalone hosting uses the same immutable object contract as R2.
export function createFileBucket(directory) {
  const ready = mkdir(directory, { recursive: true });
  const filename = (key) => {
    if (!/^objects\/[a-f0-9-]{36}$/i.test(key))
      throw new Error("Invalid object key.");
    return join(directory, `${key.slice(8)}.bin`);
  };
  const missing = (error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  };
  return {
    async list({ cursor, limit = 1000 } = {}) {
      await ready;
      const names = (await readdir(directory))
        .filter((n) => /^[a-f0-9-]{36}\.bin$/i.test(n))
        .sort();
      const start = cursor ? names.findIndex((n) => n > cursor) : 0;
      const selected = start < 0 ? [] : names.slice(start, start + limit);
      return {
        objects: await Promise.all(
          selected.map(async (n) => ({
            key: `objects/${n.slice(0, -4)}`,
            size: (await stat(join(directory, n))).size,
          })),
        ),
        truncated: start >= 0 && start + selected.length < names.length,
        cursor: selected.at(-1),
      };
    },
    async put(key, bytes) {
      await ready;
      const file = await open(filename(key), "wx");
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      return { key };
    },
    async head(key) {
      const bytes = await readFile(filename(key)).catch(missing);
      return bytes
        ? {
            size: bytes.length,
            checksums: {
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          }
        : null;
    },
    async get(key) {
      const bytes = await readFile(filename(key)).catch(missing);
      return bytes
        ? { size: bytes.length, arrayBuffer: async () => bytes }
        : null;
    },
    async delete(key) {
      await unlink(filename(key)).catch(missing);
    },
  };
}
