import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("the searchable catalog covers every bundled EmojiTwo asset without duplicate values", async () => {
  const catalog = JSON.parse(
      await readFile("src/assets/emoji-catalog.json", "utf8"),
    ),
    index = JSON.parse(await readFile("src/assets/emoji-index.json", "utf8"));
  assert.deepEqual(
    new Set(catalog.map((e) => e.code)),
    new Set(Object.keys(index)),
  );
  assert.equal(new Set(catalog.map((e) => e.value)).size, catalog.length);
  assert.ok(catalog.every((e) => e.name && e.keywords && e.category));
  assert.ok(catalog.some((e) => e.keywords.includes("thumbsup")));
  const msn = JSON.parse(
    await readFile("src/assets/msn-emoticons.json", "utf8"),
  );
  assert.equal(msn.length, 81);
  assert.equal(new Set(msn.map((e) => e.id)).size, 81);
});
