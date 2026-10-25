// Compile the already-vendored EmojiTwo vectors into reusable image tiles.
// No CDN, runtime image library, provider, or artwork change.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const index = JSON.parse(await readFile("src/assets/emoji-index.json", "utf8")),
  symbols = new Map();
for (const sheet of new Set(Object.values(index))) {
  const text = await readFile(`src/assets/emoji-${sheet}.svg`, "utf8");
  for (const match of text.matchAll(
    /<symbol\b([^>]*\bid="e-([^"]+)"[^>]*)>([\s\S]*?)<\/symbol>/g,
  )) {
    const view = /viewBox="([^"]+)"/.exec(match[1])?.[1],
      extra = [...match[1].matchAll(/xmlns:(?!xlink)[a-zA-Z0-9_-]+="[^"]+"/g)]
        .map((m) => m[0])
        .join(" ");
    symbols.set(
      match[2],
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${extra} viewBox="${view}" width="128" height="128">${match[3]}</svg>`,
    );
  }
}
if (symbols.size !== Object.keys(index).length)
  throw new Error("Artwork inventory mismatch.");
const server = createServer((req, res) => {
  const code = req.url.slice(1, -4);
  if (symbols.has(code)) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(symbols.get(code));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Emoji atlas compiler</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const codes = Object.keys(index),
    mapping = {};
  await mkdir("src/assets/emoji-atlas", { recursive: true });
  for (let offset = 0; offset < codes.length; offset += 64) {
    const batch = codes.slice(offset, offset + 64),
      sheet = offset / 64;
    const data = await page.evaluate(async (codes) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1024;
      const context = canvas.getContext("2d");
      for (let n = 0; n < codes.length; n += 8)
        await Promise.all(
          codes.slice(n, n + 8).map(async (code, i) => {
            const image = new Image();
            image.src = `/${code}.svg`;
            try {
              await image.decode();
            } catch {
              throw new Error(`Invalid emoji vector ${code}`);
            }
            const slot = n + i;
            context.drawImage(
              image,
              (slot % 8) * 128,
              Math.floor(slot / 8) * 128,
              128,
              128,
            );
          }),
        );
      return canvas.toDataURL("image/png").split(",")[1];
    }, batch);
    await writeFile(
      `src/assets/emoji-atlas/${sheet}.png`,
      Buffer.from(data, "base64"),
    );
    batch.forEach(
      (code, i) => (mapping[code] = [sheet, i % 8, Math.floor(i / 8)]),
    );
  }
  await writeFile("src/assets/emoji-atlas-index.json", JSON.stringify(mapping));
  console.log(
    `Compiled ${codes.length} EmojiTwo assets into ${Math.ceil(codes.length / 64)} local image sheets.`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
