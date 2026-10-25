import { readdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const files = [];
for (const name of await readdir("release")) {
  if (
    !name.startsWith(`Gather-${version}-`) ||
    !/\.(exe|dmg|zip|AppImage|deb)$/.test(name)
  )
    continue;
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(`release/${name}`)) {
    hash.update(chunk);
    size += chunk.length;
  }
  files.push({ name, size, sha256: hash.digest("hex") });
}
if (!files.length) throw new Error("No native packages were built.");
await writeFile(
  "release/desktop-build.json",
  JSON.stringify(
    {
      format: "gather-desktop-build-v1",
      version,
      platform: process.platform,
      arch: process.arch,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      checks: ["unit", "packaged-profile-restart", "packaged-chat-voice"],
      distribution: "testing-only",
      files,
    },
    null,
    2,
  ),
);
console.log(
  `Inventoried ${files.length} native packages. These are test artifacts, not a published update.`,
);
