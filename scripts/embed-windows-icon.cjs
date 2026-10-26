// electron-builder skips its own icon step when signAndEditExecutable is false
// (needed on machines without symlink rights), which left Gather.exe with the
// generic Electron icon in shortcuts, the taskbar and Explorer. Set it here.
const path = require("node:path");

exports.default = async function embedWindowsIcon(context) {
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") {
    console.warn("Skipping Windows icon: rcedit only runs on Windows.");
    return;
  }
  const { rcedit } = await import("rcedit");
  const info = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`);
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, "electron", "icon.ico"),
    "version-string": {
      ProductName: info.productName,
      FileDescription: info.productName,
      InternalName: info.productName,
      OriginalFilename: `${info.productFilename}.exe`,
    },
    "file-version": info.version,
    "product-version": info.version,
  });
  console.log(`Embedded icon into ${path.basename(exe)}`);
};
