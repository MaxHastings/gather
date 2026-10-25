import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
const base = "https://gather-friends.max-jacob-hastings.workers.dev";
const expected = await fetch(base + "/downloads/manifest.json").then((r) =>
  r.json(),
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(
  expected.version,
  version,
  "The public download must be the current release.",
);
const localHash = createHash("sha256");
for await (const bytes of createReadStream(
  `release/Gather-${version}-Setup.exe`,
))
  localHash.update(bytes);
assert.equal(
  expected.sha256,
  localHash.digest("hex"),
  "The hosted manifest must describe the local tested executable.",
);
const response = await fetch(base + `/download/windows?v=${version}`);
assert.equal(response.status, 200);
assert.match(
  response.headers.get("content-disposition"),
  /attachment; filename="Gather/,
);
const hash = createHash("sha256");
let size = 0;
for await (const chunk of response.body) {
  hash.update(chunk);
  size += chunk.length;
}
assert.equal(size, expected.size);
assert.equal(hash.digest("hex"), expected.sha256);
console.log(
  `PASS: public Windows download is byte-for-byte identical to the tested executable (${(size / 1024 / 1024).toFixed(1)} MiB).`,
);
