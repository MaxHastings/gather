import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { decryptSnapshot } from "./backup-crypto.mjs";
import { restoreDatabase } from "../server/restore.mjs";
import { createRequire } from "node:module";
config({ quiet: true });
const source = process.argv[2];
if (!source) throw new Error("Pass the encrypted backup path to publish.");
const bytes = await readFile(resolve(source));
const payload = decryptSnapshot(bytes, process.env.GATHER_BACKUP_KEY);
const releaseKey = payload.format === "gather-release-key-v1";
if (releaseKey) {
  const { signManifest, verifyManifest } = createRequire(import.meta.url)(
    "../electron/update-signature.cjs",
  );
  const info = {
    version: "0.0.1",
    releaseDate: "2026-10-24T00:00:00.000Z",
    files: [
      {
        url: "Gather-0.0.1-Setup.exe",
        size: 1,
        sha512: Buffer.alloc(64).toString("base64"),
      },
    ],
  };
  const signed = signManifest(info, payload.privateKey);
  const trusted = JSON.parse(
    await readFile(
      new URL("../electron/update-trust.json", import.meta.url),
      "utf8",
    ),
  );
  if (signed.gatherKeyId !== payload.keyId)
    throw new Error("Release-key backup does not match its identifier.");
  verifyManifest(signed, trusted, "0.0.0");
} else {
  const db = restoreDatabase(payload);
  db.close();
}
async function gh(args, body, raw = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    let errors = "";
    child.stdout.on("data", (data) => {
      output.push(data);
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(
            raw
              ? Buffer.concat(output)
              : JSON.parse(Buffer.concat(output).toString("utf8")),
          )
        : reject(
            new Error(
              `GitHub backup operation failed (${code}). ${errors.slice(0, 300)}`,
            ),
          ),
    );
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}
const repository = process.env.GATHER_BACKUP_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
  throw new Error(
    "Set GATHER_BACKUP_REPOSITORY to the separate private backup repository, as owner/name.",
  );
const metadata = await gh(["api", `repos/${repository}`]);
if (metadata.full_name !== repository || metadata.private !== true)
  throw new Error(
    "Backups can be published only to a verified private repository.",
  );
const branch = "codex/operational-backups";
const refs = await gh([
  "api",
  `repos/${repository}/git/matching-refs/heads/${branch}`,
]);
if (!refs.some((ref) => ref.ref === `refs/heads/${branch}`)) {
  const main = await gh(["api", `repos/${repository}/git/ref/heads/main`]);
  await gh(
    ["api", `repos/${repository}/git/refs`, "--method", "POST", "--input", "-"],
    { ref: `refs/heads/${branch}`, sha: main.object.sha },
  );
}
const filename = basename(source);
if (!/^gather-[a-zA-Z0-9-]+\.gather-backup$/.test(filename))
  throw new Error("Unsupported backup filename.");
const tree = await gh([
  "api",
  `repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
]);
if (tree.truncated)
  throw new Error("Backup listing was truncated; refusing an ambiguous retry.");
const existing = tree.tree.find(
  (entry) => entry.path === `backups/${filename}`,
);
const currentRef = existing
  ? await gh(["api", `repos/${repository}/git/ref/heads/${branch}`])
  : null;
const result = existing
  ? {
      content: {
        sha: existing.sha,
        html_url: `https://github.com/${repository}/blob/${branch}/backups/${filename}`,
      },
      commit: { sha: currentRef.object.sha },
    }
  : await gh(
      [
        "api",
        `repos/${repository}/contents/backups/${filename}`,
        "--method",
        "PUT",
        "--input",
        "-",
      ],
      {
        message: releaseKey
          ? "Store encrypted verified release signing key"
          : "Store encrypted verified operational snapshot",
        branch,
        content: bytes.toString("base64"),
      },
    );
// Read the binary Git blob rather than reinterpreting a contents-API JSON field.
// Raw Buffer output preserves every encrypted byte, including invalid UTF-8.
const uploaded = await gh(
  [
    "api",
    `repos/${repository}/git/blobs/${result.content.sha}`,
    "-H",
    "Accept: application/vnd.github.raw+json",
  ],
  undefined,
  true,
);
if (!bytes.equals(uploaded))
  throw new Error(
    "Independent backup verification failed: remote bytes differ.",
  );
console.log(
  JSON.stringify({
    private: true,
    branch,
    url: result.content.html_url,
    commit: result.commit.sha,
    encrypted: true,
    restoreVerified: true,
    kind: releaseKey ? "release-signing-key" : "database-snapshot",
  }),
);
