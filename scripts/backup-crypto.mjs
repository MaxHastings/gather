import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
const header = Buffer.from("GATHERBK1");
function keyBytes(key) {
  if (!/^[a-f0-9]{64}$/i.test(key || ""))
    throw new Error("GATHER_BACKUP_KEY must be a 32-byte hexadecimal key.");
  return Buffer.from(key, "hex");
}
export function encryptSnapshot(snapshot, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}
export function decryptSnapshot(bytes, key) {
  if (bytes.length < 38 || !bytes.subarray(0, 9).equals(header))
    throw new Error("Unsupported encrypted backup.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(key),
    bytes.subarray(9, 21),
  );
  cipher.setAAD(header);
  cipher.setAuthTag(bytes.subarray(21, 37));
  return JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(37)), cipher.final()]).toString(
      "utf8",
    ),
  );
}
