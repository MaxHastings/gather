import { readFile, appendFile, writeFile } from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import dotenv from "dotenv";
const filename = new URL("../.env", import.meta.url);
const source = await readFile(filename, "utf8");
let encoded = dotenv.parse(source).GATHER_UPDATE_SIGNING_KEY;
if (!encoded) {
  encoded = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "der" })
    .toString("base64");
  await appendFile(
    filename,
    `${source.endsWith("\n") ? "" : "\n"}GATHER_UPDATE_SIGNING_KEY=${encoded}\n`,
  );
}
const key = createPrivateKey({
  key: Buffer.from(encoded, "base64"),
  type: "pkcs8",
  format: "der",
});
if (key.asymmetricKeyType !== "ed25519")
  throw new Error("Gather update key must be Ed25519.");
const publicKey = createPublicKey(key)
  .export({ type: "spki", format: "pem" })
  .toString();
const id = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
const trustPath = new URL("../electron/update-trust.json", import.meta.url);
let trust;
try {
  trust = JSON.parse(await readFile(trustPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (
  trust &&
  !trust.keys?.some((entry) => entry.id === id && entry.publicKey === publicKey)
)
  throw new Error(
    "Existing trust does not match this key; use an explicit key-rotation release.",
  );
if (!trust)
  await writeFile(
    trustPath,
    JSON.stringify(
      { format: "gather-update-trust-v1", keys: [{ id, publicKey }] },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
console.log(
  "Gather update signing key is ready in .env; only its public verification key is bundled. No private key was printed.",
);
