import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import { encryptSnapshot, decryptSnapshot } from "./backup-crypto.mjs";
const { signManifest, verifyManifest } = createRequire(import.meta.url)(
  "../electron/update-signature.cjs",
);
const values = dotenv.parse(await readFile(".env"));
const trust = JSON.parse(await readFile("electron/update-trust.json", "utf8"));
const proof = {
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
const signed = signManifest(proof, values.GATHER_UPDATE_SIGNING_KEY);
verifyManifest(signed, trust, "0.0.0");
const payload = {
  format: "gather-release-key-v1",
  keyId: signed.gatherKeyId,
  privateKey: values.GATHER_UPDATE_SIGNING_KEY,
  trust,
};
const bytes = encryptSnapshot(payload, values.GATHER_BACKUP_KEY);
const restored = decryptSnapshot(bytes, values.GATHER_BACKUP_KEY);
verifyManifest(
  signManifest(proof, restored.privateKey),
  restored.trust,
  "0.0.0",
);
const directory = resolve(".gather-backups");
await mkdir(directory, { recursive: true });
const filename = join(
  directory,
  `gather-update-key-${new Date().toISOString().replace(/[:.]/g, "-")}.gather-backup`,
);
await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    file: filename,
    encrypted: true,
    signingRestoreVerified: true,
  }),
);
