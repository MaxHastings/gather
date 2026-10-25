const {
  createPublicKey,
  createPrivateKey,
  sign,
  verify,
  createHash,
} = require("node:crypto");
const { createReadStream } = require("node:fs");
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const MAX_INSTALLER_BYTES = 300_000_000;
function newerVersion(next, current) {
  if (!VERSION.test(next) || !VERSION.test(current)) return false;
  const a = next.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function signedPayload(info) {
  if (
    !info ||
    !VERSION.test(info.version) ||
    !Array.isArray(info.files) ||
    info.files.length !== 1 ||
    info.packages ||
    info.stagingPercentage !== undefined ||
    typeof info.gatherKeyId !== "string" ||
    !/^[a-f0-9]{16}$/.test(info.gatherKeyId) ||
    typeof info.releaseDate !== "string" ||
    !Number.isFinite(Date.parse(info.releaseDate))
  )
    throw new Error("Invalid Gather update manifest.");
  const file = info.files[0];
  if (
    file.url !== `Gather-${info.version}-Setup.exe` ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_INSTALLER_BYTES ||
    typeof file.sha512 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
    (info.path !== undefined && info.path !== file.url) ||
    (info.sha512 !== undefined && info.sha512 !== file.sha512) ||
    file.isAdminRightsRequired ||
    file.blockMapSize ||
    info.isAdminRightsRequired
  )
    throw new Error("Invalid Gather update artifact.");
  return Buffer.from(
    JSON.stringify({
      format: "gather-update-v1",
      platform: "win32",
      arch: "x64",
      channel: "stable",
      keyId: info.gatherKeyId,
      version: info.version,
      releaseDate: info.releaseDate,
      file: { url: file.url, sha512: file.sha512, size: file.size },
    }),
  );
}
function verifyManifest(info, trust, currentVersion) {
  const payload = signedPayload(info);
  const key = trust?.keys?.find((entry) => entry.id === info.gatherKeyId);
  if (
    !key ||
    typeof info.gatherSignature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(info.gatherSignature) ||
    !verify(
      null,
      payload,
      createPublicKey(key.publicKey),
      Buffer.from(info.gatherSignature, "base64"),
    )
  )
    throw new Error(
      "This update is not signed by a trusted Gather release key.",
    );
  if (!newerVersion(info.version, currentVersion))
    throw new Error("This update is not newer than the installed app.");
  return { version: info.version, file: { ...info.files[0] } };
}
function signManifest(info, encodedPrivateKey) {
  const privateKey = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const id = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const manifest = { ...info, gatherKeyId: id };
  manifest.gatherSignature = sign(
    null,
    signedPayload(manifest),
    privateKey,
  ).toString("base64");
  return manifest;
}
async function verifyInstaller(filename, expected) {
  const hash = createHash("sha512");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > expected.size || bytes > MAX_INSTALLER_BYTES)
      throw new Error("Update file size does not match.");
    hash.update(chunk);
  }
  if (bytes !== expected.size || hash.digest("base64") !== expected.sha512)
    throw new Error("Update file checksum does not match.");
}
module.exports = {
  newerVersion,
  signedPayload,
  signManifest,
  verifyManifest,
  verifyInstaller,
  MAX_INSTALLER_BYTES,
};
