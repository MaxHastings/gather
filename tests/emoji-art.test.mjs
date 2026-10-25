import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("compiled EmojiTwo inventory covers every vendored symbol exactly once with local bounded tiles", async () => {
  const source = JSON.parse(
      await readFile("src/assets/emoji-index.json", "utf8"),
    ),
    atlas = JSON.parse(
      await readFile("src/assets/emoji-atlas-index.json", "utf8"),
    ),
    catalog = JSON.parse(
      await readFile("src/assets/emoji-catalog.json", "utf8"),
    );
  assert.equal(Object.keys(source).length, 2789);
  assert.deepEqual(Object.keys(atlas).sort(), Object.keys(source).sort());
  assert.equal(catalog.length, 2789);
  const cells = new Set();
  for (const location of Object.values(atlas)) {
    assert.equal(location.length, 3);
    const [sheet, x, y] = location;
    assert.ok(Number.isInteger(sheet) && sheet >= 0 && sheet < 44);
    assert.ok(Number.isInteger(x) && x >= 0 && x < 8);
    assert.ok(Number.isInteger(y) && y >= 0 && y < 8);
    assert.ok(!cells.has(location.join(":")));
    cells.add(location.join(":"));
  }
  for (let n = 0; n < 44; n++) {
    const data = await readFile(`src/assets/emoji-atlas/${n}.png`);
    assert.equal(data.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(data.readUInt32BE(16), 1024);
    assert.equal(data.readUInt32BE(20), 1024);
  }
});
