// Shared, finite download targets. No installer URL comes from a user's message.
export const desktopTargets = {
  "windows-x64": {
    platform: "win32",
    arch: "x64",
    label: "Windows",
    suffix: "Setup.exe",
  },
  "macos-arm64": {
    platform: "darwin",
    arch: "arm64",
    label: "Mac · Apple Silicon",
    suffix: "macOS-arm64.dmg",
  },
  "macos-x64": {
    platform: "darwin",
    arch: "x64",
    label: "Mac · Intel",
    suffix: "macOS-x64.dmg",
  },
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    label: "Linux x64 · AppImage",
    suffix: "Linux-x64.AppImage",
  },
  "linux-deb-x64": {
    platform: "linux",
    arch: "x64",
    label: "Linux x64 · Debian / Ubuntu",
    suffix: "Linux-x64.deb",
  },
};
export function downloadFilename(id, version) {
  if (!desktopTargets[id] || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
    throw new Error("Invalid desktop release.");
  return `Gather-${version}-${desktopTargets[id].suffix}`;
}
export function readDesktopReleases(value) {
  if (
    value?.format !== "gather-downloads-v1" ||
    !Array.isArray(value.releases) ||
    value.releases.length > 5
  )
    throw new Error("Invalid desktop release catalog.");
  const ids = new Set();
  return value.releases.map((entry) => {
    if (
      !entry ||
      ids.has(entry.id) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 300_000_000 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.filename !== downloadFilename(entry.id, entry.version) ||
      !["stable", "preview"].includes(entry.status)
    )
      throw new Error("Invalid desktop release entry.");
    ids.add(entry.id);
    return {
      id: entry.id,
      version: entry.version,
      filename: entry.filename,
      size: entry.size,
      sha256: entry.sha256,
      status: entry.status,
      ...desktopTargets[entry.id],
    };
  });
}
export function readDownloadManifest(value, id) {
  if (
    !value ||
    value.filename !== downloadFilename(id, value.version) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 300_000_000 ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.parts) ||
    value.parts.length < 1 ||
    value.parts.length > 19
  )
    throw new Error("Invalid download manifest.");
  let size = 0;
  value.parts.forEach((part, index) => {
    if (
      part.name !== `gather-${value.version}-${index}.bin` ||
      !Number.isSafeInteger(part.size) ||
      part.size < 1 ||
      part.size > 16 * 1024 * 1024
    )
      throw new Error("Invalid download part.");
    size += part.size;
  });
  if (size !== value.size) throw new Error("Download size mismatch.");
  return value;
}
