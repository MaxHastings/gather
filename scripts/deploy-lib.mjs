import { readFile, stat } from "node:fs/promises";
import yaml from "js-yaml";
import {
  readDesktopReleases,
  readDownloadManifest,
} from "../server/desktop-releases.mjs";

// Throws unless `root` holds a complete, current download catalog and update
// manifest: the files a bare `vite build` silently deletes from dist/.
export async function validateReleaseFiles(root, version) {
  const fail = (message) => {
    throw new Error(`Release files are not deployable: ${message}`);
  };
  const json = async (path) => {
    try {
      return JSON.parse(await readFile(`${root}/${path}`, "utf8"));
    } catch {
      return fail(`${path} is missing or unreadable.`);
    }
  };
  const releases = readDesktopReleases(await json("downloads/releases.json"));
  const windows = releases.find((entry) => entry.id === "windows-x64");
  if (!windows) fail("the catalog has no Windows download.");
  if (windows.version !== version)
    fail(
      `the Windows download is ${windows.version} but package.json is ${version}. Run prepare-download for this release.`,
    );
  for (const entry of releases) {
    const folder = entry.id === "windows-x64" ? "" : `${entry.id}/`;
    const manifest = readDownloadManifest(
      await json(`downloads/${folder}manifest.json`),
      entry.id,
    );
    if (manifest.sha256 !== entry.sha256 || manifest.size !== entry.size)
      fail(`${entry.id} manifest does not match the catalog.`);
    for (const part of manifest.parts) {
      const found = await stat(`${root}/downloads/${folder}${part.name}`).catch(
        () => null,
      );
      if (found?.size !== part.size)
        fail(`${entry.id} is missing or has a wrong-sized ${part.name}.`);
    }
  }
  let update;
  try {
    update = yaml.load(await readFile(`${root}/updates/latest.yml`, "utf8"));
  } catch {
    fail("updates/latest.yml is missing.");
  }
  if (update?.version !== version)
    fail(`updates/latest.yml is ${update?.version}, expected ${version}.`);
  return releases;
}
