import { open, mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import yaml from "js-yaml";
import { execFileSync } from "node:child_process";
import {
  desktopTargets,
  downloadFilename,
  readDesktopReleases,
  readDownloadManifest,
} from "../server/desktop-releases.mjs";
const { verifyManifest, verifyInstaller } = createRequire(import.meta.url)(
  "../electron/update-signature.cjs",
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const filename = `Gather-${version}-Setup.exe`;
const update = yaml.load(await readFile("release/latest.yml", "utf8"));
verifyManifest(
  update,
  JSON.parse(await readFile("electron/update-trust.json", "utf8")),
  "0.0.0",
);
if (update.version !== version)
  throw new Error("Update metadata is for another release.");
await verifyInstaller(`release/${filename}`, update.files[0]);
const handle = await open(`release/${filename}`, "r");
const hash = createHash("sha256");
const parts = [];
const chunkSize = 16 * 1024 * 1024;
await mkdir("dist/downloads", { recursive: true });
let total = 0;
try {
  for (let index = 0; ; index++) {
    const buffer = Buffer.alloc(chunkSize);
    const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    total += bytesRead;
    const name = `gather-${version}-${index}.bin`;
    await writeFile(`dist/downloads/${name}`, bytes);
    parts.push({ name, size: bytesRead });
  }
} finally {
  await handle.close();
}
const manifest = {
  version,
  filename,
  size: total,
  sha256: hash.digest("hex"),
  parts,
};
await writeFile(
  "dist/downloads/manifest.json",
  JSON.stringify(manifest, null, 2),
);
console.log(
  `Prepared Windows download: ${(total / 1024 / 1024).toFixed(1)} MiB, ${parts.length} parts. SHA-256 ${manifest.sha256}`,
);
await mkdir("dist/updates", { recursive: true });
await copyFile("release/latest.yml", "dist/updates/latest.yml");
const releases = [
  {
    id: "windows-x64",
    version,
    filename,
    size: total,
    sha256: manifest.sha256,
    status: "stable",
  },
];
// Additional platforms are opt-in. Never copy stale or merely cross-compiled
// binaries into the public catalog because a matching filename happens to exist.
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
for (const id of new Set(process.argv.slice(2))) {
  if (!desktopTargets[id] || id === "windows-x64")
    throw new Error(`Unknown additional desktop target: ${id}`);
  const sourceId = id === "linux-deb-x64" ? "linux-x64" : id;
  const report = JSON.parse(
    await readFile(`release/${sourceId}/desktop-build.json`, "utf8"),
  );
  const target = desktopTargets[id],
    name = downloadFilename(id, version);
  if (
    report.format !== "gather-desktop-build-v1" ||
    report.version !== version ||
    report.commit !== commit ||
    report.platform !== target.platform ||
    report.arch !== target.arch ||
    !["unit", "packaged-profile-restart", "packaged-chat-voice"].every(
      (check) => report.checks?.includes(check),
    )
  )
    throw new Error(`Native validation is missing or stale for ${id}.`);
  const expected = report.files?.find((file) => file.name === name);
  if (!expected)
    throw new Error(`Native package inventory is missing ${name}.`);
  const binary = await open(`release/${sourceId}/${name}`, "r");
  const nativeHash = createHash("sha256"),
    nativeParts = [];
  const destination = `dist/downloads/${id}`;
  await mkdir(destination, { recursive: true });
  let nativeSize = 0;
  try {
    for (let index = 0; ; index++) {
      const buffer = Buffer.alloc(chunkSize),
        { bytesRead } = await binary.read(buffer, 0, chunkSize, null);
      if (!bytesRead) break;
      nativeSize += bytesRead;
      if (nativeSize > 300_000_000)
        throw new Error("Desktop package exceeds the download limit.");
      const bytes = buffer.subarray(0, bytesRead),
        part = `gather-${version}-${index}.bin`;
      nativeHash.update(bytes);
      await writeFile(`${destination}/${part}`, bytes);
      nativeParts.push({ name: part, size: bytesRead });
    }
  } finally {
    await binary.close();
  }
  const sha256 = nativeHash.digest("hex");
  if (nativeSize !== expected.size || sha256 !== expected.sha256)
    throw new Error(
      `Native package bytes differ from the tested inventory: ${id}.`,
    );
  const nativeManifest = readDownloadManifest(
    { version, filename: name, size: nativeSize, sha256, parts: nativeParts },
    id,
  );
  await writeFile(
    `${destination}/manifest.json`,
    JSON.stringify(nativeManifest, null, 2),
  );
  releases.push({
    id,
    version,
    filename: name,
    size: nativeSize,
    sha256,
    status: "preview",
  });
  console.log(
    `Prepared tested ${id} preview: ${(nativeSize / 1024 / 1024).toFixed(1)} MiB.`,
  );
}
const catalog = { format: "gather-downloads-v1", releases };
readDesktopReleases(catalog);
await writeFile(
  "dist/downloads/releases.json",
  JSON.stringify(catalog, null, 2),
);
