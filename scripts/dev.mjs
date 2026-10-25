import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit" },
);
let electron;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite.kill();
  electron?.kill();
  process.exitCode = code;
}
vite.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:5173")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error("The development server did not start.");
  const env = { ...process.env, GATHER_DEV_URL: "http://127.0.0.1:5173" };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(require("electron"), ["."], { stdio: "inherit", env });
  electron.on("exit", (code) => stop(code ?? 0));
} catch (error) {
  console.error(error.message);
  stop(1);
}
