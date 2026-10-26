import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReleaseFiles } from "../scripts/deploy-lib.mjs";

async function fixture(version = "1.2.3") {
  const root = await mkdtemp(join(tmpdir(), "gather-deploy-"));
  await mkdir(`${root}/downloads`, { recursive: true });
  await mkdir(`${root}/updates`, { recursive: true });
  const bytes = Buffer.from("installer");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = `Gather-${version}-Setup.exe`;
  await writeFile(`${root}/downloads/gather-${version}-0.bin`, bytes);
  await writeFile(
    `${root}/downloads/manifest.json`,
    JSON.stringify({
      version,
      filename,
      size: bytes.length,
      sha256,
      parts: [{ name: `gather-${version}-0.bin`, size: bytes.length }],
    }),
  );
  await writeFile(
    `${root}/downloads/releases.json`,
    JSON.stringify({
      format: "gather-downloads-v1",
      releases: [
        {
          id: "windows-x64",
          version,
          filename,
          size: bytes.length,
          sha256,
          status: "stable",
        },
      ],
    }),
  );
  await writeFile(`${root}/updates/latest.yml`, `version: ${version}\n`);
  return root;
}

test("a complete, current set of release files passes", async () => {
  const root = await fixture();
  assert.equal((await validateReleaseFiles(root, "1.2.3")).length, 1);
  await rm(root, { recursive: true });
});

test("refuses when the build wiped the downloads or the update manifest", async () => {
  const root = await fixture();
  await rm(`${root}/updates`, { recursive: true });
  await assert.rejects(validateReleaseFiles(root, "1.2.3"), /latest\.yml/);
  await rm(`${root}/downloads`, { recursive: true });
  await assert.rejects(validateReleaseFiles(root, "1.2.3"), /releases\.json/);
  await rm(root, { recursive: true });
});

test("refuses files for another version and missing parts", async () => {
  const root = await fixture();
  await assert.rejects(validateReleaseFiles(root, "1.2.4"), /package\.json/);
  await rm(`${root}/downloads/gather-1.2.3-0.bin`);
  await assert.rejects(validateReleaseFiles(root, "1.2.3"), /gather-1\.2\.3-0/);
  await rm(root, { recursive: true });
});
