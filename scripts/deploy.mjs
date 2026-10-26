// One safe way to deploy: npm run deploy
// `vite build` empties dist/, which deletes the installer parts, the download
// catalog and the update manifest. This keeps them in .gather-release, puts
// them back after the build, refuses to ship an incomplete or stale set, and
// checks the live site afterwards.
//   --no-build   dist/ is already built (release:publish)
//   --from-live  no local copy: mirror the files from the live site first
//   --dry-run    build and validate, but do not deploy
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { validateReleaseFiles } from "./deploy-lib.mjs";
import { desktopTargets } from "../server/desktop-releases.mjs";

const base = "https://gather-friends.max-jacob-hastings.workers.dev";
const keep = ".gather-release";
const flags = new Set(process.argv.slice(2));
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const run = (command) => execSync(command, { stdio: "inherit" });
const folders = ["downloads", "updates"];

async function mirrorLive() {
  const get = async (path) => {
    const response = await fetch(base + path);
    if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  };
  const save = async (path, bytes) => {
    const file = `${keep}${path}`;
    await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await writeFile(file, bytes);
  };
  const catalog = await get("/downloads/releases.json");
  await save("/downloads/releases.json", catalog);
  await save("/updates/latest.yml", await get("/updates/latest.yml"));
  for (const entry of JSON.parse(catalog).releases) {
    if (!desktopTargets[entry.id]) continue;
    const folder = entry.id === "windows-x64" ? "" : `/${entry.id}`;
    const manifest = await get(`/downloads${folder}/manifest.json`);
    await save(`/downloads${folder}/manifest.json`, manifest);
    for (const part of JSON.parse(manifest).parts)
      await save(
        `/downloads${folder}/${part.name}`,
        await get(`/downloads${folder}/${part.name}`),
      );
  }
  console.log("Mirrored the live download files.");
}

// 1. Save anything the last build or prepare-download left in dist/.
for (const folder of folders)
  if (existsSync(`dist/${folder}`)) {
    await mkdir(keep, { recursive: true });
    await cp(`dist/${folder}`, `${keep}/${folder}`, { recursive: true });
  }
if (flags.has("--from-live")) await mirrorLive();
// 2. Build (this wipes dist/), then put the release files back.
if (!flags.has("--no-build")) run("npm run build");
for (const folder of folders)
  if (existsSync(`${keep}/${folder}`)) {
    await rm(`dist/${folder}`, { recursive: true, force: true });
    await cp(`${keep}/${folder}`, `dist/${folder}`, { recursive: true });
  }
// 3. Refuse to deploy if they are missing, incomplete or for another version.
const releases = await validateReleaseFiles("dist", version).catch((error) => {
  console.error(
    `\n${error.message}\nNothing was deployed. If the files are only missing, run: npm run deploy -- --from-live`,
  );
  process.exit(1);
});
console.log(
  `Release files OK: ${releases.map((r) => `${r.id} ${r.version}`).join(", ")}.`,
);
if (flags.has("--dry-run")) process.exit(0);
// 4. Deploy, then verify the live site.
run("npx wrangler deploy");
const problems = [];
const check = async (path, test) => {
  try {
    const response = await fetch(base + path);
    if (!response.ok) problems.push(`${path} returned ${response.status}.`);
    else if (test && !(await test(response)))
      problems.push(`${path} is not what was deployed.`);
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
  }
};
const local = JSON.parse(
  await readFile("dist/downloads/releases.json", "utf8"),
);
await check("/", null);
await check("/download", null);
await check("/downloads/releases.json", async (r) => {
  const live = await r.json();
  return JSON.stringify(live) === JSON.stringify(local);
});
await check("/updates/latest.yml", async (r) =>
  (await r.text()).includes(`version: ${version}`),
);
for (const entry of local.releases)
  await check(
    entry.id === "windows-x64" ? "/download/windows" : `/download/${entry.id}`,
    async (r) => {
      const length = Number(r.headers.get("content-length"));
      await r.body?.cancel();
      return !length || length === entry.size;
    },
  );
if (problems.length) {
  console.error(
    `\nDeployed, but the live check failed:\n- ${problems.join("\n- ")}\nRoll back now: npx wrangler rollback`,
  );
  process.exit(1);
}
console.log(`\nDeployed and verified live: ${base}`);
