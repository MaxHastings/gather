// Optional maintenance command; normal builds use the committed artwork.
// Source: EmojiTwo/emojitwo, 311eff547b3ff4a61fdbae897dd09d41416048fc.
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
const source = process.argv[2] ?? ".gather-test-emojitwo";
const files = (await readdir(join(source, "svg")))
  .filter((file) => /^[a-f0-9-]+\.svg$/.test(file))
  .sort();
const symbols = [];
const canonical = (name) =>
  name
    .slice(0, -4)
    .split("-")
    .map((part) => parseInt(part, 16).toString(16))
    .join("-");
for (const file of files) {
  let svg = (await readFile(join(source, "svg", file), "utf8"))
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (
    /<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)|url\((?!#)/i.test(
      svg,
    )
  )
    throw new Error(`Unexpected active emoji content: ${file}`);
  const prefix = `e-${file.slice(0, -4)}-`;
  svg = svg
    .replace(/xlink:href=/g, "href=")
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`);
  const root =
    /^<svg\b([^>]*?)viewBox="([^"]+)"([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!root) throw new Error(`Unsupported emoji asset: ${file}`);
  const namespaces = [...(root[1] + root[3]).matchAll(/xmlns:[\w-]+="[^"]+"/g)]
    .map((match) => match[0])
    .join(" ");
  symbols.push(
    `<symbol id="e-${canonical(file)}" ${namespaces} viewBox="${root[2]}">${root[4]}</symbol>`,
  );
}
await mkdir("src/assets", { recursive: true });
await mkdir("licenses", { recursive: true });
for (const name of await readdir("src/assets"))
  if (/^emoji-\d+\.svg$/.test(name)) await unlink(join("src/assets", name));
const groups = [[]];
let groupBytes = 0;
const index = {};
for (const [i, symbol] of symbols.entries()) {
  const bytes = Buffer.byteLength(symbol);
  if (groupBytes + bytes > 3_000_000) {
    groups.push([]);
    groupBytes = 0;
  }
  index[canonical(files[i])] = groups.length - 1;
  groups.at(-1).push(symbol);
  groupBytes += bytes;
}
for (const [i, group] of groups.entries())
  await writeFile(
    `src/assets/emoji-${i}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg">${group.join("")}</svg>`,
  );
await unlink("src/assets/emoji.svg").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
await writeFile("src/assets/emoji-index.json", JSON.stringify(index));
await copyFile(join(source, "LICENSE.md"), "licenses/EmojiTwo-LICENSE.md");
await unlink("licenses/Twemoji-CC-BY-4.0.txt").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
console.log(
  `Bundled ${files.length} SVG emoji. No runtime CDN or parser dependency.`,
);
