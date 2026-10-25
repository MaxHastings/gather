import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

async function run(args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Release check failed (${code}): ${args.join(" ")}`),
          ),
    );
  });
}
await stat("release/win-unpacked/Gather.exe");
await run(["node_modules/npm/bin/npm-cli.js", "test"]);
await run(["tests/history-browser.mjs"]);
await run(["tests/media-cache-browser.mjs"]);
await run(["scripts/identity-smoke.mjs"]);
await run(["scripts/session-smoke.mjs"]);
await run(["scripts/archive-smoke.mjs"]);
await run(["scripts/conversation-tools-smoke.mjs"]);
await run(["scripts/avatar-smoke.mjs"]);
await run(["scripts/everyday-smoke.mjs"]);
await run(["scripts/restore-client-smoke.mjs"]);
await run(["scripts/interaction-smoke.mjs"]);
await run(["scripts/membership-smoke.mjs"], { GATHER_SMOKE_PACKAGED: "1" });
await run(["scripts/desktop-downloads-smoke.mjs"]);
await run(["scripts/media-smoke.mjs"]);
await run(["scripts/storage-smoke.mjs"]);
await run(["scripts/notifications-smoke.mjs"]);
await run(["scripts/offline-smoke.mjs"]);
await run(["scripts/smoke.mjs"], {
  GATHER_SMOKE_PACKAGED: "1",
  GATHER_SMOKE_DROP_OFFERS: "1",
});
await run(["scripts/browser-smoke.mjs"]);
await run(["scripts/group-voice-smoke.mjs"], { GATHER_GROUP_PACKAGED: "1" });
await run(["scripts/check-portable.mjs"]);
console.log(
  "PASS: release checks passed for the packaged desktop app and browser client.",
);
