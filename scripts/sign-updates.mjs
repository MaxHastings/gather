import { readFile, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import dotenv from "dotenv";
import yaml from "js-yaml";
const { signManifest, verifyManifest, verifyInstaller } = createRequire(
  import.meta.url,
)("../electron/update-signature.cjs");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const key = dotenv.parse(await readFile(".env")).GATHER_UPDATE_SIGNING_KEY;
if (!key)
  throw new Error(
    "Initialize the local Gather update signing key before making a release.",
  );
const trust = JSON.parse(await readFile("electron/update-trust.json", "utf8"));
const metadata = yaml.load(await readFile("release/latest.yml", "utf8"));
if (metadata.version !== version)
  throw new Error("Update metadata does not match this release.");
const filename = `Gather-${version}-Setup.exe`;
const size = (await stat(`release/${filename}`)).size;
// Only the intended full per-user installer is published, never a web payload.
if (
  metadata.files?.length !== 1 ||
  metadata.files[0].url !== filename ||
  (metadata.files[0].size !== undefined && metadata.files[0].size !== size)
)
  throw new Error("Unexpected release artifact.");
metadata.files[0].size = size;
const signed = signManifest(metadata, key);
verifyManifest(signed, trust, "0.0.0");
await verifyInstaller(`release/${filename}`, signed.files[0]);
await writeFile("release/latest.yml", yaml.dump(signed, { lineWidth: -1 }));
console.log(
  `Signed verified Windows update metadata for ${version}. Private key stays local.`,
);
