// Free "ad-hoc" macOS signature. No Apple Developer account is involved, so
// Gatekeeper still asks the user to approve the first launch, but Apple Silicon
// refuses to run binaries that carry no signature at all.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
};
