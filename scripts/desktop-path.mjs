import { join } from "node:path";
export function desktopExecutable(root = process.cwd()) {
  if (process.platform === "win32")
    return join(root, "release/win-unpacked/Gather.exe");
  if (process.platform === "linux")
    return join(root, "release/linux-unpacked/gather");
  if (process.platform === "darwin")
    return join(
      root,
      process.arch === "arm64" ? "release/mac-arm64" : "release/mac",
      "Gather.app/Contents/MacOS/Gather",
    );
  throw new Error("This desktop platform is not supported.");
}
