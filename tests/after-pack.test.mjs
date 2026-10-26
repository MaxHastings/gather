import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("package.json has exactly one afterPack hook and it runs both the icon and signing steps", () => {
  // JSON.parse keeps only the last duplicate key, so count them in the text.
  const text = readFileSync("package.json", "utf8");
  assert.equal(text.match(/"afterPack"/g).length, 1);
  const hook = JSON.parse(text).build.afterPack;
  assert.equal(hook, "scripts/after-pack.cjs");
  const source = readFileSync(hook, "utf8");
  assert.match(source, /embed-windows-icon/);
  assert.match(source, /adhoc-sign/);
});

test("the combined hook does nothing on a platform it does not serve", async () => {
  const { default: afterPack } = require("../scripts/after-pack.cjs");
  await afterPack({ electronPlatformName: "linux", appOutDir: "x", packager: {} });
});
