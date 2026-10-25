import { appendFileSync } from "node:fs";
const targets = [
  {
    name: "Windows x64",
    os: "windows-2025",
    artifact: "windows-x64",
    family: "windows",
  },
  {
    name: "macOS Apple Silicon",
    os: "macos-15",
    artifact: "macos-arm64",
    family: "macos",
  },
  {
    name: "macOS Intel",
    os: "macos-15-intel",
    artifact: "macos-x64",
    family: "macos",
  },
  {
    name: "Linux x64",
    os: "ubuntu-24.04",
    artifact: "linux-x64",
    family: "linux",
  },
];
const target = process.env.GATHER_BUILD_TARGET || "all";
if (!["all", "windows", "macos", "linux"].includes(target))
  throw new Error("Unknown desktop build target.");
const matrix = JSON.stringify({
  include: targets.filter(
    (entry) => target === "all" || entry.family === target,
  ),
});
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
console.log(matrix);
